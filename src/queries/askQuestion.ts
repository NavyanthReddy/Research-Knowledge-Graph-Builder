import * as dotenv from 'dotenv';
import { DatabaseClient } from '../database/client';
import { QueryTranslator } from '../agents/queryTranslator';
import { IntelligentQueryAgent } from '../agents/intelligentQueryAgent';
import { QueryResultWithMetadata, QueryMetadata, FallbackInfo } from '../agents/queryMetadata';
import * as readline from 'readline';
import { detectIntentAndRoute, RoutingResult } from '../router';
import { executeGraphQuery, executeFTSQuery, executeNL2SQLQuery } from './queryExecutors';
import { formatAnswerCard } from './answerCard';
import { validateAndSanitizeSQL } from './sqlValidator';

dotenv.config();

/**
 * Interactive query interface that translates natural language questions to SQL
 * Implements consistent QA flow with routing hierarchy:
 * 1. Detect intent & route
 * 2. Build plan (template SQL or NL→SQL)
 * 3. Sanitize/validate SQL
 * 4. Execute with smart fallbacks
 * 5. Return results with metadata
 * 6. Print answer card (dev mode)
 */

interface QueryPattern {
  pattern: RegExp;
  query: (match: RegExpMatchArray, db: DatabaseClient) => Promise<any[]>;
  description: string;
}

class QuestionAnswerer {
  public db: DatabaseClient;
  private patterns: QueryPattern[];
  private queryTranslator: QueryTranslator | null;
  private intelligentAgent: IntelligentQueryAgent | null;
  private devMode: boolean;

  constructor(devMode: boolean = true) {
    this.db = new DatabaseClient();
    this.patterns = this.initializePatterns();
    this.devMode = devMode;
    
    // Initialize intelligent agent if API key is available (PRIMARY AGENT)
    if (process.env.HUGGINGFACE_API_KEY) {
      this.intelligentAgent = new IntelligentQueryAgent(process.env.HUGGINGFACE_API_KEY, this.db);
      this.queryTranslator = new QueryTranslator(process.env.HUGGINGFACE_API_KEY);
    } else {
      this.intelligentAgent = null;
      this.queryTranslator = null;
      if (devMode) {
        console.warn('⚠️  HUGGINGFACE_API_KEY not set. LLM-powered agents disabled.');
      }
    }
  }

