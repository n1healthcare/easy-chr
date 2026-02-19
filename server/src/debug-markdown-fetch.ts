/**
 * Diagnostic script to trace markdown fetching failures.
 *
 * Usage:
 *   cd server
 *   USER_ID=ad405f4e-8089-4e23-8b9c-03c8f2648d16 npx tsx src/debug-markdown-fetch.ts
 */

import dotenv from 'dotenv';
dotenv.config();

const BASE_URL = (process.env.N1_API_BASE_URL || '').replace(/\/+$/, '');
const API_KEY = process.env.N1_API_KEY || '';
const USER_ID = process.env.USER_ID || '';

if (!BASE_URL || !API_KEY || !USER_ID) {
  console.error('Missing required env vars: N1_API_BASE_URL, N1_API_KEY, USER_ID');
  process.exit(1);
}

console.log(`\n=== Markdown Fetch Diagnostic ===`);
console.log(`API Base URL: ${BASE_URL}`);
console.log(`User ID:      ${USER_ID}`);
console.log(`API Key:      ${API_KEY.substring(0, 8)}...`);
console.log();

interface Record {
  id: string;
  file_name: string;
  status: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

interface PaginatedResponse {
  status: string;
  user_id: string;
  data: Record[];
  total_count: number;
  total_pages: number;
  page: number;
  page_size: number;
  all_reviewed: boolean;
  unreviewed_count: number;
}

async function run() {
  // Step 1: Fetch paginated records
  console.log(`--- Step 1: Fetch /records/paginated ---`);
  const paginatedUrl = `${BASE_URL}/records/paginated?user_id=${USER_ID}&page=1&page_size=100`;
  console.log(`GET ${paginatedUrl}`);

  const paginatedRes = await fetch(paginatedUrl, {
    headers: { 'N1-Api-Key': API_KEY },
  });

  if (!paginatedRes.ok) {
    console.error(`FAILED: ${paginatedRes.status} ${paginatedRes.statusText}`);
    console.error(await paginatedRes.text());
    return;
  }

  const paginatedData: PaginatedResponse = await paginatedRes.json();
  console.log(`Response status: ${paginatedData.status}`);
  console.log(`Total count:     ${paginatedData.total_count}`);
  console.log(`Total pages:     ${paginatedData.total_pages}`);
  console.log(`Records on page: ${paginatedData.data.length}`);
  console.log(`All reviewed:    ${paginatedData.all_reviewed}`);
  console.log(`Unreviewed:      ${paginatedData.unreviewed_count}`);
  console.log();

  // Step 2: Inspect each record
  console.log(`--- Step 2: Record details ---`);
  const allRecords = paginatedData.data;
  const statusCounts: { [key: string]: number } = {};

  for (const record of allRecords) {
    statusCounts[record.status] = (statusCounts[record.status] || 0) + 1;
  }

  console.log(`Status breakdown:`);
  for (const [status, count] of Object.entries(statusCounts)) {
    console.log(`  ${status}: ${count}`);
  }
  console.log();

  const completedRecords = allRecords.filter(r => r.status.toUpperCase() === 'COMPLETED');
  console.log(`Completed records: ${completedRecords.length} / ${allRecords.length}`);
  console.log();

  // Step 3: Try fetching markdown for each completed record
  console.log(`--- Step 3: Fetch markdown for each completed record ---`);
  let successCount = 0;
  let failCount = 0;

  for (const record of completedRecords) {
    const markdownEndpoint = `${BASE_URL}/records/${record.id}/markdown?user_id=${USER_ID}`;

    try {
      const mdRes = await fetch(markdownEndpoint, {
        headers: { 'N1-Api-Key': API_KEY },
      });

      if (!mdRes.ok) {
        const errText = await mdRes.text();
        console.log(`  FAIL [${mdRes.status}] ${record.file_name} (${record.id})`);
        console.log(`    Error: ${errText.substring(0, 200)}`);
        failCount++;
        continue;
      }

      const mdData: any = await mdRes.json();

      if (!mdData.markdown_url) {
        console.log(`  FAIL [no markdown_url] ${record.file_name} (${record.id})`);
        console.log(`    Response keys: ${Object.keys(mdData).join(', ')}`);
        failCount++;
        continue;
      }

      // Step 4: Try downloading the actual markdown content
      const contentRes = await fetch(mdData.markdown_url);

      if (!contentRes.ok) {
        console.log(`  FAIL [download ${contentRes.status}] ${record.file_name} (${record.id})`);
        failCount++;
        continue;
      }

      const content = await contentRes.text();
      const sizeKb = (content.length / 1024).toFixed(1);

      if (!content || content.trim().length === 0) {
        console.log(`  FAIL [empty content] ${record.file_name} (${record.id})`);
        failCount++;
        continue;
      }

      console.log(`  OK   [${sizeKb} KB] ${record.file_name} (${record.id})`);
      successCount++;

    } catch (error) {
      console.log(`  FAIL [exception] ${record.file_name} (${record.id})`);
      console.log(`    ${error instanceof Error ? error.message : String(error)}`);
      failCount++;
    }
  }

  // Summary
  console.log();
  console.log(`=== Summary ===`);
  console.log(`Total records from API:   ${allRecords.length}`);
  console.log(`Completed records:        ${completedRecords.length}`);
  console.log(`Markdown fetch success:   ${successCount}`);
  console.log(`Markdown fetch failed:    ${failCount}`);

  if (paginatedData.total_pages > 1) {
    console.log(`\nWARNING: There are ${paginatedData.total_pages} pages but only page 1 was checked.`);
    console.log(`Total records across all pages: ${paginatedData.total_count}`);
  }

  if (failCount > 0) {
    console.log(`\nDiagnosis: ${failCount} record(s) failed markdown fetch.`);
    console.log(`These would fall back to PDF+OCR in the normal pipeline.`);
  }

  if (completedRecords.length === 0 && allRecords.length > 0) {
    console.log(`\nDiagnosis: No records have status 'COMPLETED'.`);
    console.log(`The pipeline skips non-completed records.`);
  }
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
