import * as dotenv from 'dotenv';
import { DatabaseClient } from '../database/client';

dotenv.config();

/**
 * Query: Which papers improve on the original 3DGS method?
 * Limits results to 10 papers
 */

async function main() {
  const db = new DatabaseClient();

  try {
    console.log('🔍 Query: Which papers improve on the original 3DGS method?\n');
    console.log('   Limiting to top 10 papers...\n');
    
    // Test connection
    await db.testConnection();

    // Query papers that improve on 3DGS
    // Look for relationships where 3DGS is the TARGET (being improved upon)
    // OR where 3DGS is the SOURCE (the paper's method) and it improves something
    const query = `
      SELECT DISTINCT
        p.id,
        p.arxiv_id,
        p.title,
        p.authors,
        p.published_date,
        p.arxiv_url,
        target_e.name as method_name,
        r.relationship_type,
        r.context,
        r.confidence_score
      FROM papers p
      JOIN relationships r ON p.id = r.paper_id
      JOIN entities target_e ON r.target_entity_id = target_e.id
      JOIN entities source_e ON r.source_entity_id = source_e.id
      WHERE (
        -- Case 1: 3DGS is the target (being improved upon)
        (target_e.canonical_name ILIKE '%3d gaussian splatting%'
          OR target_e.canonical_name ILIKE '%3dgs%'
          OR target_e.canonical_name ILIKE '%gaussian splatting%')
        AND target_e.entity_type = 'method'
        AND r.relationship_type IN ('improves', 'extends', 'enhances')
      )
      OR (
        -- Case 2: 3DGS is the source but paper title suggests it's an improvement
        (source_e.canonical_name ILIKE '%3d gaussian splatting%'
          OR source_e.canonical_name ILIKE '%3dgs%')
        AND (p.title ILIKE '%improve%' OR p.title ILIKE '%enhance%' OR p.title ILIKE '%extend%' OR p.title ILIKE '%better%')
        AND r.relationship_type = 'improves'
      )
      ORDER BY p.published_date DESC, r.confidence_score DESC
      LIMIT 10
    `;

    const results = await db.query(query);

    if (results.length === 0) {
      console.log('❌ No papers found that improve on 3DGS.');
      console.log('   Make sure you have processed some papers first by running: npm start\n');
      return;
    }

    console.log(`✅ Found ${results.length} papers that improve on 3DGS:\n`);
    console.log('─'.repeat(80));

    results.forEach((paper: any, idx: number) => {
      console.log(`\n${idx + 1}. ${paper.title}`);
      console.log(`   📅 Published: ${paper.published_date || 'Unknown'}`);
      console.log(`   👥 Authors: ${Array.isArray(paper.authors) ? paper.authors.slice(0, 3).join(', ') + (paper.authors.length > 3 ? '...' : '') : 'N/A'}`);
      console.log(`   🔗 arXiv ID: ${paper.arxiv_id}`);
      console.log(`   🌐 URL: ${paper.arxiv_url || 'N/A'}`);
      const confidence = typeof paper.confidence_score === 'number' 
        ? paper.confidence_score 
        : parseFloat(paper.confidence_score || '0');
      console.log(`   🔗 Relationship: ${paper.relationship_type} (confidence: ${confidence.toFixed(2)})`);
      if (paper.context) {
        const contextPreview = paper.context.length > 150 
          ? paper.context.substring(0, 150) + '...' 
          : paper.context;
        console.log(`   💬 Context: "${contextPreview}"`);
      }
      console.log('─'.repeat(80));
    });

    console.log(`\n📊 Total: ${results.length} papers\n`);

  } catch (error) {
    console.error('❌ Error querying database:', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main();
}