  private initializePatterns(): QueryPattern[] {
    return [
      // Pattern 1: Papers that improve on a method
      {
        pattern: /(?:which|what|find|show).*papers?.*(?:improve|enhance|extend|better).*(?:on|upon|over)?\s*(?:the\s+)?(?:method\s+)?([\w\s]+)/i,
        query: async (match, db) => {
          const methodName = match[1].trim();
          const query = `
            SELECT DISTINCT
              p.id,
              p.arxiv_id,
              p.title,
              p.authors,
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
            LIMIT 10
          `;
          return await db.query(query, [`%${methodName}%`]);
        },
        description: 'Finds papers that improve on a specific method',
      },

      // Pattern 2: Papers that compare against a method
      {
        pattern: /(?:which|what|find|show).*(?:methods?|papers?).*compare.*(?:against|with|to)\s+([\w\s\-\/]+)(?:\s+or\s+([\w\s\-\/]+))?/i,
        query: async (match, db) => {
          // Extract method names - handle "or" for multiple methods
          let method1 = match[1]?.trim() || '';
          let method2 = match[2]?.trim() || '';
          
          // Normalize method names to canonical form (remove hyphens, spaces, convert to lowercase)
          const normalizeMethod = (method: string): string => {
            return method.replace(/[-\s]/g, '').toLowerCase();
          };
          
          const normalized1 = normalizeMethod(method1);
          const normalized2 = normalizeMethod(method2);
          
          // Build search patterns - search both canonical_name (normalized) and name (with variations)
          const searchTerms: string[] = [];
          const allMethods = [method1, method2, normalized1, normalized2].filter(m => m);
          
          // Remove duplicates
          const uniqueMethods = [...new Set(allMethods)];
          
          for (const method of uniqueMethods) {
            searchTerms.push(`%${method}%`);
          }
          
          if (searchTerms.length === 0) {
            return [];
          }
          
          // Build normalized search terms
          const normalizedSearchTerms = [normalized1, normalized2].filter(m => m);
          
          // First, try to find explicit "compares" relationships
          const compareConditions = normalizedSearchTerms.map((term, i) => 
            `target_e.canonical_name = $${i + 1}`
          ).join(' OR ');
          
          let query = `
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
            WHERE r.relationship_type = 'compares'
              AND target_e.entity_type = 'method'
              AND (${compareConditions})
            ORDER BY p.published_date DESC, r.confidence_score DESC
            LIMIT 20
          `;
          
          let results: any[] = [];
          try {
            results = await db.query(query, normalizedSearchTerms);
          } catch (error) {
            // If that fails, results stays empty
          }
          
          // If no explicit comparison relationships, fall back to finding papers that mention these methods
          if (results.length === 0 && normalizedSearchTerms.length > 0) {
            // Build OR conditions for exact match on canonical_name
            const conditions = normalizedSearchTerms.map((term, i) => 
              `e.canonical_name = $${i + 1}`
            ).join(' OR ');
            
            // Use exact match values (canonical names are already normalized to lowercase)
            const searchPatterns = normalizedSearchTerms;
            
            query = `
              SELECT DISTINCT
                p.id,
                p.arxiv_id,
                p.title,
                p.authors,
                p.published_date,
                p.arxiv_url,
                p.abstract,
                ARRAY_AGG(DISTINCT e.name) as mentioned_methods
              FROM papers p
              JOIN paper_entities pe ON p.id = pe.paper_id
              JOIN entities e ON pe.entity_id = e.id
              WHERE e.entity_type = 'method'
                AND (${conditions})
              GROUP BY p.id, p.arxiv_id, p.title, p.authors, p.published_date, p.arxiv_url, p.abstract
              ORDER BY p.published_date DESC
              LIMIT 20
            `;
            
            try {
              results = await db.query(query, searchPatterns);
            } catch (error) {
              console.error('Error in fallback query:', error);
              // Return empty results if query fails
              results = [];
            }
          }
          
          return results;
        },
        description: 'Finds papers that compare against specific methods',
      },

      // Pattern 3: Most common methods/concepts/datasets/metrics
      {
        pattern: /(?:what|which|find|show).*(?:most|top|popular|common|frequently).*(?:methods?|concepts?|datasets?|metrics?)/i,
        query: async (match, db) => {
          const entityType = match[0].includes('method') ? 'method' :
                            match[0].includes('concept') ? 'concept' :
                            match[0].includes('dataset') ? 'dataset' :
                            match[0].includes('metric') ? 'metric' : 'method';
          
          const limitMatch = match[0].match(/\d+/);
          const limit = limitMatch ? parseInt(limitMatch[0]) : 10;

          const query = `
            SELECT 
              e.name,
              e.description,
              e.entity_type,
              COUNT(DISTINCT pe.paper_id) as paper_count,
              AVG(pe.significance_score) as avg_significance
            FROM entities e
            JOIN paper_entities pe ON e.id = pe.entity_id
            WHERE e.entity_type = $1
            GROUP BY e.id, e.name, e.description, e.entity_type
            ORDER BY paper_count DESC, avg_significance DESC
            LIMIT $2
          `;
          return await db.query(query, [entityType, limit]);
        },
        description: 'Finds most commonly used entities',
      },

      // Pattern 4: Papers related by shared concepts
      {
        pattern: /(?:find|show|which).*papers?.*(?:related|similar|share).*(?:concepts?|methods?)/i,
        query: async (match, db) => {
          // Extract concept names if mentioned
          const conceptMatch = match[0].match(/(?:concept|method|dataset|metric)\s+([\w\s,]+)/i);
          const concepts = conceptMatch ? conceptMatch[1].split(',').map(c => c.trim()) : 
                          ['splatting', 'rendering', 'gaussian'];
          
          const query = `
            SELECT 
              p.id,
              p.arxiv_id,
              p.title,
              p.authors,
              p.published_date,
              COUNT(DISTINCT e.id) as shared_concepts,
              ARRAY_AGG(DISTINCT e.name) as concept_names
            FROM papers p
            JOIN paper_entities pe ON p.id = pe.paper_id
            JOIN entities e ON pe.entity_id = e.id
            WHERE e.entity_type = 'concept'
              AND e.canonical_name = ANY($1::text[])
            GROUP BY p.id, p.arxiv_id, p.title, p.authors, p.published_date
            HAVING COUNT(DISTINCT e.id) >= 1
            ORDER BY shared_concepts DESC, p.published_date DESC
            LIMIT 10
          `;
          return await db.query(query, [concepts]);
        },
        description: 'Finds papers related by shared concepts',
      },

      // Pattern 5: Papers using a specific dataset or metric
      {
        pattern: /(?:which|what|find|show).*papers?.*(?:use|using|evaluate|evaluated).*(?:dataset|metric)\s+([\w\s]+)/i,
        query: async (match, db) => {
          const datasetMetric = match[1].trim();
          const entityType = match[0].includes('dataset') ? 'dataset' : 'metric';
          
          const query = `
            SELECT DISTINCT
              p.id,
              p.arxiv_id,
              p.title,
              p.authors,
              p.published_date,
              p.arxiv_url,
              e.name as entity_name,
              pe.significance_score
            FROM papers p
            JOIN paper_entities pe ON p.id = pe.paper_id
            JOIN entities e ON pe.entity_id = e.id
            WHERE e.entity_type = $1
              AND (e.canonical_name ILIKE $2 OR e.name ILIKE $2)
            ORDER BY p.published_date DESC, pe.significance_score DESC
            LIMIT 10
          `;
          return await db.query(query, [entityType, `%${datasetMetric}%`]);
        },
        description: 'Finds papers using specific datasets or metrics',
      },

      // Pattern 6: Entities in a specific paper
      {
        pattern: /(?:what|which|find|show).*(?:entities?|methods?|concepts?|datasets?|metrics?).*in.*paper.*([\w\.]+)/i,
        query: async (match, db) => {
          const arxivId = match[1].trim();
          
          const query = `
            SELECT 
              e.name,
              e.entity_type,
              e.description,
              pe.mention_count,
              pe.significance_score
            FROM entities e
            JOIN paper_entities pe ON e.id = pe.entity_id
            JOIN papers p ON pe.paper_id = p.id
            WHERE p.arxiv_id = $1
            ORDER BY pe.significance_score DESC, pe.mention_count DESC
          `;
          return await db.query(query, [arxivId]);
        },
        description: 'Finds entities in a specific paper',
      },

      // Pattern 7: Relationship network for an entity
      {
        pattern: /(?:what|which|find|show).*(?:relationships?|connections?).*(?:for|of|about)\s+([\w\s]+)/i,
        query: async (match, db) => {
          const entityName = match[1].trim();
          
          const query = `
            SELECT 
              source_e.name as source_entity,
              target_e.name as target_entity,
              r.relationship_type,
              r.context,
              r.confidence_score,
              p.title as paper_title,
              p.arxiv_id
            FROM relationships r
            JOIN entities source_e ON r.source_entity_id = source_e.id
            JOIN entities target_e ON r.target_entity_id = target_e.id
            JOIN papers p ON r.paper_id = p.id
            WHERE (source_e.canonical_name ILIKE $1 OR source_e.name ILIKE $1
              OR target_e.canonical_name ILIKE $1 OR target_e.name ILIKE $1)
            ORDER BY r.confidence_score DESC
            LIMIT 20
          `;
          return await db.query(query, [`%${entityName}%`]);
        },
        description: 'Finds relationships for a specific entity',
      },

      // Pattern 8: Count statistics (only simple counts like "How many papers are in the database?")
      {
        pattern: /^(?:how many|count|statistics).*(?:papers?|entities?|relationships?)\s+(?:are\s+)?(?:in\s+)?(?:the\s+)?(?:database|total)\s*[?.]?$/i,
        query: async (match, db) => {
          const what = match[0].includes('paper') ? 'papers' :
                      match[0].includes('entity') ? 'entities' :
                      match[0].includes('relationship') ? 'relationships' : 'all';
          
          if (what === 'all') {
            const papers = await db.query('SELECT COUNT(*) as count FROM papers');
            const entities = await db.query('SELECT COUNT(*) as count FROM entities');
            const relationships = await db.query('SELECT COUNT(*) as count FROM relationships');
            return [{
              papers: parseInt(papers[0].count),
              entities: parseInt(entities[0].count),
              relationships: parseInt(relationships[0].count),
            }];
          }
          
          const table = what === 'papers' ? 'papers' : 
                       what === 'entities' ? 'entities' : 
                       'relationships';
          const query = `SELECT COUNT(*) as count FROM ${table}`;
          return await db.query(query);
        },
        description: 'Gets simple count statistics (no conditions)',
      },

      // Pattern 9: Papers with math equations
      {
        pattern: /(?:which|what|find|show|papers?|paper).*(?:having|with|contain|include|that\s+have|that\s+contain|have|has|contains?|includes?).*(?:math|mathematical|equation|formula|formulas|theorem|proof|proofs|derivation|derivations)/i,
        query: async (match, db) => {
          // Search for papers that mention math-related terms in abstract or title
          // Common math keywords: equation, formula, mathematical, theorem, proof, derivation, 
          // integral, differential, optimization, loss function, objective function, etc.
          const query = `
            SELECT DISTINCT
              p.id,
              p.arxiv_id,
              p.title,
              p.authors,
              p.abstract,
              p.published_date,
              p.arxiv_url,
              (
                CASE 
                  WHEN p.abstract ILIKE '%equation%' OR p.title ILIKE '%equation%' THEN 1 ELSE 0
                END +
                CASE 
                  WHEN p.abstract ILIKE '%formula%' OR p.title ILIKE '%formula%' THEN 1 ELSE 0
                END +
                CASE 
                  WHEN p.abstract ILIKE '%mathematical%' OR p.title ILIKE '%mathematical%' THEN 1 ELSE 0
                END +
                CASE 
                  WHEN p.abstract ILIKE '%theorem%' OR p.title ILIKE '%theorem%' THEN 1 ELSE 0
                END +
                CASE 
                  WHEN p.abstract ILIKE '%proof%' OR p.title ILIKE '%proof%' THEN 1 ELSE 0
                END +
                CASE 
                  WHEN p.abstract ILIKE '%derivation%' OR p.title ILIKE '%derivation%' THEN 1 ELSE 0
                END +
                CASE 
                  WHEN p.abstract ILIKE '%optimization%' OR p.title ILIKE '%optimization%' THEN 1 ELSE 0
                END +
                CASE 
                  WHEN p.abstract ILIKE '%loss function%' OR p.abstract ILIKE '%objective function%' THEN 1 ELSE 0
                END
              ) as math_score
            FROM papers p
            WHERE (
              p.abstract ILIKE '%equation%' OR p.title ILIKE '%equation%' OR
              p.abstract ILIKE '%formula%' OR p.title ILIKE '%formula%' OR
              p.abstract ILIKE '%mathematical%' OR p.title ILIKE '%mathematical%' OR
              p.abstract ILIKE '%theorem%' OR p.title ILIKE '%theorem%' OR
              p.abstract ILIKE '%proof%' OR p.title ILIKE '%proof%' OR
              p.abstract ILIKE '%derivation%' OR p.title ILIKE '%derivation%' OR
              p.abstract ILIKE '%optimization%' OR p.title ILIKE '%optimization%' OR
              p.abstract ILIKE '%loss function%' OR p.abstract ILIKE '%objective function%' OR
              p.abstract ~* '\\b(?:minimize|maximize|arg\\s*min|arg\\s*max|gradient|jacobian|hessian|matrix|vector|tensor)\\b'
            )
            ORDER BY math_score DESC, p.published_date DESC
            LIMIT 20
          `;
          return await db.query(query, []);
        },
        description: 'Finds papers containing math equations, formulas, or mathematical content',
      },

      // Pattern 9: General entity search (only if no specific patterns like "by", "written by", etc.)
      {
        pattern: /^(?:find|search|show).*([\w\s]+)$/i,
        query: async (match, db) => {
          const fullQuestion = match.input || match[0] || '';
          const searchTerm = match[1].trim();
          
          // Exact title match pattern: title = '...'
          const exactTitleMatch = fullQuestion.match(/title\s*=\s*['"]([^'"]+)['"]/i);
          if (exactTitleMatch) {
            const titlePhrase = exactTitleMatch[1];
            const query = `
              SELECT id, arxiv_id, title, authors, abstract, published_date, arxiv_url
              FROM papers
              WHERE (title ILIKE $1 OR abstract ILIKE $1)
              ORDER BY published_date DESC
              LIMIT 20
            `;
            try {
              return await db.query(query, [`%${titlePhrase}%`]);
            } catch (error) {
              // ignore and continue
            }
          }
          
          // Skip if question has specific patterns that should be handled elsewhere
          const hasSpecificPatterns = /\b(by|written by|authored by|published in|with|containing|more than|less than|average|mean|exactly|top|latest|recent|papers? written|papers? by|papers? from)\b/i.test(fullQuestion);
          if (hasSpecificPatterns) {
            return [];
          }
          
          // Also check if the question structure suggests it's about papers, not entities
          if (/papers?.*(?:by|written|authored|from)/i.test(fullQuestion)) {
            return [];
          }
          
          const query = `
            SELECT 
              e.name,
              e.entity_type,
              e.description,
              COUNT(DISTINCT pe.paper_id) as paper_count
            FROM entities e
            LEFT JOIN paper_entities pe ON e.id = pe.entity_id
            WHERE e.canonical_name ILIKE $1 OR e.name ILIKE $1 OR e.description ILIKE $1
            GROUP BY e.id, e.name, e.entity_type, e.description
            ORDER BY paper_count DESC
            LIMIT 10
          `;
          return await db.query(query, [`%${searchTerm}%`]);
        },
        description: 'General entity search',
      },
    ];
  }

