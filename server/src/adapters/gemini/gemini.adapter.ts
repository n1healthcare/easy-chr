import { LLMClientPort } from '../../application/ports/llm-client.port.js';
import type { LLMStreamOptions } from '../../application/ports/llm-client.port.js';
import { Config, ConfigParameters } from '../../../vendor/gemini-cli/packages/core/src/config/config.js';
import { GeminiChat, StreamEventType } from '../../../vendor/gemini-cli/packages/core/src/core/geminiChat.js';
import { DEFAULT_GEMINI_MODEL } from '../../../vendor/gemini-cli/packages/core/src/config/models.js';
import { DEFAULT_MODEL_CONFIGS } from '../../../vendor/gemini-cli/packages/core/src/config/defaultModelConfigs.js';
import { AuthType } from '../../../vendor/gemini-cli/packages/core/src/core/contentGenerator.js';
import path from 'path';
import fs from 'fs';
import { retryLLM } from '../../common/index.js';
import type { BillingContext } from '../../utils/billing.js';
import { createBillingHeaders } from '../../utils/billing.js';

const DEFAULT_GEMINI_STREAM_TIMEOUT_MS = 120000;

export class GeminiAdapter implements LLMClientPort {
  private configByBillingKey: Map<string, Config> = new Map();
  private configInitPromises: Map<string, Promise<Config>> = new Map();
  private chatSessions: Map<string, GeminiChat> = new Map();

  /**
   * Get the underlying Config object for advanced agent operations.
   * Lazily initializes a billing-scoped config if needed.
   */
  async getConfig(billingContext?: BillingContext): Promise<Config> {
    const { config } = await this.getOrCreateConfig(billingContext);
    return config;
  }

  private getBillingKey(billingContext?: BillingContext): string {
    if (!billingContext?.userId) {
      return 'default';
    }
    return `${billingContext.userId}:${billingContext.chrId || ''}`;
  }

  private async createConfig(billingContext?: BillingContext): Promise<Config> {
    const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

    // Get the web search model from env, defaulting to MARKDOWN_MODEL or gemini-3-flash-preview
    const webSearchModel = process.env.WEB_SEARCH_MODEL || process.env.MARKDOWN_MODEL || 'gemini-3-flash-preview';

    // Create custom model config that overrides web-search to use an available model
    // The default uses gemini-2.5-flash which may not be available on all LiteLLM proxies
    const modelConfigServiceConfig = {
      aliases: {
        ...DEFAULT_MODEL_CONFIGS.aliases,
        // Override the base model used by web-search
        'gemini-2.5-flash-base': {
          extends: 'base',
          modelConfig: {
            model: webSearchModel,
          },
        },
      },
      overrides: DEFAULT_MODEL_CONFIGS.overrides,
    };

    const customHeaders = billingContext?.userId
      ? createBillingHeaders(billingContext)
      : undefined;
    const configParams: ConfigParameters = {
      sessionId: 'default-session', // This is just for config init
      targetDir: process.cwd(),
      cwd: process.cwd(),
      debugMode: true,
      model,
      retryFetchErrors: true, // Enable retry on "fetch failed" network errors
      modelConfigServiceConfig,
      customHeaders,
    };

    const config = new Config(configParams);
    await config.initialize();

    // Initialize authentication
    await config.refreshAuth(AuthType.USE_GEMINI);
    return config;
  }

  private async getOrCreateConfig(
    billingContext?: BillingContext,
  ): Promise<{ config: Config; billingKey: string }> {
    const billingKey = this.getBillingKey(billingContext);
    const existingConfig = this.configByBillingKey.get(billingKey);
    if (existingConfig) {
      return { config: existingConfig, billingKey };
    }

    const inFlight = this.configInitPromises.get(billingKey);
    if (inFlight) {
      const config = await inFlight;
      return { config, billingKey };
    }

    const initPromise = this.createConfig(billingContext)
      .then((config) => {
        this.configByBillingKey.set(billingKey, config);
        this.configInitPromises.delete(billingKey);
        return config;
      })
      .catch((error) => {
        this.configInitPromises.delete(billingKey);
        throw error;
      });

    this.configInitPromises.set(billingKey, initPromise);
    const config = await initPromise;
    return { config, billingKey };
  }

  async initialize(): Promise<void> {
    // Warm default (no billing context) config.
    await this.getOrCreateConfig();

    const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    const webSearchModel = process.env.WEB_SEARCH_MODEL || process.env.MARKDOWN_MODEL || 'gemini-3-flash-preview';
    console.log(`Using Gemini Model: ${model}`);
    console.log(`Using Web Search Model: ${webSearchModel}`);
    console.log('Gemini Adapter initialized successfully.');
  }

  async sendMessageStream(message: string, sessionId: string, filePaths?: string[], options?: LLMStreamOptions): Promise<AsyncGenerator<string, void, unknown>> {
    const { config, billingKey } = await this.getOrCreateConfig(options?.billingContext);
    const scopedSessionId = `${billingKey}:${sessionId}`;

    // If tools are provided, create a new chat session with tools (don't cache it)
    // Otherwise, use the cached session
    let chat: GeminiChat;
    if (options?.tools && options.tools.length > 0) {
      chat = new GeminiChat(
        config,
        'You are a helpful assistant.',
        options.tools,
        []  // History - fresh session for tool-based requests
      );
    } else {
      chat = this.chatSessions.get(scopedSessionId);
      if (!chat) {
        chat = new GeminiChat(
          config,
          'You are a helpful assistant.',
          [], // Tools
          []  // History
        );
        this.chatSessions.set(scopedSessionId, chat);
      }
    }

    const modelConfigKey = {
      model: options?.model || config.getModel() || DEFAULT_GEMINI_MODEL
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

    const rawStreamTimeoutMs = process.env.GEMINI_STREAM_TIMEOUT_MS;
    let streamTimeoutMs = DEFAULT_GEMINI_STREAM_TIMEOUT_MS;
    if (rawStreamTimeoutMs) {
      const parsedStreamTimeoutMs = Number(rawStreamTimeoutMs);
      if (Number.isFinite(parsedStreamTimeoutMs) && parsedStreamTimeoutMs > 0) {
        streamTimeoutMs = parsedStreamTimeoutMs;
      }
    }
    // Per-chunk inactivity timeout: resets every time a chunk arrives.
    // Detects stalled streams without killing long-running active generations.
    let timeoutHandle = setTimeout(() => {
      console.warn(`[GeminiAdapter] Stream stalled — no chunks received for ${streamTimeoutMs}ms; aborting.`);
      controller.abort();
    }, streamTimeoutMs);

    function resetTimeout() {
      clearTimeout(timeoutHandle);
      timeoutHandle = setTimeout(() => {
        console.warn(`[GeminiAdapter] Stream stalled — no chunks received for ${streamTimeoutMs}ms; aborting.`);
        controller.abort();
      }, streamTimeoutMs);
    }

    let stream: AsyncIterable<any>;
    try {
      stream = await retryLLM(
        () => chat.sendMessageStream(modelConfigKey, parts, 'user-prompt-id', controller.signal),
        { operationName: 'GeminiAdapter.sendMessageStream' }
      );
    } catch (error) {
      clearTimeout(timeoutHandle);
      throw error;
    }

    async function* generator() {
      try {
        for await (const event of stream) {
          if (event.type === StreamEventType.CHUNK) {
            resetTimeout();
            const text = event.value.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              yield text;
            }
          }
        }
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    return generator();
  }
}
