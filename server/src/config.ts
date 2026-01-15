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
    // Agentic Doctor model - uses the most capable model for complex medical analysis
    // Falls back to INTERMEDIATE_MODEL which is typically a capable model
    doctor: process.env.DOCTOR_MODEL || process.env.INTERMEDIATE_MODEL || 'gemini-2.5-pro',
  },
  agenticLoop: {
    // Maximum iterations for the agentic loop (tool calls + refinements)
    maxIterations: parseInt(process.env.MAX_AGENTIC_ITERATIONS || '10'),
    // Enable/disable web search for medical knowledge
    enableWebSearch: process.env.ENABLE_WEB_SEARCH !== 'false',
  },
};
