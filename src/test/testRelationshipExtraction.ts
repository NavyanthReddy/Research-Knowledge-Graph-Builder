import * as dotenv from 'dotenv';
import { HfInference } from '@huggingface/inference';
import { EntityExtractorAgent } from '../agents/entityExtractorAgent';
import { RelationshipMapperAgent } from '../agents/relationshipMapperAgent';
import { Paper, Entity } from '../database/client';
import { parseJsonFromLlama, validateRelationshipJson } from '../utils/jsonParser';

// Load environment variables
dotenv.config();

/**
 * Test script for relationship extraction on a sample paper
 * Helps tune the relationship extraction prompt before processing full corpus
 */
async function testRelationshipExtraction() {
  console.log('='.repeat(80));
  console.log('Testing Relationship Extraction on Sample Paper');
  console.log('='.repeat(80));
  console.log();

  // Check if API key is set
  const apiKey = process.env.HUGGINGFACE_API_KEY;
  if (!apiKey) {
    console.error('❌ ERROR: HUGGINGFACE_API_KEY not found in environment variables');
    console.error('   Please set HUGGINGFACE_API_KEY in your .env file');
    process.exit(1);
  }

  console.log('✅ HUGGINGFACE_API_KEY found');
  console.log();

  // Create Llama client
  console.log('Creating Hugging Face Inference client...');
  const hf = new HfInference(apiKey);
  console.log('✅ Client created');
  console.log();

  // Create agents
  console.log('Creating agents...');
  const entityExtractor = new EntityExtractorAgent(hf);
  const relationshipMapper = new RelationshipMapperAgent(hf);
  console.log('✅ Agents created');
  console.log();

  // Sample paper about Gaussian Splatting (same as entity test)
  const samplePaper: Paper = {
    arxiv_id: '2308.04079',
    title: '3D Gaussian Splatting for Real-Time Radiance Field Rendering',
    authors: ['Bernhard Kerbl', 'Georgios Kopanas', 'Thomas Leimkühler', 'George Drettakis'],
    abstract: `Radiance Field methods have recently revolutionized novel-view synthesis of scenes captured with multiple photos or videos. However, achieving high visual quality still requires neural networks that are costly to train and render, while recent faster methods inevitably trade off speed for quality. For unbounded and complete scenes (rather than isolated objects) and 1080p resolution rendering, no current method can achieve real-time display rates. We introduce three key elements that allow us to achieve state-of-the-art visual quality while maintaining competitive training times and importantly allow high-quality real-time (≥ 30 fps) novel-view synthesis at 1080p resolution. First, starting from sparse points produced during camera calibration, we represent the scene with 3D Gaussians that preserve desirable properties of continuous volumetric radiance fields for scene optimization while avoiding unnecessary computation in empty space; second, we perform interleaved optimization/density control of the 3D Gaussians, notably optimizing anisotropic covariance to achieve an accurate representation of the scene; third, we develop a fast, visibility-aware rendering algorithm that supports anisotropic splatting and both accelerates training and allows real-time rendering. We demonstrate state-of-the-art visual quality and real-time rendering on several established datasets.`,
    published_date: new Date('2023-08-08'),
    pdf_url: 'https://arxiv.org/pdf/2308.04079.pdf',
    arxiv_url: 'https://arxiv.org/abs/2308.04079',
    processed: false,
  };

  // Sample full text (abstract + short introduction section)
  const sampleFullText = `${samplePaper.abstract}

Introduction

Neural rendering has emerged as a powerful paradigm for synthesizing photorealistic novel views from a sparse set of input images. Recent advances in Neural Radiance Fields (NeRF) have demonstrated remarkable quality in view synthesis tasks. However, NeRF-based methods typically require hours of training and seconds of rendering time, limiting their practical applicability.

Our method, 3D Gaussian Splatting, addresses these limitations by representing scenes as a collection of 3D Gaussians rather than a continuous neural network. Each Gaussian stores its position, orientation (via covariance), color, and opacity. During rendering, we project these 3D Gaussians to 2D and perform alpha blending, similar to traditional point-based rendering but with learned anisotropic kernels.

Key innovations include: (1) efficient optimization using gradient descent on 3D Gaussian parameters, (2) adaptive density control through cloning and pruning of Gaussians, (3) anisotropic covariance optimization for accurate geometry representation, and (4) a GPU-accelerated rasterization pipeline that enables real-time rendering at high resolutions.

We evaluate our method on standard benchmarks including MipNeRF-360, Tanks and Temples, and Deep Blending datasets. Our approach achieves comparable or superior quality to NeRF while reducing training time by an order of magnitude and enabling real-time rendering at 1080p resolution. Quantitative metrics including PSNR, SSIM, and LPIPS demonstrate significant improvements over existing methods.

The method is implemented in PyTorch and CUDA, leveraging modern GPU architectures for efficient training and rendering. We use stochastic gradient descent with adaptive learning rates, and our rendering pipeline is optimized for parallel execution on GPUs.`;

  console.log('Sample Paper:');
  console.log('-'.repeat(80));
  console.log(`Title: ${samplePaper.title}`);
  console.log(`Authors: ${samplePaper.authors.join(', ')}`);
  console.log(`arXiv ID: ${samplePaper.arxiv_id}`);
  console.log();
  console.log(`Full text length: ${sampleFullText.length} characters`);
  console.log();

  try {
    // Step 1: Extract entities first
    console.log('='.repeat(80));
    console.log('Step 1: Extracting Entities');
    console.log('='.repeat(80));
    console.log();
    console.log('Extracting entities using EntityExtractorAgent...');
    const entityStartTime = Date.now();

    const entities = await entityExtractor.extractEntities(samplePaper, sampleFullText);

    const entityEndTime = Date.now();
    const entityDuration = entityEndTime - entityStartTime;

    console.log();
    console.log(`✅ Entity extraction completed (${entityDuration}ms)`);
    console.log(`   Found ${entities.length} entities`);
    console.log();

    // Print list of entities found
    console.log('Entities Found:');
    console.log('-'.repeat(80));
    if (entities.length === 0) {
      console.log('⚠️  WARNING: No entities extracted. Cannot extract relationships without entities.');
      process.exit(1);
    }

    // Assign IDs to entities for relationship matching (simulate database IDs)
    // The relationship mapper needs entities with IDs to match relationships
    entities.forEach((entity, index) => {
      entity.id = index + 1;
    });

    // Group by type
    const entitiesByType: { [key: string]: Entity[] } = {};
    entities.forEach((entity) => {
      if (!entitiesByType[entity.entity_type]) {
        entitiesByType[entity.entity_type] = [];
      }
      entitiesByType[entity.entity_type].push(entity);
    });

    Object.keys(entitiesByType).forEach((type) => {
      console.log(`\n${type.toUpperCase()}S (${entitiesByType[type].length}):`);
      entitiesByType[type].forEach((entity) => {
        console.log(
          `  ${(entity as any).id}. ${entity.name} (confidence: ${entity.confidence_score?.toFixed(2) || 'N/A'})`
        );
      });
    });

    console.log();
    console.log('-'.repeat(80));
    console.log();

    // Step 2: Extract relationships
    console.log('='.repeat(80));
    console.log('Step 2: Extracting Relationships');
    console.log('='.repeat(80));
    console.log();

    if (entities.length < 2) {
      console.log('⚠️  WARNING: Need at least 2 entities to extract relationships');
      console.log('   Only found', entities.length, 'entity/entities');
      process.exit(1);
    }

    // First, make a direct API call to show raw response
    console.log('Making direct API call to show raw Llama response...');
    console.log('-'.repeat(80));
    const relationshipStartTime = Date.now();

    // Use relationshipExtractionPrompt to get the exact prompt
    const { relationshipExtractionPrompt, SYSTEM_INSTRUCTION } = await import(
      '../agents/promptTemplates'
    );
    const prompt = relationshipExtractionPrompt(samplePaper, sampleFullText, entities);

    const rawResponse = await hf.chatCompletion({
      model: 'meta-llama/Llama-3.1-8B-Instruct',
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
      temperature: 0.1,
      max_tokens: 4096,
    });

    const rawContent = rawResponse.choices[0]?.message?.content || '';
    console.log('Raw Llama Response:');
    console.log('-'.repeat(80));
    console.log(rawContent);
    console.log('-'.repeat(80));
    console.log();

    // Now extract relationships using the agent
    console.log('Extracting relationships using RelationshipMapperAgent...');
    const agentStartTime = Date.now();

    const relationships = await relationshipMapper.extractRelationships(
      samplePaper,
      sampleFullText,
      entities
    );

    const agentEndTime = Date.now();
    const agentDuration = agentEndTime - agentStartTime;
    const totalDuration = agentEndTime - relationshipStartTime;

    console.log();
    console.log('='.repeat(80));
    console.log(`✅ Relationship extraction completed (${agentDuration}ms processing)`);
    console.log(`   Total time including raw response: ${totalDuration}ms`);
    console.log('='.repeat(80));
    console.log();

    // Print extracted relationships in formatted table
    console.log('Extracted Relationships:');
    console.log('='.repeat(80));

    if (relationships.length === 0) {
      console.log('⚠️  WARNING: No relationships were extracted');
    } else {
      // Group relationships by type
      const relationshipsByType: { [key: string]: typeof relationships } = {};
      relationships.forEach((rel) => {
        if (!relationshipsByType[rel.relationship_type]) {
          relationshipsByType[rel.relationship_type] = [];
        }
        relationshipsByType[rel.relationship_type].push(rel);
      });

      // Print summary
      console.log(`Total relationships extracted: ${relationships.length}`);
      console.log();
      Object.keys(relationshipsByType).forEach((type) => {
        console.log(`  ${type}: ${relationshipsByType[type].length}`);
      });
      console.log();

      // Print detailed table for each relationship type
      Object.keys(relationshipsByType).forEach((type) => {
        console.log(`\n${type.toUpperCase()} Relationships:`);
        console.log('-'.repeat(80));
        console.log(
          `${'Source Entity'.padEnd(30)} | ${'Target Entity'.padEnd(30)} | Confidence`
        );
        console.log('-'.repeat(80));

        relationshipsByType[type].forEach((rel) => {
          // Find entity names by ID
          const sourceEntity = entities.find((e) => (e as any).id === rel.source_entity_id);
          const targetEntity = entities.find((e) => (e as any).id === rel.target_entity_id);

          const sourceName = sourceEntity?.name || `ID:${rel.source_entity_id}`;
          const targetName = targetEntity?.name || `ID:${rel.target_entity_id}`;
          const conf = (rel.confidence_score || 0).toFixed(2);

          console.log(
            `${sourceName.substring(0, 30).padEnd(30)} | ${targetName.substring(0, 30).padEnd(30)} | ${conf}`
          );
        });
      });

      // Print all relationships in a detailed format
      console.log('\n' + '='.repeat(80));
      console.log('Detailed Relationship List:');
      console.log('='.repeat(80));
      relationships.forEach((rel, index) => {
        // Find entity names by ID
        const sourceEntity = entities.find((e) => (e as any).id === rel.source_entity_id);
        const targetEntity = entities.find((e) => (e as any).id === rel.target_entity_id);

        const sourceName = sourceEntity?.name || `ID:${rel.source_entity_id}`;
        const targetName = targetEntity?.name || `ID:${rel.target_entity_id}`;

        console.log(`\n${index + 1}. ${rel.relationship_type}: ${sourceName} -> ${targetName}`);
        console.log(`   Source Entity ID: ${rel.source_entity_id}`);
        console.log(`   Target Entity ID: ${rel.target_entity_id}`);
        console.log(`   Confidence: ${rel.confidence_score || 'N/A'}`);
        if (rel.context) {
          console.log(`   Evidence: "${rel.context.substring(0, 100)}${rel.context.length > 100 ? '...' : ''}"`);
        }
      });
    }

    console.log();
    console.log('='.repeat(80));
    console.log('✅ TEST COMPLETED');
    console.log(`   Extracted ${entities.length} entities`);
    console.log(`   Extracted ${relationships.length} relationships`);
    console.log('='.repeat(80));

    // Print statistics
    if (relationships.length > 0) {
      const avgConfidence =
        relationships.reduce((sum, r) => sum + (r.confidence_score || 0), 0) /
        relationships.length;
      console.log();
      console.log('Statistics:');
      console.log(`  Average confidence: ${avgConfidence.toFixed(3)}`);
      console.log(
        `  Relationships with confidence ≥ 0.9: ${
          relationships.filter((r) => (r.confidence_score || 0) >= 0.9).length
        }`
      );
      console.log(
        `  Relationships with confidence < 0.7: ${
          relationships.filter((r) => (r.confidence_score || 0) < 0.7).length
        }`
      );
    }
  } catch (error: any) {
    console.error('❌ ERROR: Relationship extraction failed');
    console.error('   Error message:', error.message);
    console.error('   Error type:', error.constructor.name);

    if (error.stack) {
      console.error('   Stack trace:');
      console.error(error.stack);
    }

    console.log();
    console.log('='.repeat(80));
    console.log('❌ TEST FAILED: Relationship extraction failed');
    console.log('='.repeat(80));

    process.exit(1);
  }
}

// Run the test
testRelationshipExtraction().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

