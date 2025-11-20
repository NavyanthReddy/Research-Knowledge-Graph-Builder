import { HfInference } from '@huggingface/inference';
import { Paper, Entity, Relationship } from '../database/client';
import {
  SYSTEM_INSTRUCTION,
  relationshipExtractionPrompt,
} from './promptTemplates';

/**
 * Utility function for fuzzy string matching
 * Returns the best matching entity based on name similarity
 */
function findBestMatch(
  searchName: string,
  entities: Entity[],
  threshold: number = 0.6
): Entity | null {
  if (!searchName || !entities || entities.length === 0) {
    return null;
  }

  const normalizedSearch = searchName.toLowerCase().trim();

  // First try exact match (case-insensitive)
  let exactMatch = entities.find(
    (e) =>
      e.name.toLowerCase() === normalizedSearch ||
      e.canonical_name.toLowerCase() === normalizedSearch
  );
  if (exactMatch) {
    return exactMatch;
  }

  // Try partial match (contains)
  let partialMatch = entities.find(
    (e) =>
      e.name.toLowerCase().includes(normalizedSearch) ||
      e.canonical_name.toLowerCase().includes(normalizedSearch) ||
      normalizedSearch.includes(e.name.toLowerCase()) ||
      normalizedSearch.includes(e.canonical_name.toLowerCase())
  );
  if (partialMatch) {
    return partialMatch;
  }

  // Calculate Levenshtein distance for fuzzy matching
  let bestMatch: Entity | null = null;
  let bestScore = 0;

  for (const entity of entities) {
    // Calculate similarity for both name and canonical_name
    const nameScore = calculateSimilarity(normalizedSearch, entity.name.toLowerCase());
    const canonicalScore = calculateSimilarity(
      normalizedSearch,
      entity.canonical_name.toLowerCase()
    );
    const maxScore = Math.max(nameScore, canonicalScore);

    if (maxScore > bestScore && maxScore >= threshold) {
      bestScore = maxScore;
      bestMatch = entity;
    }
  }

  return bestMatch;
}

/**
 * Calculate similarity between two strings using Levenshtein distance
 * Returns a score between 0.0 and 1.0
 */
function calculateSimilarity(str1: string, str2: string): number {
  if (str1 === str2) return 1.0;
  if (str1.length === 0 || str2.length === 0) return 0.0;

  const distance = levenshteinDistance(str1, str2);
  const maxLength = Math.max(str1.length, str2.length);
  return 1.0 - distance / maxLength;
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix: number[][] = [];

  // Initialize matrix
  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  // Fill matrix
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1, // deletion
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j - 1] + 1 // substitution
        );
      }
    }
  }

  return matrix[len1][len2];
}

/**
 * RelationshipMapperAgent
 * Identifies semantic relationships between entities in research papers using Llama LLM
 */
export class RelationshipMapperAgent {
  private llmClient: HfInference;
  private model = 'meta-llama/Llama-3.1-8B-Instruct';

  constructor(llmClient: HfInference) {
    this.llmClient = llmClient;
  }

