import axios from 'axios';
import pdf from 'pdf-parse';

// ============================================================================
// PDF PARSER CLASS
// ============================================================================

/**
 * Parses PDF files to extract text content from research papers
 * Handles downloading PDFs, extracting text, and identifying sections
 */
export class PDFParser {
  /**
   * Download PDF from URL and extract text content
   * @param pdfUrl - URL to the PDF file
   * @returns Extracted text as a string
   * @throws Error if PDF cannot be downloaded or parsed
   */
  async fetchPDFText(pdfUrl: string): Promise<string> {
    try {
      console.log(`Fetching PDF: ${pdfUrl}`);
      
      // Download PDF as binary data
      const response = await axios.get(pdfUrl, {
        responseType: 'arraybuffer', // Get binary data
        timeout: 60000, // 60 second timeout (PDFs can be large)
        headers: {
          'User-Agent': 'Gaussian-Splatting-KG/1.0',
        },
      });

      // Convert binary data to Buffer
      const pdfBuffer = Buffer.from(response.data);
      
      // Use pdf-parse to extract text from PDF
      const data = await pdf(pdfBuffer);
      
      // Return extracted text
      return data.text;
    } catch (error) {
      console.error(`Error fetching/parsing PDF ${pdfUrl}:`, error);
      throw error;
    }
  }

  /**
   * Extract sections from paper text
   * Attempts to identify common research paper sections:
   * - Abstract
   * - Introduction
   * - Related Work
   * - Method/Methodology
   * - Experiments/Evaluation
   * - Conclusion
   * 
   * @param text - Full text of the paper
   * @returns Object mapping section names to their text content
   */
  extractSections(text: string): { [key: string]: string } {
    const sections: { [key: string]: string } = {};
    
    // Common section header patterns in research papers
    // These regex patterns look for section headers like "1. Introduction" or "Introduction"
    const sectionPatterns = [
      { name: 'abstract', pattern: /(?:^|\n)\s*abstract\s*(?:\n|:)/i },
      { name: 'introduction', pattern: /(?:^|\n)\s*1\s*\.?\s*introduction\s*(?:\n|:)/i },
      { name: 'related_work', pattern: /(?:^|\n)\s*2\s*\.?\s*related\s+work\s*(?:\n|:)/i },
      { name: 'method', pattern: /(?:^|\n)\s*(?:3\s*\.?\s*)?method(?:ology)?\s*(?:\n|:)/i },
      { name: 'experiments', pattern: /(?:^|\n)\s*(?:4\s*\.?\s*)?(?:experiments?|evaluation)\s*(?:\n|:)/i },
      { name: 'conclusion', pattern: /(?:^|\n)\s*(?:5\s*\.?\s*)?conclusion\s*(?:\n|:)/i },
    ];

    // Find each section
    for (const { name, pattern } of sectionPatterns) {
      const match = text.match(pattern);
      if (match) {
        // Found section header - extract everything until next section
        const startIndex = match.index! + match[0].length;
        let endIndex = text.length; // Default to end of text

        // Look for the next section header to determine where this section ends
        for (const otherSection of sectionPatterns) {
          if (otherSection.name !== name) {
            const nextMatch = text.substring(startIndex).match(otherSection.pattern);
            if (nextMatch && nextMatch.index! < endIndex - startIndex) {
              endIndex = startIndex + nextMatch.index!;
            }
          }
        }

        // Extract section text and clean it up
        sections[name] = text.substring(startIndex, endIndex).trim();
      }
    }

    return sections;
  }

  /**
   * Extract arXiv citation IDs from paper text
   * Looks for patterns like "arXiv:2312.02179" or "arXiv 2312.02179"
   * 
   * @param text - Paper text to search
   * @returns Array of unique arXiv IDs found
   */
  extractCitations(text: string): string[] {
    // Pattern to match arXiv citations
    // Matches: "arXiv:2312.02179", "arXiv 2312.02179", etc.
    const arxivPattern = /arXiv[:\s]*(\d{4}\.\d{4,5})/gi;
    const citations: string[] = [];
    let match;

    // Find all matches
    while ((match = arxivPattern.exec(text)) !== null) {
      if (match[1]) {
        citations.push(match[1]);
      }
    }

    // Return unique citations only
    return [...new Set(citations)];
  }

  /**
   * Get the most relevant sections for entity extraction
   * Prioritizes abstract, introduction, and method sections
   * Falls back to full text if sections aren't found
   * 
   * @param text - Full paper text
   * @returns Text content optimized for entity extraction
   */
  getRelevantTextForExtraction(text: string): string {
    const sections = this.extractSections(text);
    
    // Combine most relevant sections (in order of importance)
    const relevantSections = [
      sections.abstract,
      sections.introduction,
      sections.method,
    ].filter(section => section && section.length > 0);

    // If we found relevant sections, combine them
    if (relevantSections.length > 0) {
      return relevantSections.join('\n\n');
    }

    // Fallback to full text if sections not found
    return text;
  }
}

