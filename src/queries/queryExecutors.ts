/**
 * Query Executors
 * Execute queries for each route type (graph, FTS, nl2sql)
 */

import { DatabaseClient } from '../database/client';
import { RoutingResult } from '../router';
import { validateAndSanitizeSQL, validateParameterCount } from './sqlValidator';
import { QueryResultWithMetadata, QueryMetadata } from '../agents/queryMetadata';

/**
 * Execute a graph query based on intent and parameters
 */
export async function executeGraphQuery(
  routing: RoutingResult,
  db: DatabaseClient
): Promise<QueryResultWithMetadata> {
  const startTime = Date.now();
  const metadata: QueryMetadata = {
    question: '', // Will be set by caller
    detectedIntent: routing.intent,
    executionRoute: 'graph',
    fallbacks: [],
    executionTimeMs: 0,
    resultCount: 0,
    warnings: [],
    errors: [],
  };

  try {
    let sql: string;
    let params: any[] = [];

    switch (routing.intent) {
      case "lineage": {
        // Papers that improve on a method
        const methodName = routing.parameters?.target_method || '';
        sql = `
          SELECT DISTINCT
            p.id,
            p.arxiv_id,
            p.title,
            p.authors,
            p.abstract,
            p.published_date,
            p.arxiv_url,
            source_e.name as source_method,
            target_e.name as target_method,
            r.relationship_type,
            r.context,
            r.confidence_score
          FROM papers p
          JOIN relationships r ON p.id = r.paper_id
          JOIN entities source_e ON r.source_entity_id = source_e.id
          JOIN entities target_e ON r.target_entity_id = target_e.id
          WHERE (target_e.canonical_name ILIKE $1 OR target_e.name ILIKE $1)
            AND target_e.entity_type = 'method'
            AND r.relationship_type IN ('improves', 'extends', 'enhances')
          ORDER BY p.published_date DESC, r.confidence_score DESC
          LIMIT 20
        `;
        params = [`%${methodName}%`];
        break;
      }

      case "introduces": {
        // Concepts/methods introduced by a paper
        const paperId = routing.parameters?.paper_id;
        if (paperId) {
          sql = `
            SELECT DISTINCT
              e.id,
              e.name,
              e.entity_type,
              e.description,
              e.confidence_score,
              pe.mention_count,
              pe.significance_score
            FROM entities e
            JOIN paper_entities pe ON e.id = pe.entity_id
            JOIN papers p ON pe.paper_id = p.id
            WHERE p.arxiv_id = $1
            ORDER BY pe.significance_score DESC, pe.mention_count DESC
            LIMIT 50
          `;
          params = [paperId];
        } else {
          throw new Error("Paper ID required for 'introduces' intent");
        }
        break;
      }

      case "extends": {
        // Papers that extend a base entity
        const baseEntity = routing.parameters?.base_entity || '';
        sql = `
          SELECT DISTINCT
            p.id,
            p.arxiv_id,
            p.title,
            p.authors,
            p.published_date,
            p.arxiv_url,
            source_e.name as extending_entity,
            target_e.name as base_entity,
            r.relationship_type,
            r.context,
            r.confidence_score
          FROM papers p
          JOIN relationships r ON p.id = r.paper_id
          JOIN entities source_e ON r.source_entity_id = source_e.id
          JOIN entities target_e ON r.target_entity_id = target_e.id
          WHERE (target_e.canonical_name ILIKE $1 OR target_e.name ILIKE $1)
            AND r.relationship_type IN ('extends', 'builds_on', 'generalizes')
          ORDER BY p.published_date DESC, r.confidence_score DESC
          LIMIT 20
        `;
        params = [`%${baseEntity}%`];
        break;
      }

      case "uses": {
        // Papers that use a dataset/metric/method
        const entityName = routing.parameters?.entity_name || '';
        sql = `
          SELECT DISTINCT
            p.id,
            p.arxiv_id,
            p.title,
            p.authors,
            p.published_date,
            p.arxiv_url,
            e.name as entity_name,
            e.entity_type,
            r.relationship_type,
            r.context
          FROM papers p
          JOIN relationships r ON p.id = r.paper_id
          JOIN entities e ON (r.source_entity_id = e.id OR r.target_entity_id = e.id)
          WHERE (e.canonical_name ILIKE $1 OR e.name ILIKE $1)
            AND r.relationship_type IN ('uses', 'evaluates', 'employs')
          ORDER BY p.published_date DESC
          LIMIT 20
        `;
        params = [`%${entityName}%`];
        break;
      }

      case "compares": {
        // Papers that compare with a method
        const comparedMethod = routing.parameters?.compared_method || '';
        sql = `
          SELECT DISTINCT
            p.id,
            p.arxiv_id,
            p.title,
            p.authors,
            p.published_date,
            p.arxiv_url,
            source_e.name as comparing_method,
            target_e.name as compared_method,
            r.relationship_type,
            r.context,
            r.confidence_score
          FROM papers p
          JOIN relationships r ON p.id = r.paper_id
          JOIN entities source_e ON r.source_entity_id = source_e.id
          JOIN entities target_e ON r.target_entity_id = target_e.id
          WHERE (target_e.canonical_name ILIKE $1 OR target_e.name ILIKE $1)
            AND r.relationship_type = 'compares'
          ORDER BY p.published_date DESC
          LIMIT 20
        `;
        params = [`%${comparedMethod}%`];
        break;
      }

      case "authored_by": {
        // Papers by an author
        const authorName = routing.parameters?.author_name || '';
        sql = `
          SELECT DISTINCT
            p.id,
            p.arxiv_id,
            p.title,
            p.authors,
            p.abstract,
            p.published_date,
            p.arxiv_url
          FROM papers p
          WHERE EXISTS (
            SELECT 1 FROM unnest(p.authors) AS author
            WHERE author ILIKE $1
          )
          ORDER BY p.published_date DESC
          LIMIT 20
        `;
        params = [`%${authorName}%`];
        break;
      }

      case "neighbors": {
        // Neighbors of an entity (connected entities)
        const entityName = routing.parameters?.entity_name || '';
        sql = `
          SELECT DISTINCT
            CASE 
              WHEN e1.canonical_name ILIKE $1 OR e1.name ILIKE $1 THEN e2.name
              ELSE e1.name
            END as neighbor_name,
            CASE 
              WHEN e1.canonical_name ILIKE $1 OR e1.name ILIKE $1 THEN e2.entity_type
              ELSE e1.entity_type
            END as neighbor_type,
            r.relationship_type,
            COUNT(*) as relationship_count
          FROM relationships r
          JOIN entities e1 ON r.source_entity_id = e1.id
          JOIN entities e2 ON r.target_entity_id = e2.id
          WHERE (e1.canonical_name ILIKE $1 OR e1.name ILIKE $1 
                 OR e2.canonical_name ILIKE $1 OR e2.name ILIKE $1)
            AND e1.id != e2.id
          GROUP BY neighbor_name, neighbor_type, r.relationship_type
          ORDER BY relationship_count DESC
          LIMIT 20
        `;
        params = [`%${entityName}%`];
        break;
      }

      case "most_common": {
        // Most/least common/popular entities of a specific type
        const entityType = routing.parameters?.entity_type || 'method';
        const limit = routing.parameters?.limit || 10;
        // Validate order parameter to prevent SQL injection
        const rawOrder = routing.parameters?.order || 'DESC';
        const order = (rawOrder === 'ASC' || rawOrder === 'DESC') ? rawOrder : 'DESC';
        sql = `
          SELECT 
            e.name,
            e.description,
            COUNT(DISTINCT pe.paper_id) as paper_count,
            AVG(pe.significance_score) as avg_significance
          FROM entities e
          JOIN paper_entities pe ON e.id = pe.entity_id
          WHERE e.entity_type = $1
          GROUP BY e.id, e.name, e.description
          ORDER BY paper_count ${order}, avg_significance ${order}
          LIMIT $2
        `;
        params = [entityType, limit];
        break;
      }

      default:
        throw new Error(`Unsupported graph intent: ${routing.intent}`);
    }

    // Validate and sanitize SQL
    const validation = validateAndSanitizeSQL(sql);
    if (!validation.valid || !validation.sanitized) {
      throw new Error(`SQL validation failed: ${validation.errors.join(', ')}`);
    }
    sql = validation.sanitized;

    // Validate parameters
    if (!validateParameterCount(sql, params)) {
      throw new Error('Parameter count mismatch');
    }

    // Execute query
    const results = await db.query(sql, params);
    
    metadata.resultCount = results.length;
    metadata.executionTimeMs = Date.now() - startTime;
    metadata.sqlQuery = sql;
    if (validation.warnings.length > 0) {
      metadata.warnings = validation.warnings;
    }

    return { results, metadata };

  } catch (error: any) {
    if (!metadata.errors) metadata.errors = [];
    metadata.errors.push(error.message || String(error));
    metadata.executionTimeMs = Date.now() - startTime;
    throw error;
  }
}

