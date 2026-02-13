/**
 * Injects the 3D Body Twin viewer into generated HTML realms.
 *
 * Reads the body-twin-viewer.html template, inlines the body-twin data,
 * and appends it before </body> in the generated HTML.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { OrganModel } from '../common/storage-paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Inject the 3D body twin viewer into an HTML string.
 *
 * @param htmlContent - The full HTML string (the generated realm)
 * @param bodyTwinData - The BodyTwinData object to inline as JSON
 * @returns The HTML string with the viewer injected before </body>
 */
export function injectBodyTwinViewer(htmlContent: string, bodyTwinData: object): string {
  const templatePath = path.join(__dirname, '..', 'templates', 'body-twin-viewer.html');

  let template: string;
  try {
    template = fs.readFileSync(templatePath, 'utf-8');
  } catch {
    console.warn('[injectBodyTwinViewer] Template not found at', templatePath);
    return htmlContent;
  }

  const viewer = template
    .replace('"__BODY_TWIN_DATA__"', JSON.stringify(bodyTwinData))
    .replace(OrganModel.URL_PLACEHOLDER, OrganModel.FILENAME);

  // Hide report content until the landing page is dismissed.
  // Injected into <head> so it applies before any body content paints.
  const headBlocker = `<style id="bt-head-blocker">body>*:not(#bt-landing){visibility:hidden!important}#bt-landing{visibility:visible!important}</style>`;

  let result = htmlContent;

  // Inject blocker into <head>
  const headCloseIndex = result.indexOf('</head>');
  if (headCloseIndex !== -1) {
    result = result.slice(0, headCloseIndex) + headBlocker + '\n' + result.slice(headCloseIndex);
  }

  // Inject viewer before </body>
  const bodyCloseIndex = result.lastIndexOf('</body>');
  if (bodyCloseIndex === -1) {
    return result + '\n' + viewer;
  }

  return (
    result.slice(0, bodyCloseIndex) +
    '\n' + viewer + '\n' +
    result.slice(bodyCloseIndex)
  );
}
