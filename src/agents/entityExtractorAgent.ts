import { HfInference } from '@huggingface/inference';
import { Paper, Entity } from '../database/client';
import {
  SYSTEM_INSTRUCTION,
  entityExtractionPrompt,
} from './promptTemplates';

/**
 * EntityExtractorAgent
 * Extracts structured entities from research papers using Llama LLM
 */
export class EntityExtractorAgent {
  private llmClient: HfInference;
  private model = 'meta-llama/Llama-3.1-8B-Instruct';

  constructor(llmClient: HfInference) {
    this.llmClient = llmClient;
  }

  /**
   * Extract entities from a research paper
   * @param paper - Paper metadata
   * @param fullText - Full text content of the paper
   * @returns Array of extracted entities
   */
  async extractEntities(paper: Paper, fullText: string): Promise<Entity[]> {
    try {
      console.log(`[EntityExtractorAgent] Extracting entities from paper: ${paper.title}`);

      // Build the detailed prompt for Llama using template
      const prompt = entityExtractionPrompt(paper, fullText);

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
        max_tokens: 4096, // Enough for detailed entity extraction
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        console.warn('[EntityExtractorAgent] No response content from LLM');
        return [];
      }

      console.log('[EntityExtractorAgent] Received response from LLM, parsing JSON...');

      // Extract JSON from response (handle cases where Llama adds extra text)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn('[EntityExtractorAgent] No JSON found in response');
        console.log('[EntityExtractorAgent] Response content:', content.substring(0, 500));
        return [];
      }

      // Parse JSON
      let parsedData;
      try {
        parsedData = JSON.parse(jsonMatch[0]);
      } catch (parseError: any) {
        console.error('[EntityExtractorAgent] Failed to parse JSON:', parseError.message);
        console.log('[EntityExtractorAgent] JSON string:', jsonMatch[0].substring(0, 500));
        return [];
      }

      // Extract entities array
      const entities = Array.isArray(parsedData.entities)
        ? parsedData.entities
        : parsedData.entity
        ? [parsedData.entity]
        : [];

      if (entities.length === 0) {
        console.warn('[EntityExtractorAgent] No entities found in parsed response');
        return [];
      }

      console.log(`[EntityExtractorAgent] Extracted ${entities.length} raw entities, converting to Entity objects...`);

      // Convert to Entity objects
      const entityObjects: Entity[] = entities
        .map((rawEntity: any) => this.convertToEntity(rawEntity, paper.id))
        .filter((entity: Entity | null): entity is Entity => entity !== null);

      console.log(`[EntityExtractorAgent] Successfully created ${entityObjects.length} valid Entity objects`);

      return entityObjects;
    } catch (error: any) {
      console.error('[EntityExtractorAgent] Error extracting entities:', error.message);
      console.error('[EntityExtractorAgent] Stack trace:', error.stack);
      return [];
    }
  }


  /**
   * Convert raw entity from LLM response to Entity object
   */
  private convertToEntity(rawEntity: any, paperId?: number): Entity | null {
    try {
      // Validate required fields
      if (!rawEntity.name || !rawEntity.type) {
        console.warn('[EntityExtractorAgent] Entity missing required fields:', rawEntity);
        return null;
      }

      // Normalize entity type (map "problem" to "concept" since DB doesn't support "problem")
      let entityType: 'concept' | 'method' | 'dataset' | 'metric' = 'concept';
      const rawType = rawEntity.type?.toLowerCase();

      if (rawType === 'method') {
        entityType = 'method';
      } else if (rawType === 'dataset') {
        entityType = 'dataset';
      } else if (rawType === 'metric') {
        entityType = 'metric';
      } else if (rawType === 'concept' || rawType === 'problem') {
        entityType = 'concept'; // Map problem to concept
      } else {
        console.warn(`[EntityExtractorAgent] Unknown entity type: ${rawType}, defaulting to concept`);
      }

      // Normalize name and create canonical form
      const name = String(rawEntity.name).trim();
      const canonicalName = this.createCanonicalName(name);

      // Validate confidence score
      let confidenceScore: number | null = null;
      if (rawEntity.confidence !== undefined && rawEntity.confidence !== null) {
        const conf = parseFloat(String(rawEntity.confidence));
        if (!isNaN(conf) && conf >= 0 && conf <= 1) {
          confidenceScore = conf;
        }
      }

      // Get description
      const description = rawEntity.description
        ? String(rawEntity.description).trim()
        : null;

      // Create Entity object
      const entity: Entity = {
        name: name,
        entity_type: entityType,
        description: description,
        canonical_name: canonicalName,
        confidence_score: confidenceScore,
        first_mentioned_in: paperId || null,
      };

      return entity;
    } catch (error: any) {
      console.error('[EntityExtractorAgent] Error converting entity:', error.message);
      console.error('[EntityExtractorAgent] Raw entity:', rawEntity);
      return null;
    }
  }

  /**
   * Create canonical form of entity name for deduplication
   * Normalizes: lowercase, removes special chars, collapses spaces
   */
  private createCanonicalName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^\w\s-]/g, '') // Remove special chars except hyphens and spaces
      .replace(/\s+/g, ' ') // Collapse multiple spaces
      .replace(/\s*-\s*/g, '') // Remove hyphens
      .replace(/&/g, 'and') // Replace & with 'and'
      .trim();
  }
}

