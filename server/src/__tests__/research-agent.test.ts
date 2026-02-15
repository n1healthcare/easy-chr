/**
 * Tests for services/research-agent.service.ts
 *
 * Tests pure functions: classifySource and formatResearchAsMarkdown.
 * The main researchClaims generator requires a live Gemini Config.
 */

import { describe, it, expect } from 'vitest';
import {
  formatResearchAsMarkdown,
  type ResearchOutput,
  type ResearchedClaim,
  type UnsupportedClaim,
} from '../services/research-agent.service.js';

// classifySource is not exported, so we test it indirectly via formatResearchAsMarkdown
// which renders source.type. We focus on formatResearchAsMarkdown here.

describe('formatResearchAsMarkdown', () => {
  it('formats verified claims with sources', () => {
    const research: ResearchOutput = {
      researchedClaims: [
        {
          id: 'claim-1',
          originalClaim: 'Vitamin D deficiency causes fatigue',
          searchQuery: 'vitamin d fatigue',
          supported: true,
          confidence: 'high',
          evidence: 'Multiple studies confirm this relationship.',
          sources: [
            { title: 'PubMed Article', uri: 'https://pubmed.ncbi.nlm.nih.gov/123', type: 'journal' },
            { title: 'Mayo Clinic', uri: 'https://mayoclinic.org/vitd', type: 'institution' },
          ],
        },
      ],
      unsupportedClaims: [],
      additionalFindings: [],
    };

    const md = formatResearchAsMarkdown(research);
    expect(md).toContain('# Research Findings');
    expect(md).toContain('## Verified Claims');
    expect(md).toContain('claim-1: Vitamin D deficiency causes fatigue');
    expect(md).toContain('**Confidence:** high');
    expect(md).toContain('**Evidence:**');
    expect(md).toContain('[PubMed Article](https://pubmed.ncbi.nlm.nih.gov/123) (journal)');
    expect(md).toContain('[Mayo Clinic](https://mayoclinic.org/vitd) (institution)');
  });

  it('formats unsupported claims', () => {
    const research: ResearchOutput = {
      researchedClaims: [],
      unsupportedClaims: [
        {
          id: 'claim-2',
          originalClaim: 'Coffee cures cancer',
          searchQuery: 'coffee cancer cure',
          reason: 'No supporting sources found',
        },
      ],
      additionalFindings: [],
    };

    const md = formatResearchAsMarkdown(research);
    expect(md).toContain('## Unsupported Claims');
    expect(md).toContain('**Coffee cures cancer**: No supporting sources found');
    expect(md).not.toContain('Verified Claims');
  });

  it('formats both verified and unsupported claims', () => {
    const research: ResearchOutput = {
      researchedClaims: [
        {
          id: 'claim-1',
          originalClaim: 'Claim A',
          searchQuery: 'q',
          supported: true,
          confidence: 'medium',
          evidence: 'Some evidence.',
          sources: [{ title: 'Src', uri: 'https://src.com', type: 'unknown' }],
        },
      ],
      unsupportedClaims: [
        {
          id: 'claim-2',
          originalClaim: 'Claim B',
          searchQuery: 'q',
          reason: 'Not found',
        },
      ],
      additionalFindings: [],
    };

    const md = formatResearchAsMarkdown(research);
    expect(md).toContain('## Verified Claims');
    expect(md).toContain('## Unsupported Claims');
  });

  it('handles empty research output', () => {
    const research: ResearchOutput = {
      researchedClaims: [],
      unsupportedClaims: [],
      additionalFindings: [],
    };

    const md = formatResearchAsMarkdown(research);
    expect(md).toContain('# Research Findings');
    expect(md).not.toContain('## Verified');
    expect(md).not.toContain('## Unsupported');
  });
});
