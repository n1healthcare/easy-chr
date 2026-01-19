/**
 * Port interface for fetching PDFs from the N1 API backend
 */

export interface PDFRecord {
  id: string;
  user_id: string;
  file_name: string;
  url: string;
  status: string;
  progress: number;
  created_at?: string;
  updated_at?: string;
}

export interface PDFFetcherPort {
  /**
   * Fetch all PDF records for a given user_id
   * @param userId The user ID to fetch PDFs for
   * @returns Array of PDF buffers with their metadata
   */
  fetchPDFsForUser(userId: string): Promise<Array<{ buffer: Buffer; fileName: string; recordId: string }>>;
}
