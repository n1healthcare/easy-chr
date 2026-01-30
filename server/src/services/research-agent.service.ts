/**
 * Research Agent Service
 *
 * Validates medical claims with external evidence using Gemini's web search.
 * Extracts key claims from analysis and searches for supporting sources.
 */

import path from 'path';
import fs from 'fs';
import { Config } from '../../vendor/gemini-cli/packages/core/src/config/config.js';
import { webSearch, type WebSearchResult } from './web-search.service.js';
import { REALM_CONFIG } from '../config.js';
import { retryLLM, retryAPI, sleep } from '../common/index.js';

// ============================================================================
// URL Resolution (Google redirect → actual URL)
// ============================================================================

/**
 * Resolves a Google grounding redirect URL to the actual destination URL.
 * Returns the original URL if resolution fails.
 */
async function resolveRedirectUrl(url: string): Promise<string> {
  // Skip if not a Google redirect URL
  if (!url.includes('vertexaisearch.cloud.google.com/grounding-api-redirect')) {
    return url;
  }

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual' // Don't follow redirects, just get the Location header
    });

    const location = response.headers.get('location');
    if (location) {
      return location;
    }
  } catch (error) {
    console.warn(`[ResearchAgent] Failed to resolve redirect URL: ${url}`);
  }

  return url; // Fallback to original
}

/**
 * Validates that a URL is accessible (returns 2xx or 3xx status).
 */
async function validateUrl(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000) // 5 second timeout
    });
    return response.ok || (response.status >= 300 && response.status < 400);
  } catch {
    return false;
  }
}

// ============================================================================
// Types
// ============================================================================

export interface ResearchSource {
  title: string;
  uri: string;
  type: 'journal' | 'institution' | 'guideline' | 'education' | 'health-site' | 'unknown';
  snippet?: string;
}

export interface ResearchedClaim {
  id: string;
  originalClaim: string;
  searchQuery: string;
  supported: boolean;
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
  sources: ResearchSource[];
  notes?: string;
}

export interface UnsupportedClaim {
  id: string;
  originalClaim: string;
  searchQuery: string;
  reason: string;
}

export interface AdditionalFinding {
  finding: string;
  relevance: string;
  sources: ResearchSource[];
}

export interface ResearchOutput {
  researchedClaims: ResearchedClaim[];
  unsupportedClaims: UnsupportedClaim[];
  additionalFindings: AdditionalFinding[];
}

export interface ResearchEvent {
  type: 'claim_extracted' | 'searching' | 'claim_researched' | 'complete' | 'error';
  data: {
    claim?: string;
    claimIndex?: number;
    totalClaims?: number;
    result?: ResearchedClaim;
    message?: string;
  };
}

// ============================================================================
// Skill Loader
// ============================================================================

function loadSkillContent(): string {
  const skillPath = path.join(
    process.cwd(),
    '.gemini',
    'skills',
    'research-agent',
    'SKILL.md'
  );

  try {
    return fs.readFileSync(skillPath, 'utf-8');
  } catch (error) {
    console.warn('[ResearchAgent] Could not load SKILL.md');
    return '';
  }
}

function loadClaimExtractionPrompt(): string {
  const content = loadSkillContent();

  if (!content) {
    throw new Error('[ResearchAgent] Could not load SKILL.md - prompts must be defined in .gemini/skills/research-agent/SKILL.md');
  }

  // Extract the prompt between <!-- PROMPT:CLAIM_EXTRACTION --> markers
  const match = content.match(/<!-- PROMPT:CLAIM_EXTRACTION -->\n([\s\S]*?)\n<!-- \/PROMPT:CLAIM_EXTRACTION -->/);

  if (!match) {
    throw new Error('[ResearchAgent] SKILL.md is missing PROMPT:CLAIM_EXTRACTION section');
  }

  return match[1].trim();
}

// ============================================================================
// Claim Extraction (LLM-based)
// ============================================================================

interface ExtractedClaim {
  claim: string;
  searchQuery: string;
  priority: 'high' | 'medium' | 'low';
}

