/**
 * Style Injection for Generated HTML Reports
 *
 * Reads the centralized report.css and injects it into LLM-generated HTML.
 * This ensures deterministic, consistent styling regardless of LLM output.
 *
 * Usage:
 *   import { injectStyles } from './styles/inject-styles.js';
 *   htmlContent = await injectStyles(htmlContent);
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedCSS: string | null = null;

/**
 * Load report.css from disk. Cached after first read.
 */
export async function loadReportCSS(): Promise<string> {
  if (cachedCSS !== null) return cachedCSS;

  const cssPath = path.join(__dirname, 'report.css');
  try {
    const css = await fs.readFile(cssPath, 'utf-8');
    console.log(`[styles] Loaded report.css (${css.length} chars)`);
    cachedCSS = css;
    return css;
  } catch (error) {
    console.error(`[styles] Failed to load report.css from ${cssPath}:`, error);
    throw error;
  }
}

/**
 * Strip all <style>...</style> blocks from HTML.
 * Removes LLM-generated CSS to avoid conflicts with our injected styles.
 */
function stripStyleTags(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, '');
}

/**
 * Inject the centralized CSS into an HTML document.
 *
 * 1. Strips any <style> tags the LLM generated (prevents duplication)
 * 2. Injects our report.css as a <style> block before </head>
 *
 * If no </head> tag is found, prepends the style block to the HTML.
 */
export async function injectStyles(html: string): Promise<string> {
  const css = await loadReportCSS();
  if (!css) return html;

  // Strip LLM-generated style tags
  let result = stripStyleTags(html);

  const styleBlock = `<style data-source="n1-report-styles">\n${css}\n</style>`;

  // Inject before </head> if present (case-insensitive)
  const headCloseRegex = /<\/head>/i;
  if (headCloseRegex.test(result)) {
    result = result.replace(headCloseRegex, `${styleBlock}\n</head>`);
  } else {
    // Fallback: wrap in <head> and inject before <body> for valid HTML
    const headBlock = `<head>\n${styleBlock}\n</head>`;
    const bodyTagRegex = /<body/i;
    if (bodyTagRegex.test(result)) {
      result = result.replace(bodyTagRegex, `${headBlock}\n<body`);
    } else {
      result = headBlock + '\n' + result;
    }
  }

  return result;
}
