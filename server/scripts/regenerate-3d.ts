/**
 * Regenerate 3D Body Twin viewer only
 *
 * Usage: npx tsx scripts/regenerate-3d.ts [realmId]
 *
 * Re-injects the body-twin-viewer.html template into an existing realm HTML.
 * No LLM calls — reads organ_insights.md, transforms to JSON, and injects.
 *
 * If no realmId is provided, uses the most recently modified realm.
 */

import fs from 'fs';
import path from 'path';
import { transformOrganInsightsToBodyTwin } from '../src/services/body-twin-transformer.service.js';
import { injectBodyTwinViewer } from '../src/utils/inject-body-twin.js';
import { OrganModel } from '../src/common/storage-paths.js';

function regenerate3d(realmId?: string) {
  const storageDir = path.join(process.cwd(), 'storage');
  const realmsDir = path.join(storageDir, 'realms');

  // Find realm
  if (!realmId) {
    // Use the most recently modified realm
    const realmDirs = fs.readdirSync(realmsDir).filter((d) => {
      const stat = fs.statSync(path.join(realmsDir, d));
      return stat.isDirectory();
    });

    if (realmDirs.length === 0) {
      throw new Error('No realms found in storage/realms/. Run the full pipeline first.');
    }

    // Sort by modification time, most recent first
    realmDirs.sort((a, b) => {
      const aStat = fs.statSync(path.join(realmsDir, a));
      const bStat = fs.statSync(path.join(realmsDir, b));
      return bStat.mtimeMs - aStat.mtimeMs;
    });

    realmId = realmDirs[0];
    console.log(`Using most recent realm: ${realmId}`);
  }

  const htmlPath = path.join(realmsDir, realmId, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`Realm HTML not found: ${htmlPath}`);
  }

  // Read organ insights
  const organInsightsPath = path.join(storageDir, 'organ_insights.md');
  if (!fs.existsSync(organInsightsPath)) {
    throw new Error('organ_insights.md not found in storage/. Run the full pipeline first.');
  }
  const organInsightsContent = fs.readFileSync(organInsightsPath, 'utf-8');
  console.log(`Loaded organ_insights.md: ${organInsightsContent.length} chars`);

  // Transform to BodyTwinData
  const bodyTwinData = transformOrganInsightsToBodyTwin(organInsightsContent);
  console.log(`Transformed: ${bodyTwinData.organs.length} organs, ${bodyTwinData.systems.length} systems, ${bodyTwinData.connections.length} connections`);

  // Persist body-twin.json
  fs.writeFileSync(path.join(storageDir, 'body-twin.json'), JSON.stringify(bodyTwinData, null, 2), 'utf-8');

  // Read existing HTML
  let htmlContent = fs.readFileSync(htmlPath, 'utf-8');

  // Strip existing 3D viewer injection (everything from the viewer comment to end of its script)
  const viewerStart = htmlContent.indexOf('<!-- 3D Body Twin Viewer');
  if (viewerStart !== -1) {
    // Find the </body> that comes after the viewer injection
    const bodyClose = htmlContent.indexOf('</body>', viewerStart);
    if (bodyClose !== -1) {
      htmlContent = htmlContent.slice(0, viewerStart) + htmlContent.slice(bodyClose);
      console.log('Stripped existing 3D viewer injection');
    }
  }

  // Also strip the head blocker if present
  htmlContent = htmlContent.replace(/<style id="bt-head-blocker">.*?<\/style>\n?/s, '');

  // Re-inject fresh viewer
  htmlContent = injectBodyTwinViewer(htmlContent, bodyTwinData);
  fs.writeFileSync(htmlPath, htmlContent, 'utf-8');

  // Copy 3D organ model to realm directory (viewer loads it via relative path)
  const glbSource = OrganModel.localSourcePath();
  const glbDest = path.join(realmsDir, realmId, OrganModel.FILENAME);
  if (fs.existsSync(glbSource)) {
    fs.copyFileSync(glbSource, glbDest);
    console.log(`Copied GLB model to realm directory (${(fs.statSync(glbDest).size / 1024 / 1024).toFixed(1)}MB)`);
  } else {
    console.warn(`Warning: GLB model not found at ${glbSource}`);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('Done! 3D Body Twin viewer re-injected.');
  console.log(`${'='.repeat(60)}`);
  console.log(`📁 HTML: ${htmlPath}`);
  console.log(`🌐 View: http://localhost:3000/realms/${realmId}/index.html`);
}

// Run
const realmId = process.argv[2] || undefined;
regenerate3d(realmId);
