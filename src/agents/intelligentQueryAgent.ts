import { HfInference } from '@huggingface/inference';
import { DatabaseClient } from '../database/client';
import { QueryResultWithMetadata, QueryMetadata, FallbackInfo } from './queryMetadata';

/**
 * Intelligent Query Agent
 * Analyzes questions and generates optimal SQL queries using LLM reasoning
 * This is the primary agent for answering arbitrary questions
 */
export class IntelligentQueryAgent {
  private hf: HfInference;
  private model = 'meta-llama/Llama-3.1-8B-Instruct';
  private db: DatabaseClient;

  constructor(apiKey: string, db: DatabaseClient) {
    this.hf = new HfInference(apiKey);
    this.db = db;
  }

  /**
   * Main method: Answer a question intelligently using the knowledge graph
   * Returns results with detailed metadata about reasoning and execution
   */
  async answerQuestion(question: string): Promise<QueryResultWithMetadata> {
    const startTime = Date.now();
    const metadata: QueryMetadata = {
      question: question, // Store the original question
      detectedIntent: 'unknown',
      executionRoute: 'nl2sql',
      fallbacks: [],
      executionTimeMs: 0,
      resultCount: 0,
      warnings: [],
      errors: [],
    };

    try {
      // Step 1: Analyze the question and understand what's needed
      const analysis = await this.analyzeQuestion(question);
      console.log('  📊 Analysis:', JSON.stringify(analysis, null, 2));
      
      // Store analysis for use in fixQuery if needed
      (this as any).lastAnalysis = analysis;
      
      metadata.detectedIntent = analysis.intent || 'unknown';
      metadata.intentConfidence = analysis.confidence || undefined;
      
        // Step 2: Generate SQL query based on analysis
        let sql = await this.generateSQL(question, analysis);
        
        if (!sql || !this.validateSQL(sql)) {
          console.warn('  ⚠️  No valid SQL generated');
          if (sql) {
            console.warn('  Generated SQL:', sql);
            metadata.warnings?.push('Generated SQL failed validation');
          } else {
            metadata.errors?.push('Failed to generate SQL from analysis');
          }
          metadata.executionTimeMs = Date.now() - startTime;
          return { results: [], metadata };
        }

        // Fix: Check for negation in question ("not about", "does not contain", etc.)
        const questionLower = question.toLowerCase();
        // Check for negation patterns: "not about", "not in", "does not contain", "without", etc.
        const hasNegation = /\b(not\s+about|not\s+in|not\s+contain|doesn't|does not|don't|do not|excluding|without|except|are not)\b/i.test(questionLower);
        
        if (hasNegation && sql.includes('ILIKE')) {
          // CRITICAL FIX: For negation queries, check if only ONE field is checked
          // If so, expand to check BOTH title AND abstract
          const onlyAbstract = (sql.includes('abstract NOT ILIKE') || sql.includes('abstract ILIKE')) && 
                               !sql.includes('title NOT ILIKE') && !sql.includes('title ILIKE');
          const onlyTitle = (sql.includes('title NOT ILIKE') || sql.includes('title ILIKE')) && 
                           !sql.includes('abstract NOT ILIKE') && !sql.includes('abstract ILIKE');
          
          if (onlyAbstract || onlyTitle) {
            // Extract the pattern (could be $1, '%term%', etc.) and replace single field with both
            sql = sql.replace(
              /WHERE\s+(abstract|title)\s+(?:NOT\s+)?ILIKE\s+([^\s]+)/gi,
              (match, field, patternVal) => {
                // Replace single field check with both title AND abstract checks
                // Use the captured patternVal (could be $1, '%gaussian%', etc.)
                return `WHERE (title NOT ILIKE ${patternVal} AND abstract NOT ILIKE ${patternVal})`;
              }
            );
            console.log('  🔧 Fixed: Expanded negation query to check both title AND abstract');
            metadata.warnings?.push('Fixed negation: Added both title and abstract checks');
            metadata.sqlQuery = sql;
          } else if (!sql.includes('NOT ILIKE') && !sql.match(/\bNOT\s+\w+\s+ILIKE/i)) {
            // SQL has ILIKE but not NOT ILIKE - add NOT
            // Replace ILIKE with NOT ILIKE for existing checks
            sql = sql.replace(/(WHERE|AND|OR)\s+(abstract|title)\s+ILIKE\b/gi, '$1 $2 NOT ILIKE');
            sql = sql.replace(/(WHERE|AND|OR)\s+([^\s]+)\s+ILIKE\b/gi, (match, op, col) => {
              if (match.includes('NOT')) return match;
              return `${op} ${col} NOT ILIKE`;
            });
            console.log('  🔧 Fixed: Detected negation, changed ILIKE to NOT ILIKE');
            metadata.warnings?.push('Fixed negation in SQL (changed ILIKE to NOT ILIKE)');
            metadata.sqlQuery = sql;
          }
          
          // Fix double negation if it somehow got created
          if (sql.includes('NOT NOT ILIKE')) {
            sql = sql.replace(/\s+NOT\s+NOT\s+ILIKE/gi, ' NOT ILIKE');
            console.log('  🔧 Fixed: Removed double negation (NOT NOT ILIKE → NOT ILIKE)');
            metadata.warnings?.push('Fixed double negation in SQL');
            metadata.sqlQuery = sql;
          }
          
          // Remove any trailing "= FALSE" that might have been incorrectly added by LLM
          if (sql.includes('= FALSE')) {
            sql = sql.replace(/\s+NOT\s+ILIKE\s+([^=]+)\s*=\s*FALSE/gi, ' NOT ILIKE $1');
            sql = sql.replace(/(NOT\s+ILIKE\s+[^=]+)\s*=\s*FALSE/gi, '$1');
            if (sql.includes('= FALSE')) {
              sql = sql.replace(/\s+NOT\s+ILIKE\s+([^=\s]+)\s*=\s*FALSE/gi, ' NOT ILIKE $1');
            }
            metadata.sqlQuery = sql;
          }
        }
        
        // Fix: For "about X" / general searches, ensure both title and abstract are searched
        // If only one is present (title or abstract), expand to (title OR abstract)
        if (!hasNegation) {
          // Case 1: only title ILIKE present
          if (sql.includes('title ILIKE') && !sql.includes('abstract ILIKE') && !sql.includes('abstract NOT ILIKE')) {
            const patternMatch = sql.match(/title\s+ILIKE\s+([^\s]+)/i);
            if (patternMatch && patternMatch[1]) {
              const pattern = patternMatch[1];
              sql = sql.replace(/WHERE\s+title\s+ILIKE\s+[^\s]+/gi, `WHERE (title ILIKE ${pattern} OR abstract ILIKE ${pattern})`);
              console.log('  🔧 Fixed: Added abstract search to complement title search');
              metadata.warnings?.push('Added abstract search for consistency');
              metadata.sqlQuery = sql;
            }
          }
          // Case 2: only abstract ILIKE present
          if (sql.includes('abstract ILIKE') && !sql.includes('title ILIKE') && !sql.includes('title NOT ILIKE')) {
            const patternMatch = sql.match(/abstract\s+ILIKE\s+([^\s]+)/i);
            if (patternMatch && patternMatch[1]) {
              const pattern = patternMatch[1];
              sql = sql.replace(/WHERE\s+abstract\s+ILIKE\s+[^\s]+/gi, `WHERE (title ILIKE ${pattern} OR abstract ILIKE ${pattern})`);
              console.log('  🔧 Fixed: Added title search to complement abstract search');
              metadata.warnings?.push('Added title search for consistency');
              metadata.sqlQuery = sql;
            }
          }
        }

        console.log('  🔍 Generated SQL:', sql);
        metadata.sqlQuery = sql;

        // Additional safety: if ordering by confidence_score without relationships, switch to published_date
        if (!/JOIN\s+relationships/i.test(sql) && /ORDER\s+BY\s+[^;]*confidence_score/i.test(sql)) {
          sql = sql.replace(/ORDER\s+BY\s+[^;]*confidence_score\s*(DESC|ASC)?/i, 'ORDER BY published_date DESC');
          metadata.sqlQuery = sql;
          metadata.warnings?.push('Replaced ordering by confidence_score with published_date for papers-only query');
        }

      // Detect ranking signals from SQL
      const rankingMatch = sql.match(/ORDER\s+BY\s+([^\s]+(?:\s+DESC|\s+ASC)?)/i);
      if (rankingMatch) {
        const orderClause = rankingMatch[1];
        const direction = orderClause.toUpperCase().includes('DESC') ? 'DESC' : 'ASC';
        const signal = orderClause.replace(/\s+(DESC|ASC)$/i, '').trim();
        metadata.rankingSignals = {
          signal: signal,
          direction: direction,
        };
      }

      // Step 3: Extract parameters intelligently
      const params = await this.extractParameters(question, sql, analysis);
      console.log('  📝 Parameters:', params);
      
      // Step 4: Execute query (fix canonical_name normalization before execution)
      try {
        // Fix canonical_name normalization in SQL if present
        let execSQL = sql;
        if (execSQL.includes('canonical_name')) {
          execSQL = execSQL.replace(/canonical_name\s*=\s*['"]([^'"]+)['"]/gi, (match, value) => {
            const normalized = value.toLowerCase()
              .replace(/&/g, 'and')
              .replace(/\s+/g, ' ')
              .trim();
            return `canonical_name = '${normalized}'`;
          });
          if (execSQL !== sql) {
            metadata.sqlQuery = execSQL;
            metadata.warnings?.push('Normalized canonical_name in SQL');
          }
        }
        
        const results = await this.db.query(execSQL, params);
        console.log(`  ✅ Query executed successfully, returned ${results.length} results`);
        
        metadata.resultCount = results.length;
        metadata.executionTimeMs = Date.now() - startTime;
        
        if (results.length === 0 && execSQL !== sql) {
          console.log('  ℹ️  Query returned 0 results (may need different approach)');
          metadata.warnings?.push('Query returned 0 results after normalization');
        }
        
        return { results, metadata };
      } catch (error: any) {
        console.warn('  ⚠️  Query execution failed:', error.message);
        console.warn('  SQL:', sql);
        console.warn('  Params:', params);
        
        metadata.errors?.push(`SQL execution failed: ${error.message}`);
        
        // Step 5: Try to fix the query if it fails
        const fixedSQL = await this.fixQuery(sql, error.message, question, analysis);
        if (fixedSQL && fixedSQL !== sql) {
          console.log('  🔧 Attempting to fix SQL...');
          
          metadata.fallbacks.push({
            from: 'nl_to_sql',
            to: 'nl_to_sql_fixed',
            reason: `SQL execution failed: ${error.message}`,
            timestamp: new Date(),
          });
          metadata.sqlQuery = fixedSQL;
          
          try {
            // For focus-based queries, we need to extract the search term and add % wildcards
            let fixedParams = params;
            if (fixedSQL.includes('focus_score') && analysis) {
              const searchTerm = analysis.conditions?.value || 'gaussian';
              fixedParams = [`%${searchTerm.toLowerCase()}%`];
              console.log('  🔧 Using search term for focus query:', fixedParams[0]);
            }
            
            const results = await this.db.query(fixedSQL, fixedParams);
            console.log('  ✅ Fixed query executed successfully');
            
            metadata.resultCount = results.length;
            metadata.executionTimeMs = Date.now() - startTime;
            
            // Store the ranking signal if it's a focus-based query
            if (fixedSQL.includes('focus_score')) {
              metadata.rankingSignals = {
                signal: 'focus_score',
                direction: 'DESC',
              };
            }
            
            return { results, metadata };
          } catch (fixError: any) {
            console.warn('  ❌ Could not fix query:', fixError.message);
            metadata.errors?.push(`Fixed SQL also failed: ${fixError.message}`);
            metadata.executionTimeMs = Date.now() - startTime;
            return { results: [], metadata };
          }
        }
        
        metadata.executionTimeMs = Date.now() - startTime;
        return { results: [], metadata };
      }
    } catch (error: any) {
      console.error('  ❌ Error in intelligent agent:', error.message);
      metadata.errors?.push(`Agent error: ${error.message}`);
      metadata.executionTimeMs = Date.now() - startTime;
      return { results: [], metadata };
    }
  }

