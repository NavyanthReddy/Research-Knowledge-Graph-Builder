#!/usr/bin/env ts-node
/**
 * End-to-End Pipeline Test
 * Tests the complete pipeline with a single paper (arXiv:2308.04079)
 */

import * as dotenv from 'dotenv';
import { PipelineOrchestrator } from '../pipeline/orchestrator';
import { DatabaseClient } from '../database/client';

dotenv.config();

async function testPipeline() {
  console.log('🧪 End-to-End Pipeline Test');
  console.log('═'.repeat(70));
  console.log('\nTesting with paper: arXiv:2308.04079 (3D Gaussian Splatting)');
  console.log('─'.repeat(70) + '\n');

  const orchestrator = new PipelineOrchestrator();
  const db = new DatabaseClient();
  const testArxivId = '2308.04079';

  try {
    // Initialize
    console.log('📋 Step 0: Initializing pipeline...\n');
    await orchestrator.initialize();

    // Check if paper already exists
    console.log(`📋 Step 1: Checking if paper ${testArxivId} exists in database...\n`);
    const existingPaper = await db.query(
      'SELECT id, arxiv_id, title, processed FROM papers WHERE arxiv_id = $1',
      [testArxivId]
    );

    if (existingPaper.length > 0) {
      console.log(`✅ Paper found in database:`);
      console.log(`   ID: ${existingPaper[0].id}`);
      console.log(`   Title: ${existingPaper[0].title.substring(0, 80)}...`);
      console.log(`   Processed: ${existingPaper[0].processed ? 'Yes' : 'No'}\n`);

      if (existingPaper[0].processed) {
        console.log('⚠️  Paper is already processed. Resetting for fresh test...\n');
        await db.query(
          'UPDATE papers SET processed = FALSE, processing_error = NULL WHERE arxiv_id = $1',
          [testArxivId]
        );
      }
    } else {
      console.log(`📥 Paper not found. Fetching from arXiv...\n`);
      // Fetch the paper
      const entries = await orchestrator['arxivFetcher'].fetchPapers(`id_list=${testArxivId}`, 0);
      if (entries.length === 0) {
        throw new Error(`Paper ${testArxivId} not found on arXiv`);
      }
      const paper = await orchestrator['arxivFetcher'].convertToPaperFormat(entries[0]);
      const paperId = await db.insertPaper(paper);
      console.log(`✅ Paper inserted with ID: ${paperId}\n`);
    }

    // Get paper ID
    const paperResult = await db.query(
      'SELECT id, arxiv_id, title FROM papers WHERE arxiv_id = $1',
      [testArxivId]
    );
    if (paperResult.length === 0) {
      throw new Error('Paper not found after insertion');
    }
    const paperId = paperResult[0].id;

    // Process the paper
    console.log('📋 Step 2: Processing paper through full pipeline...\n');
    const startTime = Date.now();
    
    await orchestrator.processPaper(paperId);
    
    const processingTime = Date.now() - startTime;
    console.log(`\n✅ Processing completed in ${(processingTime / 1000).toFixed(2)}s\n`);

    // Verify database insertion
    console.log('📋 Step 3: Verifying database insertion...\n');

    // Check paper status
    const paperCheck = await db.query(
      'SELECT id, arxiv_id, title, processed, processing_error FROM papers WHERE id = $1',
      [paperId]
    );
    if (paperCheck.length === 0) {
      throw new Error('Paper not found after processing');
    }
    const paper = paperCheck[0];
    
    console.log('📄 Paper Status:');
    console.log(`   ✅ Paper ID: ${paper.id}`);
    console.log(`   ✅ arXiv ID: ${paper.arxiv_id}`);
    console.log(`   ✅ Title: ${paper.title.substring(0, 70)}...`);
    console.log(`   ✅ Processed: ${paper.processed ? 'Yes ✅' : 'No ❌'}`);
    if (paper.processing_error) {
      console.log(`   ⚠️  Processing Error: ${paper.processing_error}`);
    }
    console.log('');

    // Check entities
    const entitiesCheck = await db.query(
      `SELECT COUNT(*) as count, 
              entity_type, 
              AVG(confidence_score) as avg_confidence
       FROM entities e
       JOIN paper_entities pe ON e.id = pe.entity_id
       WHERE pe.paper_id = $1
       GROUP BY entity_type`,
      [paperId]
    );
    
    let totalEntities = 0;
    console.log('🏷️  Entities Extracted:');
    for (const row of entitiesCheck) {
      const count = parseInt(row.count);
      totalEntities += count;
      console.log(`   ✅ ${row.entity_type}: ${count} entities (avg confidence: ${parseFloat(row.avg_confidence || 0).toFixed(2)})`);
    }
    
    // Get sample entities
    const sampleEntities = await db.query(
      `SELECT e.name, e.entity_type, e.confidence_score, pe.mention_count
       FROM entities e
       JOIN paper_entities pe ON e.id = pe.entity_id
       WHERE pe.paper_id = $1
       ORDER BY pe.significance_score DESC
       LIMIT 10`,
      [paperId]
    );
    
    if (sampleEntities.length > 0) {
      console.log('\n   Sample entities:');
      sampleEntities.forEach((e, idx) => {
        console.log(`   ${idx + 1}. ${e.name} (${e.entity_type}) - confidence: ${parseFloat(e.confidence_score || 0).toFixed(2)}, mentions: ${e.mention_count}`);
      });
    }
    console.log(`\n   ✅ Total entities: ${totalEntities}\n`);

    // Check relationships
    const relationshipsCheck = await db.query(
      `SELECT COUNT(*) as count, 
              relationship_type,
              AVG(confidence_score) as avg_confidence
       FROM relationships
       WHERE paper_id = $1
       GROUP BY relationship_type`,
      [paperId]
    );
    
    let totalRelationships = 0;
    console.log('🔗 Relationships Extracted:');
    for (const row of relationshipsCheck) {
      const count = parseInt(row.count);
      totalRelationships += count;
      console.log(`   ✅ ${row.relationship_type}: ${count} relationships (avg confidence: ${parseFloat(row.avg_confidence || 0).toFixed(2)})`);
    }
    
    // Get sample relationships with evidence
    const sampleRelationships = await db.query(
      `SELECT 
         e1.name as source_entity,
         e2.name as target_entity,
         r.relationship_type,
         r.confidence_score,
         r.context
       FROM relationships r
       JOIN entities e1 ON r.source_entity_id = e1.id
       JOIN entities e2 ON r.target_entity_id = e2.id
       WHERE r.paper_id = $1
       ORDER BY r.confidence_score DESC
       LIMIT 5`,
      [paperId]
    );
    
    if (sampleRelationships.length > 0) {
      console.log('\n   Sample relationships:');
      sampleRelationships.forEach((r, idx) => {
        console.log(`   ${idx + 1}. ${r.source_entity} --[${r.relationship_type}]--> ${r.target_entity}`);
        console.log(`      Confidence: ${parseFloat(r.confidence_score || 0).toFixed(2)}`);
        if (r.context) {
          const context = r.context.length > 100 ? r.context.substring(0, 100) + '...' : r.context;
          console.log(`      Evidence: "${context}"`);
        }
      });
    }
    console.log(`\n   ✅ Total relationships: ${totalRelationships}\n`);

    // Check paper_entities links
    const paperEntitiesCheck = await db.query(
      'SELECT COUNT(*) as count FROM paper_entities WHERE paper_id = $1',
      [paperId]
    );
    const paperEntitiesCount = parseInt(paperEntitiesCheck[0].count);
    console.log(`🔗 Paper-Entity Links: ${paperEntitiesCount} links created ✅\n`);

    // Final summary
    console.log('═'.repeat(70));
    console.log('📊 TEST SUMMARY');
    console.log('═'.repeat(70));
    console.log(`✅ Paper processed: ${paper.processed ? 'Yes' : 'No'}`);
    console.log(`✅ Entities extracted: ${totalEntities}`);
    console.log(`✅ Relationships extracted: ${totalRelationships}`);
    console.log(`✅ Paper-entity links: ${paperEntitiesCount}`);
    console.log(`✅ Processing time: ${(processingTime / 1000).toFixed(2)}s`);
    console.log('═'.repeat(70) + '\n');

    if (paper.processed && totalEntities > 0 && totalRelationships > 0) {
      console.log('✅ END-TO-END TEST PASSED!\n');
      console.log('The pipeline successfully processed a paper from arXiv → PDF → Entities → Relationships → Database.\n');
      process.exit(0);
    } else {
      console.log('⚠️  TEST INCOMPLETE\n');
      if (!paper.processed) {
        console.log('❌ Paper was not marked as processed');
      }
      if (totalEntities === 0) {
        console.log('❌ No entities were extracted');
      }
      if (totalRelationships === 0) {
        console.log('⚠️  No relationships were extracted (may be normal if <2 entities found)');
      }
      process.exit(1);
    }

  } catch (error: any) {
    console.error('\n❌ TEST FAILED\n');
    console.error('Error:', error.message);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    await orchestrator.close();
    await db.close();
  }
}

if (require.main === module) {
  testPipeline();
}

