/**
 * Extract relevant snippets from raw source documents based on validation issues.
 *
 * Instead of including the full extracted content (can be 1.6MB) in the correction
 * prompt, this searches for the specific markers/values mentioned in the validator's
 * critical issues and returns only the surrounding context.
 */

const STOP_WORDS = new Set([
  'the', 'and', 'but', 'for', 'are', 'was', 'were', 'has', 'have', 'had',
  'not', 'from', 'with', 'this', 'that', 'should', 'found', 'shows', 'show',
  'value', 'values', 'missing', 'incorrect', 'wrong', 'zero', 'null', 'than',
  'more', 'less', 'between', 'into', 'does', 'been', 'being', 'which', 'their',
  'there', 'they', 'will', 'would', 'could', 'about', 'also', 'only', 'other',
  'some', 'such', 'over', 'under', 'after', 'before', 'when', 'where', 'while',
  'each', 'every', 'both', 'same', 'different', 'data', 'issue', 'check',
  'source', 'json', 'structured', 'document', 'report', 'currently', 'actual',
  'expected', 'instead', 'however', 'verified', 'present', 'absent',
]);

/**
 * Extract search terms from issue descriptions.
 * Focuses on medical markers, values, and dates that would appear in source docs.
 */
function extractSearchTerms(issues: Array<{ description: string }>): string[] {
  const terms = new Set<string>();

  for (const issue of issues) {
    const desc = issue.description;

    // Extract quoted strings (e.g., "Vitamin B6", "CBC Report")
    const quoted = desc.match(/"([^"]+)"|'([^']+)'/g);
    if (quoted) {
      for (const q of quoted) {
        terms.add(q.replace(/['"]/g, ''));
      }
    }

    // Extract numbers with units (e.g., "20.08 umol/L", "160 nmol/L")
    const numbersWithUnits = desc.match(/\d+\.?\d*\s*(?:umol|nmol|mg|mIU|ng|pg|mcg|IU|mmol|g\/dL|%|U\/L|mL|mm|µ?mol|ug|kU|mEq|fL|K\/uL|M\/uL)(?:\/[a-zA-Z]+)?/gi);
    if (numbersWithUnits) {
      for (const n of numbersWithUnits) {
        terms.add(n.trim());
      }
    }

    // Extract multi-word medical terms (capitalized sequences like "Vitamin B6", "Rheumatoid Factor")
    const medicalTerms = desc.match(/[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)+(?:\s+[A-Z0-9]+)?/g);
    if (medicalTerms) {
      for (const t of medicalTerms) {
        terms.add(t.trim());
      }
    }

    // Extract individual significant words (>3 chars, not stop words, likely medical)
    const words = desc.split(/[\s,.:;()\[\]{}]+/);
    for (const word of words) {
      const cleaned = word.replace(/^['"]+|['"]+$/g, '');
      if (
        cleaned.length > 3 &&
        !STOP_WORDS.has(cleaned.toLowerCase()) &&
        !/^\d+$/.test(cleaned) // skip bare numbers
      ) {
        terms.add(cleaned);
      }
    }
  }

  return [...terms];
}

export interface ExcerptOptions {
  /** Lines of context before and after each match (default: 10) */
  contextLines?: number;
  /** Maximum total output size in bytes (default: 100KB) */
  maxBytes?: number;
}

/**
 * Search extracted content for snippets relevant to the given validation issues.
 * Returns a formatted string of excerpts with section context, capped at maxBytes.
 */
/**
 * Extract sections from extracted content that are dense with lab data
 * (pipe-delimited tables with markers, values, units, reference ranges).
 *
 * This gives the structurer access to raw lab values for cross-referencing
 * against the analyst's interpretation, without the full 1.6MB payload.
 */
export function extractLabSections(
  extractedContent: string,
  maxBytes: number = 50_000
): string {
  const lines = extractedContent.split('\n');

  // Parse into sections (## [SectionName] markers)
  const sections: Array<{ name: string; content: string; labDensity: number }> = [];
  let currentName = '';
  let currentLines: string[] = [];

  for (const line of lines) {
    const sectionMatch = line.match(/^## \[([^\]]+)\]/);
    if (sectionMatch) {
      if (currentName && currentLines.length > 0) {
        const content = currentLines.join('\n');
        // Count pipe-delimited lines (lab data rows typically have 3+ pipes)
        const labLines = currentLines.filter(l => (l.match(/\|/g) || []).length >= 3).length;
        sections.push({ name: currentName, content, labDensity: labLines });
      }
      currentName = sectionMatch[1];
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  // Don't forget the last section
  if (currentName && currentLines.length > 0) {
    const content = currentLines.join('\n');
    const labLines = currentLines.filter(l => (l.match(/\|/g) || []).length >= 3).length;
    sections.push({ name: currentName, content, labDensity: labLines });
  }

  // Sort by lab density (most lab-data-rich first)
  const labSections = sections
    .filter(s => s.labDensity > 0)
    .sort((a, b) => b.labDensity - a.labDensity);

  if (labSections.length === 0) {
    return '(No lab data tables found in source documents)';
  }

  // Build output respecting maxBytes
  const output: string[] = [];
  output.push('[Source lab data for cross-referencing values, units, and reference ranges]');
  output.push('');
  let totalBytes = 0;

  for (const section of labSections) {
    const chunk = `--- ${section.name} (${section.labDensity} lab rows) ---\n${section.content}\n`;
    if (totalBytes + chunk.length > maxBytes) {
      output.push(`\n... [TRUNCATED — ${labSections.length - output.length + 1} more section(s) omitted to stay under ${Math.round(maxBytes / 1024)}KB]`);
      break;
    }
    output.push(chunk);
    totalBytes += chunk.length;
  }

  return output.join('\n');
}

export function extractSourceExcerpts(
  extractedContent: string,
  issues: Array<{ description: string }>,
  options?: ExcerptOptions,
): string {
  const contextLines = options?.contextLines ?? 10;
  const maxBytes = options?.maxBytes ?? 100_000; // 100KB default

  const searchTerms = extractSearchTerms(issues);

  if (searchTerms.length === 0) {
    return '(No search terms could be extracted from the validation issues)';
  }

  const lines = extractedContent.split('\n');
  const matchedLineIndices = new Set<number>();

  // Search for each term, mark matching lines + context
  for (const term of searchTerms) {
    const termLower = term.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(termLower)) {
        for (let j = Math.max(0, i - contextLines); j <= Math.min(lines.length - 1, i + contextLines); j++) {
          matchedLineIndices.add(j);
        }
      }
    }
  }

  if (matchedLineIndices.size === 0) {
    return `(No matches found in source documents for terms: ${searchTerms.slice(0, 10).join(', ')})`;
  }

  // Sort indices and group into contiguous ranges
  const sorted = [...matchedLineIndices].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  let rangeStart = sorted[0];
  let rangeEnd = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] <= rangeEnd + 1) {
      rangeEnd = sorted[i];
    } else {
      ranges.push([rangeStart, rangeEnd]);
      rangeStart = sorted[i];
      rangeEnd = sorted[i];
    }
  }
  ranges.push([rangeStart, rangeEnd]);

  // Build output from ranges, respecting maxBytes
  const excerpts: string[] = [];
  excerpts.push(`[Source excerpts for: ${searchTerms.slice(0, 15).join(', ')}]`);
  excerpts.push('');

  let totalBytes = 0;

  for (const [start, end] of ranges) {
    const chunk = lines.slice(start, end + 1).join('\n');

    if (totalBytes + chunk.length > maxBytes) {
      excerpts.push(`\n... [TRUNCATED — ${ranges.length - excerpts.length + 1} more excerpt(s) omitted to stay under ${Math.round(maxBytes / 1024)}KB]`);
      break;
    }

    excerpts.push(`--- (lines ${start + 1}-${end + 1}) ---`);
    excerpts.push(chunk);
    excerpts.push('');
    totalBytes += chunk.length;
  }

  return excerpts.join('\n');
}
