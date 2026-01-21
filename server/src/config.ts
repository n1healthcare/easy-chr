import dotenv from 'dotenv';
import path from 'path';

// Load .env file from server root if not already loaded
// Note: In this monorepo structure, CWD is often root, but we should be safe
dotenv.config({ path: path.join(process.cwd(), '.env') });

export const REALM_CONFIG = {
  models: {
    // Default to LiteLLM-compatible models
    // In production, these are injected by forge-sentinel via env vars
    markdown: process.env.MARKDOWN_MODEL || 'gemini-2.5-flash',
    intermediate: process.env.INTERMEDIATE_MODEL || 'gemini-3-pro-preview',
    html: process.env.HTML_MODEL || 'gemini-3-flash-preview',
    // Agentic Doctor model - uses the most capable model for complex medical analysis
    // Falls back to INTERMEDIATE_MODEL which is typically a capable model
    doctor: process.env.DOCTOR_MODEL || process.env.INTERMEDIATE_MODEL || 'gemini-3-pro-preview',
  },
  agenticLoop: {
    // Maximum iterations for the agentic loop (tool calls + refinements)
    maxIterations: parseInt(process.env.MAX_AGENTIC_ITERATIONS || '10'),
    // Enable/disable web search for medical knowledge
    enableWebSearch: process.env.ENABLE_WEB_SEARCH !== 'false',
  },
};
