#!/usr/bin/env ts-node
/**
 * Example Queries Demo
 * Runs all 5 example queries and displays results beautifully
 */

import * as dotenv from 'dotenv';
import { DatabaseClient } from '../database/client';

dotenv.config();

interface QueryResult {
  title: string;
  description: string;
  sql: string;
  data: any[];
}

async function runQueries() {
  console.log('\n📊 Example Queries Demo');
  console.log('═'.repeat(70));
  console.log('Running all 5 required example queries\n');

  const db = new DatabaseClient();

  try {
    // Test connection
    const connected = await db.testConnection();
    if (!connected) {
      throw new Error('Cannot connect to database. Check DATABASE_URL in .env');
    }

    const queries: QueryResult[] = [];

    // Query 1: Papers that improve on 3D Gaussian Splatting
    console.log('━'.repeat(70));
    console.log('📊 QUERY 1: Papers Improving on 3D Gaussian Splatting');
    console.log('━'.repeat(70));
    console.log('\nDescription: Finds papers that improve, extend, or enhance 3D Gaussian Splatting\n');
    
    const query1SQL = `
      SELECT DISTINCT
        p.id,
        p.arxiv_id,
        p.title,
        p.authors,
        p.published_date,
        e.name as method_name,
        r.relationship_type,
        r.context,
        r.confidence_score
      FROM papers p
      JOIN relationships r ON p.id = r.paper_id
      JOIN entities e ON r.target_entity_id = e.id
      WHERE e.canonical_name ILIKE '%3d gaussian splatting%'
        AND e.entity_type = 'method'
        AND r.relationship_type IN ('improves', 'extends', 'enhances')
      ORDER BY p.published_date DESC, r.confidence_score DESC
      LIMIT 10
    `;
    console.log('SQL:');
    console.log(query1SQL.split('\n').map(line => `   ${line}`).join('\n'));
    console.log('');
    
    const query1Results = await db.query(query1SQL);
    queries.push({
      title: 'Papers Improving on 3D Gaussian Splatting',
      description: 'Finds papers that improve, extend, or enhance 3D Gaussian Splatting',
      sql: query1SQL,
      data: query1Results,
    });

    displayTable(query1Results, ['title', 'arxiv_id', 'relationship_type', 'confidence_score']);
    console.log(`\n✅ Found ${query1Results.length} papers\n`);

    // Query 2: Most popular methods
    console.log('━'.repeat(70));
    console.log('📊 QUERY 2: Most Popular Methods');
    console.log('━'.repeat(70));
    console.log('\nDescription: Methods mentioned in the most papers, ordered by frequency\n');
    
    const query2SQL = `
      SELECT 
        e.name,
        e.description,
        COUNT(DISTINCT pe.paper_id) as paper_count,
        AVG(pe.significance_score) as avg_significance
      FROM entities e
      JOIN paper_entities pe ON e.id = pe.entity_id
      WHERE e.entity_type = 'method'
      GROUP BY e.id, e.name, e.description
      ORDER BY paper_count DESC, avg_significance DESC
      LIMIT 10
    `;
    console.log('SQL:');
    console.log(query2SQL.split('\n').map(line => `   ${line}`).join('\n'));
    console.log('');
    
    const query2Results = await db.query(query2SQL);
    queries.push({
      title: 'Most Popular Methods',
      description: 'Methods mentioned in the most papers',
      sql: query2SQL,
      data: query2Results,
    });

    displayTable(query2Results, ['name', 'paper_count', 'avg_significance']);
    console.log(`\n✅ Found ${query2Results.length} methods\n`);

    // Query 3: Common evaluation datasets
    console.log('━'.repeat(70));
    console.log('📊 QUERY 3: Common Evaluation Datasets');
    console.log('━'.repeat(70));
    console.log('\nDescription: Datasets most commonly used for evaluation\n');
    
    const query3SQL = `
      SELECT 
        e.name,
        e.description,
        COUNT(DISTINCT pe.paper_id) as paper_count,
        AVG(pe.significance_score) as avg_significance
      FROM entities e
      JOIN paper_entities pe ON e.id = pe.entity_id
      WHERE e.entity_type = 'dataset'
      GROUP BY e.id, e.name, e.description
      ORDER BY paper_count DESC, avg_significance DESC
      LIMIT 10
    `;
    console.log('SQL:');
    console.log(query3SQL.split('\n').map(line => `   ${line}`).join('\n'));
    console.log('');
    
    const query3Results = await db.query(query3SQL);
    queries.push({
      title: 'Common Evaluation Datasets',
      description: 'Datasets most commonly used for evaluation',
      sql: query3SQL,
      data: query3Results,
    });

    displayTable(query3Results, ['name', 'paper_count', 'avg_significance']);
    console.log(`\n✅ Found ${query3Results.length} datasets\n`);

    // Query 4: Research trends over time
    console.log('━'.repeat(70));
    console.log('📊 QUERY 4: Research Trends Over Time');
    console.log('━'.repeat(70));
    console.log('\nDescription: Number of papers published per year\n');
    
    const query4SQL = `
      SELECT 
        EXTRACT(YEAR FROM published_date) as year,
        COUNT(*) as paper_count
      FROM papers
      WHERE published_date IS NOT NULL
      GROUP BY year
      ORDER BY year DESC
      LIMIT 10
    `;
    console.log('SQL:');
    console.log(query4SQL.split('\n').map(line => `   ${line}`).join('\n'));
    console.log('');
    
    const query4Results = await db.query(query4SQL);
    queries.push({
      title: 'Research Trends Over Time',
      description: 'Number of papers published per year',
      sql: query4SQL,
      data: query4Results,
    });

    displayTable(query4Results, ['year', 'paper_count']);
    console.log(`\n✅ Found ${query4Results.length} years\n`);

    // Query 5: Papers with most novel contributions
    console.log('━'.repeat(70));
    console.log('📊 QUERY 5: Papers with Most Novel Contributions');
    console.log('━'.repeat(70));
    console.log('\nDescription: Papers that introduce new entities (high entity count, high confidence)\n');
    
    const query5SQL = `
      SELECT 
        p.id,
        p.arxiv_id,
        p.title,
        p.published_date,
        COUNT(DISTINCT e.id) as entity_count,
        COUNT(DISTINCT r.id) as relationship_count,
        AVG(e.confidence_score) as avg_confidence
      FROM papers p
      JOIN paper_entities pe ON p.id = pe.paper_id
      JOIN entities e ON pe.entity_id = e.id
      LEFT JOIN relationships r ON p.id = r.paper_id
      WHERE p.processed = TRUE
      GROUP BY p.id, p.arxiv_id, p.title, p.published_date
      ORDER BY entity_count DESC, relationship_count DESC, avg_confidence DESC
      LIMIT 10
    `;
    console.log('SQL:');
    console.log(query5SQL.split('\n').map(line => `   ${line}`).join('\n'));
    console.log('');
    
    const query5Results = await db.query(query5SQL);
    queries.push({
      title: 'Papers with Most Novel Contributions',
      description: 'Papers that introduce new entities',
      sql: query5SQL,
      data: query5Results,
    });

    displayTable(query5Results, ['title', 'entity_count', 'relationship_count', 'avg_confidence']);
    console.log(`\n✅ Found ${query5Results.length} papers\n`);

    // Final summary
    console.log('═'.repeat(70));
    console.log('📊 DEMO SUMMARY');
    console.log('═'.repeat(70));
    queries.forEach((q, idx) => {
      const icon = q.data.length > 0 ? '✅' : '⚠️ ';
      console.log(`${icon} Query ${idx + 1}: ${q.title} - ${q.data.length} results`);
    });
    console.log('═'.repeat(70) + '\n');

  } catch (error: any) {
    console.error('\n❌ Error running queries:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    await db.close();
  }
}

function displayTable(data: any[], columns: string[]) {
  if (data.length === 0) {
    console.log('   (No results found)\n');
    return;
  }

  // Calculate column widths
  const widths: { [key: string]: number } = {};
  columns.forEach(col => {
    widths[col] = Math.max(
      col.length,
      ...data.map(row => {
        const val = row[col];
        return val ? String(val).length : 0;
      })
    );
  });

  // Limit width to 50 for long columns
  Object.keys(widths).forEach(key => {
    if (widths[key] > 50) widths[key] = 50;
  });

  // Print header
  const headerRow = '┌' + columns.map(col => '─'.repeat(Math.min(widths[col] + 2, 52))).join('┬') + '┐';
  console.log(headerRow);
  const header = '│' + columns.map(col => {
    const width = Math.min(widths[col] + 2, 52);
    return ` ${col.padEnd(width - 1)}`;
  }).join('│') + '│';
  console.log(header);
  const separator = '├' + columns.map(col => '─'.repeat(Math.min(widths[col] + 2, 52))).join('┼') + '┤';
  console.log(separator);

  // Print rows (limit to 5 for display)
  const displayData = data.slice(0, 5);
  for (const row of displayData) {
    const rowStr = '│' + columns.map(col => {
      const val = row[col];
      let display = val !== null && val !== undefined ? String(val) : '';
      if (display.length > 48) display = display.substring(0, 45) + '...';
      const width = Math.min(widths[col] + 2, 52);
      return ` ${display.padEnd(width - 1)}`;
    }).join('│') + '│';
    console.log(rowStr);
  }

  // Print footer
  const footer = '└' + columns.map(col => '─'.repeat(Math.min(widths[col] + 2, 52))).join('┴') + '┘';
  console.log(footer);

  if (data.length > 5) {
    console.log(`\n   ... and ${data.length - 5} more results`);
  }
}

if (require.main === module) {
  runQueries();
}

