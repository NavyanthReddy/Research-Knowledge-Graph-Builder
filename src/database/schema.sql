-- Gaussian Splatting Knowledge Graph Database Schema
-- Run this file to create all tables, indexes, and views

-- ============================================================================
-- TABLES
-- ============================================================================

-- Papers table: Stores metadata about research papers from arXiv
CREATE TABLE IF NOT EXISTS papers (
    id SERIAL PRIMARY KEY,
    arxiv_id VARCHAR(50) UNIQUE NOT NULL,
    title TEXT NOT NULL,
    authors TEXT[],
    abstract TEXT,
    published_date DATE,
    pdf_url TEXT,
    arxiv_url TEXT,
    ingestion_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed BOOLEAN DEFAULT FALSE,
    processing_error TEXT,
    CONSTRAINT unique_arxiv_id UNIQUE (arxiv_id)
);

-- Entities table: Stores extracted entities (methods, concepts, datasets, metrics)
-- canonical_name is normalized for deduplication (e.g., "3dgs", "3d gaussian splatting")
CREATE TABLE IF NOT EXISTS entities (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    entity_type VARCHAR(50) NOT NULL, -- 'concept', 'method', 'dataset', 'metric'
    description TEXT,
    canonical_name TEXT, -- normalized name for deduplication
    confidence_score DECIMAL(3,2) CHECK (confidence_score >= 0 AND confidence_score <= 1),
    first_mentioned_in INTEGER REFERENCES papers(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_canonical_name_type UNIQUE (canonical_name, entity_type)
);

-- Relationships table: Stores semantic connections between entities
-- relationship_type: 'improves', 'uses', 'extends', 'compares', 'cites', etc.
CREATE TABLE IF NOT EXISTS relationships (
    id SERIAL PRIMARY KEY,
    source_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    relationship_type VARCHAR(100) NOT NULL,
    paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    confidence_score DECIMAL(3,2) CHECK (confidence_score >= 0 AND confidence_score <= 1),
    context TEXT, -- snippet of text that establishes this relationship
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT no_self_relationship CHECK (source_entity_id != target_entity_id),
    CONSTRAINT unique_relationship UNIQUE (source_entity_id, target_entity_id, relationship_type, paper_id)
);

-- Paper-Entities junction table: Links papers to entities they mention
-- Tracks how many times an entity is mentioned and its significance in the paper
CREATE TABLE IF NOT EXISTS paper_entities (
    paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    mention_count INTEGER DEFAULT 1,
    first_mention_position INTEGER, -- character position in paper text
    significance_score DECIMAL(3,2), -- how important this entity is to the paper
    PRIMARY KEY (paper_id, entity_id)
);

-- ============================================================================
-- INDEXES (for query performance)
-- ============================================================================

-- Papers indexes
CREATE INDEX IF NOT EXISTS idx_papers_arxiv_id ON papers(arxiv_id);
CREATE INDEX IF NOT EXISTS idx_papers_processed ON papers(processed);
CREATE INDEX IF NOT EXISTS idx_papers_published_date ON papers(published_date DESC);

-- Entities indexes
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_canonical_name ON entities(canonical_name);
CREATE INDEX IF NOT EXISTS idx_entities_confidence ON entities(confidence_score DESC);

-- Relationships indexes
CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_entity_id);
CREATE INDEX IF NOT EXISTS idx_relationships_type ON relationships(relationship_type);
CREATE INDEX IF NOT EXISTS idx_relationships_paper ON relationships(paper_id);
CREATE INDEX IF NOT EXISTS idx_relationships_confidence ON relationships(confidence_score DESC);

-- Paper-Entities indexes
CREATE INDEX IF NOT EXISTS idx_paper_entities_paper ON paper_entities(paper_id);
CREATE INDEX IF NOT EXISTS idx_paper_entities_entity ON paper_entities(entity_id);
CREATE INDEX IF NOT EXISTS idx_paper_entities_significance ON paper_entities(significance_score DESC);

-- ============================================================================
-- VIEWS (pre-computed aggregations for common queries)
-- ============================================================================

-- Entity statistics: Shows how many papers mention each entity and relationship count
CREATE OR REPLACE VIEW entity_statistics AS
SELECT 
    e.id,
    e.name,
    e.entity_type,
    COUNT(DISTINCT pe.paper_id) as paper_count,
    COUNT(DISTINCT r.id) as relationship_count,
    AVG(e.confidence_score) as avg_confidence
FROM entities e
LEFT JOIN paper_entities pe ON e.id = pe.entity_id
LEFT JOIN relationships r ON e.id = r.source_entity_id OR e.id = r.target_entity_id
GROUP BY e.id, e.name, e.entity_type;

-- ============================================================================
-- EXAMPLE QUERIES (for reference, not executed here)
-- ============================================================================

-- Query 1: Find papers that improve on 3D Gaussian Splatting
-- SELECT p.*, e.name as entity_name, r.relationship_type, r.context
-- FROM papers p
-- JOIN relationships r ON p.id = r.paper_id
-- JOIN entities e ON (r.target_entity_id = e.id OR r.source_entity_id = e.id)
-- WHERE e.canonical_name ILIKE '%3d gaussian splatting%'
--   AND r.relationship_type = 'improves';

-- Query 2: Find most commonly used methods
-- SELECT e.name, COUNT(DISTINCT pe.paper_id) as paper_count
-- FROM entities e
-- JOIN paper_entities pe ON e.id = pe.entity_id
-- WHERE e.entity_type = 'method'
-- GROUP BY e.id, e.name
-- ORDER BY paper_count DESC
-- LIMIT 10;

-- Query 3: Find related papers based on shared concepts
-- SELECT p.id, p.title, COUNT(DISTINCT e.id) as shared_concepts
-- FROM papers p
-- JOIN paper_entities pe ON p.id = pe.paper_id
-- JOIN entities e ON pe.entity_id = e.id
-- WHERE e.entity_type = 'concept'
--   AND e.canonical_name IN ('splatting', 'rendering', 'gaussian')
-- GROUP BY p.id, p.title
-- HAVING COUNT(DISTINCT e.id) >= 2
-- ORDER BY shared_concepts DESC;

