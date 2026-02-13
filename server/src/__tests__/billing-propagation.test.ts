import { describe, it, expect, vi } from 'vitest';
import { SendChatUseCase } from '../application/use-cases/send-chat.use-case.js';
import { ResearchSectionUseCase } from '../application/use-cases/research-section.use-case.js';
import type { LLMClientPort } from '../application/ports/llm-client.port.js';
import { extractBillingContext, isMissingBillingContextAllowed } from '../adapters/http/server.js';

function createMockLLMClient(
  sendMessageStream: ReturnType<typeof vi.fn>,
): LLMClientPort {
  return {
    initialize: vi.fn(async () => {}),
    sendMessageStream,
    getConfig: vi.fn(async () => ({}) as any),
  };
}

async function* createTextStream(chunks: string[]): AsyncGenerator<string, void, unknown> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe('billing context extraction', () => {
  it('extracts user and chr ids from headers', () => {
    const context = extractBillingContext({
      'x-subject-user-id': 'user-123',
      'x-chr-id': 'chr-456',
    });

    expect(context).toEqual({
      userId: 'user-123',
      chrId: 'chr-456',
    });
  });

  it('supports array header values', () => {
    const context = extractBillingContext({
      'x-subject-user-id': ['user-123'],
      'x-chr-id': ['chr-456'],
    });

    expect(context).toEqual({
      userId: 'user-123',
      chrId: 'chr-456',
    });
  });

  it('returns undefined when x-subject-user-id is missing', () => {
    const context = extractBillingContext({
      'x-chr-id': 'chr-456',
    });

    expect(context).toBeUndefined();
  });
});

describe('missing billing context behavior flag', () => {
  it('uses ALLOW_MISSING_BILLING_CONTEXT env var explicitly', () => {
    const original = process.env.ALLOW_MISSING_BILLING_CONTEXT;

    process.env.ALLOW_MISSING_BILLING_CONTEXT = 'true';
    expect(isMissingBillingContextAllowed()).toBe(true);

    process.env.ALLOW_MISSING_BILLING_CONTEXT = 'false';
    expect(isMissingBillingContextAllowed()).toBe(false);

    delete process.env.ALLOW_MISSING_BILLING_CONTEXT;
    expect(isMissingBillingContextAllowed()).toBe(false);

    if (original !== undefined) {
      process.env.ALLOW_MISSING_BILLING_CONTEXT = original;
    } else {
      delete process.env.ALLOW_MISSING_BILLING_CONTEXT;
    }
  });
});

describe('billing propagation to LLM streaming paths', () => {
  it('passes billing context through SendChatUseCase', async () => {
    const sendMessageStream = vi.fn(async () => createTextStream(['ok']));
    const llmClient = createMockLLMClient(sendMessageStream);
    const useCase = new SendChatUseCase(llmClient);
    const billingContext = { userId: 'user-123', chrId: 'chr-456' };

    await useCase.execute('hello', 'session-1', billingContext);

    expect(sendMessageStream).toHaveBeenCalledWith(
      'hello',
      'session-1',
      undefined,
      { billingContext },
    );
  });

  it('passes billing context through ResearchSectionUseCase', async () => {
    const sendMessageStream = vi.fn(async () => createTextStream(['chunk-a', 'chunk-b']));
    const llmClient = createMockLLMClient(sendMessageStream);
    const useCase = new ResearchSectionUseCase(llmClient);
    const billingContext = { userId: 'user-123', chrId: 'chr-456' };

    let output = '';
    for await (const chunk of useCase.execute('section context', 'what changed?', billingContext)) {
      output += chunk;
    }

    expect(sendMessageStream).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringMatching(/^research-/),
      [],
      expect.objectContaining({
        tools: [{ googleSearch: {} }],
        billingContext,
      }),
    );
    expect(output).toBe('chunk-achunk-b');
  });
});
