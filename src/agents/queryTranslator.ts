import { HfInference } from '@huggingface/inference';

/**
 * Query Translator Agent
 * Uses LLM to translate natural language questions to SQL queries
 */
export class QueryTranslator {
  private hf: HfInference;
  private model = 'meta-llama/Llama-3.1-8B-Instruct'; // Available on free tier

  constructor(apiKey: string) {
    this.hf = new HfInference(apiKey);
  }

  /**
   * Translate a natural language question to a SQL query
   * @param question - Natural language question
   * @returns SQL query string or null if translation fails
   */
  async translateQuestionToSQL(question: string): Promise<string | null> {
    const systemPrompt = this.getSystemPrompt();
    const userPrompt = this.buildQueryPrompt(question);

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

      // Extract SQL query from response
      // The LLM should return SQL wrapped in ```sql ... ``` or just the query
      const sqlMatch = content.match(/```sql\s*([\s\S]*?)\s*```/i) ||
                       content.match(/```\s*([\s\S]*?)\s*```/) ||
                       content.match(/(SELECT[\s\S]+?;)/i);
      
      if (sqlMatch) {
        return sqlMatch[1].trim();
      }

      // If no code block found, try to extract SQL directly
      const lines = content.split('\n');
      const sqlLines = lines.filter(line => 
        line.trim().toUpperCase().startsWith('SELECT') ||
        line.trim().toUpperCase().startsWith('WITH') ||
        line.includes('FROM') ||
        line.includes('JOIN') ||
        line.includes('WHERE') ||
        line.trim() === ';' ||
        (!line.trim().startsWith('--') && line.trim().length > 0)
      );

      if (sqlLines.length > 0) {
        return sqlLines.join('\n').trim();
      }

      return null;
    } catch (error) {
      console.error('Error translating question to SQL:', error);
      return null;
    }
  }

  /**
   * Get system prompt for query translation
   */
  private getSystemPrompt(): string {
    return `You are an expert SQL query translator for a research paper knowledge graph database. Translate natural language questions to PostgreSQL SQL queries.

DATABASE SCHEMA:
Tables and columns:
1. **papers**: id (SERIAL), arxiv_id (VARCHAR), title (TEXT), authors (TEXT[]), abstract (TEXT), published_date (DATE), pdf_url (TEXT), arxiv_url (TEXT), ingestion_timestamp (TIMESTAMP), processed (BOOLEAN)
2. **entities**: id (SERIAL), name (TEXT), entity_type (VARCHAR: 'method', 'concept', 'dataset', 'metric'), description (TEXT), canonical_name (TEXT), confidence_score (DECIMAL), first_mentioned_in (INTEGER), created_at (TIMESTAMP)
3. **relationships**: id (SERIAL), source_entity_id (INTEGER), target_entity_id (INTEGER), relationship_type (VARCHAR: 'improves', 'uses', 'extends', 'compares', 'cites', 'evaluates'), paper_id (INTEGER), confidence_score (DECIMAL), context (TEXT), created_at (TIMESTAMP)
4. **paper_entities**: paper_id (INTEGER), entity_id (INTEGER), mention_count (INTEGER), first_mention_position (INTEGER), significance_score (DECIMAL)

JOINS:
- papers.id = relationships.paper_id
- entities.id = relationships.source_entity_id (source)
- entities.id = relationships.target_entity_id (target)
- papers.id = paper_entities.paper_id
- entities.id = paper_entities.entity_id

COMMON PATTERNS:
- Authors count: array_length(authors, 1)
- Text length: LENGTH(abstract), LENGTH(title)
- Date filtering: EXTRACT(YEAR FROM published_date) = $1, EXTRACT(MONTH FROM published_date) = $1
- Array operations: authors @> ARRAY['Author Name'], array_length(authors, 1) > $1
- Aggregations: COUNT(*), AVG(confidence_score), MAX(LENGTH(abstract))

CRITICAL RULES:
1. Use parameterized queries: $1, $2, etc. for user values
2. Use ILIKE for case-insensitive text search: column ILIKE $1 (with %wildcards%)
3. Use canonical_name for entity matching (normalized lowercase)
4. Always include LIMIT (default: 20, max: 100)
5. Use DISTINCT to avoid duplicates
6. Use proper JOINs for relationships
7. Order by relevance: ORDER BY published_date DESC, confidence_score DESC

OUTPUT FORMAT:
Return ONLY the SQL query, no markdown, no explanations, no code blocks. Just the SQL ready to execute.

Examples:
Q: "How many papers have more than 3 authors?"
A: SELECT COUNT(*) FROM papers WHERE array_length(authors, 1) > $1;

Q: "Show papers published in 2024"
A: SELECT * FROM papers WHERE EXTRACT(YEAR FROM published_date) = $1 ORDER BY published_date DESC LIMIT 20;

Q: "What methods are mentioned in paper 1234.5678?"
A: SELECT e.name, e.entity_type FROM entities e JOIN paper_entities pe ON e.id = pe.entity_id JOIN papers p ON pe.paper_id = p.id WHERE p.arxiv_id = $1 AND e.entity_type = 'method';

Now translate the user's question to SQL.`;
  }

  /**
   * Build user prompt with the question
   */
  private buildQueryPrompt(question: string): string {
    return `Question: "${question}"

Translate to PostgreSQL SQL. Return ONLY the SQL query, no explanations.`;
  }

  /**
   * Extract parameter values from question for SQL parameterization
   * This is a simple helper - in production, you might want more sophisticated extraction
   */
  extractParameters(question: string): string[] {
    const params: string[] = [];
    
    // Extract quoted strings
    const quotedMatches = question.match(/["']([^"']+)["']/g);
    if (quotedMatches) {
      quotedMatches.forEach(match => {
        params.push(match.replace(/["']/g, ''));
      });
    }
    
    // Extract entity names (capitalized or hyphenated terms)
    const entityMatches = question.match(/(?:[A-Z][a-z]+(?:-[A-Z][a-z]+)*|\d+D\s+[A-Z][a-z]+)/g);
    if (entityMatches) {
      entityMatches.forEach(match => {
        if (!params.includes(match)) {
          params.push(match);
        }
      });
    }
    
    return params;
  }

  /**
   * Validate generated SQL query for safety
   */
  validateSQL(sql: string): boolean {
    if (!sql || sql.trim().length === 0) {
      return false;
    }

    const upperSQL = sql.toUpperCase();
    
    // Check for dangerous operations
    const dangerousKeywords = ['DROP', 'DELETE', 'TRUNCATE', 'ALTER', 'CREATE', 'INSERT', 'UPDATE', 'GRANT', 'REVOKE'];
    for (const keyword of dangerousKeywords) {
      if (upperSQL.includes(keyword)) {
        return false;
      }
    }

    // Must be a SELECT query
    if (!upperSQL.trim().startsWith('SELECT')) {
      return false;
    }

    // Must not have multiple statements
    const semicolonCount = (sql.match(/;/g) || []).length;
    if (semicolonCount > 1) {
      return false;
    }

    return true;
  }
}

