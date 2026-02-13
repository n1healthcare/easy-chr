/**
 * Style Injection for Generated HTML Reports
 *
 * Reads the centralized report.css and injects it into LLM-generated HTML.
 * This ensures deterministic, consistent styling regardless of LLM output.
 *
 * Usage:
 *   import { injectStyles } from './styles/inject-styles.js';
 *   htmlContent = injectStyles(htmlContent);
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedCSS: string | null = null;

/**
 * Load report.css from disk. Cached after first read.
 */
export function loadReportCSS(): string {
  if (cachedCSS !== null) return cachedCSS;

  const cssPath = path.join(__dirname, 'report.css');
  try {
    cachedCSS = fs.readFileSync(cssPath, 'utf-8');
    console.log(`[styles] Loaded report.css (${cachedCSS.length} chars)`);
  } catch (error) {
    console.error(`[styles] Failed to load report.css from ${cssPath}:`, error);
    cachedCSS = '';
  }
  return cachedCSS;
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
export function injectStyles(html: string): string {
  const css = loadReportCSS();
  if (!css) return html;

  // Strip LLM-generated style tags
  let result = stripStyleTags(html);

  const styleBlock = `<style data-source="n1-report-styles">\n${css}\n</style>`;

  // Inject before </head> if present
  const headCloseIndex = result.indexOf('</head>');
  if (headCloseIndex !== -1) {
    result = result.slice(0, headCloseIndex) + styleBlock + '\n' + result.slice(headCloseIndex);
  } else {
    // Fallback: inject after opening <html> or at the start
    const htmlOpenIndex = result.indexOf('<html');
    if (htmlOpenIndex !== -1) {
      const afterHtmlTag = result.indexOf('>', htmlOpenIndex) + 1;
      result = result.slice(0, afterHtmlTag) + '\n' + styleBlock + '\n' + result.slice(afterHtmlTag);
    } else {
      result = styleBlock + '\n' + result;
    }
  }

  return result;
}
