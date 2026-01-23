/**
 * LiteLLM Billing Metadata Utilities
 *
 * Provides functions to create billing metadata headers for LiteLLM proxy.
 * The metadata is sent via custom HTTP headers that the n1-litellm callback extracts.
 */

export interface BillingContext {
  userId: string;
  chrId?: string;
}

const SERVICE_NAME = 'workflow-easy-chr';

/**
 * Create HTTP headers for LiteLLM billing callback.
 *
 * The n1-litellm callback extracts metadata from these specific headers:
 * - x-subject-user-id: Used for billing_user_id and subject_user_id
 * - x-chr-id: CHR report ID for tracking
 * - x-service-name: Service identifier for cost categorization
 *
 * See: n1-litellm/n1_billing_callback_redis.py lines 507-534
 */
export function createBillingHeaders(
  context: BillingContext,
): Record<string, string> {
  return {
    'x-subject-user-id': context.userId,
    'x-service-name': SERVICE_NAME,
    ...(context.chrId && { 'x-chr-id': context.chrId }),
  };
}
