import dotenv from 'dotenv';
import path from 'path';

// Load .env file from server root if not already loaded
// Note: In this monorepo structure, CWD is often root, but we should be safe
dotenv.config({ path: path.join(process.cwd(), '.env') });

export const REALM_CONFIG = {
  models: {
    // Default to a known stable model if env var is missing, but prefer the user's env vars
    markdown: process.env.MARKDOWN_MODEL || 'gemini-2.0-flash-exp',
    intermediate: process.env.INTERMEDIATE_MODEL || 'gemini-2.0-pro-exp',
    html: process.env.HTML_MODEL || 'gemini-2.0-pro-exp',
  }
};