  /**
   * Main QA Pipeline
   * 1. Detect intent & route
   * 2. Build plan (template SQL or NL→SQL)
   * 3. Sanitize/validate SQL
   * 4. Execute with smart fallbacks
   * 5. Return results with metadata
   */
  async answerQuestion(question: string): Promise<QueryResultWithMetadata> {
    const overallStartTime = Date.now();
    const overallMetadata: QueryMetadata = {
      question: question,
      detectedIntent: 'unknown',
      executionRoute: 'nl2sql',
      fallbacks: [],
      executionTimeMs: 0,
      resultCount: 0,
      warnings: [],
      errors: [],
    };

    try {
      // ========================================================================
      // STEP 1: Detect Intent & Route
      // ========================================================================
      if (this.devMode) {
        console.log('\n🔍 Step 1: Detecting intent and routing...\n');
      }
      const routing = detectIntentAndRoute(question);
      
      overallMetadata.detectedIntent = routing.intent;
      overallMetadata.executionRoute = routing.route;
      overallMetadata.intentConfidence = routing.confidence;
      
      if (this.devMode) {
        console.log(`   Intent: ${routing.intent}`);
        console.log(`   Route: ${routing.route}`);
        console.log(`   Confidence: ${(routing.confidence * 100).toFixed(1)}%`);
        if (routing.parameters) {
          console.log(`   Parameters:`, JSON.stringify(routing.parameters, null, 2));
        }
        console.log('');
      }

      // ========================================================================
      // STEP 2 & 3: Build Plan & Sanitize/Validate (handled in executors)
      // STEP 4: Execute with smart fallbacks
      // ========================================================================
      let result: QueryResultWithMetadata | null = null;

      try {
        // Execute based on route
        switch (routing.route) {
          case 'graph':
            if (this.devMode) {
              console.log('🔗 Step 2-4: Executing graph query...\n');
            }
            result = await executeGraphQuery(routing, this.db);
            break;

          case 'fts':
            if (this.devMode) {
              console.log('📄 Step 2-4: Executing FTS query...\n');
            }
            result = await executeFTSQuery(routing, this.db);
            break;

          case 'nl2sql':
            if (this.devMode) {
              console.log('🤖 Step 2-4: Executing NL→SQL query...\n');
            }
            if (!this.intelligentAgent) {
              throw new Error('Intelligent Query Agent not available');
            }
            result = await executeNL2SQLQuery(routing, question, this.intelligentAgent, this.db);
            break;

          default:
            throw new Error(`Unknown route: ${routing.route}`);
        }

        // Set question and merge metadata
        if (result.metadata) {
          result.metadata.question = question;
          result.metadata.intentConfidence = routing.confidence;
        }

      } catch (executeError: any) {
        // Fallback: Try NL→SQL if graph/FTS fails
        if (routing.route !== 'nl2sql' && this.intelligentAgent) {
          if (this.devMode) {
            console.log(`⚠️  ${routing.route} execution failed, falling back to NL→SQL...\n`);
          }
          overallMetadata.fallbacks.push({
            from: routing.route,
            to: 'nl2sql',
            reason: `Execution failed: ${executeError.message || executeError}`,
            timestamp: new Date(),
          });

          try {
            const fallbackRouting: RoutingResult = {
              intent: 'nl2sql',
              route: 'nl2sql',
              confidence: 0.50,
            };
            result = await executeNL2SQLQuery(fallbackRouting, question, this.intelligentAgent, this.db);
            result.metadata.question = question;
          } catch (fallbackError: any) {
            // Last resort: return empty result with error
            if (!overallMetadata.errors) overallMetadata.errors = [];
            overallMetadata.errors.push(`All execution strategies failed: ${executeError.message || executeError}`);
            overallMetadata.executionTimeMs = Date.now() - overallStartTime;
            return { results: [], metadata: overallMetadata };
          }
        } else {
          // No fallback available
          if (!overallMetadata.errors) overallMetadata.errors = [];
          overallMetadata.errors.push(`Execution failed: ${executeError.message || executeError}`);
          overallMetadata.executionTimeMs = Date.now() - overallStartTime;
          return { results: [], metadata: overallMetadata };
        }
      }

      // ========================================================================
      // STEP 5: Merge metadata and return results
      // ========================================================================
      if (result) {
        // Merge fallbacks
        overallMetadata.fallbacks.push(...(result.metadata.fallbacks || []));
        overallMetadata.warnings?.push(...(result.metadata.warnings || []));
        overallMetadata.errors?.push(...(result.metadata.errors || []));
        overallMetadata.sqlQuery = result.metadata.sqlQuery;
        overallMetadata.rankingSignals = result.metadata.rankingSignals;
        overallMetadata.resultCount = result.results.length;
        overallMetadata.executionTimeMs = Date.now() - overallStartTime;

        return {
          results: result.results,
          metadata: overallMetadata,
        };
      }

      // Should not reach here
      overallMetadata.executionTimeMs = Date.now() - overallStartTime;
      return { results: [], metadata: overallMetadata };

    } catch (error: any) {
      if (!overallMetadata.errors) overallMetadata.errors = [];
      overallMetadata.errors.push(`QA pipeline error: ${error.message || error}`);
      overallMetadata.executionTimeMs = Date.now() - overallStartTime;
      return { results: [], metadata: overallMetadata };
    }
  }

