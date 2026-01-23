import dotenv from 'dotenv';
import { createServer } from './adapters/http/server.js';

dotenv.config();

// Convert standard OPENAI env vars to Gemini-specific ones
// This allows forge-sentinel to be agnostic about Gemini
if (process.env.OPENAI_API_KEY) {
  process.env.GEMINI_API_KEY = process.env.OPENAI_API_KEY;
}

if (process.env.OPENAI_BASE_URL) {
  // Strip /v1 suffix for Gemini
  const baseUrl = process.env.OPENAI_BASE_URL.replace(/\/+$/, '').replace(/\/v1$/, '');
  process.env.GOOGLE_GEMINI_BASE_URL = baseUrl;
}

const start = async () => {
  try {
    const server = await createServer();
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    await server.listen({ port, host: '0.0.0.0' });
    console.log(`Server listening on port ${port}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

start();
