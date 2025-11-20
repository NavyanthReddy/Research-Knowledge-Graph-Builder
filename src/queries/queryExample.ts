import * as dotenv from 'dotenv';
import { DatabaseClient } from '../database/client';

dotenv.config();

/**
 * Example query script demonstrating how to query the knowledge graph
 * Run with: npm run query
 */

async function main() {
  const db = new DatabaseClient();

  try {
    console.log('🔍 Querying Gaussian Splatting Knowledge Graph\n');
    
    // Test connection
    await db.testConnection();

    // ============================================================================
    // Query 1: Papers that improve on 3D Gaussian Splatting
    // ============================================================================
    console.log('1️⃣  Papers that improve on 3D Gaussian Splatting:');
    console.log('   ─────────────────────────────────────────────────────────');
    const improvements = await db.getPapersImprovingMethod('3d gaussian splatting');
    
    if (improvements.length === 0) {
      console.log('   No papers found. Make sure you have processed some papers first.\n');
    } else {
      improvements.slice(0, 5).forEach((p: any, idx: number) => {
        console.log(`   ${idx + 1}. ${p.title.substring(0, 70)}${p.title.length > 70 ? '...' : ''}`);
        console.log(`      📅 Published: ${p.published_date || 'Unknown'}`);
        console.log(`      🔗 Relationship: ${p.relationship_type} (confidence: ${p.confidence_score?.toFixed(2) || 'N/A'})`);
        if (p.context) {
          console.log(`      💬 Context: "${p.context.substring(0, 100)}${p.context.length > 100 ? '...' : ''}"`);
        }
        console.log();
      });
      console.log(`   📊 Total: ${improvements.length} papers\n`);
    }

    // ============================================================================
    // Query 2: Most commonly used methods
    // ============================================================================
    console.log('2️⃣  Most commonly used methods:');
    console.log('   ─────────────────────────────────────────────────────────');
    const methods = await db.getMostCommonMethods(10);
    
    if (methods.length === 0) {
      console.log('   No methods found. Make sure you have processed some papers first.\n');
    } else {
      methods.forEach((m: any, idx: number) => {
        console.log(`   ${idx + 1}. ${m.name}`);
        console.log(`      📄 Mentioned in ${m.paper_count} papers`);
        if (m.description) {
          console.log(`      📝 ${m.description.substring(0, 80)}${m.description.length > 80 ? '...' : ''}`);
        }
        if (m.avg_significance) {
          console.log(`      ⭐ Avg significance: ${m.avg_significance.toFixed(2)}`);
        }
        console.log();
      });
    }

    // ============================================================================
    // Query 3: Related papers by shared concepts
    // ============================================================================
    console.log('3️⃣  Papers related by shared concepts (splatting, rendering):');
    console.log('   ─────────────────────────────────────────────────────────');
    const related = await db.getRelatedPapersByConcepts(['splatting', 'rendering'], 5);
    
    if (related.length === 0) {
      console.log('   No related papers found.\n');
    } else {
      related.forEach((p: any, idx: number) => {
        console.log(`   ${idx + 1}. ${p.title.substring(0, 70)}${p.title.length > 70 ? '...' : ''}`);
        console.log(`      🔗 Shared concepts: ${p.concept_names.join(', ')}`);
        console.log(`      📊 Matching concepts: ${p.matching_concepts}`);
        console.log();
      });
    }

    // ============================================================================
    // Custom Query 4: All entities by type
    // ============================================================================
    console.log('4️⃣  Entity counts by type:');
    console.log('   ─────────────────────────────────────────────────────────');
    
    const entityStats = await db.query(`
      SELECT entity_type, COUNT(*) as count
      FROM entities
      GROUP BY entity_type
      ORDER BY count DESC
    `);
    
    entityStats.forEach((stat: any) => {
      console.log(`   ${stat.entity_type}: ${stat.count} entities`);
    });
    console.log();

    // ============================================================================
    // Custom Query 5: Relationship types distribution
    // ============================================================================
    console.log('5️⃣  Relationship types distribution:');
    console.log('   ─────────────────────────────────────────────────────────');
    
    const relStats = await db.query(`
      SELECT relationship_type, COUNT(*) as count
      FROM relationships
      GROUP BY relationship_type
      ORDER BY count DESC
    `);
    
    relStats.forEach((stat: any) => {
      console.log(`   ${stat.relationship_type}: ${stat.count} relationships`);
    });
    console.log();

  } catch (error) {
    console.error('Error querying database:', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

// Add query method to DatabaseClient if not exists
if (require.main === module) {
  main();
}

