# Gaussian Splatting Knowledge Graph - Agentic System

## Overview
An agentic backend that ingests Gaussian Splatting research papers, extracts entities and semantic relationships using an LLM (Hugging Face `meta-llama/Llama-3.1-8B-Instruct`), builds a semantic knowledge graph in PostgreSQL, and answers arbitrary natural language questions via an Intelligent Query Agent with transparent reasoning metadata.

## Architecture
- Ingestion
  - `src/ingestion/arxivFetcher.ts` fetches paper metadata and PDFs from arXiv (configurable query).
  - `pdf-parse` extracts text.
  - Papers are stored in `papers`; text feeds the extraction agents.
- Extraction Agents
  - `EntityExtractorAgent`: extracts entities (concept, method, dataset, metric, problem).
  - `RelationshipMapperAgent`: maps relationships (improves_on, extends, introduces, evaluates_with, uses_method, addresses_problem, compares_with, builds_on).
  - Robust JSON parsing/repair via `src/utils/jsonParser.ts`.
  - Reusable prompt templates: `src/agents/promptTemplates.ts`.
  - Rule-based fallbacks ensure minimal functionality without paid APIs.
- Knowledge Graph (PostgreSQL)
  - `papers`, `entities`, `relationships`, `paper_entities` with indexes and a view (`entity_statistics`).
- Querying
  - `IntelligentQueryAgent` generates/fixes SQL from NL prompts; executes and returns rows + metadata (detected intent, route, SQL, ranking signal, fallbacks, warnings/errors).
  - Multi-tier query strategy in `src/queries/askQuestion.ts`: intelligent agent → pattern match → rule-based SQL → domain-guarded full-text/graph search → legacy LLM translation.
  - Critical fixes: negation handling, canonical name normalization, `SELECT DISTINCT` vs `ORDER BY`, ambiguous `confidence_score` qualification, relevance gating.

## Database Schema (PostgreSQL)
Defined in `src/database/schema.sql`:
- `papers(id, arxiv_id, title, authors[], abstract, published_date, pdf_url, arxiv_url, ingestion_timestamp, processed)`
- `entities(id, name, entity_type, description, canonical_name, confidence_score, first_mentioned_in, created_at)`
- `relationships(id, source_entity_id, target_entity_id, relationship_type, paper_id, confidence_score, context, created_at)`
- `paper_entities(paper_id, entity_id, mention_count, first_mention_position, significance_score)`
Indexes on common filters and text search columns.

### Example Queries (3–5)
1) Count papers about Gaussian:
```sql
SELECT COUNT(*) FROM papers WHERE (title ILIKE '%gaussian%' OR abstract ILIKE '%gaussian%');
```
2) Papers not about Gaussian:
```sql
SELECT id, title FROM papers WHERE (title NOT ILIKE '%gaussian%' AND abstract NOT ILIKE '%gaussian%') LIMIT 20;
```
3) Methods that improve on 3DGS:
```sql
SELECT DISTINCT p.id, p.title, r.relationship_type, r.confidence_score
FROM papers p
JOIN relationships r ON p.id = r.paper_id
JOIN entities target_e ON r.target_entity_id = target_e.id
WHERE target_e.canonical_name = '3dgs' AND r.relationship_type IN ('improves','extends','enhances')
ORDER BY r.confidence_score DESC, p.published_date DESC
LIMIT 10;
```
4) Most common methods (top 10):
```sql
SELECT e.name AS method, COUNT(*) AS mentions
FROM entities e
JOIN paper_entities pe ON e.id = pe.entity_id
WHERE e.entity_type = 'method'
GROUP BY e.name
ORDER BY mentions DESC
LIMIT 10;
```
5) Papers related by shared concepts:
```sql
SELECT DISTINCT p.id, p.title
FROM papers p
JOIN paper_entities pe1 ON p.id = pe1.paper_id
JOIN paper_entities pe2 ON pe1.paper_id = pe2.paper_id
JOIN entities e1 ON pe1.entity_id = e1.id
JOIN entities e2 ON pe2.entity_id = e2.id
WHERE e1.entity_type = 'concept' AND e2.entity_type = 'concept' AND e1.id <> e2.id
LIMIT 20;
```

