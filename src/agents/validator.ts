import { ExtractedEntity } from './entityExtractor';
import { ExtractedRelationship } from './relationshipMapper';
import { DatabaseClient } from '../database/client';

// ============================================================================
// VALIDATOR CLASS
// ============================================================================

/**
 * Validates and filters extracted entities and relationships
 * Ensures data quality before storing in database
 */
export class Validator {
  private db: DatabaseClient;
  private entityConfidenceThreshold: number;
  private relationshipConfidenceThreshold: number;

  constructor(
    db: DatabaseClient,
    entityConfidenceThreshold: number = 0.6,
    relationshipConfidenceThreshold: number = 0.65
  ) {
    this.db = db;
    this.entityConfidenceThreshold = entityConfidenceThreshold;
    this.relationshipConfidenceThreshold = relationshipConfidenceThreshold;
  }

  /**
   * Validate and filter extracted entities
   * Applies confidence threshold and filters out generic/invalid entities
   * 
   * @param entities - Raw extracted entities from LLM
   * @returns Filtered and validated entities
   */
  async validateEntities(entities: ExtractedEntity[]): Promise<ExtractedEntity[]> {
    // Step 1: Filter by confidence threshold
    const highConfidence = entities.filter(
      (e) => e.confidence_score >= this.entityConfidenceThreshold
    );

    // Step 2: Filter out generic terms and invalid entities
    const filtered = highConfidence.filter((e) => {
      // Skip generic terms that don't add value
      const genericTerms = [
        'paper',
        'work',
        'method',
        'approach',
        'result',
        'experiment',
        'study',
        'research',
        'proposed',
        'previous',
        'existing',
        'novel',
        'new',
        'algorithm',
        'technique',
      ];
      
      const canonicalLower = e.canonical_name.toLowerCase();
      if (genericTerms.some((term) => canonicalLower === term || canonicalLower.includes(` ${term} `))) {
        return false;
      }

      // Minimum name length (too short is likely noise)
      if (e.canonical_name.length < 3) {
        return false;
      }

      // Skip if name is mostly numbers or symbols
      const alphanumericChars = e.canonical_name.replace(/[^a-z0-9]/g, '').length;
      if (alphanumericChars < 2) {
        return false;
      }

      return true;
    });

    return filtered;
  }

  /**
   * Validate and filter extracted relationships
   * Applies confidence threshold and ensures both entities exist
   * 
   * @param relationships - Raw extracted relationships from LLM
   * @param entities - Validated entities list (to ensure relationships reference valid entities)
   * @returns Filtered and validated relationships
   */
  async validateRelationships(
    relationships: ExtractedRelationship[],
    entities: ExtractedEntity[]
  ): Promise<ExtractedRelationship[]> {
    // Step 1: Filter by confidence threshold
    const highConfidence = relationships.filter(
      (r) => r.confidence_score >= this.relationshipConfidenceThreshold
    );

    // Step 2: Ensure both source and target entities exist in the validated entities list
    const entityCanonicalNames = new Set(entities.map((e) => e.canonical_name));
    const valid = highConfidence.filter((r) => {
      return (
        entityCanonicalNames.has(r.source_entity) &&
        entityCanonicalNames.has(r.target_entity)
      );
    });

    // Step 3: Deduplicate relationships
    // Keep only one relationship per (source, target, type) combination
    // Prefer the one with highest confidence score
    const unique = new Map<string, ExtractedRelationship>();
    for (const rel of valid) {
      const key = `${rel.source_entity}::${rel.target_entity}::${rel.relationship_type}`;
      const existing = unique.get(key);
      
      if (!existing || existing.confidence_score < rel.confidence_score) {
        unique.set(key, rel);
      }
    }

    return Array.from(unique.values());
  }

  /**
   * Check if an entity already exists in the database
   * Used for deduplication across papers
   * 
   * @param canonicalName - Normalized entity name
   * @param entityType - Type of entity
   * @returns Entity ID if found, null otherwise
   */
  async checkEntityDuplicates(canonicalName: string, entityType: string): Promise<number | null> {
    try {
      const existing = await this.db.findEntityByCanonicalName(canonicalName, entityType);
      return existing?.id || null;
    } catch (error) {
      console.error(`Error checking entity duplicates: ${canonicalName}`, error);
      return null;
    }
  }

  /**
   * Calculate significance score for an entity in a paper
   * Higher score means entity is more important/relevant to the paper
   * 
   * Factors considered:
   * - Confidence score (from LLM extraction)
   * - Mention frequency (how many times mentioned)
   * - Position in paper (earlier mentions are weighted higher)
   * 
   * @param entity - The entity
   * @param mentionCount - Number of times entity is mentioned in paper
   * @param positionInText - Character position of first mention (0 = beginning of paper)
   * @returns Significance score between 0.0 and 1.0
   */
  calculateSignificanceScore(
    entity: ExtractedEntity,
    mentionCount: number,
    positionInText: number
  ): number {
    // Weight 1: Confidence score from LLM (50% weight)
    const confidenceWeight = entity.confidence_score;

    // Weight 2: Mention frequency (30% weight)
    // More mentions = higher significance, but cap at 10 mentions
    const frequencyWeight = Math.min(mentionCount / 10, 1.0);

    // Weight 3: Position in paper (20% weight)
    // Earlier mentions (first 5000 chars) get full weight
    // Later mentions get reduced weight
    const positionWeight = positionInText < 5000 ? 1.0 : 0.7;

    // Combine weights
    const significance = 
      confidenceWeight * 0.5 +
      frequencyWeight * 0.3 +
      positionWeight * 0.2;

    // Ensure score is between 0 and 1
    return Math.max(0, Math.min(1, significance));
  }

  /**
   * Count entity mentions in text
   * Simple string matching to count how many times an entity is mentioned
   * 
   * @param text - Paper text
   * @param entityName - Entity name to search for
   * @returns Number of mentions
   */
  countMentions(text: string, entityName: string): number {
    // Case-insensitive search
    const regex = new RegExp(entityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const matches = text.match(regex);
    return matches ? matches.length : 0;
  }

  /**
   * Find first mention position of entity in text
   * 
   * @param text - Paper text
   * @param entityName - Entity name to search for
   * @returns Character position of first mention, or -1 if not found
   */
  findFirstMentionPosition(text: string, entityName: string): number {
    // Case-insensitive search
    const regex = new RegExp(entityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const match = text.match(regex);
    return match ? (match.index || -1) : -1;
  }
}

