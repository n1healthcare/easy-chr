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
             - Homocysteine 20.08: VERIFIED in both source and JSON
             - TSH 2.3: MISSING FROM JSON - only in source
             - Timeline: source spans 2007-2025, JSON only covers 2024-2025 -->
    </key_findings>

    <documents_checked>
        <!-- Which documents/sections have been verified.
             - CHECKED: "CBC Report 2024" - 5 values verified
             - CHECKED: "Metabolic Panel" - 3 values verified
             - UNCHECKED: "Thyroid Panel 2008" -->
    </documents_checked>

    <validation_state>
        <!-- Issues logged so far and checks remaining.
             - ISSUE [critical]: Missing 12 years of timeline data (2007-2023)
             - ISSUE [warning]: Ceruloplasmin labeled "Low" but value is borderline
             - COMPLETED: Timeline check, critical findings check
             - REMAINING: Value verification, consistency check -->
    </validation_state>

    <current_investigation>
        <!-- What the validator was actively checking when compression occurred.
             - Currently verifying: trends array completeness
             - Next planned: Check supplement recommendations against evidence -->
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
             - Homocysteine: 20.08 umol/L (ref <15) - ELEVATED - 2025-07-15
             - TSH: 2.3 mIU/L (ref 0.4-4.0) - normal - 2024-05-10
             - Connection: Elevated Oxalic + Glyceric acids -> possible Type II Hyperoxaluria -->
    </key_findings>

    <documents_explored>
        <!-- Which documents have been read, which remain unexplored.
             - READ: "CBC Report 2024" - key values: WBC 5.2, RBC 4.1, Hgb 12.3
             - READ: "Metabolic Panel" - key values: Glucose 105, BUN 18
             - UNREAD: "Thyroid Panel 2008", "Bartonella Test"
             - SEARCHED: "TSH" (3 results), "neutrophils" (5 results) -->
    </documents_explored>

    <analysis_state>
        <!-- What sections of the analysis have been written. The actual analysis content
             is stored externally (not in conversation history), so just list section names and sizes.
             - WRITTEN: Executive Summary (2KB), Critical Findings (4KB), Metabolic Analysis (3KB)
             - IN PROGRESS: Timeline, Cross-System Connections
             - NOT STARTED: Recommendations, Supplement Review -->
    </analysis_state>

    <current_investigation>
        <!-- What the agent was actively investigating when compression occurred.
             - Currently exploring: Vitamin D pathway interactions
             - Next planned: Check copper/zinc ratio across years
             - Hypothesis: Low ceruloplasmin may explain neurological symptoms -->
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
