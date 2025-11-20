import { Pool, QueryResult } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Represents a research paper from arXiv
 */
export interface Paper {
  id?: number;
  arxiv_id: string;
  title: string;
  authors: string[];
  abstract: string | null;
  published_date: Date | null;
  pdf_url: string | null;
  arxiv_url: string | null;
  processed?: boolean;
}

/**
 * Represents an extracted entity (method, concept, dataset, or metric)
 */
export interface Entity {
  id?: number;
  name: string;
  entity_type: 'concept' | 'method' | 'dataset' | 'metric';
  description: string | null;
  canonical_name: string;
  confidence_score: number | null;
  first_mentioned_in: number | null;
}

/**
 * Represents a relationship between two entities
 */
export interface Relationship {
  id?: number;
  source_entity_id: number;
  target_entity_id: number;
  relationship_type: string;
  paper_id: number;
  confidence_score: number | null;
  context: string | null;
}

// ============================================================================
// DATABASE CLIENT CLASS
// ============================================================================

/**
 * Database client for interacting with PostgreSQL
 * Provides type-safe operations for papers, entities, and relationships
 */
export class DatabaseClient {
  private pool: Pool;

  constructor() {
    // Create connection pool - reuses connections for better performance
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20, // Maximum number of connections in the pool
      idleTimeoutMillis: 30000, // Close idle connections after 30 seconds
      connectionTimeoutMillis: 2000, // Timeout after 2 seconds if can't connect
    });

    // Handle pool errors (don't crash the app)
    this.pool.on('error', (err) => {
      console.error('Unexpected database error:', err);
    });
  }

  /**
   * Test database connection
   * Returns true if connection successful, false otherwise
   */
  async testConnection(): Promise<boolean> {
    try {
      const result = await this.pool.query('SELECT NOW()');
      console.log('Database connection successful:', result.rows[0].now);
      return true;
    } catch (error) {
      console.error('Database connection failed:', error);
      return false;
    }
  }

  // ============================================================================
  // PAPER OPERATIONS
  // ============================================================================

  /**
   * Insert a new paper or update if it already exists (based on arxiv_id)
   * Returns the paper's database ID
   */
  async insertPaper(paper: Paper): Promise<number> {
    const query = `
      INSERT INTO papers (arxiv_id, title, authors, abstract, published_date, pdf_url, arxiv_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (arxiv_id) DO UPDATE SET
        title = EXCLUDED.title,
        authors = EXCLUDED.authors,
        abstract = EXCLUDED.abstract,
        published_date = EXCLUDED.published_date,
        pdf_url = EXCLUDED.pdf_url,
        arxiv_url = EXCLUDED.arxiv_url
      RETURNING id
    `;
    const result = await this.pool.query(query, [
      paper.arxiv_id,
      paper.title,
      paper.authors,
      paper.abstract,
      paper.published_date,
      paper.pdf_url,
      paper.arxiv_url,
    ]);
    return result.rows[0].id;
  }

  /**
   * Get papers that haven't been processed yet
   * Returns up to 'limit' papers, ordered by publication date (newest first)
   */
  async getUnprocessedPapers(limit: number = 10): Promise<Paper[]> {
    const query = `
      SELECT * FROM papers
      WHERE processed = FALSE
      ORDER BY published_date DESC NULLS LAST
      LIMIT $1
    `;
    const result = await this.pool.query(query, [limit]);
    return result.rows;
  }

  /**
   * Mark a paper as processed (successfully or with error)
   */
  async markPaperAsProcessed(paperId: number, error: string | null = null): Promise<void> {
    const query = `
      UPDATE papers
      SET processed = TRUE, processing_error = $2
      WHERE id = $1
    `;
    await this.pool.query(query, [paperId, error]);
  }

  // ============================================================================
  // ENTITY OPERATIONS
  // ============================================================================

  /**
   * Insert a new entity or update if it already exists (based on canonical_name + entity_type)
   * Uses ON CONFLICT to update if entity already exists (deduplication)
   * Returns the entity's database ID
   */
  async insertEntity(entity: Entity): Promise<number> {
    const query = `
      INSERT INTO entities (name, entity_type, description, canonical_name, confidence_score, first_mentioned_in)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (canonical_name, entity_type) DO UPDATE SET
        name = COALESCE(EXCLUDED.name, entities.name),
        description = COALESCE(EXCLUDED.description, entities.description),
        confidence_score = GREATEST(EXCLUDED.confidence_score, entities.confidence_score)
      RETURNING id
    `;
    const result = await this.pool.query(query, [
      entity.name,
      entity.entity_type,
      entity.description,
      entity.canonical_name,
      entity.confidence_score,
      entity.first_mentioned_in,
    ]);
    return result.rows[0].id;
  }

  /**
   * Find an entity by its canonical name and type
   * Returns the entity if found, null otherwise
   */
  async findEntityByCanonicalName(canonicalName: string, entityType: string): Promise<Entity | null> {
    const query = `
      SELECT * FROM entities
      WHERE canonical_name = $1 AND entity_type = $2
      LIMIT 1
    `;
    const result = await this.pool.query(query, [canonicalName, entityType]);
    return result.rows[0] || null;
  }

  // ============================================================================
  // RELATIONSHIP OPERATIONS
  // ============================================================================

  /**
   * Insert a new relationship or update if it already exists
   * Prevents duplicate relationships between same entities in same paper
   * Returns the relationship's database ID
   */
  async insertRelationship(relationship: Relationship): Promise<number> {
    const query = `
      INSERT INTO relationships (source_entity_id, target_entity_id, relationship_type, paper_id, confidence_score, context)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (source_entity_id, target_entity_id, relationship_type, paper_id) DO UPDATE SET
        confidence_score = GREATEST(EXCLUDED.confidence_score, relationships.confidence_score),
        context = COALESCE(EXCLUDED.context, relationships.context)
      RETURNING id
    `;
    const result = await this.pool.query(query, [
      relationship.source_entity_id,
      relationship.target_entity_id,
      relationship.relationship_type,
      relationship.paper_id,
      relationship.confidence_score,
      relationship.context,
    ]);
    return result.rows[0].id;
  }

  // ============================================================================
  // PAPER-ENTITY JUNCTION OPERATIONS
  // ============================================================================

  /**
   * Link a paper to an entity (many-to-many relationship)
   * Updates mention count and significance score if link already exists
   */
  async linkPaperToEntity(
    paperId: number,
    entityId: number,
    mentionCount: number = 1,
    significanceScore: number | null = null
  ): Promise<void> {
    const query = `
      INSERT INTO paper_entities (paper_id, entity_id, mention_count, significance_score)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (paper_id, entity_id) DO UPDATE SET
        mention_count = paper_entities.mention_count + EXCLUDED.mention_count,
        significance_score = GREATEST(EXCLUDED.significance_score, paper_entities.significance_score)
    `;
    await this.pool.query(query, [paperId, entityId, mentionCount, significanceScore]);
  }

  // ============================================================================
  // QUERY OPERATIONS (Example queries from requirements)
  // ============================================================================

  /**
   * Query 1: Find papers that improve on a specific method
   * Example: "Which papers improve on 3D Gaussian Splatting?"
   * Searches for relationships where relationship_type is 'improves', 'extends', or 'enhances'
   */
  async getPapersImprovingMethod(methodName: string): Promise<any[]> {
    const query = `
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
      WHERE e.canonical_name ILIKE $1
        AND e.entity_type = 'method'
        AND r.relationship_type IN ('improves', 'extends', 'enhances')
      ORDER BY p.published_date DESC, r.confidence_score DESC
    `;
    const result = await this.pool.query(query, [`%${methodName}%`]);
    return result.rows;
  }

  /**
   * Query 2: Find most commonly used methods
   * Example: "What methods are most commonly used?"
   * Counts how many papers mention each method, ordered by frequency
   */
  async getMostCommonMethods(limit: number = 10): Promise<any[]> {
    const query = `
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
      LIMIT $1
    `;
    const result = await this.pool.query(query, [limit]);
    return result.rows;
  }

  /**
   * Query 3: Find related papers based on shared concepts
   * Example: "Find related papers based on shared concepts"
   * Finds papers that mention multiple specified concepts
   */
  async getRelatedPapersByConcepts(conceptNames: string[], limit: number = 10): Promise<any[]> {
    // Build placeholder for array of concept names
    const placeholders = conceptNames.map((_, i) => `$${i + 2}`).join(', ');
    const minSharedConcepts = Math.max(1, Math.floor(conceptNames.length / 2));
    
    const query = `
      SELECT 
        p.id,
        p.arxiv_id,
        p.title,
        p.authors,
        p.published_date,
        COUNT(DISTINCT e.id) as matching_concepts,
        ARRAY_AGG(DISTINCT e.name) as concept_names
      FROM papers p
      JOIN paper_entities pe ON p.id = pe.paper_id
      JOIN entities e ON pe.entity_id = e.id
      WHERE e.entity_type = 'concept'
        AND e.canonical_name = ANY(ARRAY[${placeholders}])
      GROUP BY p.id, p.arxiv_id, p.title, p.authors, p.published_date
      HAVING COUNT(DISTINCT e.id) >= $1
      ORDER BY matching_concepts DESC, p.published_date DESC
      LIMIT ${limit}
    `;
    const result = await this.pool.query(query, [minSharedConcepts, ...conceptNames]);
    return result.rows;
  }

  /**
   * Execute a raw SQL query (for custom queries)
   * Use with caution - always validate user input to prevent SQL injection
   */
  async query(sql: string, params?: any[]): Promise<any[]> {
    const result = await this.pool.query(sql, params || []);
    return result.rows;
  }

  /**
   * Close all database connections
   * Call this when shutting down the application
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

