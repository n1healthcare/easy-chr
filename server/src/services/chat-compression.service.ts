/**
 * Chat Compression Service
 *
 * Adapted from Gemini CLI's chatCompressionService.ts pattern.
 * Compresses conversation history when it exceeds a token threshold,
 * replacing older entries with a structured summary while preserving
 * the most recent portion intact.
 *
 * Key design:
 * - Medical-analysis-specific compression prompt (not code-focused)
 * - Preserves function call/response pairing by only splitting at safe points
 * - External state (analysis sections, validation issues) is stored outside
 *   conversation history and never lost during compression
 * - Compression failure is non-fatal — pipeline continues with full history
 */

import { GoogleGenAI } from '@google/genai';
import { REALM_CONFIG } from '../config.js';
import {
  createGoogleGenAI,
  type BillingContext,
} from '../utils/genai-factory.js';

// ============================================================================
// Types
// ============================================================================

export interface ConversationEntry {
  role: string;
  parts: Array<{
    text?: string;
    functionCall?: unknown;
    functionResponse?: unknown;
    thoughtSignature?: string;
  }>;
}

export interface CompressionResult {
  compressed: boolean;
  newHistory: ConversationEntry[];
  originalTokenEstimate: number;
  newTokenEstimate: number;
}

export interface CompressionContext {
  /** Determines the compression prompt variant */
  phase: 'analyst' | 'validator';
  /** Current state stored outside conversation history (analysis sections, docs explored, etc.) */
  externalState?: string;
}

// ============================================================================
// Token Estimation
// ============================================================================

/**
 * Estimate token count using character-based heuristic.
 * Adapted from vendor tokenCalculation.ts (estimateTokenCountSync).
 *
 * For text-only content (no images), this is accurate enough and avoids
 * an extra API call. The vendor uses the same heuristic for text-only.
 */
const ASCII_TOKENS_PER_CHAR = 0.25;
const NON_ASCII_TOKENS_PER_CHAR = 1.3;

function estimateTokenCount(history: ConversationEntry[]): number {
  let tokens = 0;
  for (const entry of history) {
    const serialized = JSON.stringify(entry);
    for (const char of serialized) {
      if (char.codePointAt(0)! <= 127) {
        tokens += ASCII_TOKENS_PER_CHAR;
      } else {
        tokens += NON_ASCII_TOKENS_PER_CHAR;
      }
    }
  }
  return Math.ceil(tokens);
}

// ============================================================================
// Split Point Logic
// ============================================================================

/**
 * Find a safe point to split conversation history for compression.
 * Adapted from vendor chatCompressionService.ts (findCompressSplitPoint).
 *
 * Key safety constraint: only split at user messages that are NOT function
 * responses, to preserve the function call/response pairing that Gemini requires.
 *
 * @param contents - The conversation history
 * @param compressFraction - Fraction of history to compress (e.g., 0.7 = oldest 70%)
 * @returns Index to split at (compress [0, index), keep [index, end))
 */
function findSplitPoint(
  contents: ConversationEntry[],
  compressFraction: number,
): number {
  const charCounts = contents.map(c => JSON.stringify(c).length);
  const totalChars = charCounts.reduce((a, b) => a + b, 0);
  const targetChars = totalChars * compressFraction;

  let lastSafeSplitPoint = 0;
  let cumulativeChars = 0;

  for (let i = 0; i < contents.length; i++) {
    const entry = contents[i];

    // Safe to split at a user message that is NOT a function response
    const isSafeSplitPoint =
      entry.role === 'user' &&
      !entry.parts.some(p => p.functionResponse !== undefined);

    if (isSafeSplitPoint) {
      if (cumulativeChars >= targetChars) {
        return i;
      }
      lastSafeSplitPoint = i;
    }

    cumulativeChars += charCounts[i];
  }

  // If we've passed the target without finding a split point after it,
  // check if we can compress everything (safe only if last entry is model text)
  const last = contents[contents.length - 1];
  if (
    last?.role === 'model' &&
    !last.parts.some(p => p.functionCall !== undefined)
  ) {
    return contents.length;
  }

  return lastSafeSplitPoint;
}

// ============================================================================
// Compression Prompt
// ============================================================================

