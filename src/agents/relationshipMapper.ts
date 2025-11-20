import { HfInference } from '@huggingface/inference';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Represents a relationship between two entities extracted from a paper
 */
export interface ExtractedRelationship {
  source_entity: string; // Canonical name of source entity
  target_entity: string; // Canonical name of target entity
  relationship_type: string; // Type of relationship (e.g., "improves", "uses")
  confidence_score: number; // Confidence score between 0.0 and 1.0
  context: string; // Text snippet that establishes this relationship
}

/**
 * Entity info needed for relationship extraction
 */
export interface EntityInfo {
  canonical_name: string;
  entity_type: string;
  name: string; // Display name
}

// ============================================================================
// RELATIONSHIP MAPPER CLASS
// ============================================================================

/**
 * Extracts semantic relationships between entities from research papers
 * Uses Mistral Mixtral-8x7B-Instruct via Hugging Face Inference API
 */
export class RelationshipMapper {
  private hf: HfInference;
  // Using a model that's available on free tier
  private model = 'meta-llama/Llama-3.1-8B-Instruct'; // Available on free tier

  constructor(apiKey: string) {
    this.hf = new HfInference(apiKey);
  }

  /**
   * Extract relationships between entities from paper text
   * @param text - Paper text (or relevant sections)
   * @param entities - List of extracted entities (needed to validate relationships)
   * @param paperTitle - Paper title (helps with context)
   * @returns Array of extracted relationships
   */
  async extractRelationships(
    text: string,
    entities: EntityInfo[],
    paperTitle: string = ''
  ): Promise<ExtractedRelationship[]> {
    // Need at least 2 entities to have relationships
    if (entities.length < 2) {
      return [];
    }

    // Build the relationship extraction prompt
    const prompt = this.buildRelationshipPrompt(text, entities, paperTitle);

    try {
      // Try using chat completion endpoint
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
          temperature: 0.2,
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
        const relationships = Array.isArray(parsed.relationships) 
          ? parsed.relationships 
          : (parsed.relationships ? [parsed.relationships] : []);

        return this.validateRelationships(relationships, entities);
      } catch (chatError) {
        // Fallback: Use simple pattern-based relationship extraction (FREE)
        console.warn('  ⚠ Chat completion failed, using fallback relationship extraction...');
        return this.fallbackRelationshipExtraction(text, entities, paperTitle);
      }
    } catch (error) {
      console.error('Error extracting relationships:', error);
      return [];
    }
  }

  /**
   * Get system prompt that defines relationship extraction task
   */
  private getSystemPrompt(): string {
    return `You are an expert in analyzing research papers. Extract semantic relationships between entities mentioned in the paper.

Relationship types:
1. **improves**: Paper A improves/extends/enhances method B (e.g., "Our method improves upon 3DGS by...")
2. **uses**: Paper A uses method B or dataset B (e.g., "We use InstantNGP for...")
3. **extends**: Paper A extends or builds upon concept B (e.g., "We extend the concept of splatting...")
4. **compares**: Paper A compares with method B (e.g., "We compare our approach with NeRF...")
5. **cites**: Paper A cites/references work B (e.g., "As shown in [3DGS]...")
6. **evaluates**: Paper A evaluates using dataset B or metric B (e.g., "We evaluate on DTU dataset...")
7. **implements**: Paper A implements method B (e.g., "We implement the 3DGS algorithm...")

CRITICAL: You MUST return ONLY valid JSON, no additional text. Use this exact format:
{
  "relationships": [...]
}`;
  }

  /**
   * Build the user prompt with paper text and entities
   */
  private buildRelationshipPrompt(
    text: string,
    entities: EntityInfo[],
    paperTitle: string
  ): string {
    // Create list of entities for the prompt
    const entityList = entities
      .map((e) => `- ${e.name} (${e.entity_type}): ${e.canonical_name}`)
      .join('\n');
    
    // Limit text length to stay within token limits
    const textSnippet = text.length > 6000 
      ? text.substring(0, 6000) + '\n...\n[Text truncated for length]' 
      : text;

    return `Analyze this research paper and extract relationships between the following entities:

Title: ${paperTitle}

Entities:
${entityList}

Paper text:
${textSnippet}

Return ONLY a JSON object with this exact structure (no additional text):
{
  "relationships": [
    {
      "source_entity": "canonical_name_of_source",
      "target_entity": "canonical_name_of_target",
      "relationship_type": "improves|uses|extends|compares|cites|evaluates|implements",
      "confidence_score": 0.9,
      "context": "specific sentence or phrase that establishes this relationship"
    }
  ]
}

Only extract relationships that are explicitly or strongly implied in the text. Do not create relationships between entities that don't actually relate to each other.`;
  }

  /**
   * Validate and normalize extracted relationships
   * Ensures both entities exist and filters invalid relationships
   */
  private validateRelationships(
    relationships: any[],
    entities: EntityInfo[]
  ): ExtractedRelationship[] {
    // Create set of valid entity canonical names for fast lookup
    const entityCanonicalNames = new Set(entities.map((e) => e.canonical_name));

    return relationships
      .filter((r) => {
        // Basic validation: check required fields
        return (
          r.source_entity &&
          r.target_entity &&
          r.relationship_type &&
          typeof r.confidence_score === 'number' &&
          r.context &&
          // Ensure both entities exist in our entity list
          entityCanonicalNames.has(r.source_entity) &&
          entityCanonicalNames.has(r.target_entity) &&
          // No self-relationships
          r.source_entity !== r.target_entity
        );
      })
      .map((r) => ({
        source_entity: r.source_entity.toLowerCase().trim(),
        target_entity: r.target_entity.toLowerCase().trim(),
        relationship_type: r.relationship_type.toLowerCase().trim(),
        confidence_score: Math.max(0, Math.min(1, r.confidence_score || 0.5)), // Clamp to 0-1
        context: r.context.trim(),
      }))
      .filter((r, idx, arr) => {
        // Deduplicate: keep only one relationship per (source, target, type) combination
        // Keep the one with highest confidence score
        const key = `${r.source_entity}::${r.target_entity}::${r.relationship_type}`;
        const existing = arr.find(
          (x) => `${x.source_entity}::${x.target_entity}::${x.relationship_type}` === key
        );
        if (existing && existing !== r) {
          // Keep the one with higher confidence
          return r.confidence_score > existing.confidence_score;
        }
        return true;
      });
  }

  /**
   * Fallback relationship extraction using enhanced pattern matching
   * Completely FREE - works without API
   */
  private fallbackRelationshipExtraction(
    text: string,
    entities: EntityInfo[],
    paperTitle: string
  ): ExtractedRelationship[] {
    const relationships: ExtractedRelationship[] = [];
    const textLower = text.toLowerCase();

    // Create entity name map for matching (including partial matches)
    const entityNameMap = new Map<string, { canonical: string; fullName: string }>();
    entities.forEach(e => {
      const canonLower = e.canonical_name.toLowerCase();
      entityNameMap.set(canonLower, { canonical: e.canonical_name, fullName: e.name });
      entityNameMap.set(e.name.toLowerCase(), { canonical: e.canonical_name, fullName: e.name });
      
      // Add partial matches for compound names
      if (e.canonical_name.includes(' ')) {
        const words = e.canonical_name.split(' ');
        if (words.length > 1) {
          // Add last word (e.g., "Splatting" from "3d gaussian splatting")
          entityNameMap.set(words[words.length - 1], { canonical: e.canonical_name, fullName: e.name });
        }
      }
      
      // Special handling for common abbreviations
      if (canonLower.includes('gaussian splatting')) {
        entityNameMap.set('3dgs', { canonical: e.canonical_name, fullName: e.name });
        entityNameMap.set('3d gs', { canonical: e.canonical_name, fullName: e.name });
        entityNameMap.set('gs', { canonical: e.canonical_name, fullName: e.name });
      }
    });

    // Find the paper's main method (prefer shorter/more specific method names - likely the paper's contribution)
    // Papers often introduce new methods with acronyms or short names
    const methods = entities.filter(e => e.entity_type === 'method');
    const paperMethod = methods
      .sort((a, b) => {
        // Prefer shorter names (likely acronyms like "YoNoSplat")
        // Prefer names that don't contain common terms like "gaussian", "nerf"
        const aIsGeneric = a.canonical_name.includes('gaussian') || a.canonical_name.includes('nerf');
        const bIsGeneric = b.canonical_name.includes('gaussian') || b.canonical_name.includes('nerf');
        if (aIsGeneric && !bIsGeneric) return 1;
        if (!aIsGeneric && bIsGeneric) return -1;
        return a.canonical_name.length - b.canonical_name.length;
      })[0]?.canonical_name || null;

    // Enhanced patterns to find "improves" relationships
    const improvePhrases = [
      /(?:improves?|enhances?|extends?|advances?|better)\s+(?:upon|on|over|than|the)?\s*([A-Za-z0-9\s]+?)(?:\s|\.|,|;)/gi,
      /(?:builds?|based)\s+on\s+([A-Za-z0-9\s]+?)(?:\s|\.|,|;)/gi,
      /(?:overcomes?|addresses?)\s+(?:the\s+)?(?:limitations?\s+of\s+)?([A-Za-z0-9\s]+?)(?:\s|\.|,|;)/gi,
    ];

    // Extract "improves" relationships
    for (const pattern of improvePhrases) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const mentionedText = match[1]?.trim() || '';
        if (!mentionedText || mentionedText.length < 3) continue;
        
        const mentionedLower = mentionedText.toLowerCase();
        
        // Check if mentioned text matches any entity
        for (const [key, entityInfo] of entityNameMap.entries()) {
          // More flexible matching
          if (mentionedLower.includes(key) || key.includes(mentionedLower) || 
              (mentionedLower.includes('gaussian') && key.includes('gaussian')) ||
              (mentionedLower.includes('nerf') && key.includes('nerf'))) {
            
            const targetEntity = entityInfo.canonical;
            
            // Find source entity (the paper's method)
            const sourceEntity = paperMethod || 
              entities.find(e => e.entity_type === 'method' && e.canonical_name !== targetEntity)?.canonical_name ||
              entities[0]?.canonical_name;

            if (sourceEntity && sourceEntity !== targetEntity && paperMethod) {
              // Extract context around the match
              const matchIndex = match.index || 0;
              const contextStart = Math.max(0, matchIndex - 200);
              const contextEnd = Math.min(text.length, matchIndex + match[0].length + 200);
              let context = text.substring(contextStart, contextEnd).trim();
              
              // Clean up context
              context = context.replace(/\s+/g, ' ').substring(0, 300);
              
              relationships.push({
                source_entity: paperMethod,
                target_entity: targetEntity,
                relationship_type: 'improves',
                confidence_score: 0.8,
                context,
              });
            }
            break; // Found a match, move to next pattern match
          }
        }
      }
    }

    // Also check paper title for improvement indicators
    const titleLower = paperTitle.toLowerCase();
    if (titleLower.includes('improve') || titleLower.includes('enhance') || 
        titleLower.includes('extend') || titleLower.includes('better') ||
        titleLower.includes('advance')) {
      
      // Find entities mentioned in title
      for (const entity of entities) {
        if (entity.entity_type === 'method' && entity.canonical_name !== paperMethod) {
          const entityInTitle = titleLower.includes(entity.canonical_name) || 
                               titleLower.includes(entity.name.toLowerCase());
          
          if (entityInTitle && paperMethod) {
            relationships.push({
              source_entity: paperMethod,
              target_entity: entity.canonical_name,
              relationship_type: 'improves',
              confidence_score: 0.85, // Higher confidence from title
              context: paperTitle,
            });
          }
        }
      }
    }

    // Deduplicate
    const unique = new Map<string, ExtractedRelationship>();
    for (const rel of relationships) {
      const key = `${rel.source_entity}::${rel.target_entity}::${rel.relationship_type}`;
      const existing = unique.get(key);
      if (!existing || existing.confidence_score < rel.confidence_score) {
        unique.set(key, rel);
      }
    }

    return Array.from(unique.values());
  }
}