  /**
   * Analyze the question to understand intent and data needs
   */
  private async analyzeQuestion(question: string): Promise<any> {
    const prompt = this.getAnalysisPrompt(question);
    
    try {
      const response = await this.hf.chatCompletion({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: `You are an expert database analyst. Analyze questions to understand what data is needed.

Return ONLY a JSON object with this structure:
{
  "intent": "count|list|aggregate|filter|compare|search",
  "entity_type": "papers|entities|relationships|mixed",
  "fields_needed": ["title", "authors", "abstract", ...],
  "conditions": {
    "type": "comparison|text_search|date|array_operation",
    "field": "authors|published_date|abstract|...",
    "operator": ">|<|>=|<=|=|ILIKE|array_length",
    "value": "extracted value or null"
  },
  "aggregations": ["COUNT", "AVG", "MAX", "MIN"],
  "sorting": {
    "field": "published_date|confidence_score|LENGTH(abstract)",
    "direction": "DESC|ASC"
  },
  "limit": 20
}

Return ONLY JSON, no explanations.`,
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.1,
        max_tokens: 512,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        return this.defaultAnalysis(question);
      }

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch (parseError) {
          return this.defaultAnalysis(question);
        }
      }
      
      return this.defaultAnalysis(question);
    } catch (error) {
      return this.defaultAnalysis(question);
    }
  }