/**
 * Execute a full-text search (FTS) query
 */
export async function executeFTSQuery(
  routing: RoutingResult,
  db: DatabaseClient
): Promise<QueryResultWithMetadata> {
  const startTime = Date.now();
  const metadata: QueryMetadata = {
    question: '', // Will be set by caller
    detectedIntent: routing.intent,
    executionRoute: 'fts',
    fallbacks: [],
    executionTimeMs: 0,
    resultCount: 0,
    warnings: [],
    errors: [],
  };

  try {
    let sql: string;
    let params: any[] = [];

    switch (routing.intent) {
      case "focus": {
        // Papers that focus on a topic
        const topic = routing.parameters?.topic || '';
        const hasNegation = routing.parameters?.negation || false;
        
        if (hasNegation) {
          sql = `
            SELECT DISTINCT
              p.id,
              p.arxiv_id,
              p.title,
              p.authors,
              p.abstract,
              p.published_date,
              p.arxiv_url
            FROM papers p
            WHERE (p.title NOT ILIKE $1 AND p.abstract NOT ILIKE $1)
            ORDER BY p.published_date DESC
            LIMIT 20
          `;
        } else {
          sql = `
            SELECT DISTINCT
              p.id,
              p.arxiv_id,
              p.title,
              p.authors,
              p.abstract,
              p.published_date,
              p.arxiv_url,
              CASE
                WHEN p.title ILIKE $1 THEN 3
                WHEN p.abstract ILIKE $1 THEN 2
                ELSE 1
              END as relevance_score
            FROM papers p
            WHERE (p.title ILIKE $1 OR p.abstract ILIKE $1)
            ORDER BY relevance_score DESC, p.published_date DESC
            LIMIT 20
          `;
        }
        params = [`%${topic}%`];
        break;
      }

      case "count": {
        // Count papers/entities with optional filter
        const entityType = routing.parameters?.entity_type || 'paper';
        const hasNegation = routing.parameters?.negation || false;
        const filterCondition = routing.parameters?.filter_condition;

        if (entityType === 'paper' || entityType === 'papers') {
          if (filterCondition) {
            if (hasNegation) {
              sql = `
                SELECT COUNT(*) as count
                FROM papers p
                WHERE (p.title NOT ILIKE $1 AND p.abstract NOT ILIKE $1)
              `;
            } else {
              sql = `
                SELECT COUNT(*) as count
                FROM papers p
                WHERE (p.title ILIKE $1 OR p.abstract ILIKE $1)
              `;
            }
            params = [`%${filterCondition}%`];
          } else {
            sql = `SELECT COUNT(*) as count FROM papers`;
            params = [];
          }
        } else {
          // Count entities by type
          sql = `
            SELECT COUNT(*) as count
            FROM entities
            WHERE entity_type = $1
          `;
          params = [entityType];
        }
        break;
      }

      default:
        throw new Error(`Unsupported FTS intent: ${routing.intent}`);
    }

    // Validate and sanitize SQL
    const validation = validateAndSanitizeSQL(sql);
    if (!validation.valid || !validation.sanitized) {
      throw new Error(`SQL validation failed: ${validation.errors.join(', ')}`);
    }
    sql = validation.sanitized;

    // Validate parameters
    if (!validateParameterCount(sql, params)) {
      throw new Error('Parameter count mismatch');
    }

    // Execute query
    const results = await db.query(sql, params);
    
    metadata.resultCount = results.length;
    metadata.executionTimeMs = Date.now() - startTime;
    metadata.sqlQuery = sql;
    if (validation.warnings.length > 0) {
      metadata.warnings = validation.warnings;
    }

    return { results, metadata };

  } catch (error: any) {
    if (!metadata.errors) metadata.errors = [];
    metadata.errors.push(error.message || String(error));
    metadata.executionTimeMs = Date.now() - startTime;
    throw error;
  }
}