function getMedicalCompressionPrompt(phase: 'analyst' | 'validator'): string {
  if (phase === 'validator') {
    return `You are a conversation history compressor for a medical data validation agent.

When the conversation history grows too large, you compress it into a structured snapshot. This snapshot becomes the agent's ONLY memory of past work. All critical verification results, issues found, and data checked MUST be preserved.

First, review the entire conversation in a private <scratchpad>. Identify every verification result, issue found, and data point checked. Then generate the <state_snapshot>.

Be EXTREMELY dense with information. Include specific values, check results, and issue details. Omit only tool response formatting boilerplate.

<state_snapshot>
    <patient_overview>
        <!-- Patient context and the question being analyzed.
             Include demographics, chief complaints, key diagnoses if mentioned. -->
    </patient_overview>

    <key_findings>
        <!-- ALL verification results so far. Include:
             - Values verified (marker, value, status: verified/missing/wrong)
             - Timeline checks performed
             - Date range comparisons
             Example:
             - [Marker] [value]: VERIFIED in both source and JSON
             - [Marker] [value]: MISSING FROM JSON - only in source
             - Timeline: source spans [start year]-[end year], JSON only covers [subset] -->
    </key_findings>

    <documents_checked>
        <!-- Which documents/sections have been verified.
             - CHECKED: "[Document Name]" - N values verified
             - CHECKED: "[Document Name]" - N values verified
             - UNCHECKED: "[Document Name]" -->
    </documents_checked>

    <validation_state>
        <!-- Issues logged so far and checks remaining.
             - ISSUE [critical]: [description of critical issue found]
             - ISSUE [warning]: [description of warning-level issue]
             - COMPLETED: [list of completed check categories]
             - REMAINING: [list of remaining check categories] -->
    </validation_state>

    <current_investigation>
        <!-- What the validator was actively checking when compression occurred.
             - Currently verifying: [active check description]
             - Next planned: [next planned check description] -->
    </current_investigation>
</state_snapshot>`;
  }

  return `You are a conversation history compressor for a medical analysis agent.

When the conversation history grows too large, you compress it into a structured snapshot. This snapshot becomes the agent's ONLY memory of past work. All critical medical findings, data explored, and investigation state MUST be preserved.

First, review the entire conversation in a private <scratchpad>. Identify every piece of clinically significant information. Then generate the <state_snapshot>.

Be EXTREMELY dense with medical information. Include specific values, dates, units, and reference ranges. Omit only tool response formatting boilerplate.

<state_snapshot>
    <patient_overview>
        <!-- Current understanding of the patient: demographics, chief complaints, key diagnoses.
             Include the patient question/context provided at the start. -->
    </patient_overview>

    <key_findings>
        <!-- ALL clinically significant findings discovered so far. Include:
             - Specific lab values with units and reference ranges
             - Dates of findings
             - Status (elevated/low/normal/critical)
             - Cross-system connections identified
             Example:
             - [Marker]: [value] [unit] (ref [range]) - [STATUS] - [date]
             - [Marker]: [value] [unit] (ref [range]) - [STATUS] - [date]
             - Connection: [finding A] + [finding B] -> possible [clinical implication] -->
    </key_findings>

    <documents_explored>
        <!-- Which documents have been read, which remain unexplored.
             - READ: "[Document Name]" - key values: [marker] [value], [marker] [value]
             - READ: "[Document Name]" - key values: [marker] [value], [marker] [value]
             - UNREAD: "[Document Name]", "[Document Name]"
             - SEARCHED: "[query]" (N results), "[query]" (N results) -->
    </documents_explored>

    <analysis_state>
        <!-- What sections of the analysis have been written. The actual analysis content
             is stored externally (not in conversation history), so just list section names and sizes.
             - WRITTEN: [Section Name] (NKB), [Section Name] (NKB), [Section Name] (NKB)
             - IN PROGRESS: [Section Name], [Section Name]
             - NOT STARTED: [Section Name], [Section Name] -->
    </analysis_state>

    <current_investigation>
        <!-- What the agent was actively investigating when compression occurred.
             - Currently exploring: [active investigation topic]
             - Next planned: [next planned investigation topic]
             - Hypothesis: [current working hypothesis if any] -->
    </current_investigation>
</state_snapshot>`;
}

// ============================================================================
// Chat Compression Service
// ============================================================================

export class ChatCompressionService {
  private genai: GoogleGenAI;
  private compressionFailed: boolean = false;

