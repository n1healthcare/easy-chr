import { Config, ConfigParameters } from './vendor/gemini-cli/packages/core/src/config/config.js';
import { GeminiChat, StreamEventType } from './vendor/gemini-cli/packages/core/src/core/geminiChat.js';
import { DEFAULT_GEMINI_MODEL } from './vendor/gemini-cli/packages/core/src/config/models.js';
import { AuthType } from './vendor/gemini-cli/packages/core/src/core/contentGenerator.js';
import path from 'path';

async function main() {
  console.log('Starting POC...');

  // 1. Initialize Config
  const configParams: ConfigParameters = {
    sessionId: 'test-session-1',
    targetDir: process.cwd(),
    cwd: process.cwd(),
    debugMode: true,
    model: DEFAULT_GEMINI_MODEL,
    // Add other required parameters if needed, or minimal defaults
  };

  const config = new Config(configParams);
  
  try {
      await config.initialize();
      // Initialize authentication to ensure ContentGenerator is ready
      // We use USE_GEMINI as a default which looks for GEMINI_API_KEY env var
      await config.refreshAuth(AuthType.USE_GEMINI);
      console.log('Config initialized successfully.');
  } catch (error) {
      console.error('Failed to initialize config:', error);
      return;
  }

  // 2. Initialize Chat
  const chat = new GeminiChat(
    config,
    'You are a helpful assistant.', // System instruction
    [], // Tools
    []  // History
  );

  console.log('Chat initialized. Sending message...');

  // 3. Send Message
  const message = 'Hello, can you tell me what 2 + 2 is?';
  
  // ModelConfigKey is used to select the model configuration
  const modelConfigKey = {
      model: DEFAULT_GEMINI_MODEL
  };

  // Create an abort signal
  const controller = new AbortController();

  try {
    const stream = await chat.sendMessageStream(
      modelConfigKey,
      { text: message },
      'test-prompt-id',
      controller.signal
    );

    console.log('Stream started. Receiving chunks:');

    for await (const event of stream) {
      if (event.type === StreamEventType.CHUNK) {
        const text = event.value.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          process.stdout.write(text);
        }
      } else if (event.type === StreamEventType.RETRY) {
        console.log('\n[Retry Event]');
      }
    }
    console.log('\n\nStream finished.');

  } catch (error) {
    console.error('Error sending message:', error);
  }
}

main().catch(console.error);