/**
 * Execute an NL→SQL query (delegates to Intelligent Query Agent)
 */
export async function executeNL2SQLQuery(
  routing: RoutingResult,
  question: string,
  intelligentAgent: any, // IntelligentQueryAgent
  db: DatabaseClient
): Promise<QueryResultWithMetadata> {
  const startTime = Date.now();
  const metadata: QueryMetadata = {
    question: question,
    detectedIntent: routing.intent,
    executionRoute: 'nl2sql',
    fallbacks: [],
    executionTimeMs: 0,
    resultCount: 0,
    warnings: [],
    errors: [],
  };

  try {
    if (!intelligentAgent) {
      throw new Error('Intelligent Query Agent not available (HUGGINGFACE_API_KEY not set)');
    }

    // Use Intelligent Query Agent to generate and execute SQL
    const result = await intelligentAgent.answerQuestion(question);
    
    // Merge metadata
    metadata.sqlQuery = result.metadata.sqlQuery;
    metadata.rankingSignals = result.metadata.rankingSignals;
    metadata.fallbacks = result.metadata.fallbacks;
    metadata.warnings = result.metadata.warnings;
    metadata.errors = result.metadata.errors;
    metadata.resultCount = result.results.length;
    metadata.executionTimeMs = Date.now() - startTime;

    // If result has errors, try one retry with error feedback
    if (result.metadata.errors && result.metadata.errors.length > 0 && result.results.length === 0) {
      const lastError = result.metadata.errors[result.metadata.errors.length - 1];
      metadata.warnings?.push(`Retry with error feedback: ${lastError}`);
      
      // Attempt retry (Intelligent Agent should handle this internally)
      // For now, just return the first attempt result
    }

    return result;

  } catch (error: any) {
    if (!metadata.errors) metadata.errors = [];
    if (!metadata.errors) metadata.errors = [];
    metadata.errors.push(error.message || String(error));
    metadata.executionTimeMs = Date.now() - startTime;
    throw error;
  }
}

