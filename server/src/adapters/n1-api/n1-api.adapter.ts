import { PDFFetcherPort, PDFRecord } from '../../application/ports/pdf-fetcher.port.js';
import { getLogger } from '../../logger.js';

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
  private logger = getLogger().child({ component: 'N1ApiAdapter' });

  constructor(baseUrl: string, apiKey: string) {
    if (!baseUrl) {
      throw new Error('N1_API_BASE_URL is required');
    }
    if (!apiKey) {
      throw new Error('N1_API_KEY is required');
    }

    // Remove trailing slash to prevent double-slash URLs
    this.baseUrl = baseUrl.replace(/\/+$/, '');
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

    this.logger.info({ userId }, 'Fetching PDFs for user');

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

      this.logger.info(
        { page, recordsOnPage: responseData.data.length },
        'Fetched records page',
      );

      // Download each completed PDF immediately while URLs are fresh
      for (const record of responseData.data) {
        if (record.status !== 'COMPLETED') {
          this.logger.debug(
            { recordId: record.id, status: record.status },
            'Skipping non-completed record',
          );
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

          this.logger.info(
            {
              recordId: record.id,
              fileName,
              sizeKb: Number((buffer.length / 1024).toFixed(2)),
            },
            'Downloaded PDF successfully',
          );
        } catch (error) {
          this.logger.error({ err: error, recordId: record.id }, 'Error downloading PDF');
          // Continue with other PDFs even if one fails
        }
      }

      // Check if we've reached the last page
      if (page >= responseData.total_pages) {
        this.logger.info({ totalPages: responseData.total_pages }, 'Processed all record pages');
        break;
      }

      page++;
    }

    this.logger.info({ totalPdfs: pdfs.length }, 'Completed PDF fetch for user');
    return pdfs;
  }
}
