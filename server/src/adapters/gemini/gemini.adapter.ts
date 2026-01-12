import { LLMClientPort } from '../../application/ports/llm-client.port.js';
import { Config, ConfigParameters } from '../../../vendor/gemini-cli/packages/core/src/config/config.js';
import { GeminiChat, StreamEventType } from '../../../vendor/gemini-cli/packages/core/src/core/geminiChat.js';
import { DEFAULT_GEMINI_MODEL } from '../../../vendor/gemini-cli/packages/core/src/config/models.js';
import { AuthType } from '../../../vendor/gemini-cli/packages/core/src/core/contentGenerator.js';
import path from 'path';
import fs from 'fs';

export class GeminiAdapter implements LLMClientPort {
  private config: Config | null = null;
  private chatSessions: Map<string, GeminiChat> = new Map();

  async initialize(): Promise<void> {
    const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    console.log(`Using Gemini Model: ${model}`);

    const configParams: ConfigParameters = {
      sessionId: 'default-session', // This is just for config init
      targetDir: process.cwd(),
      cwd: process.cwd(),
      debugMode: true,
      model: model,
    };

    this.config = new Config(configParams);
    await this.config.initialize();
    
    // Initialize authentication
    await this.config.refreshAuth(AuthType.USE_GEMINI);
    console.log('Gemini Adapter initialized successfully.');
  }

  async sendMessageStream(message: string, sessionId: string, filePaths?: string[], options?: { model?: string, tools?: any[] }): Promise<AsyncGenerator<string, void, unknown>> {
    if (!this.config) {
      throw new Error('GeminiAdapter not initialized');
    }

    // If tools are provided, create a new chat session with tools (don't cache it)
    // Otherwise, use the cached session
    let chat: GeminiChat;
    if (options?.tools && options.tools.length > 0) {
      chat = new GeminiChat(
        this.config,
        'You are a helpful assistant.',
        options.tools,
        []  // History - fresh session for tool-based requests
      );
    } else {
      chat = this.chatSessions.get(sessionId);
      if (!chat) {
        chat = new GeminiChat(
          this.config,
          'You are a helpful assistant.',
          [], // Tools
          []  // History
        );
        this.chatSessions.set(sessionId, chat);
      }
    }

    const modelConfigKey = {
      model: options?.model || this.config.getModel() || DEFAULT_GEMINI_MODEL
    };

    const controller = new AbortController();

    let parts: any[] = [{ text: message }];

    if (filePaths && filePaths.length > 0) {
      for (const filePath of filePaths) {
        const ext = path.extname(filePath).toLowerCase();
        const filename = path.basename(filePath);

        // Text-based files: send as text parts
        if (['.md', '.txt', '.json', '.csv', '.xml', '.js', '.ts'].includes(ext)) {
          const content = fs.readFileSync(filePath, 'utf-8');
          parts.push({
            text: `\n\n--- File: ${filename} ---\n${content}\n----------------\n`
          });
          continue;
        }

        // Binary files: send as inlineData
        let detectedMime = 'application/octet-stream';
        if (ext === '.pdf') detectedMime = 'application/pdf';
        if (ext === '.png') detectedMime = 'image/png';
        if (ext === '.jpg' || ext === '.jpeg') detectedMime = 'image/jpeg';

        const fileBuffer = fs.readFileSync(filePath);
        const base64Data = fileBuffer.toString('base64');

        parts.push({
          inlineData: {
            mimeType: detectedMime,
            data: base64Data
          }
        });
      }
    }

    const stream = await chat.sendMessageStream(
      modelConfigKey,
      parts,
      'user-prompt-id',
      controller.signal
    );

    async function* generator() {
      for await (const event of stream) {
        if (event.type === StreamEventType.CHUNK) {
          const text = event.value.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            yield text;
          }
        }
      }
    }

    return generator();
  }
}
