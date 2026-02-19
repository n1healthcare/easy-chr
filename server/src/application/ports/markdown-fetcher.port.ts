/**
 * Port interface for fetching pre-extracted markdown from the N1 API backend.
 * Parser-router uploads MinerU-extracted markdown per record; this port
 * retrieves that markdown so we can skip Phase 1 (Vision OCR).
 *
 * Records uploaded before parser-router PR #94 will not have markdown.
 * Those are returned in `failedRecordIds` so the caller can fall back
 * to PDF download + Vision OCR.
 */

export interface MarkdownRecord {
  recordId: string;
  fileName: string;
  markdownContent: string;
}

export interface MarkdownFetchResult {
  markdowns: MarkdownRecord[];
  failedRecordIds: Array<{ recordId: string; fileName: string }>;
}

export interface MarkdownFetcherPort {
  /**
   * Fetch pre-extracted markdown for all completed records belonging to a user.
   * For each record:
   *   1. Call get_record_markdown_url to get a signed URL
   *   2. Download the raw markdown from the signed URL
   *
   * Records that fail (404, no markdown) are returned in `failedRecordIds`
   * rather than being silently skipped.
   *
   * @param userId - The user ID to fetch markdowns for
   * @returns Successful markdowns and IDs of records that need PDF fallback
   */
  fetchMarkdownsForUser(userId: string): Promise<MarkdownFetchResult>;

  /**
   * Download PDFs for specific record IDs (used as fallback for records
   * without pre-extracted markdown).
   * @param userId - The user ID
   * @param records - Record IDs and file names to download
   * @returns Array of PDF buffers with metadata
   */
  fetchPDFsByRecordIds(
    userId: string,
    records: Array<{ recordId: string; fileName: string }>,
  ): Promise<Array<{ buffer: Buffer; fileName: string; recordId: string }>>;
}