  constructor(genai?: GoogleGenAI, billingContext?: BillingContext) {
    this.genai = genai ?? createGoogleGenAI(billingContext);
  }

  /**
   * Check if compression is needed and compress if so.
   * Safe to call every iteration — no-ops if under threshold.
   * Compression failure is non-fatal (returns original history).
   */
  async compressIfNeeded(
    history: ConversationEntry[],
    context: CompressionContext,
  ): Promise<CompressionResult> {
    const { threshold, preserveFraction, tokenLimit } = REALM_CONFIG.compression;
    const originalTokens = estimateTokenCount(history);

    // No-op: under threshold
    if (originalTokens < tokenLimit * threshold) {
      return {
        compressed: false,
        newHistory: history,
        originalTokenEstimate: originalTokens,
        newTokenEstimate: originalTokens,
      };
    }

    // No-op: previous compression attempt failed (prevent retry loops, vendor pattern)
    if (this.compressionFailed) {
      return {
        compressed: false,
        newHistory: history,
        originalTokenEstimate: originalTokens,
        newTokenEstimate: originalTokens,
      };
    }

    console.log(
      `[ChatCompression] Triggered for ${context.phase}: ~${originalTokens} tokens > ${Math.round(tokenLimit * threshold)} threshold (${history.length} entries)`
    );

    // Find split point: compress oldest portion, keep newest
    const compressFraction = 1 - preserveFraction;
    const splitPoint = findSplitPoint(history, compressFraction);

    if (splitPoint === 0) {
      console.log('[ChatCompression] No safe split point found, skipping');
      return {
        compressed: false,
        newHistory: history,
        originalTokenEstimate: originalTokens,
        newTokenEstimate: originalTokens,
      };
    }

    const toCompress = history.slice(0, splitPoint);
    const toKeep = history.slice(splitPoint);

    // Build the compression request
    const externalContext = context.externalState
      ? `\n\n[EXTERNAL STATE — stored outside conversation history, preserved automatically:\n${context.externalState}]`
      : '';

    const compressionContents: ConversationEntry[] = [
      ...toCompress,
      {
        role: 'user',
        parts: [{
          text: `${externalContext}\n\nFirst, reason in your scratchpad. Then, generate the <state_snapshot>.`,
        }],
      },
    ];

    try {
      const compressionModel = REALM_CONFIG.models.markdown; // gemini-2.5-flash

      const response = await this.genai.models.generateContent({
        model: compressionModel,
        contents: compressionContents,
        config: {
          systemInstruction: getMedicalCompressionPrompt(context.phase),
        },
      });

      const summary = response.text || '';

      if (!summary || summary.length === 0) {
        console.warn('[ChatCompression] Empty compression response, skipping');
        return {
          compressed: false,
          newHistory: history,
          originalTokenEstimate: originalTokens,
          newTokenEstimate: originalTokens,
        };
      }

      // Build new history: [summary, model ack, ...kept entries]
      const newHistory: ConversationEntry[] = [
        {
          role: 'user',
          parts: [{ text: summary }],
        },
        {
          role: 'model',
          parts: [{ text: 'Understood. I have the full context of the medical analysis so far. Continuing with the available tools.' }],
        },
        ...toKeep,
      ];

      // Validate: reject if compressed version is larger (vendor line 229)
      const newTokens = estimateTokenCount(newHistory);

      if (newTokens >= originalTokens) {
        console.warn(
          `[ChatCompression] Compressed version is NOT smaller (${newTokens} >= ${originalTokens}), skipping`
        );
        this.compressionFailed = true;
        return {
          compressed: false,
          newHistory: history,
          originalTokenEstimate: originalTokens,
          newTokenEstimate: newTokens,
        };
      }

      console.log(
        `[ChatCompression] Success: ${originalTokens} -> ${newTokens} tokens ` +
        `(${toCompress.length} entries compressed, ${toKeep.length} kept)`
      );

      return {
        compressed: true,
        newHistory,
        originalTokenEstimate: originalTokens,
        newTokenEstimate: newTokens,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[ChatCompression] Compression failed, continuing with full history: ${errorMessage}`);
      this.compressionFailed = true;
      return {
        compressed: false,
        newHistory: history,
        originalTokenEstimate: originalTokens,
        newTokenEstimate: originalTokens,
      };
    }
  }
}
