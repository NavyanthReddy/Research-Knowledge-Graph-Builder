import { HfInference } from '@huggingface/inference';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Represents an extracted entity from a research paper
 */
export interface ExtractedEntity {
  name: string; // Exact name as mentioned in the paper
  entity_type: 'concept' | 'method' | 'dataset' | 'metric';
  description: string; // Brief description
  canonical_name: string; // Normalized name for deduplication (lowercase, no special chars)
  confidence_score: number; // Confidence score between 0.0 and 1.0
  context?: string; // Sentence or phrase where entity is mentioned
}

// ============================================================================
// ENTITY EXTRACTOR CLASS
// ============================================================================

/**
 * Extracts entities (methods, concepts, datasets, metrics) from research papers
 * Uses Mistral Mixtral-8x7B-Instruct via Hugging Face Inference API
 */
export class EntityExtractor {
  private hf: HfInference;
  // Using a model that's available on free tier and supports text generation well
  // If this doesn't work, the system will fall back to rule-based extraction
  private model = 'meta-llama/Llama-3.1-8B-Instruct'; // Available on free tier
  private useSimpleExtraction = false; // Fallback to simpler extraction if API fails

  constructor(apiKey: string) {
    this.hf = new HfInference(apiKey);
  }

  /**
   * Extract entities from paper text using Mistral Mixtral
   * @param text - Paper text (or relevant sections)
   * @param paperTitle - Paper title (helps with context)
   * @returns Array of extracted entities
   */
  async extractEntities(text: string, paperTitle: string = ''): Promise<ExtractedEntity[]> {
    // Build the extraction prompt
    const prompt = this.buildExtractionPrompt(text, paperTitle);

    try {
      // Try using chat completion endpoint (OpenAI-compatible)
      // This works better with instruction-tuned models
      try {
        const response = await this.hf.chatCompletion({
          model: this.model,
          messages: [
            {
              role: 'system',
              content: this.getSystemPrompt(),
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.1,
          max_tokens: 2048,
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
          throw new Error('No response from API');
        }

        // Extract JSON from response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No JSON found');
        }

        const parsed = JSON.parse(jsonMatch[0]);
        const entities = Array.isArray(parsed.entities) 
          ? parsed.entities 
          : (parsed.entities ? [parsed.entities] : []);
        
        return this.validateAndNormalizeEntities(entities);
      } catch (chatError) {
        // Fallback: Use simple rule-based extraction if API fails
        console.warn('  ⚠ Chat completion failed, using fallback extraction...');
        return this.fallbackExtraction(text, paperTitle);
      }
    } catch (error) {
      console.error('Error extracting entities:', error);
      // Return fallback extraction on error
      return this.fallbackExtraction(text, paperTitle);
    }
  }

  /**
   * Fallback extraction using enhanced pattern matching
   * Used when API fails or isn't available - completely FREE solution
   */
  private fallbackExtraction(text: string, paperTitle: string): ExtractedEntity[] {
    const entities: ExtractedEntity[] = [];
    const textLower = text.toLowerCase();
    
    // Enhanced patterns for Gaussian Splatting papers (comprehensive)
    const patterns = [
      // Methods
      {
        name: '3D Gaussian Splatting',
        canonical_name: '3d gaussian splatting',
        entity_type: 'method' as const,
        pattern: /(?:3[Dd]\s*)?[Gg]aussian\s+[Ss]platting|3[Dd]GS|gaussian\s+splat/gi,
        description: '3D Gaussian Splatting method for novel view synthesis',
      },
      {
        name: 'NeRF',
        canonical_name: 'nerf',
        entity_type: 'method' as const,
        pattern: /\bNeRF\b|Neural\s+Radiance\s+Fields/gi,
        description: 'Neural Radiance Fields for novel view synthesis',
      },
      {
        name: 'InstantNGP',
        canonical_name: 'instantngp',
        entity_type: 'method' as const,
        pattern: /Instant\s*NGP|instant.*ngp/gi,
        description: 'Instant Neural Graphics Primitives',
      },
      {
        name: 'MipNeRF',
        canonical_name: 'mipnerf',
        entity_type: 'method' as const,
        pattern: /\bMipNeRF\b|Mip.*NeRF/gi,
        description: 'Mip-NeRF: Multiscale representation for neural radiance fields',
      },
      // Metrics
      {
        name: 'PSNR',
        canonical_name: 'psnr',
        entity_type: 'metric' as const,
        pattern: /\bPSNR\b|Peak\s+Signal.*Noise\s+Ratio/gi,
        description: 'Peak Signal-to-Noise Ratio evaluation metric',
      },
      {
        name: 'SSIM',
        canonical_name: 'ssim',
        entity_type: 'metric' as const,
        pattern: /\bSSIM\b|Structural\s+Similarity/gi,
        description: 'Structural Similarity Index evaluation metric',
      },
      {
        name: 'LPIPS',
        canonical_name: 'lpips',
        entity_type: 'metric' as const,
        pattern: /\bLPIPS\b|Learned\s+Perceptual\s+Image\s+Patch\s+Similarity/gi,
        description: 'Learned Perceptual Image Patch Similarity metric',
      },
      // Datasets
      {
        name: 'DTU',
        canonical_name: 'dtu',
        entity_type: 'dataset' as const,
        pattern: /\bDTU\b/gi,
        description: 'DTU MVS dataset for 3D reconstruction evaluation',
      },
      {
        name: 'Tanks and Temples',
        canonical_name: 'tanks and temples',
        entity_type: 'dataset' as const,
        pattern: /Tanks\s+and\s+Temples/gi,
        description: 'Tanks and Temples benchmark dataset',
      },
      {
        name: 'MipNeRF-360',
        canonical_name: 'mipnerf 360',
        entity_type: 'dataset' as const,
        pattern: /MipNeRF.*360|360.*dataset/gi,
        description: 'MipNeRF-360 dataset for novel view synthesis',
      },
      // Concepts
      {
        name: 'splatting',
        canonical_name: 'splatting',
        entity_type: 'concept' as const,
        pattern: /\bsplatting\b/gi,
        description: 'Splatting rendering technique',
      },
    ];

    // Extract paper-specific method names from title (e.g., "YoNoSplat", "4DSTR")
    // These are likely the paper's main contribution
    const titleMethodMatch = paperTitle.match(/([A-Z][a-z]*(?:[A-Z][a-z]*)*(?:\d+[A-Z]*)?):/);
    if (titleMethodMatch && titleMethodMatch[1]) {
      const paperMethod = titleMethodMatch[1].trim();
      // Check if it's mentioned in text
      if (text.match(new RegExp(paperMethod, 'i'))) {
        entities.push({
          name: paperMethod,
          canonical_name: paperMethod.toLowerCase(),
          entity_type: 'method' as const,
          description: `Method introduced in paper: ${paperTitle}`,
          confidence_score: 0.9,
          context: paperTitle,
        });
      }
    }

    // Extract method names from patterns like "X-GS" or "X-Gaussian"
    const methodPatterns = [
      /([A-Z][a-z]+(?:[A-Z][a-z]+)*(?:-GS|-Gaussian|-NeRF))\b/g,
      /([A-Z][a-z]+(?:[0-9]+[A-Z]*)+(?:GS|Gaussian|Splatting))/g,
    ];

    for (const pattern of methodPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const methodName = match[1];
        if (methodName && methodName.length > 3) {
          entities.push({
            name: methodName,
            canonical_name: methodName.toLowerCase().replace(/[^a-z0-9\s]/g, ''),
            entity_type: 'method' as const,
            description: `Method mentioned in paper: ${methodName}`,
            confidence_score: 0.75,
            context: match[0],
          });
        }
      }
    }

    // Continue with existing patterns
    for (const { name, canonical_name, entity_type, pattern, description } of patterns) {
      const matches = text.match(pattern);
      if (matches && matches.length > 0) {
        // Find context around first occurrence
        const firstMatch = matches[0];
        const matchIndex = text.search(pattern);
        const contextStart = Math.max(0, matchIndex - 100);
        const contextEnd = Math.min(text.length, matchIndex + firstMatch.length + 100);
        const context = text.substring(contextStart, contextEnd).trim();
        
        entities.push({
          name,
          entity_type,
          description: description || `Extracted from paper: ${paperTitle}`,
          canonical_name,
          confidence_score: 0.8, // Higher confidence for pattern matching
          context,
        });
      }
    }

    // Deduplicate
    return entities.filter((e, idx, arr) => 
      arr.findIndex(x => x.canonical_name === e.canonical_name && x.entity_type === e.entity_type) === idx
    );
  }

  /**
   * Get system prompt that defines the task for the model
   */
  private getSystemPrompt(): string {
    return `You are an expert in computer vision and 3D graphics research. Your task is to extract entities from research papers about Gaussian Splatting and related topics.

Extract the following types of entities:
1. **Methods**: Specific techniques, algorithms, or approaches (e.g., "3D Gaussian Splatting", "InstantNGP", "NeRF")
2. **Concepts**: Theoretical concepts or ideas (e.g., "view-dependent appearance", "splatting", "rendering")
3. **Datasets**: Evaluation datasets (e.g., "DTU", "Tanks and Temples", "MipNeRF-360")
4. **Metrics**: Evaluation metrics (e.g., "PSNR", "SSIM", "LPIPS")

For each entity, provide:
- A precise name (as mentioned in the paper)
- The entity type
- A brief description
- A canonical name (normalized, lowercase, no special chars except spaces)
- A confidence score (0.0-1.0)

CRITICAL: You MUST return ONLY valid JSON, no additional text. Use this exact format:
{
  "entities": [...]
}`;
  }

  /**
   * Build the user prompt with paper text
   */
  private buildExtractionPrompt(text: string, paperTitle: string): string {
    // Limit text length to stay within token limits and focus on important parts
    // Mixtral has 32k context, but we limit to ~8000 chars to be safe
    const textSnippet = text.length > 8000 
      ? text.substring(0, 8000) + '\n...\n[Text truncated for length]' 
      : text;

    return `Extract all relevant entities from this research paper excerpt:

Title: ${paperTitle}

Text:
${textSnippet}

Return ONLY a JSON object with this exact structure (no additional text):
{
  "entities": [
    {
      "name": "exact name from paper",
      "entity_type": "method|concept|dataset|metric",
      "description": "brief description",
      "canonical_name": "normalized lowercase name",
      "confidence_score": 0.95,
      "context": "sentence or phrase where entity is mentioned"
    }
  ]
}`;
  }

  /**
   * Validate and normalize extracted entities
   * Filters out invalid entities and ensures consistent format
   */
  private validateAndNormalizeEntities(entities: any[]): ExtractedEntity[] {
    return entities
      .filter((e) => {
        // Basic validation: check required fields and valid entity type
        return (
          e.name &&
          typeof e.name === 'string' &&
          ['method', 'concept', 'dataset', 'metric'].includes(e.entity_type) &&
          e.canonical_name &&
          typeof e.canonical_name === 'string' &&
          typeof e.confidence_score === 'number'
        );
      })
      .map((e) => ({
        name: e.name.trim(),
        entity_type: e.entity_type,
        description: (e.description || '').trim(),
        canonical_name: this.normalizeCanonicalName(e.canonical_name),
        confidence_score: Math.max(0, Math.min(1, e.confidence_score || 0.5)), // Clamp between 0 and 1
        context: e.context?.trim(),
      }))
      .filter((e, idx, arr) => {
        // Deduplicate: keep only first occurrence of same canonical_name + entity_type
        return arr.findIndex(
          (x) => x.canonical_name === e.canonical_name && x.entity_type === e.entity_type
        ) === idx;
      });
  }

  /**
   * Normalize canonical name for deduplication
   * Converts to lowercase, removes special characters, normalizes whitespace
   * Examples:
   *   "3D Gaussian Splatting" → "3d gaussian splatting"
   *   "3DGS" → "3dgs"
   *   "NeRF++" → "nerf"
   */
  private normalizeCanonicalName(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '') // Remove special chars except spaces and hyphens
      .replace(/\s+/g, ' ') // Normalize whitespace (multiple spaces → single space)
      .trim();
  }
}
