import * as dotenv from 'dotenv';
import { HfInference } from '@huggingface/inference';
import { EntityExtractorAgent } from '../agents/entityExtractorAgent';
import { Paper } from '../database/client';
import { parseJsonFromLlama, validateEntityJson } from '../utils/jsonParser';

// Load environment variables
dotenv.config();

/**
 * Test script for entity extraction on a sample paper
 * Helps tune the entity extraction prompt before processing full corpus
 */
async function testEntityExtraction() {
  console.log('='.repeat(80));
  console.log('Testing Entity Extraction on Sample Paper');
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

  // Create entity extractor agent
  console.log('Creating EntityExtractorAgent...');
  const entityExtractor = new EntityExtractorAgent(hf);
  console.log('✅ EntityExtractorAgent created');
  console.log();

  // Sample paper about Gaussian Splatting
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
  console.log('Abstract:');
  console.log(samplePaper.abstract);
  console.log('-'.repeat(80));
  console.log();

  console.log(`Full text length: ${sampleFullText.length} characters`);
  console.log();

  try {
    // First, make a direct API call to show raw response
    console.log('Making direct API call to show raw Llama response...');
    console.log('-'.repeat(80));
    const startTime = Date.now();

    // Use entityExtractionPrompt to get the exact prompt
    const { entityExtractionPrompt } = await import('../agents/promptTemplates');
    const prompt = entityExtractionPrompt(samplePaper, sampleFullText);
    const { SYSTEM_INSTRUCTION } = await import('../agents/promptTemplates');

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

    // Now extract entities using the agent
    console.log('Extracting entities using EntityExtractorAgent...');
    const entityStartTime = Date.now();

    const entities = await entityExtractor.extractEntities(samplePaper, sampleFullText);

    const entityEndTime = Date.now();
    const entityDuration = entityEndTime - entityStartTime;
    const totalDuration = entityEndTime - startTime;

    console.log();
    console.log('='.repeat(80));
    console.log(`✅ Entity extraction completed (${entityDuration}ms processing)`);
    console.log(`   Total time including raw response: ${totalDuration}ms`);
    console.log('='.repeat(80));
    console.log();

    // Print extracted entities in formatted table
    console.log('Extracted Entities:');
    console.log('='.repeat(80));
    
    if (entities.length === 0) {
      console.log('⚠️  WARNING: No entities were extracted');
    } else {
      // Group entities by type
      const entitiesByType: { [key: string]: typeof entities } = {};
      entities.forEach((entity) => {
        if (!entitiesByType[entity.entity_type]) {
          entitiesByType[entity.entity_type] = [];
        }
        entitiesByType[entity.entity_type].push(entity);
      });

      // Print summary
      console.log(`Total entities extracted: ${entities.length}`);
      console.log();
      Object.keys(entitiesByType).forEach((type) => {
        console.log(`  ${type}: ${entitiesByType[type].length}`);
      });
      console.log();

      // Print detailed table for each type
      const types = ['method', 'dataset', 'metric', 'concept'];
      types.forEach((type) => {
        if (entitiesByType[type] && entitiesByType[type].length > 0) {
          console.log(`\n${type.toUpperCase()}S:`);
          console.log('-'.repeat(80));
          console.log(
            `${'Name'.padEnd(40)} | ${'Description'.padEnd(50)} | Confidence`
          );
          console.log('-'.repeat(80));

          entitiesByType[type].forEach((entity) => {
            const name = (entity.name || 'N/A').substring(0, 40).padEnd(40);
            const desc = (entity.description || 'N/A').substring(0, 50).padEnd(50);
            const conf = (entity.confidence_score || 0).toFixed(2);
            console.log(`${name} | ${desc} | ${conf}`);
          });
        }
      });

      // Print all entities in a detailed format
      console.log('\n' + '='.repeat(80));
      console.log('Detailed Entity List:');
      console.log('='.repeat(80));
      entities.forEach((entity, index) => {
        console.log(`\n${index + 1}. ${entity.name} (${entity.entity_type})`);
        console.log(`   Description: ${entity.description || 'N/A'}`);
        console.log(`   Confidence: ${entity.confidence_score || 'N/A'}`);
        console.log(`   Canonical Name: ${entity.canonical_name || 'N/A'}`);
      });
    }

    console.log();
    console.log('='.repeat(80));
    console.log('✅ TEST COMPLETED');
    console.log(`   Extracted ${entities.length} entities from sample paper`);
    console.log('='.repeat(80));

    // Print statistics
    if (entities.length > 0) {
      const avgConfidence =
        entities.reduce((sum, e) => sum + (e.confidence_score || 0), 0) /
        entities.length;
      console.log();
      console.log('Statistics:');
      console.log(`  Average confidence: ${avgConfidence.toFixed(3)}`);
      console.log(
        `  Entities with confidence ≥ 0.9: ${
          entities.filter((e) => (e.confidence_score || 0) >= 0.9).length
        }`
      );
      console.log(
        `  Entities with confidence < 0.7: ${
          entities.filter((e) => (e.confidence_score || 0) < 0.7).length
        }`
      );
    }
  } catch (error: any) {
    console.error('❌ ERROR: Entity extraction failed');
    console.error('   Error message:', error.message);
    console.error('   Error type:', error.constructor.name);

    if (error.stack) {
      console.error('   Stack trace:');
      console.error(error.stack);
    }

    console.log();
    console.log('='.repeat(80));
    console.log('❌ TEST FAILED: Entity extraction failed');
    console.log('='.repeat(80));

    process.exit(1);
  }
}

// Run the test
testEntityExtraction().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

