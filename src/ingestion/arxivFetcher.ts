import axios from 'axios';
import * as cheerio from 'cheerio';
import { Paper } from '../database/client';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Raw entry from arXiv API (before conversion to Paper format)
 */
interface ArxivEntry {
  id: string; // arXiv ID (e.g., "2312.02179")
  title: string;
  authors: string[];
  abstract: string;
  published: Date;
  pdfUrl: string;
  arxivUrl: string;
}

// ============================================================================
// ARXIV FETCHER CLASS
// ============================================================================

/**
 * Fetches research papers from arXiv API
 * Handles querying, parsing XML responses, and converting to Paper format
 */
export class ArxivFetcher {
  private baseUrl = 'http://export.arxiv.org/api/query';
  private maxResults: number;

  constructor(maxResults: number = 100) {
    this.maxResults = maxResults;
  }

  /**
   * Fetch a paper by explicit arXiv ID using id_list (best-effort)
   */
  async fetchPaperById(arxivId: string): Promise<ArxivEntry | null> {
    try {
      const url = `${this.baseUrl}?id_list=${encodeURIComponent(arxivId)}`;
      console.log(`Fetching paper by arXiv ID: ${arxivId}`);
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Gaussian-Splatting-KG/1.0',
        },
        timeout: 30000,
      });
      const entries = this.parseArxivResponse(response.data);
      // Normalize to compare without version suffix
      const entry = entries.find(e => e.id.replace(/v\\d+$/, '') === arxivId) || entries[0];
      return entry || null;
    } catch (error) {
      console.warn(`Could not fetch arXiv ID ${arxivId}:`, error);
      return null;
    }
  }

  /**
   * Fetch a batch of papers from arXiv
   * @param query - arXiv search query (e.g., 'cat:cs.CV AND all:"gaussian splatting"')
   * @param start - Starting index for pagination (0-indexed)
   * @returns Array of ArxivEntry objects
   */
  async fetchPapers(query: string = 'cat:cs.CV AND all:"gaussian splatting"', start: number = 0): Promise<ArxivEntry[]> {
    try {
      // Build arXiv API URL with query parameters
      const url = `${this.baseUrl}?search_query=${encodeURIComponent(query)}&start=${start}&max_results=${this.maxResults}&sortBy=submittedDate&sortOrder=descending`;
      
      console.log(`Fetching papers from arXiv: ${url}`);
      
      // Make HTTP request to arXiv API
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Gaussian-Splatting-KG/1.0',
        },
        timeout: 30000, // 30 second timeout
      });

      // Parse XML response and extract papers
      return this.parseArxivResponse(response.data);
    } catch (error) {
      console.error('Error fetching from arXiv:', error);
      throw error;
    }
  }

  /**
   * Parse arXiv XML response and extract paper information
   * arXiv returns Atom feed XML format
   */
  private parseArxivResponse(xmlData: string): ArxivEntry[] {
    // Use cheerio to parse XML (works like jQuery for XML/HTML)
    const $ = cheerio.load(xmlData, { xmlMode: true });
    const entries: ArxivEntry[] = [];

    // Each <entry> tag represents one paper
    $('entry').each((_, elem) => {
      const $entry = $(elem);
      
      // Extract arXiv ID from URL (e.g., "http://arxiv.org/abs/2312.02179v1" -> "2312.02179")
      const arxivId = $entry.find('id').text().split('/').pop()?.replace(/v\d+$/, '') || '';
      
      // Extract title (remove newlines and extra whitespace)
      const title = $entry.find('title').text().trim();
      
      // Extract abstract
      const abstract = $entry.find('summary').text().trim();
      
      // Extract authors (multiple <author><name> tags)
      const authors: string[] = [];
      $entry.find('author > name').each((_, author) => {
        authors.push($(author).text().trim());
      });

      // Extract publication date and convert to Date object
      const publishedText = $entry.find('published').text();
      const published = publishedText ? new Date(publishedText) : new Date();

      // Build URLs
      const arxivUrl = `https://arxiv.org/abs/${arxivId}`;
      const pdfUrl = `https://arxiv.org/pdf/${arxivId}.pdf`;

      // Only add entry if we have required fields
      if (arxivId && title) {
        entries.push({
          id: arxivId,
          title,
          authors,
          abstract,
          published,
          pdfUrl,
          arxivUrl,
        });
      }
    });

    return entries;
  }

  /**
   * Convert ArxivEntry to Paper format (for database storage)
   */
  async convertToPaperFormat(entry: ArxivEntry): Promise<Paper> {
    return {
      arxiv_id: entry.id,
      title: entry.title,
      authors: entry.authors,
      abstract: entry.abstract || null,
      published_date: entry.published,
      pdf_url: entry.pdfUrl,
      arxiv_url: entry.arxivUrl,
    };
  }

  /**
   * Fetch multiple batches of papers (handles pagination)
   * Automatically fetches until reaching totalLimit or no more papers available
   * Includes rate limiting delays between batches
   * 
   * @param query - arXiv search query
   * @param totalLimit - Maximum total papers to fetch
   * @returns Array of all fetched papers
   */
  async fetchAllPapers(query?: string, totalLimit: number = 100): Promise<ArxivEntry[]> {
    const allPapers: ArxivEntry[] = [];
    let start = 0;
    const batchSize = 50; // arXiv API allows up to 2000 per request, but we use 50 to be safe

    // Keep fetching until we reach the limit or run out of papers
    while (allPapers.length < totalLimit) {
      const batch = await this.fetchPapers(query, start);
      
      // If no papers returned, we're done
      if (batch.length === 0) {
        break;
      }

      // Add papers to our collection
      allPapers.push(...batch);
      
      // Update starting index for next batch
      start += batchSize;

      // If we got fewer papers than requested, we've reached the end
      if (batch.length < batchSize) {
        break;
      }

      // Rate limiting: wait 3 seconds between batches to be polite to arXiv servers
      console.log(`  Fetched ${allPapers.length} papers so far...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    // Ensure seed paper is included (domain fit): 3D Gaussian Splatting for Real-Time Radiance Field Rendering (arXiv: 2308.04079)
    try {
      const seedId = '2308.04079';
      const hasSeed = allPapers.some(p => p.id.replace(/v\\d+$/, '') === seedId) ||
        allPapers.some(p => /3D Gaussian Splatting for Real-Time Radiance Field Rendering/i.test(p.title));
      if (!hasSeed) {
        const seed = await this.fetchPaperById(seedId);
        if (seed) {
          console.log('✅ Ensured seed paper is included:', seed.title);
          allPapers.unshift(seed);
        } else {
          console.warn('⚠️  Could not fetch seed paper by ID; consider adjusting query.');
        }
      }
    } catch (e) {
      console.warn('Seed inclusion step encountered an issue:', e);
    }

    // Return only up to totalLimit papers
    return allPapers.slice(0, totalLimit);
  }
}

