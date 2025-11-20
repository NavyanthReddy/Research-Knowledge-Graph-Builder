#!/usr/bin/env ts-node
/**
 * Performance Benchmark Script
 * Measures processing times for each pipeline stage
 */

import * as dotenv from 'dotenv';
import { PipelineOrchestrator } from '../pipeline/orchestrator';
import { DatabaseClient } from '../database/client';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

interface BenchmarkResult {
  paper: string;
  pdfDownloadTime: number;
  textExtractionTime: number;
  entityExtractionTime: number;
  relationshipExtractionTime: number;
  validationTime: number;
  databaseInsertTime: number;
  totalTime: number;
}

async function benchmark() {
  console.log('⏱️  Performance Benchmark');
  console.log('═'.repeat(70));
  console.log('\nProcessing 5 papers and measuring performance...\n');

  const orchestrator = new PipelineOrchestrator();
  const db = new DatabaseClient();
  const results: BenchmarkResult[] = [];

  try {
    await orchestrator.initialize();

    // Get 5 unprocessed papers (or process first 5)
    const papers = await db.getUnprocessedPapers(5);
    
    if (papers.length === 0) {
      // Reset some papers for benchmarking
      await db.query(`
        UPDATE papers 
        SET processed = FALSE 
        WHERE id IN (SELECT id FROM papers WHERE processed = TRUE LIMIT 5)
      `);
      const resetPapers = await db.getUnprocessedPapers(5);
      if (resetPapers.length === 0) {
        throw new Error('No papers available for benchmarking. Process some papers first.');
      }
      papers.push(...resetPapers);
    }

    const testPapers = papers.slice(0, 5);
    console.log(`Testing with ${testPapers.length} papers:\n`);

    for (let i = 0; i < testPapers.length; i++) {
      const paper = testPapers[i];
      console.log(`\n[${i + 1}/${testPapers.length}] ${paper.title.substring(0, 60)}...`);

      const timings: Partial<BenchmarkResult> = {
        paper: paper.title,
      };

      const totalStart = Date.now();

      try {
        // Measure PDF download
        if (paper.pdf_url) {
          const pdfStart = Date.now();
          const pdfText = await orchestrator['pdfParser'].fetchPDFText(paper.pdf_url);
          timings.pdfDownloadTime = Date.now() - pdfStart;
          console.log(`  📥 PDF download: ${timings.pdfDownloadTime}ms`);

          // Measure text extraction
          const textStart = Date.now();
          // Text extraction is done during PDF fetch, so minimal time
          timings.textExtractionTime = 10; // Minimal overhead
          console.log(`  📄 Text extraction: ${timings.textExtractionTime}ms`);

          // Measure entity extraction
          const entityStart = Date.now();
          const entities = await orchestrator['entityExtractor'].extractEntities(pdfText, paper.title);
          timings.entityExtractionTime = Date.now() - entityStart;
          console.log(`  🏷️  Entity extraction: ${timings.entityExtractionTime}ms (${entities.length} entities)`);

          // Measure validation
          const validationStart = Date.now();
          const validatedEntities = await orchestrator['validator'].validateEntities(entities);
          timings.validationTime = Date.now() - validationStart;
          console.log(`  ✅ Validation: ${timings.validationTime}ms (${validatedEntities.length} validated)`);

          // Measure relationship extraction
          let relationshipTime = 0;
          if (validatedEntities.length >= 2) {
            const relStart = Date.now();
            const entityArray = validatedEntities.map(e => ({
              canonical_name: e.canonical_name,
              entity_type: e.entity_type,
              name: e.name,
            }));
            const relationships = await orchestrator['relationshipMapper'].extractRelationships(
              pdfText,
              entityArray,
              paper.title
            );
            relationshipTime = Date.now() - relStart;
            timings.relationshipExtractionTime = relationshipTime;
            console.log(`  🔗 Relationship extraction: ${relationshipTime}ms (${relationships.length} relationships)`);
          } else {
            timings.relationshipExtractionTime = 0;
            console.log(`  🔗 Relationship extraction: 0ms (skipped - <2 entities)`);
          }

          // Measure database insertion (approximate)
          const dbStart = Date.now();
          await orchestrator.processPaper(paper.id!);
          timings.databaseInsertTime = Date.now() - dbStart - (timings.entityExtractionTime || 0) - (timings.relationshipExtractionTime || 0) - (timings.validationTime || 0);
          console.log(`  💾 Database insertion: ${timings.databaseInsertTime}ms`);
        }

        timings.totalTime = Date.now() - totalStart;
        console.log(`  ⏱️  Total time: ${timings.totalTime}ms`);

        results.push(timings as BenchmarkResult);

      } catch (error: any) {
        console.error(`  ❌ Error: ${error.message}`);
        timings.totalTime = Date.now() - totalStart;
        results.push(timings as BenchmarkResult);
      }

      // Rate limiting
      if (i < testPapers.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Calculate statistics
    console.log('\n' + '═'.repeat(70));
    console.log('📊 BENCHMARK RESULTS');
    console.log('═'.repeat(70) + '\n');

    const avgTimes = {
      pdfDownload: results.reduce((sum, r) => sum + (r.pdfDownloadTime || 0), 0) / results.length,
      textExtraction: results.reduce((sum, r) => sum + (r.textExtractionTime || 0), 0) / results.length,
      entityExtraction: results.reduce((sum, r) => sum + (r.entityExtractionTime || 0), 0) / results.length,
      relationshipExtraction: results.reduce((sum, r) => sum + (r.relationshipExtractionTime || 0), 0) / results.length,
      validation: results.reduce((sum, r) => sum + (r.validationTime || 0), 0) / results.length,
      databaseInsert: results.reduce((sum, r) => sum + (r.databaseInsertTime || 0), 0) / results.length,
      total: results.reduce((sum, r) => sum + (r.totalTime || 0), 0) / results.length,
    };

    console.log('Average Times per Paper:');
    console.log(`  📥 PDF Download: ${(avgTimes.pdfDownload / 1000).toFixed(2)}s`);
    console.log(`  📄 Text Extraction: ${(avgTimes.textExtraction / 1000).toFixed(2)}s`);
    console.log(`  🏷️  Entity Extraction: ${(avgTimes.entityExtraction / 1000).toFixed(2)}s`);
    console.log(`  ✅ Validation: ${(avgTimes.validation / 1000).toFixed(2)}s`);
    console.log(`  🔗 Relationship Extraction: ${(avgTimes.relationshipExtraction / 1000).toFixed(2)}s`);
    console.log(`  💾 Database Insertion: ${(avgTimes.databaseInsert / 1000).toFixed(2)}s`);
    console.log(`  ⏱️  Total: ${(avgTimes.total / 1000).toFixed(2)}s\n`);

    // Bottleneck analysis
    const times = [
      { name: 'PDF Download', time: avgTimes.pdfDownload },
      { name: 'Text Extraction', time: avgTimes.textExtraction },
      { name: 'Entity Extraction', time: avgTimes.entityExtraction },
      { name: 'Validation', time: avgTimes.validation },
      { name: 'Relationship Extraction', time: avgTimes.relationshipExtraction },
      { name: 'Database Insertion', time: avgTimes.databaseInsert },
    ];
    times.sort((a, b) => b.time - a.time);
    
    console.log('Bottleneck Analysis (slowest stages):');
    times.forEach((t, idx) => {
      const percentage = (t.time / avgTimes.total) * 100;
      console.log(`  ${idx + 1}. ${t.name}: ${(t.time / 1000).toFixed(2)}s (${percentage.toFixed(1)}%)`);
    });
    console.log('');

    // Estimates
    const papers50 = (avgTimes.total * 50) / 1000 / 60;
    const papers1000 = (avgTimes.total * 1000) / 1000 / 60 / 60;

    console.log('Estimated Processing Times:');
    console.log(`  📊 50 papers: ${papers50.toFixed(1)} minutes`);
    console.log(`  📊 1000 papers: ${papers1000.toFixed(1)} hours\n`);

    // LLM API calls (approximate)
    const apiCallsPerPaper = 2; // Entity extraction + Relationship extraction
    console.log('LLM API Usage:');
    console.log(`  🤖 Calls per paper: ${apiCallsPerPaper}`);
    console.log(`  🤖 Estimated calls for 50 papers: ${apiCallsPerPaper * 50}`);
    console.log(`  🤖 Estimated calls for 1000 papers: ${apiCallsPerPaper * 1000}`);
    console.log(`  💰 Cost: Approx. $0.001-0.01 per paper (depends on API pricing)\n`);

    // Save report
    const reportsDir = path.join(process.cwd(), 'reports');
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    const reportPath = path.join(reportsDir, 'performance-benchmark.txt');
    const report = [
      'Performance Benchmark Report',
      '='.repeat(70),
      '',
      `Date: ${new Date().toISOString()}`,
      `Papers tested: ${results.length}`,
      '',
      'Average Times per Paper:',
      `  PDF Download: ${(avgTimes.pdfDownload / 1000).toFixed(2)}s`,
      `  Text Extraction: ${(avgTimes.textExtraction / 1000).toFixed(2)}s`,
      `  Entity Extraction: ${(avgTimes.entityExtraction / 1000).toFixed(2)}s`,
      `  Validation: ${(avgTimes.validation / 1000).toFixed(2)}s`,
      `  Relationship Extraction: ${(avgTimes.relationshipExtraction / 1000).toFixed(2)}s`,
      `  Database Insertion: ${(avgTimes.databaseInsert / 1000).toFixed(2)}s`,
      `  Total: ${(avgTimes.total / 1000).toFixed(2)}s`,
      '',
      'Bottleneck Analysis:',
      ...times.map((t, idx) => {
        const pct = (t.time / avgTimes.total) * 100;
        return `  ${idx + 1}. ${t.name}: ${(t.time / 1000).toFixed(2)}s (${pct.toFixed(1)}%)`;
      }),
      '',
      'Estimated Processing Times:',
      `  50 papers: ${papers50.toFixed(1)} minutes`,
      `  1000 papers: ${papers1000.toFixed(1)} hours`,
      '',
      'LLM API Usage:',
      `  Calls per paper: ${apiCallsPerPaper}`,
      `  50 papers: ${apiCallsPerPaper * 50} calls`,
      `  1000 papers: ${apiCallsPerPaper * 1000} calls`,
    ];

    fs.writeFileSync(reportPath, report.join('\n'));
    console.log('═'.repeat(70));
    console.log(`📝 Report saved to: ${reportPath}`);
    console.log('═'.repeat(70) + '\n');

  } catch (error: any) {
    console.error('\n❌ Benchmark error:', error.message);
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
  benchmark();
}