  /**
   * Default analysis if LLM fails
   */
  private defaultAnalysis(question: string): any {
    const q = question.toLowerCase();
    
    return {
      intent: q.includes('how many') || q.includes('count') ? 'count' :
              q.includes('what') || q.includes('which') || q.includes('show') ? 'list' :
              q.includes('average') || q.includes('mean') || q.includes('avg') ? 'aggregate' :
              'search',
      entity_type: q.includes('paper') ? 'papers' :
                   q.includes('entity') || q.includes('method') || q.includes('concept') ? 'entities' :
                   q.includes('relationship') ? 'relationships' : 'mixed',
      fields_needed: [],
      conditions: {},
      aggregations: q.includes('average') ? ['AVG'] : [],
      sorting: { field: 'published_date', direction: 'DESC' },
      limit: 20,
    };
  }

  /**
   * Generate SQL query based on question and analysis
   */
  private async generateSQL(question: string, analysis: any): Promise<string | null> {
    const systemPrompt = this.getSQLGenerationPrompt();
    const userPrompt = `Question: "${question}"

Analysis:
- Intent: ${analysis.intent}
- Entity Type: ${analysis.entity_type}
- Fields Needed: ${JSON.stringify(analysis.fields_needed)}
- Conditions: ${JSON.stringify(analysis.conditions)}
- Aggregations: ${JSON.stringify(analysis.aggregations)}
- Sorting: ${JSON.stringify(analysis.sorting)}

Generate a PostgreSQL SQL query that answers this question. Return ONLY the SQL query, no explanations.`;

    try {
      const response = await this.hf.chatCompletion({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: systemPrompt,
          },
          {
            role: 'user',
            content: userPrompt,
          },
        ],
        temperature: 0.1,
        max_tokens: 1024,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        return null;
      }

      // Extract SQL
      const sqlMatch = content.match(/```sql\s*([\s\S]*?)\s*```/i) ||
                       content.match(/```\s*([\s\S]*?)\s*```/) ||
                       content.match(/(SELECT[\s\S]+?;)/i);
      
      if (sqlMatch) {
        let sql = sqlMatch[1].trim();
        // Remove trailing semicolon if present (we'll add it if needed)
        sql = sql.replace(/;\s*$/, '');
        return sql;
      }

      // Try to extract SQL from lines
      const lines = content.split('\n');
      const sqlLines = lines.filter(line => {
        const trimmed = line.trim().toUpperCase();
        return trimmed.startsWith('SELECT') ||
               trimmed.startsWith('WITH') ||
               line.includes('FROM') ||
               line.includes('JOIN') ||
               line.includes('WHERE') ||
               trimmed === ';' ||
               (trimmed.length > 0 && !trimmed.startsWith('--') && !trimmed.startsWith('//'));
      });

      if (sqlLines.length > 0) {
        let sql = sqlLines.join('\n').trim();
        sql = sql.replace(/;\s*$/, '');
        return sql;
      }

      return null;
    } catch (error) {
      console.error('Error generating SQL:', error);
      return null;
    }
  }

  /**
   * Get comprehensive SQL generation prompt
   */
  private getSQLGenerationPrompt(): string {
    return `You are an expert PostgreSQL query generator for a research paper knowledge graph.

IMPORTANT: Pay careful attention to NEGATION in questions:
- "how many papers are NOT about X" → use "WHERE abstract NOT ILIKE '%X%'"
- "papers that do NOT contain X" → use "WHERE ... NOT ILIKE '%X%'"
- "papers without X" → use "WHERE ... NOT ILIKE '%X%'"
- Always use NOT ILIKE for negation, never just ILIKE

DATABASE SCHEMA:

**papers** table:
- id (SERIAL PRIMARY KEY)
- arxiv_id (VARCHAR(50), UNIQUE)
- title (TEXT)
- authors (TEXT[]) - array of author names
- abstract (TEXT)
- published_date (DATE)
- pdf_url (TEXT)
- arxiv_url (TEXT)
- ingestion_timestamp (TIMESTAMP)
- processed (BOOLEAN)

**entities** table:
- id (SERIAL PRIMARY KEY)
- name (TEXT) - display name
- entity_type (VARCHAR) - 'method', 'concept', 'dataset', 'metric'
- description (TEXT)
- canonical_name (TEXT) - normalized for matching
- confidence_score (DECIMAL)
- first_mentioned_in (INTEGER) - references papers.id
- created_at (TIMESTAMP)

**relationships** table:
- id (SERIAL PRIMARY KEY)
- source_entity_id (INTEGER) - references entities.id
- target_entity_id (INTEGER) - references entities.id
- relationship_type (VARCHAR) - 'improves', 'uses', 'extends', 'compares', 'cites', 'evaluates'
- paper_id (INTEGER) - references papers.id
- confidence_score (DECIMAL)
- context (TEXT) - text snippet establishing relationship
- created_at (TIMESTAMP)

**paper_entities** table:
- paper_id (INTEGER) - references papers.id
- entity_id (INTEGER) - references entities.id
- mention_count (INTEGER)
- first_mention_position (INTEGER)
- significance_score (DECIMAL)

KEY JOINS:
- papers.id = relationships.paper_id
- entities.id = relationships.source_entity_id
- entities.id = relationships.target_entity_id
- papers.id = paper_entities.paper_id
- entities.id = paper_entities.entity_id

IMPORTANT PATTERNS:
- Array length: array_length(authors, 1) > 2
- Array contains: authors @> ARRAY['Author Name']
- Array search: array_to_string(authors, ', ') ILIKE '%Name%'
- Text length: LENGTH(abstract), LENGTH(title)
- Date extraction: EXTRACT(YEAR FROM published_date), EXTRACT(MONTH FROM published_date)
- Aggregations: COUNT(*), AVG(array_length(authors, 1)), MAX(LENGTH(abstract))
- Text search: title ILIKE '%term%', abstract ILIKE '%term%'

CRITICAL RULES:
1. Use parameterized queries: $1, $2, etc. for values
2. Use ILIKE for case-insensitive text search with %wildcards%
3. Use canonical_name for entity matching (it's normalized)
4. Always include LIMIT (default: 20, max: 100)
5. Use DISTINCT to avoid duplicates
6. Use proper JOINs, not WHERE clauses for relationships
7. Order by relevance: published_date DESC, confidence_score DESC
8. Handle NULLs: COALESCE(abstract, ''), authors IS NOT NULL

Return ONLY the SQL query, ready to execute. No markdown, no explanations.`;
  }

  /**
   * Get analysis prompt
   */
  private getAnalysisPrompt(question: string): string {
    return `Analyze this question about a research paper knowledge graph:

"${question}"

What data is needed to answer this? What tables, fields, conditions, and aggregations are required?

Return ONLY JSON with the analysis structure.`;
  }

  /**
   * Extract parameters intelligently from question and analysis
   */
  private async extractParameters(question: string, sql: string, analysis: any): Promise<any[]> {
    const params: any[] = [];
    const placeholders = sql.match(/\$(\d+)/g) || [];
    // Use unique placeholder indices to avoid duplicate params when $1 appears multiple times
    const placeholderIndices = Array.from(new Set(placeholders.map(p => parseInt(p.replace('$', ''), 10)))).sort((a, b) => a - b);
    const paramCount = placeholderIndices.length;

    if (paramCount === 0) {
      return [];
    }

    // Detect "top N" limit from question or analysis
    const topMatch = question.match(/\btop\s+(\d+)\b/i);
    const explicitLimit = topMatch ? parseInt(topMatch[1]) : (typeof analysis?.limit === 'number' ? analysis.limit : undefined);

    // Extract numbers
    const numbers = question.match(/\b(\d{1,4})\b/g)?.map(n => parseInt(n)) || [];
    
    // Extract years
    const years = question.match(/\b(19|20)\d{2}\b/g)?.map(y => parseInt(y)) || [];
    
    // Extract quoted strings (highest priority for entity names)
    const quotedStrings = question.match(/["']([^"']+)["']/g)?.map(s => s.replace(/["']/g, '')) || [];
    
    // Extract entity names with "&" or complex names (e.g., "Tanks & Temples", "MipNeRF-360")
    // Look for patterns like: "X & Y dataset", "X-Y method", or capitalized sequences
    // Also include lowercase technical terms like "gaussian", "nerf", etc.
    const entityPatterns = [
      /([A-Z][a-zA-Z0-9\s&]+(?:\s+&\s+[A-Z][a-zA-Z0-9\s]+)*)\s+(?:dataset|method|metric|concept)/gi,
      /([A-Z][a-zA-Z0-9]+(?:-[A-Z][a-zA-Z0-9]+)+)/g,  // Hyphenated names like "MipNeRF-360"
      /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/g,  // Multi-word capitalized
      /\b(NeRF|PSNR|SSIM|LPIPS|3DGS|3DGS|InstantNGP|gaussian|nerf|splatting|3dgs|instantngp|mipnerf)\b/gi,  // Known acronyms and lowercase terms
    ];
    
    let entityNames: string[] = [];
    for (const pattern of entityPatterns) {
      const matches = question.match(pattern) || [];
      entityNames.push(...matches.map(m => m.trim()));
    }
    
    // Remove duplicates and filter out common words
    entityNames = [...new Set(entityNames)].filter(name => 
      !/^(Which|What|How|Show|Find|List|Get|Papers|Paper|The|Use|Uses|Dataset|Method|Metric)$/i.test(name)
    );
    
    // Extract author names (capitalized words that might be names)
    const authorMatches = question.match(/\b([A-Z][a-z]+\s+[A-Z][a-z]+)\b/g) || [];
    
    // Extract months
    const monthNames = question.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi) || [];
    
    // Smart parameter assignment based on SQL query content
    for (let i = 0; i < paramCount; i++) {
      const sqlLower = sql.toLowerCase();
      const paramIndex = placeholderIndices[i];
      
      // If this parameter is the LIMIT placeholder, use a numeric value
      const limitPlaceholderMatch = sqlLower.match(/limit\s+\$(\d+)/i);
      if (limitPlaceholderMatch && parseInt(limitPlaceholderMatch[1]) === paramIndex) {
        const limitVal = explicitLimit || 10;
        params.push(limitVal);
        continue;
      }
      
      // Priority 1: Check what the parameter is for based on SQL context
      if (sqlLower.includes(`canonical_name`)) {
        // For canonical_name, use entity name and normalize it
        let entityName = '';
        
        // Priority 1: Use analysis value if available (most reliable)
        const analysisValue = analysis?.conditions?.value;
        if (analysisValue && typeof analysisValue === 'string') {
          entityName = analysisValue;
        } else if (quotedStrings.length > 0) {
          // Priority 2: Quoted strings
          entityName = quotedStrings[0];
          quotedStrings.shift();
        } else if (entityNames.length > 0) {
          // Priority 3: Matched entity patterns
          entityName = entityNames[0];
          entityNames.shift();
        } else {
          // Priority 4: Try to extract key term from question (better patterns)
          const questionLower = question.toLowerCase();
          
          // Extract single-word technical terms (like "gaussian", "nerf", "splatting")
          const singleWordMatches = question.match(/\b(gaussian|nerf|splatting|instantngp|mipnerf|tanks|temples|psnr|ssim|lpips)\b/i);
          if (singleWordMatches && singleWordMatches[1]) {
            entityName = singleWordMatches[1];
          } else {
            // Extract term after "about", "focuses", "mentions", etc., but only the last meaningful word(s)
            const afterPatterns = [
              // Match "about X" where X is 1-3 words (stop at end or common words)
              /(?:about|focuses?\s+(?:the\s+most\s+)?about|mentions?\s+(?:the\s+most\s+)?about)\s+([a-z]+(?:\s+[a-z]+){0,2}?)(?:\s+dataset|\s+method|\s+metric|\s+paper|\s+papers|$|\.|\?)/i,
              // Match "the most about X"
              /(?:the\s+most\s+about)\s+([a-z]+(?:\s+[a-z]+){0,2}?)(?:\s+dataset|\s+method|\s+metric|\s+paper|\s+papers|$|\.|\?)/i,
              // Match "focuses on X" or "mentions X"
              /(?:focuses?\s+on|mentions?)\s+([a-z]+(?:\s+[a-z]+){0,2}?)(?:\s+dataset|\s+method|\s+metric|\s+paper|\s+papers|$|\.|\?)/i,
              // Match after common verbs
              /(?:use|uses|used by|with|from)\s+([a-z]+(?:\s+[a-z]+){0,2}?)(?:\s+dataset|\s+method|\s+metric|\s+paper|\s+papers|$|\.|\?)/i,
            ];
            
            for (const pattern of afterPatterns) {
              const match = question.match(pattern);
              if (match && match[1]) {
                // Extract just the last meaningful word (often the key term)
                const words = match[1].trim().split(/\s+/);
                // If there are multiple words, prefer the last one (e.g., "the most about gaussian" -> "gaussian")
                entityName = words[words.length - 1];
                break;
              }
            }
            
            // If still no match, try to find any technical term in the question
            if (!entityName) {
              const technicalTerms = question.match(/\b(gaussian|nerf|splatting|3dgs|instantngp|mipnerf)\b/i);
              if (technicalTerms && technicalTerms[0]) {
                entityName = technicalTerms[0].toLowerCase();
              }
            }
          }
        }
        
        // Normalize for canonical_name: lowercase, replace & with 'and', collapse spaces
        if (entityName) {
          const normalized = entityName.toLowerCase()
            .replace(/&/g, 'and')
            .replace(/\s+/g, ' ')
            .trim();
          params.push(normalized);
        } else {
          params.push(null);
        }
      } else if (sqlLower.includes(`extract(year`) || (sqlLower.includes(`year`) && years.length > 0)) {
        params.push(years[0]);
        years.shift();
      } else if (sqlLower.includes(`extract(month`) || (sqlLower.includes(`month`) && monthNames.length > 0)) {
        const monthMap: { [key: string]: number } = {
          'january': 1, 'february': 2, 'march': 3, 'april': 4,
          'may': 5, 'june': 6, 'july': 7, 'august': 8,
          'september': 9, 'october': 10, 'november': 11, 'december': 12
        };
        if (monthNames.length > 0) {
          const monthName = monthNames[0]?.toLowerCase();
          if (monthName && monthMap[monthName]) {
            params.push(monthMap[monthName]);
            monthNames.shift();
          } else {
            params.push(null);
          }
        } else {
          params.push(null);
        }
      } else if (sqlLower.includes(`authors`) && authorMatches.length > 0) {
        params.push(authorMatches[0]);
        authorMatches.shift();
      } else if ((sqlLower.includes(`array_length`) || sqlLower.includes(`>`)) && numbers.length > 0) {
        params.push(numbers[0]);
        numbers.shift();
      } else if (quotedStrings.length > 0) {
        // Use full quoted phrase as a single parameter
        const phrase = quotedStrings[0].trim();
        params.push(`%${phrase}%`);
        quotedStrings.shift();
      } else if (entityNames.length > 0) {
        params.push(`%${entityNames[0]}%`);
        entityNames.shift();
      } else if (authorMatches.length > 0) {
        params.push(authorMatches[0]);
        authorMatches.shift();
      } else {
        // Last resort: extract from analysis
        const analysisValue = analysis?.conditions?.value;
        if (analysisValue) {
          params.push(`%${analysisValue}%`);
        } else {
          params.push(null);
        }
      }
    }

    return params;
  }

  /**
   * Try to fix SQL query if it fails
   */
  private async fixQuery(sql: string, errorMessage: string, question: string, analysis?: any): Promise<string | null> {
    let fixed = sql;
    
    // CRITICAL FIX: Remove double negation "NOT NOT ILIKE" FIRST (before any other fixes)
    if (fixed.includes('NOT NOT ILIKE') || fixed.match(/\bNOT\s+NOT\s+ILIKE/i)) {
      fixed = fixed.replace(/\s+NOT\s+NOT\s+ILIKE/gi, ' NOT ILIKE');
      fixed = fixed.replace(/\bNOT\s+NOT\s+ILIKE/gi, 'NOT ILIKE');
      fixed = fixed.replace(/(WHERE|AND|OR)\s+([^\s]+)\s+NOT\s+NOT\s+ILIKE/gi, '$1 $2 NOT ILIKE');
      console.log('  🔧 Fixed: Removed double negation (NOT NOT ILIKE → NOT ILIKE)');
      return fixed;
    }
    
    // Fix negation queries (if SQL says ILIKE but question has "not")
    const questionLower = question.toLowerCase();
    const hasNegation = /\b(not\s+about|not\s+in|not\s+contain|doesn't|does not|don't|do not|excluding|without|except|are not)\b/i.test(questionLower);
    if (hasNegation && fixed.includes('ILIKE')) {
      // Check if already has NOT ILIKE - don't add another NOT
      if (!fixed.includes('NOT ILIKE') && !fixed.match(/\bNOT\s+\w+\s+ILIKE/i)) {
        // Replace ILIKE with NOT ILIKE for negation queries
        fixed = fixed.replace(/(WHERE|AND|OR)\s+(abstract|title)\s+ILIKE\b/gi, '$1 $2 NOT ILIKE');
        fixed = fixed.replace(/(WHERE|AND|OR)\s+([^\s]+)\s+ILIKE\b/gi, (match, op, col) => {
          // Don't add NOT if there's already a NOT before this
          if (match.includes('NOT')) return match;
          return `${op} ${col} NOT ILIKE`;
        });
        // Remove any trailing "= FALSE" that might have been incorrectly added
        fixed = fixed.replace(/\s+NOT\s+ILIKE\s+([^=]+)\s*=\s*FALSE/gi, ' NOT ILIKE $1');
        console.log('  🔧 Fixed: Detected negation in question, changed ILIKE to NOT ILIKE');
        return fixed;
      }
    }
      
      // Fix: Remove invalid "= FALSE" after NOT ILIKE if present
      if (fixed.includes('NOT ILIKE') && fixed.includes('= FALSE')) {
        fixed = fixed.replace(/\s+NOT\s+ILIKE\s+([^=\s]+)\s*=\s*FALSE/gi, ' NOT ILIKE $1');
        console.log('  🔧 Fixed: Removed invalid "= FALSE" after NOT ILIKE');
        return fixed;
      }
      
      // Fix missing confidence_score column in papers table
      if (errorMessage.includes('column "confidence_score" does not exist') || 
          errorMessage.includes('column papers.confidence_score')) {
      // Remove confidence_score from papers table references
      fixed = fixed.replace(/papers?\.confidence_score|confidence_score(?=\s+DESC|\s+ASC|\s*,|\s*$)/gi, '');
      
      // If query is about "focuses the most" or "most about", generate a relevance-based query
      const q = question.toLowerCase();
      if ((q.includes('focuses') && q.includes('most')) || (q.includes('most') && q.includes('about'))) {
        // Extract the entity/topic being searched for from analysis or question
        const analysisValue = analysis?.conditions?.value || 'gaussian';
        const searchTerm = analysisValue.toLowerCase();
        
        // Generate a query that measures focus by counting mentions (use parameterized query)
        // We'll need to escape the search term and use $1 placeholder
        fixed = `
          SELECT 
            p.id,
            p.arxiv_id,
            p.title,
            p.authors,
            p.abstract,
            p.published_date,
            p.arxiv_url,
            (
              -- Weight title mentions more heavily (10x)
              (CASE WHEN p.title ILIKE $1 THEN 10 ELSE 0 END) +
              -- Count abstract mentions (1x per mention)
              (LENGTH(COALESCE(p.abstract, '')) - LENGTH(REPLACE(LOWER(COALESCE(p.abstract, '')), LOWER($1), ''))) / NULLIF(LENGTH($1), 0) +
              -- Check if linked to entity with high significance
              COALESCE(MAX(pe.significance_score), 0) * 5
            ) as focus_score
          FROM papers p
          LEFT JOIN paper_entities pe ON p.id = pe.paper_id
          LEFT JOIN entities e ON pe.entity_id = e.id AND e.canonical_name ILIKE $1
          WHERE 
            (p.title ILIKE $1 OR p.abstract ILIKE $1 OR e.canonical_name ILIKE $1)
            AND p.abstract IS NOT NULL
          GROUP BY p.id, p.arxiv_id, p.title, p.authors, p.abstract, p.published_date, p.arxiv_url
          ORDER BY focus_score DESC, p.published_date DESC
          LIMIT 20
        `;
        console.log('  🔧 Fixed: Generated focus-based relevance query');
        // Return a special marker to indicate we need to use the first param with % wildcards
        return fixed;
      }
      
      // Otherwise, just remove confidence_score and order by published_date
      fixed = fixed.replace(/ORDER BY\s+.*confidence_score.*/i, 'ORDER BY published_date DESC');
      console.log('  🔧 Fixed: Removed invalid confidence_score column');
      return fixed;
    }
    
    // Fix SELECT DISTINCT with ORDER BY columns not in SELECT
    if (errorMessage.includes('ORDER BY expressions must appear in select list') || 
        errorMessage.includes('must appear in SELECT')) {
      // Extract ORDER BY clause
      const orderByMatch = fixed.match(/ORDER\s+BY\s+([^\s]+(?:\s+DESC|\s+ASC)?(?:\s*,\s*[^\s]+(?:\s+DESC|\s+ASC)?)*)/i);
      if (orderByMatch) {
        const orderByClause = orderByMatch[1];
        // Extract column names from ORDER BY
        const orderColumns = orderByClause.split(',').map(col => {
          const trimmed = col.trim();
          // Remove DESC/ASC
          return trimmed.replace(/\s+(DESC|ASC)$/i, '').trim();
        });
        
        // Check if SELECT DISTINCT
        if (fixed.toUpperCase().includes('SELECT DISTINCT')) {
          // Extract SELECT list
          const selectMatch = fixed.match(/SELECT\s+DISTINCT\s+(.+?)\s+FROM/i);
          if (selectMatch) {
            let selectList = selectMatch[1];
            
            // Add ORDER BY columns to SELECT if they're not already there
            for (const orderCol of orderColumns) {
              // Check if column is already in SELECT (simplified check)
              const colName = orderCol.split('.').pop() || orderCol;
              if (!selectList.includes(colName) && !selectList.includes(orderCol)) {
                selectList += `, ${orderCol}`;
              }
            }
            
            // Replace SELECT DISTINCT with fixed SELECT list
            fixed = fixed.replace(/SELECT\s+DISTINCT\s+(.+?)\s+FROM/i, `SELECT DISTINCT ${selectList}\nFROM`);
            console.log('  🔧 Fixed SELECT DISTINCT with ORDER BY columns');
          }
        }
      }
      
      return fixed;
    }
    
    // Fix ambiguous column references (e.g., "confidence_score is ambiguous")
    if (errorMessage.toLowerCase().includes('ambiguous') || errorMessage.toLowerCase().includes('is ambiguous')) {
      // Qualify confidence_score to relationships.confidence_score (r.confidence_score) when joins are present
      if (fixed.match(/\bJOIN\s+relationships\b/i)) {
        // Qualify ORDER BY confidence_score → ORDER BY r.confidence_score
        fixed = fixed.replace(/\bORDER\s+BY\s+confidence_score\b/gi, 'ORDER BY r.confidence_score');
        fixed = fixed.replace(/\bORDER\s+BY\s+confidence_score\s+(DESC|ASC)\b/gi, 'ORDER BY r.confidence_score $1');
        // Qualify bare confidence_score in SELECT if present
        fixed = fixed.replace(/\bSELECT\s+DISTINCT\s+([^;]+?)\bconfidence_score\b/gi, (m, before) => {
          return m.replace(/\bconfidence_score\b/gi, 'r.confidence_score');
        });
        // If SELECT DISTINCT and now ordering by r.confidence_score, ensure it's in SELECT list
        if (fixed.toUpperCase().includes('SELECT DISTINCT') && fixed.match(/\bORDER\s+BY\s+r\.confidence_score\b/i)) {
          const selectMatch = fixed.match(/SELECT\s+DISTINCT\s+(.+?)\s+FROM/i);
          if (selectMatch && !/r\.confidence_score/i.test(selectMatch[1])) {
            fixed = fixed.replace(/SELECT\s+DISTINCT\s+(.+?)\s+FROM/i, (m, list) => {
              return `SELECT DISTINCT ${list}, r.confidence_score\nFROM`;
            });
          }
        }
        console.log('  🔧 Fixed: Qualified ambiguous confidence_score to r.confidence_score');
      }
      return fixed;
    }
    
    // Add LIMIT if missing
    if (!fixed.toUpperCase().includes('LIMIT')) {
      fixed += ' LIMIT 20';
    }
    
    // Fix common syntax errors
    fixed = fixed.replace(/;;+/g, ';');
    
    // Fix array operations if error mentions them
    if (errorMessage.includes('array')) {
      fixed = fixed.replace(/authors\s*=\s*\$(\d+)/gi, 'authors @> ARRAY[$1]');
    }
    
    // Fix canonical_name comparison - should use normalized value (always normalize)
    if (fixed.includes('canonical_name') || fixed.includes('canonical_name')) {
      // Normalize: "Tanks & Temples" -> "tanks and temples", "3DGS" -> "3dgs", etc.
      fixed = fixed.replace(/canonical_name\s*=\s*['"]([^'"]+)['"]/gi, (match, value) => {
        // Normalize: lowercase, replace & with 'and', collapse multiple spaces
        const normalized = value.toLowerCase()
          .replace(/&/g, 'and')
          .replace(/\s+/g, ' ')
          .trim();
        return `canonical_name = '${normalized}'`;
      });
      console.log('  🔧 Fixed canonical_name normalization');
    }
    
    return fixed;
  }

  /**
   * Validate SQL for safety
   */
  private validateSQL(sql: string): boolean {
    if (!sql || sql.trim().length === 0) {
      return false;
    }

    const upperSQL = sql.toUpperCase();
    
    // Block dangerous operations
    const dangerous = ['DROP', 'DELETE', 'TRUNCATE', 'ALTER', 'CREATE', 'INSERT', 'UPDATE', 'GRANT', 'REVOKE'];
    for (const keyword of dangerous) {
      if (upperSQL.includes(keyword)) {
        return false;
      }
    }

    // Must be SELECT or WITH (CTE)
    if (!upperSQL.trim().startsWith('SELECT') && !upperSQL.trim().startsWith('WITH')) {
      return false;
    }

    // Only one statement
    const semicolonCount = (sql.match(/;/g) || []).length;
    if (semicolonCount > 1) {
      return false;
    }

    return true;
  }
}

