import * as dotenv from 'dotenv';
import { HfInference } from '@huggingface/inference';
import { parseJsonFromLlama, validateEntityJson } from '../utils/jsonParser';

// Load environment variables
dotenv.config();

/**
 * Test script for Hugging Face Llama connection
 * Helps debug Llama prompt/response issues before running full pipeline
 */
async function testLlamaConnection() {
  console.log('='.repeat(80));
  console.log('Testing Hugging Face Llama Connection');
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
  console.log(`   Key length: ${apiKey.length} characters`);
  console.log(`   Key prefix: ${apiKey.substring(0, 10)}...`);
  console.log();

  // Create Llama client
  console.log('Creating Hugging Face Inference client...');
  const hf = new HfInference(apiKey);
  console.log('✅ Client created');
  console.log();

  // Model configuration
  const model = 'meta-llama/Llama-3.1-8B-Instruct';
  console.log(`Model: ${model}`);
  console.log();

  // Test prompt - matches actual entity extraction prompt structure
  const testPrompt = `You are an expert research paper analyzer. Extract structured information from the following research paper.

Paper Title: Test Paper on Neural Networks

Abstract: This paper discusses neural networks and their application to image classification tasks.

Full Text: Neural networks are computational models inspired by biological neural networks. They are widely used for image classification tasks, achieving state-of-the-art results on benchmark datasets like ImageNet.

Extract these entity types:

1. CONCEPTS: Key ideas or theoretical constructs (example: "radiance fields", "neural rendering")

2. METHODS: Algorithms or techniques (example: "3D Gaussian Splatting", "volumetric rendering")

3. DATASETS: Named datasets for evaluation (example: "Mip-NeRF 360", "Tanks and Temples")

4. METRICS: Evaluation metrics (example: "PSNR", "SSIM", "FPS")

5. PROBLEMS: Research challenges addressed (example: "slow rendering speed", "memory efficiency")

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

Do not include any markdown, code blocks, or explanatory text. Only JSON.`;

  console.log('Test Prompt:');
  console.log('-'.repeat(80));
  console.log(testPrompt);
  console.log('-'.repeat(80));
  console.log();

  try {
    // Make API call
    console.log('Making API call to Hugging Face...');
    const startTime = Date.now();

    const response = await hf.chatCompletion({
      model: model,
      messages: [
        {
          role: 'system',
          content: 'You are an expert research paper analyzer.',
        },
        {
          role: 'user',
          content: testPrompt,
        },
      ],
      temperature: 0.1,
      max_tokens: 1024,
    });

    const endTime = Date.now();
    const duration = endTime - startTime;

    console.log(`✅ API call successful (${duration}ms)`);
    console.log();

    // Print raw response
    console.log('Raw Response:');
    console.log('-'.repeat(80));
    const content = response.choices[0]?.message?.content;
    if (!content) {
      console.error('❌ ERROR: No content in response');
      console.error('   Response object:', JSON.stringify(response, null, 2));
      process.exit(1);
    }

    console.log(content);
    console.log('-'.repeat(80));
    console.log();

    // Try to parse JSON from response
    console.log('Attempting to parse JSON from response...');
    try {
      const parsed = parseJsonFromLlama(content);
      console.log('✅ JSON parsed successfully');
      console.log();

      // Print parsed JSON
      console.log('Parsed JSON:');
      console.log('-'.repeat(80));
      console.log(JSON.stringify(parsed, null, 2));
      console.log('-'.repeat(80));
      console.log();

      // Validate entity JSON structure
      console.log('Validating entity JSON structure...');
      const isValid = validateEntityJson(parsed);
      if (isValid) {
        console.log('✅ JSON structure is valid');
        console.log();

        // Print parsed entities
        if (parsed.entities && Array.isArray(parsed.entities)) {
          console.log(`Found ${parsed.entities.length} entities:`);
          console.log('-'.repeat(80));
          parsed.entities.forEach((entity: any, index: number) => {
            console.log(`${index + 1}. ${entity.name || 'N/A'} (${entity.type || 'N/A'})`);
            console.log(`   Description: ${entity.description || 'N/A'}`);
            console.log(`   Confidence: ${entity.confidence || 'N/A'}`);
            console.log();
          });
          console.log('-'.repeat(80));
        } else {
          console.warn('⚠️  WARNING: No entities array found in parsed JSON');
        }
      } else {
        console.error('❌ ERROR: JSON structure validation failed');
        console.error('   See logs above for details');
      }

      // Final report
      console.log();
      console.log('='.repeat(80));
      if (isValid && parsed.entities && parsed.entities.length > 0) {
        console.log('✅ TEST PASSED: Llama connection is working correctly!');
        console.log(`   Successfully extracted ${parsed.entities.length} entities`);
      } else if (isValid) {
        console.log('⚠️  TEST PARTIAL: Llama connection works but no entities extracted');
      } else {
        console.log('❌ TEST FAILED: JSON structure validation failed');
      }
      console.log('='.repeat(80));
    } catch (parseError: any) {
      console.error('❌ ERROR: Failed to parse JSON from response');
      console.error('   Error message:', parseError.message);
      console.error('   Error stack:', parseError.stack);
      console.log();
      console.log('='.repeat(80));
      console.log('❌ TEST FAILED: JSON parsing failed');
      console.log('='.repeat(80));
      process.exit(1);
    }
  } catch (error: any) {
    console.error('❌ ERROR: API call failed');
    console.error('   Error message:', error.message);
    console.error('   Error type:', error.constructor.name);

    if (error.response) {
      console.error('   HTTP Status:', error.response.status);
      console.error('   Response body:', JSON.stringify(error.response.body, null, 2));
    }

    if (error.httpRequest) {
      console.error('   Request URL:', error.httpRequest.url);
      console.error('   Request method:', error.httpRequest.method);
    }

    if (error.stack) {
      console.error('   Stack trace:');
      console.error(error.stack);
    }

    console.log();
    console.log('='.repeat(80));
    console.log('❌ TEST FAILED: API call failed');
    console.log('='.repeat(80));
    console.log();
    console.log('Troubleshooting tips:');
    console.log('1. Check if HUGGINGFACE_API_KEY is correct');
    console.log('2. Verify the API key has access to the model');
    console.log('3. Check Hugging Face API status');
    console.log('4. Verify your internet connection');
    console.log('5. Check if the model name is correct');

    process.exit(1);
  }
}

// Run the test
testLlamaConnection().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

