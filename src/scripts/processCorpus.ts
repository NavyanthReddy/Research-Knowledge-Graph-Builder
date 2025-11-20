#!/usr/bin/env ts-node
/**
 * Batch Processing Script
 * Process a corpus of papers (50-100) with progress tracking and error handling
 */

import * as dotenv from 'dotenv';
import { PipelineOrchestrator } from '../pipeline/orchestrator';
import { DatabaseClient } from '../database/client';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

interface ProcessingStats {
  total: number;
  successful: number;
  failed: number;
  skipped: number;
  totalEntities: number;
  totalRelationships: number;
  processingTimes: number[];
  errors: Array<{ paper: string; error: string }>;
}

async function processCorpus() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let count = 50;
  let skipExisting = false;
  let seed = '2308.04079';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--count' && args[i + 1]) {
      count = parseInt(args[i + 1]);
    } else if (args[i] === '--skip-existing') {
      skipExisting = true;
    } else if (args[i] === '--seed' && args[i + 1]) {
      seed = args[i + 1];
    }
  }

  console.log('🚀 Batch Processing Corpus');
  console.log('═'.repeat(70));
  console.log(`\nConfiguration:`);
  console.log(`   Count: ${count} papers`);
  console.log(`   Seed: ${seed}`);
  console.log(`   Skip existing: ${skipExisting ? 'Yes' : 'No'}\n`);

  const orchestrator = new PipelineOrchestrator();
  const db = new DatabaseClient();
  const stats: ProcessingStats = {
    total: 0,
    successful: 0,
    failed: 0,
    skipped: 0,
    totalEntities: 0,
    totalRelationships: 0,
    processingTimes: [],
    errors: [],
  };

  // Create logs directory
  const logsDir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const errorLogPath = path.join(logsDir, `errors-${timestamp}.log`);
  const summaryPath = path.join(logsDir, `processing-summary-${timestamp}.json`);

  try {
    await orchestrator.initialize();

    // Step 1: Ingest papers
    console.log('━'.repeat(70));
    console.log('📥 Step 1: Ingesting Papers');
    console.log('━'.repeat(70) + '\n');

    await orchestrator.ingestFromSeedAndCitations(count);
    stats.total = count;

    // Step 2: Get unprocessed papers
    console.log('\n━'.repeat(70));
    console.log('📋 Step 2: Processing Papers');
    console.log('━'.repeat(70) + '\n');

    const batchSize = parseInt(process.env.BATCH_SIZE || '10', 10);
    let processed = 0;
    const startTime = Date.now();

    while (processed < stats.total) {
      const papers = await db.getUnprocessedPapers(batchSize);
      if (papers.length === 0) {
        console.log('\n✅ All papers processed!\n');
        break;
      }

      for (const paper of papers) {
        if (processed >= stats.total) break;

        const paperStartTime = Date.now();
        const progress = `[${processed + 1}/${stats.total}]`;
        
        console.log(`${progress} Processing: "${paper.title.substring(0, 60)}..."`);
        
        try {
          // Check if already processed (if skipExisting)
          if (skipExisting && paper.processed) {
            console.log(`   ⏭️  Skipped (already processed)`);
            stats.skipped++;
            processed++;
            continue;
          }

          // Process paper with retry
          let success = false;
          let lastError: Error | null = null;
          
          for (let retry = 0; retry < 3; retry++) {
            try {
              await orchestrator.processPaper(paper.id!);
              
              // Verify processing
              const check = await db.query(
                'SELECT processed, processing_error FROM papers WHERE id = $1',
                [paper.id]
              );
              
              if (check[0].processed) {
                success = true;
                break;
              } else if (check[0].processing_error) {
                throw new Error(check[0].processing_error);
              }
            } catch (error: any) {
              lastError = error;
              if (retry < 2) {
                console.log(`   ⚠️  Retry ${retry + 1}/3...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
            }
          }

          const paperTime = Date.now() - paperStartTime;
          stats.processingTimes.push(paperTime);
          
          if (success) {
            // Get counts
            const entityCount = await db.query(
              'SELECT COUNT(*) as count FROM paper_entities WHERE paper_id = $1',
              [paper.id]
            );
            const relCount = await db.query(
              'SELECT COUNT(*) as count FROM relationships WHERE paper_id = $1',
              [paper.id]
            );
            
            const entities = parseInt(entityCount[0].count);
            const relationships = parseInt(relCount[0].count);
            
            stats.totalEntities += entities;
            stats.totalRelationships += relationships;
            stats.successful++;
            
            console.log(`   ✅ Success (${(paperTime / 1000).toFixed(1)}s) - ${entities} entities, ${relationships} relationships`);
          } else {
            stats.failed++;
            const errorMsg = lastError?.message || 'Unknown error';
            stats.errors.push({ paper: paper.title, error: errorMsg });
            
            console.log(`   ❌ Failed: ${errorMsg}`);
            
            // Log error
            fs.appendFileSync(errorLogPath, 
              `${new Date().toISOString()} - Paper ${paper.arxiv_id}: ${errorMsg}\n`
            );
          }
        } catch (error: any) {
          stats.failed++;
          const errorMsg = error.message || String(error);
          stats.errors.push({ paper: paper.title, error: errorMsg });
          
          console.log(`   ❌ Error: ${errorMsg}`);
          fs.appendFileSync(errorLogPath,
            `${new Date().toISOString()} - Paper ${paper.arxiv_id}: ${errorMsg}\n`
          );
        }

        processed++;
        const elapsed = Date.now() - startTime;
        const remaining = stats.total - processed;
        const avgTime = stats.processingTimes.reduce((a, b) => a + b, 0) / stats.processingTimes.length;
        const estimatedRemaining = (remaining * avgTime) / 1000;

        console.log(`   ⏱️  Elapsed: ${(elapsed / 1000).toFixed(0)}s | Est. remaining: ${estimatedRemaining.toFixed(0)}s\n`);

        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Final summary
    const totalTime = Date.now() - startTime;
    const avgProcessingTime = stats.processingTimes.length > 0
      ? stats.processingTimes.reduce((a, b) => a + b, 0) / stats.processingTimes.length
      : 0;

    console.log('═'.repeat(70));
    console.log('📊 PROCESSING SUMMARY');
    console.log('═'.repeat(70));
    console.log(`✅ Successful: ${stats.successful}`);
    console.log(`❌ Failed: ${stats.failed}`);
    console.log(`⏭️  Skipped: ${stats.skipped}`);
    console.log(`🏷️  Total entities: ${stats.totalEntities}`);
    console.log(`🔗 Total relationships: ${stats.totalRelationships}`);
    console.log(`⏱️  Average time per paper: ${(avgProcessingTime / 1000).toFixed(2)}s`);
    console.log(`⏱️  Total time: ${(totalTime / 1000).toFixed(2)}s`);
    console.log('═'.repeat(70) + '\n');

    // Save summary
    const summary = {
      timestamp: new Date().toISOString(),
      configuration: { count, seed, skipExisting },
      stats: {
        ...stats,
        avgProcessingTimeMs: avgProcessingTime,
        totalTimeMs: totalTime,
        errors: stats.errors,
      },
    };
    
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`📝 Summary saved to: ${summaryPath}`);
    if (stats.errors.length > 0) {
      console.log(`📝 Errors logged to: ${errorLogPath}`);
    }
    console.log('');

    if (stats.failed > 0) {
      console.log(`⚠️  ${stats.failed} papers failed. Check error log for details.\n`);
      process.exit(1);
    } else {
      console.log('✅ All papers processed successfully!\n');
      process.exit(0);
    }

  } catch (error: any) {
    console.error('\n❌ Batch processing error:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    await orchestrator.close();
    await db.close();
  }
}

if (require.main === module) {
  processCorpus().catch((error) => {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  });
}

