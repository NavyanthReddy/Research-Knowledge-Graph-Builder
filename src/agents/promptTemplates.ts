import { Paper, Entity } from '../database/client';

/**
 * Consistent system instruction for all LLM prompts
 */
export const SYSTEM_INSTRUCTION = 'You are an expert research paper analyzer.';

/**
 * Detailed description of entity types for extraction
 */
export const ENTITY_TYPES_DESCRIPTION = `Extract these entity types:

1. CONCEPTS: Key ideas or theoretical constructs (example: "radiance fields", "neural rendering")

2. METHODS: Algorithms or techniques (example: "3D Gaussian Splatting", "volumetric rendering")

3. DATASETS: Named datasets for evaluation (example: "Mip-NeRF 360", "Tanks and Temples")

4. METRICS: Evaluation metrics (example: "PSNR", "SSIM", "FPS")

5. PROBLEMS: Research challenges addressed (example: "slow rendering speed", "memory efficiency")`;

/**
 * Detailed description of relationship types for extraction
 */
export const RELATIONSHIP_TYPES_DESCRIPTION = `Identify semantic relationships between these entities. Use these relationship types:

- improves_on: method/paper improves upon another method
- extends: extends or generalizes a concept/method
- introduces: paper introduces a new entity
- evaluates_with: evaluates using a dataset or metric
- uses_method: applies or uses a technique
- addresses_problem: solves a research challenge
- compares_with: compares against baseline or alternative
- builds_on: builds upon previous work`;

/**
 * Standard instruction for JSON output format
 */
export const JSON_FORMAT_INSTRUCTION = `Do not include any markdown, code blocks, or explanatory text. Only JSON.`;

/**
 * Entity extraction prompt template
 * @param paper - Paper metadata
 * @param fullText - Full text content of the paper
 * @returns Formatted prompt for entity extraction
 */
export function entityExtractionPrompt(paper: Paper, fullText: string): string {
  // Limit text length to 8000 characters for context window
  const maxTextLength = 8000;
  const truncatedText =
    fullText.length > maxTextLength
      ? fullText.substring(0, maxTextLength) + '\n\n[Text truncated for length...]'
      : fullText;

  return `You are an expert research paper analyzer. Extract structured information from the following research paper.

Paper Title: ${paper.title}

Abstract: ${paper.abstract || 'N/A'}

Full Text: ${truncatedText}

${ENTITY_TYPES_DESCRIPTION}

For each entity, provide:
- name: entity name (lowercase for technical terms)
- type: one of [concept, method, dataset, metric, problem]
- description: brief description in 1-2 sentences
- confidence: your confidence from 0.0 to 1.0

Return ONLY valid JSON in this exact format:

{
  "entities": [
    {"name": "3d gaussian splatting", "type": "method", "description": "A method for real-time rendering", "confidence": 0.95}
  ]
}

${JSON_FORMAT_INSTRUCTION}`;
}

/**
 * Relationship extraction prompt template
 * @param paper - Paper metadata
 * @param fullText - Full text content of the paper
 * @param entities - List of entities found in the paper
 * @returns Formatted prompt for relationship extraction
 */
export function relationshipExtractionPrompt(
  paper: Paper,
  fullText: string,
  entities: Entity[]
): string {
  // Limit text length to 8000 characters for context window
  const maxTextLength = 8000;
  const truncatedText =
    fullText.length > maxTextLength
      ? fullText.substring(0, maxTextLength) + '\n\n[Text truncated for length...]'
      : fullText;

  // Create entity list for the prompt
  const entityList = entities
    .map((e) => `- ${e.name} (${e.entity_type})`)
    .join('\n');

  return `You are an expert at analyzing relationships in research papers.

Paper Title: ${paper.title}

Entities found in this paper:

${entityList}

Full Text: ${truncatedText}

${RELATIONSHIP_TYPES_DESCRIPTION}

For each relationship provide:
- source: entity name from the list above
- target: entity name from the list above
- type: one of the relationship types above
- evidence: direct quote or paraphrase from the paper
- confidence: your confidence from 0.0 to 1.0

Return ONLY valid JSON in this exact format:

{
  "relationships": [
    {
      "source": "3d gaussian splatting",
      "target": "neural radiance fields",
      "type": "improves_on",
      "evidence": "Our method achieves real-time rendering while NeRF is slow",
      "confidence": 0.9
    }
  ]
}

${JSON_FORMAT_INSTRUCTION}`;
}