  /**
   * Format results with metadata for display
   * STEP 6: Print answer card (dev mode) or minimal output (production)
   */
  formatResults(
    queryResult: QueryResultWithMetadata,
    question: string
  ): void {
    // Use new answer card formatter (primary output)
    const answerCard = formatAnswerCard(question, queryResult, this.devMode);
    console.log(answerCard);
    
    // Legacy detailed formatting (kept for backward compatibility, only in dev mode)
    if (this.devMode) {
      const { results, metadata } = queryResult;
      
      // Only show detailed legacy format if there are additional details not in answer card
      // (Answer card already shows most important info)
      if (results.length > 0 && results[0].title) {
        console.log('\n📄 Detailed Results:\n');

        console.log(`✅ Found ${results.length} result(s):\n`);
        console.log('─'.repeat(80));

        // Different formatting based on result structure
        if (results[0].title) {
          // Paper results
          results.forEach((result: any, idx: number) => {
            console.log(`\n${idx + 1}. ${result.title}`);
            if (result.authors) {
              const authors = Array.isArray(result.authors) 
                ? result.authors.slice(0, 3).join(', ') + (result.authors.length > 3 ? '...' : '')
                : result.authors;
              console.log(`   👥 Authors: ${authors}`);
            }
            if (result.published_date) {
              console.log(`   📅 Published: ${new Date(result.published_date).toLocaleDateString()}`);
            }
            if (result.arxiv_id) {
              console.log(`   🔗 arXiv ID: ${result.arxiv_id}`);
            }
            if (result.arxiv_url) {
              console.log(`   🌐 URL: ${result.arxiv_url}`);
            }
            console.log('─'.repeat(80));
          });
        }
      }
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/**
 * Interactive mode - ask questions repeatedly
 */
async function interactiveMode() {
  const devMode = process.env.NODE_ENV !== 'production';
  const qa = new QuestionAnswerer(devMode);
  
  try {
    await qa.db.testConnection();
    console.log('\n💬 Interactive Knowledge Graph Query Interface');
    console.log('   Ask questions about papers, entities, and relationships\n');
    console.log('   Example questions:');
    console.log('   - "Which papers improve on 3D Gaussian Splatting?"');
    console.log('   - "What are the most common methods?"');
    console.log('   - "Find papers related by shared concepts"');
    console.log('   - "How many papers are in the database?"');
    console.log('   - Type "exit", "quit", or "q" to stop\n');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '❓ Your question: ',
    });

    rl.prompt();

    rl.on('line', async (line: string) => {
      const question = line.trim();
      
      if (question === 'exit' || question === 'quit' || question === 'q') {
        console.log('\n👋 Goodbye!\n');
        rl.close();
        await qa.close();
        process.exit(0);
      }

      if (!question) {
        rl.prompt();
        return;
      }

      try {
        const results = await qa.answerQuestion(question);
        // Results should already be QueryResultWithMetadata
        qa.formatResults(results as QueryResultWithMetadata, question);
      } catch (error) {
        console.error('❌ Error:', error);
      }

      rl.prompt();
    });

    rl.on('close', async () => {
      await qa.close();
      process.exit(0);
    });

  } catch (error) {
    console.error('Error initializing:', error);
    await qa.close();
    process.exit(1);
  }
}

/**
 * Single question mode
 */
async function singleQuestion(question: string) {
  const devMode = process.env.NODE_ENV !== 'production';
  const qa = new QuestionAnswerer(devMode);
  
  try {
    await qa.db.testConnection();
    const results = await qa.answerQuestion(question);
    qa.formatResults(results, question);
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await qa.close();
  }
}

// Main execution
async function main() {
  const question = process.argv.slice(2).join(' ');

  if (question) {
    // Single question mode
    await singleQuestion(question);
  } else {
    // Interactive mode
    await interactiveMode();
  }
}

if (require.main === module) {
  main();
}