## Agents

### EntityExtractorAgent (`src/agents/entityExtractorAgent.ts`)
- Prompted with paper title, abstract, full text; returns JSON with entities.
- Validates and normalizes canonical names; assigns confidences.
- Fallback: rule-based extraction if LLM fails.

### RelationshipMapperAgent (`src/agents/relationshipMapperAgent.ts`)
- Prompted with paper context and extracted entities; returns relationships JSON.
- Fuzzy matching maps names → entity IDs; confidences recorded.
- Fallback: rule-based heuristics if LLM fails.

### IntelligentQueryAgent (`src/agents/intelligentQueryAgent.ts`)
- Analyzes question, generates SQL, executes, repairs on error, returns rows + metadata:
  - detected intent, execution route, exact SQL, ranking signal, fallbacks, warnings, errors.
- Fixes implemented:
  - Negation: converts `ILIKE` → `NOT ILIKE`; strips bogus `= FALSE`; expands to `(title AND abstract)` for NOT queries.
  - Consistency: adds `abstract ILIKE` when only `title ILIKE` present.
  - Ambiguity: qualifies `ORDER BY confidence_score` → `r.confidence_score`.
  - SELECT DISTINCT: ensures `ORDER BY` columns appear in SELECT.
  - Canonical name normalization (`&`→`and`, lowercase, collapse spaces).
  - Focus-query generator when legacy fields are missing.

## Natural Language Query Interface
Run:
```bash
npm run ask
```
Examples:
- “Which papers improve on the original 3DGS method?”
- “Which papers are not about gaussian?”
- “How many papers are about gaussian?”
- “Which paper focuses the most about gaussian?”
- “Which methods/papers compare against Instant-NGP or Mip-NeRF?”

The interface prints metadata first (intent, route, SQL, ranking signal, fallbacks) then the results.

## Ingestion Pipeline (50–100 papers)
1) Configure `.env`:
```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/gaussian_splatting_db
HUGGINGFACE_API_KEY=... (optional; system has fallbacks)
```
2) Create schema:
```bash
npm run setup-db
```
3) Configure arXiv query in `src/ingestion/arxivFetcher.ts` (e.g., "gaussian splatting", date ranges).
4) Run pipeline:
```bash
npm run process
```
This fetches 50–100 papers (based on your query), parses PDFs, extracts entities/relationships, and populates PostgreSQL.

Notes:
- If HF API rate-limits or fails, the system falls back to rule-based extraction to keep the pipeline running (assignment “free-of-cost” constraint).
- You can re-run process to grow the corpus.

## Design Rationale
- Agent-first: LLMs for flexibility; robust fallbacks for reliability/cost.
- Parameterized SQL + auto-repair for safety and resilience.
- Canonicalization to deduplicate entities and strengthen joins.
- Transparent metadata for each answer (reviewer insight and debugging).

## Limitations
- LLM extraction quality varies; fallbacks are conservative.
- PDF parsing sometimes loses math formatting; entity/relationship recall may drop.
- No vector store/embedding FTS is included (kept within assignment scope).
- Internet/API access may be rate-limited; fallbacks ensure minimal viability.

## Future Roadmap
- Add embeddings and semantic search (pgvector).
- Active learning loop to correct/approve extractions.
- Graph-based ranking for relevance (PageRank-like signals).
- UI dashboard for query/graph exploration.
- More datasets and domain expansion beyond Gaussian Splatting.

## Development
Build and run:
```bash
npm run build
npm run ask
```
Tests and Utilities:
- `npm run test-llama`
- `npm run test-entity-extraction`
- `npm run test-relationship-extraction`