async function extractClaimsFromAnalysis(
  config: Config,
  analysisContent: string,
  crossSystemsContent: string,
  patientQuestion?: string
): Promise<ExtractedClaim[]> {
  const geminiClient = config.getGeminiClient();

  // Load prompt template from SKILL.md
  let promptTemplate = loadClaimExtractionPrompt();

  // Substitute template variables
  // Handle conditional patient_question block
  if (patientQuestion) {
    promptTemplate = promptTemplate
      .replace(/\{\{#if patient_question\}\}/g, '')
      .replace(/\{\{\/if\}\}/g, '')
      .replace(/\{\{patient_question\}\}/g, patientQuestion);
  } else {
    // Remove the entire conditional block if no patient question
    promptTemplate = promptTemplate.replace(/\{\{#if patient_question\}\}[\s\S]*?\{\{\/if\}\}/g, '');
  }

  // Substitute analysis and cross_systems
  const prompt = promptTemplate
    .replace(/\{\{analysis\}\}/g, analysisContent)
    .replace(/\{\{cross_systems\}\}/g, crossSystemsContent);

  const response = await retryLLM(
    () => geminiClient.generateContent(
      { model: REALM_CONFIG.models.doctor },
      [{ role: 'user', parts: [{ text: prompt }] }],
      new AbortController().signal
    ),
    { operationName: 'ResearchAgent.extractClaims' }
  );

  // Extract non-thought text parts (skip reasoning/thinking content)
  const parts = response.candidates?.[0]?.content?.parts || [];
  let text = '';

  for (const part of parts) {
    // Skip thought parts, only get actual content
    if (part.text && !part.thought) {
      text += part.text;
    }
  }

  // Fallback to first part if no non-thought parts found
  if (!text) {
    text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  if (!text.trim()) {
    console.warn('[ResearchAgent] LLM returned empty response');
    return [];
  }

  // Parse markdown format: **Claim**: ... **Search**: ...
  const claims: ExtractedClaim[] = [];

  // Match patterns like:
  // **Claim**: Some claim text
  // **Search**: search query
  const claimPattern = /\*\*Claim\*\*:\s*(.+?)(?=\n|$)/gi;
  const searchPattern = /\*\*Search\*\*:\s*(.+?)(?=\n|$)/gi;

  const claimMatches = [...text.matchAll(claimPattern)];
  const searchMatches = [...text.matchAll(searchPattern)];

  // Pair up claims with their search queries
  const numPairs = Math.min(claimMatches.length, searchMatches.length);

  for (let i = 0; i < numPairs; i++) {
    const claim = claimMatches[i][1].trim();
    const searchQuery = searchMatches[i][1].trim();

    if (claim && searchQuery) {
      claims.push({
        claim,
        searchQuery,
        priority: i < 3 ? 'high' : 'medium' // First 3 are high priority
      });
    }
  }

  if (claims.length === 0) {
    // Log more to see where claims might be
    console.warn('[ResearchAgent] No claims found. Full response length:', text.length);
    console.warn('[ResearchAgent] Looking for **Claim**: pattern...');
    console.warn('[ResearchAgent] Contains "**Claim**"?', text.includes('**Claim**'));
    console.warn('[ResearchAgent] Contains "Claim:"?', text.includes('Claim:'));
    console.warn('[ResearchAgent] Last 500 chars:', text.substring(text.length - 500));
    return [];
  }

  console.log(`[ResearchAgent] Extracted ${claims.length} claims from markdown`);
  return claims;
}

// ============================================================================
// Source Classification
// ============================================================================

function classifySource(uri: string, title: string): ResearchSource['type'] {
  const lowerUri = uri.toLowerCase();
  const lowerTitle = title.toLowerCase();

  // Journals
  if (
    lowerUri.includes('pubmed') ||
    lowerUri.includes('ncbi.nlm.nih') ||
    lowerUri.includes('nejm.org') ||
    lowerUri.includes('lancet.com') ||
    lowerUri.includes('jamanetwork') ||
    lowerUri.includes('nature.com') ||
    lowerUri.includes('sciencedirect') ||
    lowerUri.includes('springer') ||
    lowerUri.includes('wiley.com') ||
    lowerTitle.includes('journal')
  ) {
    return 'journal';
  }

  // Medical institutions
  if (
    lowerUri.includes('mayoclinic') ||
    lowerUri.includes('clevelandclinic') ||
    lowerUri.includes('hopkinsmedicine') ||
    lowerUri.includes('cedars-sinai') ||
    lowerUri.includes('mountsinai')
  ) {
    return 'institution';
  }

  // Guidelines
  if (
    lowerUri.includes('who.int') ||
    lowerUri.includes('cdc.gov') ||
    lowerUri.includes('nih.gov') ||
    lowerUri.includes('fda.gov') ||
    lowerUri.includes('heart.org') ||
    lowerUri.includes('diabetes.org') ||
    lowerTitle.includes('guideline')
  ) {
    return 'guideline';
  }

  // Medical education
  if (
    lowerUri.includes('uptodate') ||
    lowerUri.includes('medscape') ||
    lowerUri.includes('emedicine') ||
    lowerUri.includes('merckmanuals')
  ) {
    return 'education';
  }

  // Health sites
  if (
    lowerUri.includes('webmd') ||
    lowerUri.includes('healthline') ||
    lowerUri.includes('verywellhealth') ||
    lowerUri.includes('medicalnewstoday')
  ) {
    return 'health-site';
  }

  return 'unknown';
}

// ============================================================================
// Main Research Function
// ============================================================================

export async function* researchClaims(
  config: Config,
  analysisContent: string,
  crossSystemsContent: string,
  patientQuestion?: string
): AsyncGenerator<ResearchEvent, ResearchOutput, unknown> {
  const researchedClaims: ResearchedClaim[] = [];
  const unsupportedClaims: UnsupportedClaim[] = [];
  const additionalFindings: AdditionalFinding[] = [];

  // Step 1: Extract claims using LLM
  yield {
    type: 'claim_extracted',
    data: { message: 'Extracting key claims from analysis...' }
  };

  const claims = await extractClaimsFromAnalysis(
    config,
    analysisContent,
    crossSystemsContent,
    patientQuestion
  );

  if (claims.length === 0) {
    yield {
      type: 'error',
      data: { message: 'No claims extracted for research' }
    };
    return { researchedClaims, unsupportedClaims, additionalFindings };
  }

  yield {
    type: 'claim_extracted',
    data: {
      message: `Extracted ${claims.length} claims to research`,
      totalClaims: claims.length
    }
  };

  // Step 2: Research each claim with web search
  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];

    yield {
      type: 'searching',
      data: {
        claim: claim.claim,
        claimIndex: i + 1,
        totalClaims: claims.length,
        message: `Researching: ${claim.searchQuery}`
      }
    };

    try {
      const searchResult = await retryAPI(
        () => webSearch(config, claim.searchQuery),
        { operationName: `ResearchAgent.webSearch.claim${i + 1}` }
      );

      if (searchResult.text && searchResult.sources.length > 0) {
        // Resolve redirect URLs and validate sources in parallel
        const resolvedSources = await Promise.all(
          searchResult.sources.map(async (s) => {
            const realUri = await resolveRedirectUrl(s.uri);
            const isValid = await validateUrl(realUri);
            return {
              title: s.title,
              uri: realUri,
              type: classifySource(realUri, s.title),
              isValid
            };
          })
        );

        // Filter to only valid sources with real URLs
        const validSources: ResearchSource[] = resolvedSources
          .filter(s => s.isValid)
          .map(({ title, uri, type }) => ({ title, uri, type }));

        // Only count as supported if we have at least one valid source
        if (validSources.length === 0) {
          unsupportedClaims.push({
            id: `claim-${i + 1}`,
            originalClaim: claim.claim,
            searchQuery: claim.searchQuery,
            reason: 'No valid sources found (URLs could not be verified)'
          });

          yield {
            type: 'claim_researched',
            data: {
              claim: claim.claim,
              claimIndex: i + 1,
              totalClaims: claims.length,
              message: 'No valid sources found'
            }
          };
          continue;
        }

        const researchedClaim: ResearchedClaim = {
          id: `claim-${i + 1}`,
          originalClaim: claim.claim,
          searchQuery: claim.searchQuery,
          supported: true,
          confidence: validSources.length >= 2 ? 'high' : 'medium',
          evidence: searchResult.text,
          sources: validSources
        };

        researchedClaims.push(researchedClaim);

        yield {
          type: 'claim_researched',
          data: {
            claim: claim.claim,
            claimIndex: i + 1,
            totalClaims: claims.length,
            result: researchedClaim,
            message: `Found ${validSources.length} verified source(s)`
          }
        };
      } else {
        unsupportedClaims.push({
          id: `claim-${i + 1}`,
          originalClaim: claim.claim,
          searchQuery: claim.searchQuery,
          reason: 'No supporting sources found'
        });

        yield {
          type: 'claim_researched',
          data: {
            claim: claim.claim,
            claimIndex: i + 1,
            totalClaims: claims.length,
            message: 'No supporting sources found'
          }
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[ResearchAgent] Search failed for claim ${i + 1}:`, errorMessage);

      unsupportedClaims.push({
        id: `claim-${i + 1}`,
        originalClaim: claim.claim,
        searchQuery: claim.searchQuery,
        reason: `Search error: ${errorMessage}`
      });

      yield {
        type: 'error',
        data: {
          claim: claim.claim,
          message: `Search failed: ${errorMessage}`
        }
      };
    }

    // Add delay between claims to avoid overwhelming the API
    const throttle = REALM_CONFIG.throttle.webSearch;
    if (i < claims.length - 1 && throttle.delayBetweenRequestsMs > 0) {
      await sleep(throttle.delayBetweenRequestsMs);
    }
  }

  yield {
    type: 'complete',
    data: {
      message: `Research complete: ${researchedClaims.length} claims verified, ${unsupportedClaims.length} unsupported`
    }
  };

  return { researchedClaims, unsupportedClaims, additionalFindings };
}

// ============================================================================
// Format Research Output as Markdown
// ============================================================================

export function formatResearchAsMarkdown(research: ResearchOutput): string {
  let markdown = '# Research Findings\n\n';

  if (research.researchedClaims.length > 0) {
    markdown += '## Verified Claims\n\n';
    for (const claim of research.researchedClaims) {
      markdown += `### ${claim.id}: ${claim.originalClaim}\n\n`;
      markdown += `**Confidence:** ${claim.confidence}\n\n`;
      markdown += `**Evidence:** ${claim.evidence}\n\n`;
      markdown += '**Sources:**\n';
      for (const source of claim.sources) {
        markdown += `- [${source.title}](${source.uri}) (${source.type})\n`;
      }
      markdown += '\n';
    }
  }

  if (research.unsupportedClaims.length > 0) {
    markdown += '## Unsupported Claims\n\n';
    for (const claim of research.unsupportedClaims) {
      markdown += `- **${claim.originalClaim}**: ${claim.reason}\n`;
    }
    markdown += '\n';
  }

  return markdown;
}
