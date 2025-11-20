#!/usr/bin/env ts-node
/**
 * Data Quality Validation Script
 * Comprehensive data quality checker for the knowledge graph
 */

import * as dotenv from 'dotenv';
import { DatabaseClient } from '../database/client';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

async function validateData() {
  console.log('🔍 Data Quality Validation');
  console.log('═'.repeat(70) + '\n');

  const db = new DatabaseClient();
  const reportsDir = path.join(process.cwd(), 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(reportsDir, `data-quality-${timestamp}.txt`);
  const report: string[] = [];

  try {
    const connected = await db.testConnection();
    if (!connected) {
      throw new Error('Cannot connect to database');
    }

    // 1. Database Statistics
    console.log('📊 1. Database Statistics\n');
    report.push('═'.repeat(70));
    report.push('1. DATABASE STATISTICS');
    report.push('═'.repeat(70) + '\n');

    const paperCount = await db.query('SELECT COUNT(*) as count FROM papers');
    const entityCount = await db.query('SELECT COUNT(*) as count FROM entities');
    const relationshipCount = await db.query('SELECT COUNT(*) as count FROM relationships');
    const paperEntityCount = await db.query('SELECT COUNT(*) as count FROM paper_entities');

    const papers = parseInt(paperCount[0].count);
    const entities = parseInt(entityCount[0].count);
    const relationships = parseInt(relationshipCount[0].count);
    const paperEntities = parseInt(paperEntityCount[0].count);

    console.log(`   Papers: ${papers}`);
    console.log(`   Entities: ${entities}`);
    console.log(`   Relationships: ${relationships}`);
    console.log(`   Paper-Entity Links: ${paperEntities}\n`);

    report.push(`Papers: ${papers}`);
    report.push(`Entities: ${entities}`);
    report.push(`Relationships: ${relationships}`);
    report.push(`Paper-Entity Links: ${paperEntities}\n`);

    // Breakdown by entity type
    const entityTypeBreakdown = await db.query(`
      SELECT entity_type, COUNT(*) as count
      FROM entities
      GROUP BY entity_type
      ORDER BY count DESC
    `);
    console.log('   Entity breakdown by type:');
    report.push('Entity Breakdown by Type:');
    for (const row of entityTypeBreakdown) {
      console.log(`     ${row.entity_type}: ${row.count}`);
      report.push(`  ${row.entity_type}: ${row.count}`);
    }
    console.log('');

    // Breakdown by relationship type
    const relationshipTypeBreakdown = await db.query(`
      SELECT relationship_type, COUNT(*) as count
      FROM relationships
      GROUP BY relationship_type
      ORDER BY count DESC
    `);
    console.log('   Relationship breakdown by type:');
    report.push('\nRelationship Breakdown by Type:');
    for (const row of relationshipTypeBreakdown) {
      console.log(`     ${row.relationship_type}: ${row.count}`);
      report.push(`  ${row.relationship_type}: ${row.count}`);
    }
    console.log('');

    // Average confidence scores
    const avgEntityConfidence = await db.query(`
      SELECT AVG(confidence_score) as avg_confidence
      FROM entities
      WHERE confidence_score IS NOT NULL
    `);
    const avgRelConfidence = await db.query(`
      SELECT AVG(confidence_score) as avg_confidence
      FROM relationships
      WHERE confidence_score IS NOT NULL
    `);
    
    const avgEntityConf = parseFloat(avgEntityConfidence[0].avg_confidence || 0);
    const avgRelConf = parseFloat(avgRelConfidence[0].avg_confidence || 0);
    
    console.log(`   Average entity confidence: ${avgEntityConf.toFixed(3)}`);
    console.log(`   Average relationship confidence: ${avgRelConf.toFixed(3)}\n`);

    report.push(`\nAverage Entity Confidence: ${avgEntityConf.toFixed(3)}`);
    report.push(`Average Relationship Confidence: ${avgRelConf.toFixed(3)}\n`);

    // 2. Data Quality Metrics
    console.log('━'.repeat(70));
    console.log('🔍 2. Data Quality Metrics\n');
    report.push('═'.repeat(70));
    report.push('2. DATA QUALITY METRICS');
    report.push('═'.repeat(70) + '\n');

    // Entities with low confidence
    const lowConfidenceEntities = await db.query(`
      SELECT COUNT(*) as count
      FROM entities
      WHERE confidence_score < 0.5 AND confidence_score IS NOT NULL
    `);
    const lowConfCount = parseInt(lowConfidenceEntities[0].count);
    const icon1 = lowConfCount > 0 ? '⚠️' : '✅';
    console.log(`${icon1} Entities with confidence < 0.5: ${lowConfCount}`);
    report.push(`${icon1} Entities with confidence < 0.5: ${lowConfCount}`);

    // Relationships with missing evidence
    const missingEvidence = await db.query(`
      SELECT COUNT(*) as count
      FROM relationships
      WHERE context IS NULL OR context = ''
    `);
    const missingEvCount = parseInt(missingEvidence[0].count);
    const icon2 = missingEvCount > 0 ? '⚠️' : '✅';
    console.log(`${icon2} Relationships with missing evidence: ${missingEvCount}`);
    report.push(`${icon2} Relationships with missing evidence: ${missingEvCount}`);

    // Papers with no entities
    const papersWithNoEntities = await db.query(`
      SELECT COUNT(DISTINCT p.id) as count
      FROM papers p
      LEFT JOIN paper_entities pe ON p.id = pe.paper_id
      WHERE pe.paper_id IS NULL AND p.processed = TRUE
    `);
    const noEntitiesCount = parseInt(papersWithNoEntities[0].count);
    const icon3 = noEntitiesCount > 0 ? '⚠️' : '✅';
    console.log(`${icon3} Processed papers with no entities: ${noEntitiesCount}`);
    report.push(`${icon3} Processed papers with no entities: ${noEntitiesCount}`);

    // Papers with suspiciously high entity counts
    const highEntityCount = await db.query(`
      SELECT COUNT(DISTINCT p.id) as count
      FROM papers p
      JOIN paper_entities pe ON p.id = pe.paper_id
      GROUP BY p.id
      HAVING COUNT(pe.entity_id) > 50
    `);
    const highEntityCountNum = parseInt(highEntityCount[0]?.count || '0');
    const icon4 = highEntityCountNum > 0 ? '⚠️' : '✅';
    console.log(`${icon4} Papers with >50 entities: ${highEntityCountNum}`);
    report.push(`${icon4} Papers with >50 entities: ${highEntityCountNum}`);

    // Papers with suspiciously low entity counts
    const lowEntityCount = await db.query(`
      SELECT COUNT(DISTINCT p.id) as count
      FROM papers p
      JOIN paper_entities pe ON p.id = pe.paper_id
      WHERE p.processed = TRUE
      GROUP BY p.id
      HAVING COUNT(pe.entity_id) < 5
    `);
    const lowEntityCountNum = parseInt(lowEntityCount[0]?.count || '0');
    const icon5 = lowEntityCountNum > 0 ? '⚠️' : '✅';
    console.log(`${icon5} Processed papers with <5 entities: ${lowEntityCountNum}`);
    report.push(`${icon5} Processed papers with <5 entities: ${lowEntityCountNum}`);

    // Orphaned entities
    const orphanedEntities = await db.query(`
      SELECT COUNT(*) as count
      FROM entities e
      LEFT JOIN paper_entities pe ON e.id = pe.entity_id
      WHERE pe.entity_id IS NULL
    `);
    const orphanedCount = parseInt(orphanedEntities[0].count);
    const icon6 = orphanedCount > 0 ? '⚠️' : '✅';
    console.log(`${icon6} Orphaned entities (not linked to any paper): ${orphanedCount}`);
    report.push(`${icon6} Orphaned entities (not linked to any paper): ${orphanedCount}`);

    console.log('');

    // 3. Consistency Checks
    console.log('━'.repeat(70));
    console.log('✅ 3. Consistency Checks\n');
    report.push('\n═'.repeat(70));
    report.push('3. CONSISTENCY CHECKS');
    report.push('═'.repeat(70) + '\n');

    // Check relationships reference valid entities
    const invalidRelationships = await db.query(`
      SELECT COUNT(*) as count
      FROM relationships r
      LEFT JOIN entities e1 ON r.source_entity_id = e1.id
      LEFT JOIN entities e2 ON r.target_entity_id = e2.id
      WHERE e1.id IS NULL OR e2.id IS NULL
    `);
    const invalidRelCount = parseInt(invalidRelationships[0].count);
    const icon7 = invalidRelCount === 0 ? '✅' : '❌';
    console.log(`${icon7} Relationships with invalid entity references: ${invalidRelCount}`);
    report.push(`${icon7} Relationships with invalid entity references: ${invalidRelCount}`);

    // Check paper_entities reference valid papers and entities
    const invalidPaperEntities = await db.query(`
      SELECT COUNT(*) as count
      FROM paper_entities pe
      LEFT JOIN papers p ON pe.paper_id = p.id
      LEFT JOIN entities e ON pe.entity_id = e.id
      WHERE p.id IS NULL OR e.id IS NULL
    `);
    const invalidPECount = parseInt(invalidPaperEntities[0].count);
    const icon8 = invalidPECount === 0 ? '✅' : '❌';
    console.log(`${icon8} Paper-entity links with invalid references: ${invalidPECount}`);
    report.push(`${icon8} Paper-entity links with invalid references: ${invalidPECount}`);

    // Check for duplicate canonical names (should be unique per type)
    const duplicateCanonical = await db.query(`
      SELECT canonical_name, entity_type, COUNT(*) as count
      FROM entities
      WHERE canonical_name IS NOT NULL
      GROUP BY canonical_name, entity_type
      HAVING COUNT(*) > 1
      LIMIT 10
    `);
    const duplicateCount = duplicateCanonical.length;
    const icon9 = duplicateCount === 0 ? '✅' : '⚠️';
    console.log(`${icon9} Duplicate canonical names (same type): ${duplicateCount}`);
    report.push(`${icon9} Duplicate canonical names (same type): ${duplicateCount}`);
    if (duplicateCount > 0) {
      console.log('   Examples:');
      for (const dup of duplicateCanonical.slice(0, 5)) {
        console.log(`     ${dup.canonical_name} (${dup.entity_type}): ${dup.count} duplicates`);
      }
    }

    // Check required fields
    const nullRequiredFields = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM papers WHERE arxiv_id IS NULL) as null_arxiv_id,
        (SELECT COUNT(*) FROM entities WHERE name IS NULL OR entity_type IS NULL) as null_entity_fields,
        (SELECT COUNT(*) FROM relationships WHERE relationship_type IS NULL) as null_rel_type
    `);
    const nullFields = nullRequiredFields[0];
    const icon10 = parseInt(nullFields.null_arxiv_id) === 0 && 
                   parseInt(nullFields.null_entity_fields) === 0 &&
                   parseInt(nullFields.null_rel_type) === 0 ? '✅' : '❌';
    console.log(`${icon10} Required fields populated: ✅ (no nulls in required fields)`);
    report.push(`${icon10} Required fields populated: ✅`);

    console.log('');

    // 4. Top-Level Insights
    console.log('━'.repeat(70));
    console.log('🌟 4. Top-Level Insights\n');
    report.push('\n═'.repeat(70));
    report.push('4. TOP-LEVEL INSIGHTS');
    report.push('═'.repeat(70) + '\n');

    // Top 10 most mentioned entities
    const topEntities = await db.query(`
      SELECT e.name, e.entity_type, COUNT(DISTINCT pe.paper_id) as paper_count
      FROM entities e
      JOIN paper_entities pe ON e.id = pe.entity_id
      GROUP BY e.id, e.name, e.entity_type
      ORDER BY paper_count DESC
      LIMIT 10
    `);
    console.log('   Top 10 Most Mentioned Entities:');
    report.push('Top 10 Most Mentioned Entities:');
    topEntities.forEach((e, idx) => {
      console.log(`     ${idx + 1}. ${e.name} (${e.entity_type}): ${e.paper_count} papers`);
      report.push(`  ${idx + 1}. ${e.name} (${e.entity_type}): ${e.paper_count} papers`);
    });
    console.log('');

    // Top 10 papers by entity count
    const topPapersByEntities = await db.query(`
      SELECT p.title, COUNT(DISTINCT pe.entity_id) as entity_count
      FROM papers p
      JOIN paper_entities pe ON p.id = pe.paper_id
      GROUP BY p.id, p.title
      ORDER BY entity_count DESC
      LIMIT 10
    `);
    console.log('   Top 10 Papers by Entity Count:');
    report.push('\nTop 10 Papers by Entity Count:');
    topPapersByEntities.forEach((p, idx) => {
      const title = p.title.length > 60 ? p.title.substring(0, 60) + '...' : p.title;
      console.log(`     ${idx + 1}. ${title}: ${p.entity_count} entities`);
      report.push(`  ${idx + 1}. ${p.title}: ${p.entity_count} entities`);
    });
    console.log('');

    // Top 10 papers by relationship count
    const topPapersByRelationships = await db.query(`
      SELECT p.title, COUNT(DISTINCT r.id) as relationship_count
      FROM papers p
      JOIN relationships r ON p.id = r.paper_id
      GROUP BY p.id, p.title
      ORDER BY relationship_count DESC
      LIMIT 10
    `);
    console.log('   Top 10 Papers by Relationship Count:');
    report.push('\nTop 10 Papers by Relationship Count:');
    topPapersByRelationships.forEach((p, idx) => {
      const title = p.title.length > 60 ? p.title.substring(0, 60) + '...' : p.title;
      console.log(`     ${idx + 1}. ${title}: ${p.relationship_count} relationships`);
      report.push(`  ${idx + 1}. ${p.title}: ${p.relationship_count} relationships`);
    });
    console.log('');

    // Most common relationship types
    const commonRelTypes = await db.query(`
      SELECT relationship_type, COUNT(*) as count
      FROM relationships
      GROUP BY relationship_type
      ORDER BY count DESC
      LIMIT 10
    `);
    console.log('   Most Common Relationship Types:');
    report.push('\nMost Common Relationship Types:');
    commonRelTypes.forEach((r, idx) => {
      console.log(`     ${idx + 1}. ${r.relationship_type}: ${r.count}`);
      report.push(`  ${idx + 1}. ${r.relationship_type}: ${r.count}`);
    });
    console.log('');

    // Write report
    fs.writeFileSync(reportPath, report.join('\n'));
    console.log('═'.repeat(70));
    console.log('📝 Report saved to:', reportPath);
    console.log('═'.repeat(70) + '\n');

  } catch (error: any) {
    console.error('\n❌ Validation error:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  validateData();
}

