# Gaussian Splatting Knowledge Graph - Documentation

## Table of Contents

1. [System Architecture Overview](#system-architecture-overview)
2. [Design Rationale](#design-rationale)
3. [Graph Search Architecture](#graph-search-architecture)
4. [Limitations and Trade-offs](#limitations-and-trade-offs)
5. [Future Roadmap](#future-roadmap)

---

## System Architecture Overview

### Data Flow Diagram

```
┌─────────────┐
│   arXiv     │
│    API      │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Arxiv      │  Fetch paper metadata
│  Fetcher    │  (title, authors, abstract, URLs)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Papers    │
│  Database   │  Store paper metadata
│  (Postgres) │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   PDF       │  Download and parse PDF
│   Parser    │  Extract full text
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Entity    │  LLM extracts:
│  Extractor  │  - Methods (3DGS, NeRF, etc.)
│  (GPT-4)    │  - Concepts (splatting, rendering)
│             │  - Datasets (DTU, Tanks & Temples)
│             │  - Metrics (PSNR, SSIM)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Validator  │  Filter by confidence,
│             │  deduplicate, normalize
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Entities   │  Store with canonical names
│  Database   │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│Relationship │  LLM identifies:
│   Mapper    │  - improves, uses, extends
│  (GPT-4)    │  - compares, cites, evaluates
└──────┬──────┘
       │
       ▼
┌─────────────┐
│Relationships│  Store with context
│  Database   │  and confidence scores
└─────────────┘
```

### Key Components

#### 1. Ingestion Layer
- **ArxivFetcher**: Queries arXiv API, parses XML responses, converts to structured paper objects
- **PDFParser**: Downloads PDFs, extracts text, identifies sections (abstract, introduction, method, etc.)

#### 2. Agent Layer
- **EntityExtractor**: Uses GPT-4 to extract structured entities from paper text. Implements prompt engineering for high precision extraction.
- **RelationshipMapper**: Analyzes entity co-occurrences and extracts semantic relationships. Focuses on meaningful connections beyond simple citations.
- **Validator**: Filters low-confidence extractions, deduplicates entities using canonical names, calculates significance scores.

#### 3. Database Layer
- **PostgreSQL Schema**: Optimized for graph queries with appropriate indexes
- **DatabaseClient**: Type-safe database operations with connection pooling

#### 4. Orchestration Layer
- **PipelineOrchestrator**: Coordinates ingestion → processing → storage pipeline. Handles errors, rate limiting, progress tracking.

---

## Design Rationale

### 1. Graph Representation

**Why this node/edge structure?**

**Nodes (Entities)**:
- We use 4 entity types (methods, concepts, datasets, metrics) to capture the core elements of research papers. This is more specific than a generic "entity" but not so granular that it becomes unmanageable.
- **Canonical names** enable deduplication across papers (e.g., "3DGS", "3D Gaussian Splatting", "3dgs" all map to the same entity).
- **Confidence scores** allow filtering and ranking of extractions.

**Edges (Relationships)**:
- Relationship types are designed to capture semantic meaning, not just structural connections:
  - `improves`: For papers that enhance existing methods
  - `uses`: When a paper employs a specific method/dataset
  - `extends`: Theoretical extensions
  - `compares`: Evaluation comparisons
  - `cites`: Explicit references (beyond what arXiv metadata provides)
- **Context field** stores the actual text snippet that establishes the relationship, enabling verification and interpretation.
- **Paper_id** on relationships ensures we can trace where each relationship came from.

**Design Choices**:
- Junction table (`paper_entities`) allows many-to-many relationships and stores metadata like mention frequency and significance.
- Indexes on entity types, canonical names, and confidence scores optimize common queries.
- Views like `entity_statistics` pre-compute aggregations for quick insights.

### 2. Entity Extraction

**How agents identify entities**:
1. **Text Chunking**: Papers are processed in sections (abstract, introduction, method). For very long papers, we use the first 8000 characters to stay within LLM context limits.
2. **LLM Prompting (Few-Shot Inference Only)**: 
   - Uses pre-trained models via inference API (Hugging Face Llama, OpenAI GPT-4)
   - Structured prompts with examples (few-shot learning via prompt engineering)
   - No model training or fine-tuning (inference only)
   - Temperature set low (0.1) for consistency
   - Prompt templates include examples to guide extraction (see `src/agents/promptTemplates.ts`)
3. **Post-processing**: 
   - Canonical name normalization (lowercase, remove special chars)
   - Confidence threshold filtering (≥0.6 for entities)
   - Deduplication within the same paper

**Validation approach**:
- **Confidence scoring**: LLM provides confidence scores, validated by the `Validator` class
- **Deduplication**: Database-level unique constraint on `(canonical_name, entity_type)` prevents duplicates
- **Cross-paper linking**: When an entity already exists (same canonical name), we link the paper to the existing entity rather than creating duplicates
- **Significance scoring**: Combines confidence, mention frequency, and position in paper (early mentions are weighted higher)

**Why LLM over rule-based extraction?**
- Research terminology evolves (e.g., "splatting" vs "Gaussian splatting" vs "3DGS")
- Context matters (same word can be a method or a concept)
- Relationship extraction requires semantic understanding
- Rule-based systems are brittle for academic text

### 3. User Experience

**Intended use cases**:

1. **Literature Review / Literature Mapping**: 
   - "Find all papers that improve on 3DGS"
   - "What is the research landscape around Gaussian Splatting?"
   - Use the graph to map the entire field, showing how methods relate to each other, which papers build on which, and identify key contributors and trends. The knowledge graph enables comprehensive literature mapping beyond simple keyword search.

2. **Semantic Search**:
   - "Find papers similar to 3D Gaussian Splatting"
   - "What methods use the same concepts as NeRF?"
   - Beyond keyword matching, search by semantic meaning. Find papers by the concepts they use, methods they build upon, or problems they solve. The graph structure enables concept-based retrieval rather than text matching.

3. **Method Discovery**:
   - "What methods are most commonly used together?"
   - "Show me methods that extend the concept of splatting"
   - Discover new methods and techniques by exploring the graph. See which methods are frequently combined, which concepts spawn new methods, and identify emerging techniques.

4. **Concept Mapping**:
   - "Show papers that use similar concepts"
   - "What papers mention both rendering and splatting?"
   - Understand how concepts relate across papers. Map the conceptual space to see which ideas cluster together and which papers bridge different concept areas.

5. **Trend Analysis**:
   - "Which datasets are used most frequently?"
   - "What metrics have been trending upward?"
   - Analyze temporal trends by tracking which datasets, metrics, and methods gain popularity over time. The graph enables quantitative analysis of research trends.

6. **Novelty Discovery**:
   - "What papers introduce entirely new concepts?"
   - "Show me papers that connect previously unrelated methods"
   - Identify novel contributions by finding papers that introduce new entities, bridge disconnected parts of the graph, or connect previously unrelated methods/concepts. Papers with high centrality or bridging connections indicate novelty.

7. **Explainable Insights (B improves on A via concept X)**:
   - **Example**: "How does ConeGS improve on 3D Gaussian Splatting?"
   - **Answer**: The relationship `ConeGS --[improves]--> 3D Gaussian Splatting` includes a `context` field with the actual text snippet explaining the improvement: *"Our method improves upon 3DGS by introducing error-guided densification using pixel cones for improved reconstruction with fewer primitives"*
   - **How it works**:
     - Each relationship stores a `context` field (TEXT) containing the actual paper snippet that establishes the relationship
     - When querying improvements, users can see the exact evidence from the paper
     - For multi-hop insights, trace paths: `Paper B --[improves]--> Method A --[uses]--> Concept X`
     - The graph structure enables explainable AI: every claim is backed by provenance (paper_id, context snippet, confidence score)
   - **Query Pattern**:
     ```sql
     SELECT 
       p1.title as paper_B,
       e1.name as improves_method_A,
       r1.context as improvement_context,
       e2.name as via_concept_X,
       r2.context as concept_usage
     FROM relationships r1
     JOIN entities e1 ON r1.target_entity_id = e1.id
     JOIN papers p1 ON r1.paper_id = p1.id
     JOIN relationships r2 ON r1.source_entity_id = r2.source_entity_id
     JOIN entities e2 ON r2.target_entity_id = e2.id
     WHERE r1.relationship_type = 'improves'
       AND r2.relationship_type IN ('uses', 'extends')
       AND e1.canonical_name = '3d gaussian splatting'
     ORDER BY r1.confidence_score DESC;
     ```

**How users would interact**:
- **Current (CLI)**: Users run the pipeline, then query PostgreSQL directly or via simple scripts
- **Future (UI)**: Interactive graph visualization (e.g., D3.js + React) showing:
  - Node-link diagrams with papers and entities
  - Filtering by entity type, relationship type, confidence
  - Timeline view showing evolution of concepts
  - Search and recommendations

**Query Patterns**:
- Pattern 1: Find papers by method → `getPapersImprovingMethod()`
- Pattern 2: Aggregate statistics → `getMostCommonMethods()`
- Pattern 3: Similarity search → `getRelatedPapersByConcepts()`

---

## Graph Search Architecture

This section discusses how an agent-based search system could query the knowledge graph, the types of searches the graph structure enables, and different architectural approaches for building such a system. Note: The assignment requirement focuses on building the graph itself; this section presents design considerations for implementing a search interface.

### Types of Searches the Knowledge Graph Supports

The graph structure enables several categories of searches that go beyond traditional keyword matching:

#### 1. **Structural/Relational Searches**

These queries exploit the graph's relationship edges to find connections:

- **Lineage/Impact Queries**: "Which papers improve on method X?" - Traverse `improves`/`extends` edges to find downstream research
- **Dependency Queries**: "What methods does paper Y depend on?" - Find all entities connected via `uses`/`extends` relationships
- **Collaboration Queries**: "Which methods share concepts?" - Find entities with common neighbors (two-hop queries)
- **Temporal Evolution**: "How has method X evolved over time?" - Combine relationship traversal with paper publication dates
- **Influence Propagation**: "What papers cite concept X, and what papers do those cite?" - Multi-hop graph traversal

**Graph Operations**: These require `JOIN` operations across `papers`, `entities`, and `relationships` tables, potentially with recursive CTEs for multi-hop queries.

#### 2. **Aggregation/Statistical Searches**

These queries analyze graph metrics and patterns:

- **Popularity Rankings**: "Most common methods/datasets/metrics" - `GROUP BY` with `COUNT()` on entity relationships
- **Network Metrics**: "Which entities have the highest degree centrality?" - Count incoming/outgoing edges per entity
- **Temporal Trends**: "Which datasets gained popularity in 2024?" - Aggregate over time windows
- **Correlation Analysis**: "Which methods are frequently used together?" - Find co-occurrence patterns (entities linked to same papers)
- **Quality Metrics**: "Papers with highest confidence scores" - Aggregate relationship confidence or entity significance

**Graph Operations**: These typically use `GROUP BY`, `COUNT()`, `AVG()`, `SUM()` with `ORDER BY` and `LIMIT`.

#### 3. **Semantic/Content Searches**

These leverage the semantic information stored in the graph:

- **Concept-Based Search**: "Find papers using concept X" - Search by entity descriptions and context
- **Context-Aware Search**: "Find papers where method X is used for purpose Y" - Filter by relationship context text
- **Description Matching**: "Papers introducing methods related to 'rendering'" - Full-text search on entity descriptions
- **Semantic Similarity**: "Find papers similar to paper X" - Based on shared entities and relationship patterns (future: embeddings)

**Graph Operations**: Combine entity/relationship context fields with PostgreSQL full-text search (`to_tsvector`, `to_tsquery`).

#### 4. **Exploratory/Discovery Searches**

These help users navigate and discover the graph:

- **Neighborhood Exploration**: "Show all neighbors of entity X" - One-hop queries from a given entity
- **Path Finding**: "What's the connection between method X and method Y?" - Shortest path queries (would require graph algorithms)
- **Clustering**: "Group papers by shared concepts" - Community detection (would require graph algorithms)
- **Anomaly Detection**: "Papers with unusual relationship patterns" - Find outliers in graph structure
- **Gap Analysis**: "What concepts are mentioned but not connected?" - Find entities with no relationships

**Graph Operations**: Require more advanced graph algorithms (shortest path, community detection, centrality measures) that could be implemented via PostgreSQL extensions (e.g., `pgRouting`, `Apache AGE`) or application-level graph libraries.

#### 5. **Compositional/Filtered Searches**

These combine multiple criteria:

- **Multi-Filter Queries**: "Papers published after 2023 that use dataset X and evaluate with metric Y" - Multiple `WHERE` conditions
- **Intersection Queries**: "Papers that use both method X AND method Y" - Multiple entity filters with `AND`
- **Union Queries**: "Papers that use method X OR method Y" - Multiple entity filters with `OR`
- **Exclusion Queries**: "Papers about rendering but NOT NeRF" - `NOT EXISTS` or `EXCEPT` clauses
- **Range Queries**: "Papers with confidence scores above 0.8 published in 2024" - Numeric and date ranges

**Graph Operations**: Standard SQL filtering with multiple predicates, potentially with subqueries or `EXISTS`/`NOT EXISTS`.

---

### Architectural Approaches for Graph Search

There are several ways to build an agent-based search system for the knowledge graph. Each approach has different trade-offs in flexibility, performance, and complexity.

#### Approach 1: **Predefined Filter-Based UI**

**Design**: A structured interface where users combine predefined filters (dropdowns, checkboxes, date ranges).

**How it works**:
```
User Interface:
┌─────────────────────────────────────┐
│ Entity Type: [Method ▼]            │
│ Entity Name: [3DGS ▼]              │
│ Relationship: [improves ▼]         │
│ Date Range: [2023-01-01 to 2024-12-31]│
│ Confidence: [≥ 0.8]                │
│ [Search]                            │
└─────────────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ Query Builder                        │
│ - Constructs SQL from filters        │
│ - Validates filter combinations      │
│ - Applies default sorting/limits     │
└─────────────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ SQL Generator                        │
│ SELECT p.* FROM papers p            │
│ JOIN relationships r ON ...          │
│ WHERE r.relationship_type = 'improves'│
│   AND e.canonical_name = '3dgs'      │
│   AND p.published_date >= '2023-01-01'│
│ ORDER BY p.published_date DESC      │
│ LIMIT 20                            │
└─────────────────────────────────────┘
```

**Advantages**:
- **Fast**: No LLM calls, direct SQL generation
- **Predictable**: Users know exactly what filters are available
- **Secure**: All queries are validated against a whitelist of allowed filters
- **User-Friendly**: Non-technical users can build complex queries without SQL knowledge
- **Cacheable**: Common filter combinations can be cached

**Disadvantages**:
- **Limited Flexibility**: Can't handle queries not covered by filters
- **UI Complexity**: As filters grow, UI becomes cluttered
- **Rigid**: Hard to extend to new query patterns without UI changes

**Best For**: Production systems where query patterns are well-defined and performance is critical.

---

#### Approach 2: **Natural Language Agent with Intent Classification**

**Design**: An agent that takes open-ended questions, classifies intent, and builds structured queries.

**How it works** (This is what we implemented):
```
User Question:
"What papers improve on 3D Gaussian Splatting?"
         ↓
┌─────────────────────────────────────┐
│ Intent Router (Pattern Matching)     │
│ - Matches question to intent patterns│
│ - Extracts parameters (entity names) │
│ - Chooses execution route            │
│ Intent: "lineage"                    │
│ Parameters: {target_method: "3DGS"}  │
│ Route: "graph"                       │
└─────────────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ Query Executor (Template-Based)      │
│ - Selects SQL template for intent    │
│ - Fills in parameters                │
│ - Validates SQL safety               │
│ SQL: SELECT ... WHERE e.name ILIKE   │
│      '%3DGS%' AND r.type='improves'  │
└─────────────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ Execute & Format Results             │
│ - Runs query on database             │
│ - Formats results as answer cards    │
│ - Returns with metadata              │
└─────────────────────────────────────┘
```

**Advantages**:
- **Flexible**: Handles many question patterns via intent classification
- **User-Friendly**: Natural language interface, no SQL knowledge required
- **Fast**: Template-based queries execute in ~10-50ms
- **Extensible**: Easy to add new intent patterns without changing core logic
- **Transparent**: Can show users the SQL being executed

**Disadvantages**:
- **Pattern Limitations**: Only handles questions that match known patterns
- **Intent Ambiguity**: Some questions may match multiple intents
- **Parameter Extraction**: May fail on complex entity names or ambiguous questions

**Best For**: Systems where users ask natural language questions but patterns are somewhat predictable.

---

#### Approach 3: **LLM-Powered SQL Generation Agent**

**Design**: An agent that uses an LLM to directly generate SQL from natural language questions.

**How it works**:
```
User Question:
"What are the average confidence scores for relationships involving NeRF?"
         ↓
┌─────────────────────────────────────┐
│ Intelligent Query Agent (LLM)        │
│ - Analyzes question structure        │
│ - Understands graph schema           │
│ - Generates SQL query                │
│ Prompt:                              │
│ "Given schema: papers(id, title),    │
│  entities(id, name, type),           │
│  relationships(source, target, type, │
│  confidence_score, paper_id)         │
│  Question: [user question]           │
│  Generate PostgreSQL query."         │
└─────────────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ SQL Validator                        │
│ - Checks for dangerous operations    │
│ - Validates table/column names       │
│ - Ensures read-only access           │
│ - Validates parameter bindings       │
└─────────────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ Execute with Fallbacks               │
│ - Try generated SQL                  │
│ - If fails, try simplified query     │
│ - If still fails, return error       │
└─────────────────────────────────────┘
```

**Advantages**:
- **Maximum Flexibility**: Can handle arbitrary questions, even complex analytical queries
- **No Pattern Maintenance**: Don't need to maintain intent patterns
- **Adaptive**: LLM understands context and can generate sophisticated queries

**Disadvantages**:
- **Slower**: LLM calls take ~2-3 seconds per query
- **Unpredictable**: May generate incorrect or inefficient SQL
- **Cost**: Each query requires an API call
- **Security Risk**: Must carefully validate generated SQL

**Best For**: Research prototypes or systems where flexibility is more important than speed.

---

#### Approach 4: **Hybrid Multi-Agent System**

**Design**: Combine multiple agents - one for intent classification, one for filter building, and sub-agents for paper analysis.

**How it works**:
```
User Question:
"Find papers about dynamic scenes that improve on NeRF and were published in 2024"
         ↓
┌─────────────────────────────────────┐
│ Query Planning Agent (Orchestrator)  │
│ - Breaks question into sub-tasks     │
│ - Determines search strategy         │
│ - Coordinates sub-agents             │
│ Plan:                                │
│ 1. Filter by date (2024)            │
│ 2. Filter by entity (NeRF)          │
│ 3. Filter by relationship (improves) │
│ 4. Semantic filter (dynamic scenes) │
└─────────────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ Filter Builder Agent                 │
│ - Constructs SQL WHERE clauses       │
│ - Combines filters with AND/OR       │
│ - Optimizes query structure          │
│ SQL: SELECT ... WHERE                │
│   p.published_date >= '2024-01-01'   │
│   AND r.relationship_type='improves' │
│   AND e.canonical_name='nerf'        │
└─────────────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ Execute Initial Query                │
│ - Returns candidate papers           │
│ - Filters by structural criteria     │
│ Result: 25 papers                    │
└─────────────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ Semantic Filter Agent (Sub-Agent)    │
│ - Reads candidate paper abstracts    │
│ - Identifies papers about "dynamic  │
│   scenes" using LLM                  │
│ - Ranks papers by relevance          │
│ Filtered: 8 papers                   │
└─────────────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ Ranked Results                       │
│ - Sorted by relevance                │
│ - Includes explanation of filters    │
└─────────────────────────────────────┘
```

**Advantages**:
- **Best of Both Worlds**: Fast structural filtering + semantic understanding
- **Scalable**: Can handle large result sets by filtering in stages
- **Explainable**: Can show users which filters were applied and why
- **Efficient**: Only uses expensive LLM calls for final semantic filtering

**Disadvantages**:
- **Complexity**: Requires orchestration logic and multiple agents
- **Latency**: Multi-stage process can be slower than single-step queries
- **Error Propagation**: Failures in one stage affect downstream stages

**Best For**: Production systems that need both speed and semantic understanding, with sufficient engineering resources.

---

#### Approach 5: **Graph-Traversal Agent with Sub-Agents**

**Design**: An agent that navigates the graph structure, using sub-agents to analyze and rank papers at each step.

**How it works**:
```
User Question:
"What are the most influential papers on Gaussian Splatting?"
         ↓
┌─────────────────────────────────────┐
│ Graph Navigation Agent               │
│ - Starts from seed entities          │
│ - Traverses relationship edges       │
│ - Uses graph metrics (degree, etc.)  │
│ - Builds candidate set               │
│ Seed: "3D Gaussian Splatting"        │
│ Strategy: Find papers with most      │
│   incoming "improves"/"extends"      │
│   relationships                      │
│ Candidates: 15 papers                │
└─────────────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ Paper Analysis Sub-Agent             │
│ - Reads candidate paper abstracts    │
│ - Extracts key contributions         │
│ - Scores influence based on:         │
│   - Citation count (from graph)      │
│   - Novelty (unique entities)        │
│   - Impact (downstream papers)       │
│ Ranked: Top 5 papers                 │
└─────────────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ Explanation Generator                │
│ - Generates natural language         │
│   explanation of why each paper      │
│   is influential                     │
│ - Cites graph metrics                │
│ - Provides context                   │
└─────────────────────────────────────┘
```

**Advantages**:
- **Graph-Aware**: Leverages graph structure directly
- **Rich Analysis**: Can combine structural metrics with semantic analysis
- **Explanatory**: Can explain results based on graph traversal

**Disadvantages**:
- **Complexity**: Requires graph algorithms and traversal logic
- **Computationally Expensive**: Multi-hop traversals can be slow
- **Requires Graph Extensions**: May need PostgreSQL extensions or graph libraries

**Best For**: Systems focused on discovery and exploration, where users want to understand relationships and influence.

---

### Comparison Matrix

| Approach | Flexibility | Speed | Complexity | Best Query Types |
|----------|------------|-------|------------|------------------|
| **Predefined Filters** | Low | Very High | Low | Structured, well-defined patterns |
| **Intent Classification** | Medium | High | Medium | Natural language with predictable patterns |
| **LLM SQL Generation** | Very High | Low | Medium | Arbitrary questions, analytical queries |
| **Hybrid Multi-Agent** | High | Medium | High | Complex queries requiring both structure and semantics |
| **Graph Traversal** | Medium | Low | Very High | Relationship exploration, influence analysis |

---

### Our Implementation: Hybrid Approach

**What we built**: A combination of Approaches 2 and 3:

1. **Intent Router** (Approach 2): Fast pattern matching for common queries
   - Handles: "improves on X", "most common X", "papers using X"
   - Route: `graph` or `fts` with template-based SQL
   - Speed: ~10-50ms

2. **LLM SQL Generator** (Approach 3): Fallback for arbitrary questions
   - Handles: Complex analytical queries, novel question patterns
   - Route: `nl2sql` with LLM-generated SQL
   - Speed: ~2-3 seconds

3. **Smart Fallbacks**: If template queries fail, automatically try LLM generation

**Why this approach**:
- **Balanced**: Fast for common queries, flexible for edge cases
- **Progressive Enhancement**: Starts with fast templates, falls back to LLM only when needed
- **Transparent**: Shows users which strategy was used and why

---

### Creative Solution: Conversational Search Agent

**Concept**: An agent that doesn't just answer one question, but engages in a conversation to refine and explore the graph.

**How it works**:
```
User: "What papers improve on NeRF?"

Agent: "I found 25 papers. Would you like to:
  1. Filter by date range?
  2. See only papers with high confidence scores?
  3. Show papers that also mention specific datasets?
  4. Explore the relationship network?"

User: "Filter to 2024 only, and show confidence scores"

Agent: "Found 12 papers from 2024. Top 3 by confidence:
  1. Paper X (confidence: 0.92)
  2. Paper Y (confidence: 0.89)
  ..."

User: "What concepts do these papers introduce?"

Agent: "Analyzing the 12 papers... Common new concepts:
  - Dynamic scene rendering (8 papers)
  - Real-time optimization (7 papers)
  ..."
```

**Key Features**:
- **Conversational Context**: Remembers previous queries and filters
- **Proactive Suggestions**: Suggests related queries or refinements
- **Progressive Refinement**: Users can iteratively narrow down results
- **Multi-Modal Exploration**: Can switch between structured queries, graph visualization, and semantic search

**Implementation Ideas**:
- Maintain conversation state (filters, previous results, context)
- Use LLM to generate follow-up suggestions
- Combine graph queries with paper content analysis
- Visualize results as interactive graph diagrams

---

### Future Enhancements

**Embeddings & Semantic Search**:
- Generate embeddings for entities and relationships using models like `sentence-transformers`
- Store in PostgreSQL using `pgvector` extension
- Enable similarity search: "Find papers similar to paper X"

**Graph Algorithms**:
- Implement shortest path finding between entities
- Calculate centrality metrics (PageRank, betweenness)
- Detect communities/clusters of related papers

**Query Optimization**:
- Cache common query patterns
- Use materialized views for expensive aggregations
- Implement query result pagination and streaming

**Explainability**:
- Show query execution plans
- Explain why certain results were ranked higher
- Visualize graph traversal paths

**Multi-Hop Reasoning**:
- Support queries like "What papers cite methods that cite NeRF?"
- Implement recursive graph traversal
- Combine multiple relationship types in single query

### 4. Scalability and Scaling Plan

**Scaling to full corpus (6000+ papers)**:

#### Ingestion Strategy

**Batch Processing**:
- Process papers in configurable batches (default: 10)
- Allows progress tracking and resumability
- Batch size can be tuned based on API rate limits and system resources

**Rate Limiting**:
- 2-3 second delays between papers to respect arXiv and LLM API rate limits
- Prevents API throttling and ensures reliable ingestion
- Configurable per API provider (arXiv, Hugging Face, OpenAI)

**Resume Capability**:
- Papers marked as `processed = TRUE` are automatically skipped on re-runs
- Enables pipeline restarts without reprocessing completed work
- Critical for handling interruptions (crashes, network failures, manual stops)

**Parallelization** (Future):
- Current: Sequential processing for stability and simplicity
- Future: Process multiple papers concurrently using:
  - Worker threads or separate Node.js processes
  - Job queue (Redis/Bull) for distributed processing
  - Kubernetes workers for cloud-scale processing
- **Expected improvement**: 5-10x faster with 5-10 parallel workers

#### Database Performance

**Indexes**:
- Strategic indexes on frequently queried fields:
  - `idx_papers_arxiv_id` - Fast paper lookup
  - `idx_papers_processed` - Efficient filtering of unprocessed papers
  - `idx_papers_published_date` - Date-based queries and sorting
  - `idx_entities_type` - Entity type filtering
  - `idx_entities_canonical_name` - Entity lookup and deduplication
  - `idx_relationships_type` - Relationship type queries
  - `idx_relationships_confidence` - Confidence-based ranking

**Connection Pooling**:
- PostgreSQL connection pool (max 20 connections)
- Reuses connections to reduce overhead
- Prevents connection exhaustion under load

**Query Optimization**:
- Views for common aggregations (`entity_statistics`)
- Prepared statements for repeated queries
- Materialized views for expensive aggregations (future)

**Partitioning** (Future, for 10k+ papers):
- Partition `papers` table by `published_date` (yearly/monthly)
- Partition `relationships` by `paper_id` (hash-based)
- Improves query performance and maintenance

#### LLM API Cost Management

**Context Management**:
- Limit text input to essential sections (first 8000 chars)
- Reduces token usage and API costs
- Future: Intelligent section selection (abstract + method + conclusion only)

**Caching**:
- Cache extractions for papers that haven't changed (based on PDF hash or update date)
- Avoids redundant LLM API calls for unchanged papers
- Future: Redis cache for frequently accessed papers

**Batch Requests**:
- LLM APIs support batch processing (future optimization)
- Process multiple papers in single API call
- Expected: 2-3x cost reduction with batch API

**Model Selection**:
- Current: Hugging Face Llama models (lower cost than GPT-4)
- Future: Fine-tuned smaller models for domain-specific extraction
- Expected: 5-10x cost reduction with fine-tuned models

#### Keeping Data Fresh

**Incremental Updates** (See detailed plan in Future Roadmap):
- Only fetch new papers from arXiv (filter by date: `submittedDate:[YYYYMMDD TO *]`)
- New papers inserted with `processed = FALSE`
- Pipeline processes only unprocessed papers
- **No reprocessing**: Existing processed papers remain unchanged

**Data Freshness Strategies**:
- **Daily sync**: Cron job fetches new papers daily
- **Weekly batch**: Process accumulated unprocessed papers weekly
- **Real-time trigger**: Process immediately when new papers ingested (future)
- **Query freshness**: Use `published_date` and `ingestion_timestamp` to track data age

#### Performance Benchmarks

**Current Performance** (sequential processing):
- Single paper: ~30-60 seconds (PDF fetch + 2 LLM calls + DB writes)
- 50 papers: ~25-50 minutes (with rate limiting)
- 100 papers: ~50-100 minutes
- 6000 papers: ~60-120 hours (sequential, ~2.5-5 days)

**Projected Performance** (with optimizations):
- With 10 parallel workers: ~6-12 hours for 6000 papers
- With batch API + caching: ~3-6 hours
- With fine-tuned models + batch: ~1-2 hours

#### Consistency and Data Integrity

**Transaction Management**:
- Each paper processed in database transaction
- All-or-nothing: Entity extraction + relationship extraction + linking
- Rollback on errors to maintain consistency

**Entity Deduplication**:
- Unique constraint: `UNIQUE (canonical_name, entity_type)`
- Cross-paper linking: Same entity across papers shares same database ID
- Prevents duplicate entities and ensures graph consistency

**Relationship Deduplication**:
- Unique constraint: `UNIQUE (source_entity_id, target_entity_id, relationship_type, paper_id)`
- Prevents duplicate relationships from same paper
- Allows same relationship across different papers (different `paper_id`)

**Data Validation**:
- Confidence score filtering (≥0.6 for entities, ≥0.7 for relationships)
- Entity type validation (must be: concept, method, dataset, metric)
- Relationship type validation (normalized to allowed types)
- Prevents invalid data from entering the graph

#### Fault Tolerance

**Error Handling**:
- Per-paper try-catch blocks: Errors in one paper don't crash entire pipeline
- Failed papers marked with `processing_error` message
- Pipeline continues to next paper after failure

**Retry Mechanism**:
- Failed papers can be reprocessed by resetting `processed = FALSE`
- Allows recovery from transient failures (network, API limits)
- Example: `UPDATE papers SET processed = FALSE WHERE processing_error IS NOT NULL`

**Status Tracking**:
- `processed` flag: Tracks completion status
- `processing_error` field: Stores error messages for debugging
- `ingestion_timestamp`: Tracks when paper was first ingested
- Enables monitoring and health checks

**Recovery Strategies**:
1. **Automatic**: Pipeline automatically skips processed papers on restart
2. **Manual**: Reset specific papers for reprocessing
3. **Batch retry**: Reprocess all failed papers: `UPDATE papers SET processed = FALSE WHERE processing_error IS NOT NULL`
4. **Selective retry**: Reprocess by date range or entity type

**Resilience Features**:
- **Graceful degradation**: Falls back to abstract if PDF fetch fails
- **Partial success**: Entity extraction can succeed even if relationship extraction fails
- **Checkpoint system**: Progress saved after each paper (via `processed` flag)
- **No data loss**: All papers ingested, even if processing fails

---

## Limitations and Trade-offs

### Out of Scope

**Key Limitations**:

1. **No Production-Ready Frontend**: 
   - ❌ No production-ready web interface implemented
   - ✅ CLI-based interface only for this proof-of-concept
   - ✅ Optional demo frontend acceptable (design plan documented in Future Roadmap)
   - ✅ Future UI is documented as a design plan only, not implemented

2. **No Full-Scale Ingestion Pipeline**:
   - ❌ No production-scale ingestion system (e.g., handling 6000+ papers automatically)
   - ✅ Designed for small curated set (50-100 papers as proof-of-concept)
   - ✅ Manual/scripted ingestion for this PoC
   - ✅ Full-scale pipeline described in Future Roadmap only (not implemented)
   - ✅ Current ingestion: Simple batch processing, not distributed/automated

3. **No High-Fidelity LLM Training/Fine-Tuning**:
   - ❌ No custom model training or fine-tuning
   - ❌ No domain-specific model training
   - ✅ Uses pre-trained models via inference API only (Hugging Face, OpenAI)
   - ✅ Few-shot prompting with examples in prompts (no training)
   - ✅ Fine-tuning mentioned only as future optimization, not implemented

**Additional Out of Scope Items**:

4. **Real-time updates**: Batch processing only (no streaming/real-time processing)
5. **User authentication**: Not needed for this use case
6. **API endpoints**: Direct database access (could add REST/GraphQL later)

### Known Issues

1. **PDF Parsing Limitations**:
   - Some PDFs have poor OCR or formatting, leading to garbled text
   - Complex layouts (two-column, figures) may not parse correctly
   - Solution: Fallback to abstract when PDF fails

2. **LLM Hallucination**:
   - GPT-4 may occasionally extract entities that don't exist or misclassify them
   - Solution: Confidence thresholds and validation rules
   - Trade-off: Higher threshold = fewer false positives but also fewer true positives

3. **Entity Disambiguation**:
   - Same concept mentioned with different names may not always link (e.g., "Gaussian Splatting" vs "3DGS")
   - Solution: Canonical name normalization helps but isn't perfect
   - Future: Could use embedding-based similarity for fuzzy matching

4. **Context Window Limits**:
   - Very long papers truncated to 8000 chars, may miss entities in later sections
   - Solution: Could process paper in chunks and merge results

5. **Rate Limiting**:
   - Sequential processing is slow but avoids API errors
   - Solution: Parallel processing with proper rate limit handling (future)

### Design Decisions

**Why PostgreSQL over Neo4j?**
- PostgreSQL is more widely available, easier to set up
- Sufficient for graph queries with proper indexing
- Better for structured queries and aggregations
- Trade-off: Neo4j would have better graph traversal performance for very large datasets

**Why separate entity and relationship extraction?**
- Two-step process allows validating entities before extracting relationships
- More control over relationship quality
- Trade-off: Requires two LLM calls per paper (higher cost)

**Why confidence scores?**
- Allows filtering and ranking results
- Helps identify low-quality extractions
- Trade-off: Scores may not always be accurate (LLM-generated)

**Why canonical names?**
- Enables deduplication across papers
- Normalizes variations in naming
- Trade-off: May over-normalize (loses important distinctions)

---

## Future Roadmap

### Short-term (1-2 months)

1. **Enhanced Entity Linking**:
   - Use embeddings (OpenAI embeddings API) to find similar entities
   - Fuzzy matching for canonical names (e.g., Levenshtein distance)
   - Cluster entities that refer to the same concept

2. **Improved PDF Processing**:
   - Better section detection using heuristics
   - Handle multi-column layouts
   - Extract figures/captions (could be entities)

3. **Parallel Processing**:
   - Process multiple papers concurrently with rate limit queues
   - Use worker threads or separate processes
   - Track progress with a job queue (e.g., Bull/BullMQ)

4. **Query Interface**:
   - Simple REST API or GraphQL endpoint
   - Pre-built query templates for common use cases
   - Export results as JSON/CSV

### Medium-term (3-6 months)

5. **Web UI/Visualization** (Design Plan):

   **Overview**: A web-based interface that sits atop the PostgreSQL schema, providing interactive exploration of the knowledge graph without requiring SQL knowledge.

   **Architecture**:
   ```
   ┌─────────────────────────────────────────┐
   │         Frontend (React/Next.js)        │
   │  ┌──────────┐  ┌──────────┐  ┌────────┐│
   │  │Graph View│  │Search    │  │Timeline││
   │  │(D3.js)   │  │Interface │  │View    ││
   │  └──────────┘  └──────────┘  └────────┘│
   └─────────────────┬───────────────────────┘
                     │ REST API / GraphQL
                     ▼
   ┌─────────────────────────────────────────┐
   │      Backend API (Node.js/Express)      │
   │  ┌──────────┐  ┌──────────┐  ┌────────┐│
   │  │Query     │  │Auth      │  │Cache   ││
   │  │Builder   │  │(Optional)│  │(Redis) ││
   │  └──────────┘  └──────────┘  └────────┘│
   └─────────────────┬───────────────────────┘
                     │ SQL Queries
                     ▼
   ┌─────────────────────────────────────────┐
   │      PostgreSQL Knowledge Graph         │
   │  (papers, entities, relationships)      │
   └─────────────────────────────────────────┘
   ```

   **Key Components**:

   **1. Interactive Graph Visualization**:
   - **Technology**: D3.js, Cytoscape.js, or React Flow
   - **Node Types**:
     - Papers (rectangular nodes, color by publication year)
     - Methods (circular, blue)
     - Concepts (diamond, green)
     - Datasets (hexagon, orange)
     - Metrics (star, purple)
   - **Edge Types**:
     - Relationship type determines edge style (dashed for "compares", solid for "improves", etc.)
     - Edge thickness based on confidence score
     - Hover shows context snippet (explainable insights)
   - **Interactions**:
     - Click node → Show details panel
     - Drag to reposition (force-directed layout)
     - Zoom and pan
     - Filter by entity type, relationship type, date range
     - Highlight paths between entities

   **2. Search Interface**:
   - **Semantic Search Bar**: 
     - Natural language queries: "Find papers that improve on 3DGS"
     - Autocomplete with entity names
     - Search by paper title, entity name, or concept
   - **Advanced Filters**:
     - Entity type (method, concept, dataset, metric)
     - Relationship type (improves, uses, compares, etc.)
     - Date range (published_date)
     - Confidence score threshold
   - **Results Display**:
     - List view with paper cards
     - Graph view showing filtered subgraph
     - Export results as JSON/CSV

   **3. Timeline View**:
   - **X-axis**: Publication date
   - **Y-axis**: Entity categories (methods, concepts, datasets, metrics)
   - **Timeline bars**: Show when entities first appeared, peak usage, trends
   - **Click timeline point**: Highlight related papers in graph view
   - **Trend lines**: Show adoption curves for methods/datasets

   **4. Paper Detail Page**:
   - **Header**: Title, authors, abstract, arXiv link, publication date
   - **Entities Tab**: 
     - List of all entities mentioned in the paper
     - Entity type, significance score, mention count
     - Click entity → Navigate to entity detail page
   - **Relationships Tab**:
     - Visual graph showing relationships from this paper
     - Each relationship shows:
       - Source → Target (with relationship type)
       - Context snippet (explainable insight)
       - Confidence score
       - Link to source paper
   - **Example Insight Display**:
     ```
     ConeGS improves on 3D Gaussian Splatting
     ┌─────────────────────────────────────────┐
     │ Evidence (from paper text):             │
     │ "Our method improves upon 3DGS by       │
     │  introducing error-guided densification │
     │  using pixel cones..."                  │
     └─────────────────────────────────────────┘
     Confidence: 0.90
     ```

   **5. Entity Detail Page**:
   - **Entity Info**: Name, type, description, canonical name
   - **Connected Papers**: Papers that mention this entity
   - **Relationships**: 
     - Incoming: What improves/uses/extends this entity?
     - Outgoing: What does this entity improve/use/extend?
   - **Network Visualization**: Mini-graph showing immediate neighbors
   - **Statistics**: Paper count, relationship count, first mentioned date

   **6. Explainable Insights View** (Key Feature):
   - **Path Visualization**: Show multi-hop relationships
     - Example: "Paper B improves on Method A via Concept X"
     - Visual path: `Paper B --[improves]--> Method A --[uses]--> Concept X`
     - Each edge shows context snippet when hovered
   - **Evidence Panel**:
     - For any relationship, display the exact text snippet from the paper
     - Link back to paper with highlighted section
     - Show confidence score and validation status
   - **Insight Cards**:
     - Pre-computed interesting insights
     - "Papers that improve 3DGS" with context snippets
     - "Novel connections" (papers bridging disconnected concepts)

   **7. Analytics Dashboard**:
   - **Overview Stats**: Total papers, entities, relationships
   - **Popular Entities**: Most mentioned methods, concepts, datasets, metrics
   - **Trend Charts**: 
     - Entity adoption over time
     - Relationship type distribution
     - Publication rate timeline
   - **Network Metrics**:
     - Graph density
     - Most central entities (PageRank)
     - Community detection (clusters)

   **Data Flow**:
   - Frontend makes API calls to backend
   - Backend converts requests to SQL queries against PostgreSQL
   - Results returned as JSON
   - Frontend renders graph/nodes using D3.js or similar
   - Client-side filtering/caching for smooth interaction

   **API Endpoints** (REST or GraphQL):
   - `GET /api/papers` - List papers with filters
   - `GET /api/papers/:id` - Paper detail with entities/relationships
   - `GET /api/entities` - List entities with filters
   - `GET /api/entities/:id` - Entity detail with relationships
   - `GET /api/relationships` - List relationships with filters
   - `GET /api/graph/neighbors/:entityId` - Get entity neighbors for graph rendering
   - `GET /api/graph/path/:sourceId/:targetId` - Find shortest path between entities
   - `POST /api/search` - Semantic search endpoint
   - `GET /api/analytics/trends` - Trend data for timeline view
   - `GET /api/insights/:type` - Pre-computed insights (novel connections, improvements, etc.)

   **Design Considerations**:
   - **Performance**: 
     - Client-side graph rendering (D3.js) for smooth interaction
     - Backend pagination for large result sets
     - Redis caching for frequently accessed entities
     - GraphQL for efficient data fetching (fetch only needed fields)
   - **Scalability**:
     - Read replica for query API (separate from write database)
     - Elasticsearch for full-text search (optional)
     - CDN for static assets
   - **User Experience**:
     - Progressive loading (load visible nodes first, lazy load neighbors)
     - Virtual scrolling for large lists
     - Debounced search
     - Keyboard shortcuts for power users
   - **Visualization**:
     - Force-directed layout for graph (adjustable parameters)
     - Color coding by entity type
     - Size nodes by importance (PageRank or mention count)
     - Animation for adding/removing nodes
     - Tooltips with context on hover

   **Example User Flow**:
   1. User searches "papers that improve on 3DGS"
   2. Results show in list + graph view
   3. User clicks a paper → Detail page opens
   4. User clicks relationship "improves on 3DGS" → Context snippet displayed
   5. User clicks "3DGS" entity → Entity detail page with all connected papers
   6. User switches to timeline view → Sees when 3DGS improvements emerged
   7. User clicks insight "Novel connections" → Sees papers bridging 3DGS with other domains

6. **Semantic Search**:
   - Use embeddings to find similar papers
   - "Find papers like this one" functionality
   - Concept-based recommendations

7. **Automated Quality Metrics**:
   - Track extraction quality over time
   - A/B test different prompts
   - Manual validation interface for high-value papers

8. **Incremental Updates** (Detailed Plan):

   **Overview**: Add new papers without reprocessing existing data, keeping the knowledge graph fresh and up-to-date.

   **Mechanism**:
   
   **1. Tracking Processed Papers**:
   - Each paper has a `processed` boolean flag in the database
   - `processed = FALSE` → Paper ingested but not yet processed
   - `processed = TRUE` → Paper fully processed (entities + relationships extracted)
   - `processing_error` field stores error messages if processing fails

   **2. Incremental Ingestion**:
   ```sql
   -- Fetch only new papers from arXiv (filter by date after last sync)
   SELECT * FROM papers 
   WHERE published_date > (SELECT MAX(published_date) FROM papers WHERE processed = TRUE)
   ORDER BY published_date DESC;
   ```
   - Query arXiv API with date filter: `submittedDate:[YYYYMMDD TO *]`
   - Only fetch papers published after the last successfully processed paper
   - New papers are inserted with `processed = FALSE`
   - Duplicate prevention: `ON CONFLICT (arxiv_id) DO UPDATE` ensures no duplicates

   **3. Selective Processing**:
   - Pipeline queries for unprocessed papers: `getUnprocessedPapers(limit)`
   - Processes only papers where `processed = FALSE`
   - Skips already processed papers automatically
   - Can be run repeatedly without reprocessing existing data

   **4. Reprocessing Capability** (Optional):
   - Reset `processed = FALSE` to reprocess specific papers
   - Useful when extraction methods improve or need to update entities/relationships
   - Can reprocess by date range, entity type, or specific paper IDs
   - Example: `UPDATE papers SET processed = FALSE WHERE published_date > '2024-01-01'`

   **5. Keeping Data Fresh**:
   - **Daily Sync**: Cron job fetches new papers from arXiv daily
   - **Weekly Sync**: Batch process all unprocessed papers weekly
   - **On-Demand**: Trigger processing when new papers are ingested
   - **Query Strategy**:
     ```sql
     -- Get papers to process (newest first)
     SELECT * FROM papers 
     WHERE processed = FALSE 
     ORDER BY published_date DESC 
     LIMIT 50;
     ```

   **6. Data Consistency**:
   - **Idempotency**: Running processing multiple times is safe (processed papers skipped)
   - **Atomicity**: Each paper processed in a transaction (all-or-nothing)
   - **Entity Deduplication**: Cross-paper linking ensures entities aren't duplicated
   - **Relationship Deduplication**: `UNIQUE (source, target, type, paper)` prevents duplicates

   **7. Fault Tolerance**:
   - **Per-Paper Error Handling**: Each paper processed in try-catch block
   - **Error Storage**: Failed papers marked with `processing_error` message
   - **Pipeline Continuity**: Errors don't crash the pipeline, continues to next paper
   - **Retry Mechanism**: Failed papers can be reprocessed by resetting `processed = FALSE`
   - **Status Tracking**: `processed`, `processing_error` fields track state

   **Example Incremental Update Flow**:
   ```
   1. Daily cron job runs
   2. Fetch new papers from arXiv (published_date > last_sync_date)
   3. Insert new papers into database (processed = FALSE)
   4. Process unprocessed papers in batches
   5. Mark successful papers as processed = TRUE
   6. Store errors in processing_error for failed papers
   7. Next day: Only new papers since last sync are fetched
   ```

   **Notification System** (Future):
   - Watch for papers matching user-defined interests (entity names, keywords)
   - Email/alert when relevant papers are processed
   - Track changes to specific entities/relationships

### Long-term (6+ months)

9. **Full Corpus Processing** (Scaling Plan for 6000+ Papers):

   **Architecture**:
   - **Distributed Processing**: Kubernetes workers or AWS Batch jobs
   - **Job Queue**: Redis-based queue (Bull/BullMQ) for paper processing jobs
   - **Worker Pools**: 10-50 parallel workers processing papers concurrently
   - **Load Balancing**: Distribute papers across workers based on queue depth

   **Cost Optimization**:
   - **Caching**: Redis cache for frequently accessed papers (PDFs, extractions)
   - **Batch API Calls**: Process multiple papers in single LLM API call
   - **Fine-tuned Models**: Train domain-specific models (5-10x cheaper than GPT-4)
   - **Rate Limit Management**: Intelligent queuing to maximize API usage without throttling

   **Performance Targets**:
   - **Throughput**: Process 100-200 papers/hour with 10 workers
   - **Latency**: New papers processed within 1 hour of ingestion
   - **Cost**: < $0.10 per paper with optimizations (vs. ~$0.50 current)

   **Monitoring and Observability**:
   - **Metrics**: Processing rate, error rate, API costs, queue depth
   - **Alerts**: High error rates, stuck jobs, API limit approaching
   - **Dashboards**: Real-time processing status, cost tracking, throughput graphs
   - **Logging**: Centralized logging (ELK stack) for debugging

   **Deployment Strategy**:
   - **Development**: Single worker, sequential processing
   - **Staging**: 5 workers, parallel processing, full monitoring
   - **Production**: 20+ workers, distributed across regions, auto-scaling

10. **Advanced Analytics**:
    - Trend analysis (which concepts are growing?)
    - Citation network analysis
    - Method evolution tracking
    - Community detection (clusters of related papers)

11. **Multi-modal Extraction**:
    - Extract information from figures/diagrams
    - Parse tables for datasets/metrics
    - Link to code repositories (GitHub)

12. **Collaborative Features**:
    - Allow users to correct/annotate extractions
    - Crowdsourced validation
    - Expert review workflow

### Scaling Architecture (Future)

```
┌─────────────┐
│   arXiv     │
└──────┬──────┘
       │
       ▼
┌─────────────┐      ┌─────────────┐
│   Scheduler │─────▶│   Job Queue │
│  (Cron)     │      │  (Redis)    │
└─────────────┘      └──────┬──────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
      ┌──────────┐   ┌──────────┐   ┌──────────┐
      │ Worker 1 │   │ Worker 2 │   │ Worker N │
      └────┬─────┘   └────┬─────┘   └────┬─────┘
           │              │              │
           └──────────────┼──────────────┘
                         ▼
              ┌──────────────────┐
              │   PostgreSQL     │
              │  (Primary DB)    │
              └──────────────────┘
                         │
                         ▼
              ┌──────────────────┐
              │   Read Replica   │
              │  (Query API)     │
              └──────────────────┘
```

**Components**:
- **Scheduler**: Fetches new papers from arXiv daily
- **Job Queue**: Redis-based queue for paper processing jobs
- **Workers**: Multiple worker processes/containers processing papers in parallel
- **Database**: Primary for writes, read replica for query API
- **Cache**: Redis cache for frequently accessed entities/relationships

---

## Conclusion

This system provides a solid foundation for building a knowledge graph of Gaussian Splatting research papers. The architecture is modular and extensible, making it easy to add features like visualization, search, and advanced analytics. The use of LLMs for extraction provides flexibility and accuracy, though it comes with API costs that need to be managed for large-scale deployment.

The design prioritizes:
- **Accuracy** over speed (confidence filtering, validation)
- **Modularity** over optimization (easy to swap components)
- **Extensibility** over completeness (can add features incrementally)

For a production system, additional considerations would include monitoring, error handling, user feedback loops, and cost optimization strategies.