  /**
   * Extract relationships between entities from a research paper
   * @param paper - Paper metadata
   * @param fullText - Full text content of the paper
   * @param entities - List of entities found in the paper
   * @returns Array of extracted relationships with proper entity IDs
   */
  async extractRelationships(
    paper: Paper,
    fullText: string,
    entities: Entity[]
  ): Promise<Relationship[]> {
    try {
      console.log(
        `[RelationshipMapperAgent] Extracting relationships from paper: ${paper.title}`
      );
      console.log(
        `[RelationshipMapperAgent] Found ${entities.length} entities to analyze`
      );

      // Need at least 2 entities to have relationships
      if (entities.length < 2) {
        console.log(
          '[RelationshipMapperAgent] Not enough entities (need at least 2)'
        );
        return [];
      }

      // Build the detailed prompt for Llama using template
      const prompt = relationshipExtractionPrompt(paper, fullText, entities);

      // Call Llama with the prompt
      const response = await this.llmClient.chatCompletion({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: SYSTEM_INSTRUCTION,
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.1, // Low temperature for consistent, structured output
        max_tokens: 4096, // Enough for detailed relationship extraction
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        console.warn('[RelationshipMapperAgent] No response content from LLM');
        return [];
      }

      console.log('[RelationshipMapperAgent] Received response from LLM, parsing JSON...');

      // Extract JSON from response (handle cases where Llama adds extra text)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn('[RelationshipMapperAgent] No JSON found in response');
        console.log(
          '[RelationshipMapperAgent] Response content:',
          content.substring(0, 500)
        );
        return [];
      }

      // Parse JSON
      let parsedData;
      try {
        parsedData = JSON.parse(jsonMatch[0]);
      } catch (parseError: any) {
        console.error(
          '[RelationshipMapperAgent] Failed to parse JSON:',
          parseError.message
        );
        console.log(
          '[RelationshipMapperAgent] JSON string:',
          jsonMatch[0].substring(0, 500)
        );
        return [];
      }

      // Extract relationships array
      const relationships = Array.isArray(parsedData.relationships)
        ? parsedData.relationships
        : parsedData.relationship
        ? [parsedData.relationship]
        : [];

      if (relationships.length === 0) {
        console.warn(
          '[RelationshipMapperAgent] No relationships found in parsed response'
        );
        return [];
      }

      console.log(
        `[RelationshipMapperAgent] Extracted ${relationships.length} raw relationships, matching to entity IDs...`
      );

      // Match entity names to actual Entity IDs and create Relationship objects
      const relationshipObjects: Relationship[] = [];

      for (const rawRel of relationships) {
        try {
          // Match source entity
          const sourceEntity = this.matchEntity(rawRel.source, entities);
          if (!sourceEntity || !sourceEntity.id) {
            console.warn(
              `[RelationshipMapperAgent] Could not match source entity: "${rawRel.source}"`
            );
            continue;
          }

          // Match target entity
          const targetEntity = this.matchEntity(rawRel.target, entities);
          if (!targetEntity || !targetEntity.id) {
            console.warn(
              `[RelationshipMapperAgent] Could not match target entity: "${rawRel.target}"`
            );
            continue;
          }

          // Skip self-relationships
          if (sourceEntity.id === targetEntity.id) {
            console.warn(
              `[RelationshipMapperAgent] Skipping self-relationship: ${sourceEntity.name} -> ${targetEntity.name}`
            );
            continue;
          }

          // Map relationship type (normalize to database format if needed)
          const relationshipType = this.normalizeRelationshipType(
            rawRel.type || rawRel.relationship_type
          );

          // Validate confidence score
          let confidenceScore: number | null = null;
          if (
            rawRel.confidence !== undefined &&
            rawRel.confidence !== null
          ) {
            const conf = parseFloat(String(rawRel.confidence));
            if (!isNaN(conf) && conf >= 0 && conf <= 1) {
              confidenceScore = conf;
            }
          }

          // Get evidence/context
          const context = rawRel.evidence
            ? String(rawRel.evidence).trim()
            : null;

          // Create Relationship object
          const relationship: Relationship = {
            source_entity_id: sourceEntity.id,
            target_entity_id: targetEntity.id,
            relationship_type: relationshipType,
            paper_id: paper.id || 0, // Will be set when paper is saved
            confidence_score: confidenceScore,
            context: context,
          };

          relationshipObjects.push(relationship);
        } catch (error: any) {
          console.error(
            `[RelationshipMapperAgent] Error processing relationship:`,
            error.message
          );
          console.error(`[RelationshipMapperAgent] Raw relationship:`, rawRel);
          // Continue with next relationship
        }
      }

      console.log(
        `[RelationshipMapperAgent] Successfully created ${relationshipObjects.length} valid Relationship objects`
      );

      return relationshipObjects;
    } catch (error: any) {
      console.error(
        '[RelationshipMapperAgent] Error extracting relationships:',
        error.message
      );
      console.error('[RelationshipMapperAgent] Stack trace:', error.stack);
      return [];
    }
  }


  /**
   * Match entity name to actual Entity object using fuzzy matching
   */
  private matchEntity(searchName: string, entities: Entity[]): Entity | null {
    if (!searchName || !entities || entities.length === 0) {
      return null;
    }

    const normalizedSearch = searchName.toLowerCase().trim();

    // Try exact match first (case-insensitive)
    let exactMatch = entities.find(
      (e) =>
        e.name.toLowerCase() === normalizedSearch ||
        e.canonical_name.toLowerCase() === normalizedSearch
    );
    if (exactMatch) {
      return exactMatch;
    }

    // Try partial match (contains)
    let partialMatch = entities.find(
      (e) =>
        e.name.toLowerCase().includes(normalizedSearch) ||
        e.canonical_name.toLowerCase().includes(normalizedSearch) ||
        normalizedSearch.includes(e.name.toLowerCase()) ||
        normalizedSearch.includes(e.canonical_name.toLowerCase())
    );
    if (partialMatch) {
      return partialMatch;
    }

    // Use fuzzy matching as fallback
    return findBestMatch(searchName, entities, 0.6);
  }

  /**
   * Normalize relationship type to match database schema
   */
  private normalizeRelationshipType(rawType: string): string {
    if (!rawType) {
      return 'relates_to'; // Default fallback
    }

    const normalized = rawType.toLowerCase().trim();

    // Map to database-compatible types
    const typeMap: { [key: string]: string } = {
      improves_on: 'improves',
      improves: 'improves',
      extends: 'extends',
      introduces: 'introduces',
      evaluates_with: 'evaluates',
      evaluates: 'evaluates',
      uses_method: 'uses',
      uses: 'uses',
      addresses_problem: 'addresses',
      addresses: 'addresses',
      compares_with: 'compares',
      compares: 'compares',
      builds_on: 'builds_on',
      cites: 'cites',
      implements: 'implements',
    };

    return typeMap[normalized] || normalized; // Return mapped type or original if not found
  }
}

