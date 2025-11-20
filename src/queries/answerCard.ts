/**
 * Answer Card Formatter
 * Creates human-readable "answer cards" in dev mode
 */

import { QueryResultWithMetadata } from '../agents/queryMetadata';

/**
 * Format query results as a human-readable answer card
 * Shows the question, detected intent, execution route, results, and metadata
 */
export function formatAnswerCard(
  question: string,
  result: QueryResultWithMetadata,
  devMode: boolean = true
): string {
  if (!devMode) {
    // Production mode: minimal output
    return formatMinimalOutput(result);
  }

  const { results, metadata } = result;
  const lines: string[] = [];

  // Header
  lines.push('');
  lines.push('╔════════════════════════════════════════════════════════════════╗');
  lines.push('║                    ANSWER CARD                                  ║');
  lines.push('╚════════════════════════════════════════════════════════════════╝');
  lines.push('');

  // Question
  lines.push('📝 Question:');
  lines.push(`   "${question}"`);
  lines.push('');

  // Intent & Route
  lines.push('🎯 Intent Detection:');
  lines.push(`   Intent: ${metadata.detectedIntent || 'unknown'}`);
  lines.push(`   Route: ${metadata.executionRoute || 'unknown'}`);
  if (metadata.intentConfidence !== undefined) {
    lines.push(`   Confidence: ${(metadata.intentConfidence * 100).toFixed(1)}%`);
  }
  lines.push('');

  // Execution Info
  lines.push('⚙️  Execution:');
  lines.push(`   Route: ${metadata.executionRoute}`);
  lines.push(`   Time: ${metadata.executionTimeMs}ms`);
  if (metadata.sqlQuery) {
    lines.push(`   SQL: ${truncateSQL(metadata.sqlQuery, 100)}`);
  }
  lines.push('');

  // Fallbacks
  if (metadata.fallbacks && metadata.fallbacks.length > 0) {
    lines.push('🔄 Fallbacks:');
    metadata.fallbacks.forEach((fb, i) => {
      lines.push(`   ${i + 1}. ${fb.from} → ${fb.to}: ${fb.reason}`);
    });
    lines.push('');
  }

  // Warnings
  if (metadata.warnings && metadata.warnings.length > 0) {
    lines.push('⚠️  Warnings:');
    metadata.warnings.forEach(w => lines.push(`   • ${w}`));
    lines.push('');
  }

  // Errors
  if (metadata.errors && metadata.errors.length > 0) {
    lines.push('❌ Errors:');
    metadata.errors.forEach(e => lines.push(`   • ${e}`));
    lines.push('');
  }

  // Results
  lines.push(`📊 Results: ${metadata.resultCount} found`);
  lines.push('');

  if (results.length === 0) {
    lines.push('   (No results found)');
  } else {
    // Format results based on type
    if (results[0].count !== undefined) {
      // Count result
      lines.push(`   Count: ${results[0].count}`);
      if (results[0].description) {
        lines.push(`   📝 ${results[0].description}`);
      }
    } else {
      // Paper/entity results
      const displayCount = Math.min(results.length, 5);
      for (let i = 0; i < displayCount; i++) {
        const r = results[i];
        lines.push(`   ${i + 1}. ${formatResultItem(r)}`);
      }
      if (results.length > displayCount) {
        lines.push(`   ... and ${results.length - displayCount} more`);
      }
    }
  }

  lines.push('');
  lines.push('╔════════════════════════════════════════════════════════════════╗');
  lines.push('╚════════════════════════════════════════════════════════════════╝');
  lines.push('');

  return lines.join('\n');
}

/**
 * Format a single result item
 */
function formatResultItem(item: any): string {
  if (item.title) {
    // Paper result
    const title = item.title.length > 60 ? item.title.substring(0, 60) + '...' : item.title;
    const date = item.published_date ? ` (${new Date(item.published_date).toLocaleDateString()})` : '';
    return `${title}${date}`;
  } else if (item.name) {
    // Entity result
    return `${item.name} (${item.entity_type || 'entity'})`;
  } else if (item.neighbor_name) {
    // Neighbor result
    return `${item.neighbor_name} --[${item.relationship_type}]--> (${item.relationship_count} relationships)`;
  } else {
    // Generic result
    return JSON.stringify(item).substring(0, 80);
  }
}

/**
 * Format minimal output for production mode
 */
function formatMinimalOutput(result: QueryResultWithMetadata): string {
  const { results, metadata } = result;
  const lines: string[] = [];

  lines.push(`✅ Found ${metadata.resultCount} result(s)\n`);

  if (results.length > 0) {
    if (results[0].count !== undefined) {
      lines.push(`Count: ${results[0].count}\n`);
    } else {
      results.slice(0, 10).forEach((r, i) => {
        lines.push(`${i + 1}. ${formatResultItem(r)}`);
      });
      if (results.length > 10) {
        lines.push(`\n... and ${results.length - 10} more`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Truncate SQL query for display
 */
function truncateSQL(sql: string, maxLength: number): string {
  if (sql.length <= maxLength) return sql;
  return sql.substring(0, maxLength - 3) + '...';
}

