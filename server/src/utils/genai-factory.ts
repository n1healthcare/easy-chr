/**
 * GoogleGenAI Factory
 *
 * Creates GoogleGenAI instances with billing metadata headers injected.
 * This ensures all LLM calls are properly tracked in LiteLLM.
 */

import { GoogleGenAI } from '@google/genai';
import { createBillingHeaders, type BillingContext } from './billing.js';

export { type BillingContext } from './billing.js';

/**
 * Create a GoogleGenAI instance with optional billing context.
 *
 * When billingContext is provided, adds custom headers for LiteLLM billing:
 * - x-subject-user-id: The billing user ID
 * - x-chr-id: The CHR report ID
 * - x-service-name: Service identifier
 */
export function createGoogleGenAI(billingContext?: BillingContext): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is required');
  }

  const baseURL = process.env.GOOGLE_GEMINI_BASE_URL;
  const headers = billingContext ? createBillingHeaders(billingContext) : {};

  return new GoogleGenAI({
    apiKey,
    ...(baseURL && { baseURL }),
    ...(Object.keys(headers).length > 0 && { httpOptions: { headers } }),
  });
}
