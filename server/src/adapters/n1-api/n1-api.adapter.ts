import { PDFFetcherPort, PDFRecord } from '../../application/ports/pdf-fetcher.port.js';

interface PaginatedResponse {
  status: string;
  user_id: string;
  data: PDFRecord[];
  total_count: number;
  total_pages: number;
  page: number;
  page_size: number;
  all_reviewed: boolean;
  unreviewed_count: number;
}

export class N1ApiAdapter implements PDFFetcherPort {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    if (!baseUrl) {
      throw new Error('N1_API_BASE_URL is required');
    }
    if (!apiKey) {
      throw new Error('N1_API_KEY is required');
    }

    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  /**
   * Get a fresh signed URL for a specific record
   */
  private async getFreshUrl(userId: string, recordId: string): Promise<string> {
    const statusUrl = `${this.baseUrl}/records/status?user_id=${userId}&record_id=${recordId}`;

    const response = await fetch(statusUrl, {
      method: 'GET',
      headers: {
        'N1-Api-Key': this.apiKey,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get fresh URL (${response.status}): ${errorText}`);
    }

    const data: any = await response.json();

    if (!data.url) {
      throw new Error('No URL in status response');
    }

    return data.url;
  }

  /**
   * Download a PDF from a signed URL
   */
  private async downloadPDF(url: string, recordId: string): Promise<Buffer> {
    const response = await fetch(url);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`PDF download failed for ${recordId} (${response.status}): ${errorBody.substring(0, 200)}`);
    }

    const pdfBuffer = Buffer.from(await response.arrayBuffer());

    // Validate it's actually a PDF
    if (!pdfBuffer.toString('utf-8', 0, 5).startsWith('%PDF-')) {
      throw new Error(`Downloaded file for ${recordId} is not a valid PDF`);
    }

    return pdfBuffer;
  }

  /**
   * Fetch all completed PDFs for a user
   */
  async fetchPDFsForUser(userId: string): Promise<Array<{ buffer: Buffer; fileName: string; recordId: string }>> {
    const pdfs: Array<{ buffer: Buffer; fileName: string; recordId: string }> = [];
    let page = 1;
    const pageSize = 100;

    console.log(`[N1ApiAdapter] Fetching PDFs for user: ${userId}`);

    // Fetch and download page by page to avoid URL expiration
    while (true) {
      const url = `${this.baseUrl}/records/paginated?user_id=${userId}&page=${page}&page_size=${pageSize}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'N1-Api-Key': this.apiKey,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API request failed (${response.status}): ${errorText}`);
      }

      const responseData: PaginatedResponse = await response.json();

      if (!responseData.data || !Array.isArray(responseData.data)) {
        throw new Error(`Invalid API response format: expected 'data' array`);
      }

      console.log(`[N1ApiAdapter] Found ${responseData.data.length} records on page ${page}`);

      // Download each completed PDF immediately while URLs are fresh
      for (const record of responseData.data) {
        if (record.status !== 'COMPLETED') {
          console.log(`[N1ApiAdapter] Skipping ${record.id} (status: ${record.status})`);
          continue;
        }

        try {
          // Get fresh signed URL (valid for 2 hours)
          const freshUrl = await this.getFreshUrl(userId, record.id);

          // Download PDF
          const buffer = await this.downloadPDF(freshUrl, record.id);

          const fileName = record.file_name || `${record.id}.pdf`;

          pdfs.push({
            buffer,
            fileName,
            recordId: record.id,
          });

          console.log(`[N1ApiAdapter] Downloaded: ${fileName} (${(buffer.length / 1024).toFixed(2)} KB)`);
        } catch (error) {
          console.error(`[N1ApiAdapter] Error downloading ${record.id}:`, error);
          // Continue with other PDFs even if one fails
        }
      }

      // Check if we've reached the last page
      if (page >= responseData.total_pages) {
        console.log(`[N1ApiAdapter] Processed all ${responseData.total_pages} page(s)`);
        break;
      }

      page++;
    }

    console.log(`[N1ApiAdapter] Successfully fetched ${pdfs.length} PDFs`);
    return pdfs;
  }
}
