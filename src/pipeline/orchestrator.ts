import * as dotenv from 'dotenv';
import { DatabaseClient } from '../database/client';
import { ArxivFetcher } from '../ingestion/arxivFetcher';
import { PDFParser } from '../ingestion/pdfParser';
import { EntityExtractor } from '../agents/entityExtractor';
import { RelationshipMapper } from '../agents/relationshipMapper';
import { Validator } from '../agents/validator';

dotenv.config();

// ============================================================================
// TYPES
// ============================================================================

/**
 * Processing statistics for tracking pipeline progress
 */
interface ProcessingStats {
  totalPapers: number;
  processedPapers: number;
  failedPapers: number;
  totalEntities: number;
  totalRelationships: number;
}

// ============================================================================
// PIPELINE ORCHESTRATOR CLASS
// ============================================================================

/**
 * Main orchestrator that coordinates the entire knowledge graph construction pipeline
 * Handles paper ingestion, entity extraction, relationship mapping, and database storage
 */
export class PipelineOrchestrator {
  private db: DatabaseClient;
  private arxivFetcher: ArxivFetcher;
  private pdfParser: PDFParser;
  private entityExtractor: EntityExtractor;
  private relationshipMapper: RelationshipMapper;
  private validator: Validator;
  private stats: ProcessingStats;

  constructor() {
    // Validate required environment variables
    if (!process.env.HUGGINGFACE_API_KEY) {
      throw new Error('HUGGINGFACE_API_KEY environment variable is required');
    }

    // Initialize all components
    this.db = new DatabaseClient();
    this.arxivFetcher = new ArxivFetcher(parseInt(process.env.ARXIV_MAX_RESULTS || '100'));
    this.pdfParser = new PDFParser();
    this.entityExtractor = new EntityExtractor(process.env.HUGGINGFACE_API_KEY);
    this.relationshipMapper = new RelationshipMapper(process.env.HUGGINGFACE_API_KEY);
    this.validator = new Validator(this.db);
    
    // Initialize statistics
    this.stats = {
      totalPapers: 0,
      processedPapers: 0,
      failedPapers: 0,
      totalEntities: 0,
      totalRelationships: 0,
    };
  }

  /**
   * Initialize the pipeline and test database connection
   */
  async initialize(): Promise<void> {
    console.log('Initializing pipeline...');
    const connected = await this.db.testConnection();
    if (!connected) {
      throw new Error('Failed to connect to database. Please check DATABASE_URL in .env file.');
    }
    console.log('Pipeline initialized successfully\n');
  }

  /**
   * Step 1: Ingest papers from arXiv
   * Fetches paper metadata and stores in database
   * 
   * @param query - arXiv search query (optional, uses env var if not provided)
   * @param limit - Maximum number of papers to fetch
   */
  async ingestPapers(query?: string, limit: number = 50): Promise<void> {
    console.log(`\n=== STEP 1: Ingesting papers from arXiv ===`);
    const searchQuery = query || process.env.ARXIV_QUERY || 'cat:cs.CV AND all:"gaussian splatting"';
    console.log(`Query: ${searchQuery}`);
    console.log(`Limit: ${limit}`);

    try {
      // Fetch papers from arXiv
      const entries = await this.arxivFetcher.fetchAllPapers(searchQuery, limit);
      console.log(`\nFetched ${entries.length} papers from arXiv`);

      // Convert and store each paper
      for (const entry of entries) {
        try {
          const paper = await this.arxivFetcher.convertToPaperFormat(entry);
          const paperId = await this.db.insertPaper(paper);
          console.log(`  ✓ Inserted paper: ${paper.arxiv_id} - ${paper.title.substring(0, 60)}...`);
          this.stats.totalPapers++;
        } catch (error) {
          console.error(`  ✗ Error inserting paper ${entry.id}:`, error);
        }
      }

      console.log(`\nIngestion complete. Total papers: ${this.stats.totalPapers}`);
    } catch (error) {
      console.error('Error during paper ingestion:', error);
      throw error;
    }
  }

  /**
   * Step 1 (alternative): Ingest starting from the 3DGS seed and expand via citations
   * Seed: 2308.04079 (3D Gaussian Splatting for Real-Time Radiance Field Rendering)
   */
  async ingestFromSeedAndCitations(limit: number = 50): Promise<void> {
    console.log(`\n=== STEP 1: Ingesting from seed and citations ===`);
    const seedId = '2308.04079';
    let inserted = 0;
    const seenIds = new Set<string>();
    try {
      // Fetch and insert seed first
      const seed = await this.arxivFetcher.fetchPaperById(seedId);
      if (seed) {
        const paper = await this.arxivFetcher.convertToPaperFormat(seed);
        try {
          await this.db.insertPaper(paper);
          this.stats.totalPapers++;
          inserted++;
          seenIds.add(seed.id.replace(/v\d+$/, ''));
          console.log(`  ✓ Inserted SEED: ${paper.arxiv_id} - ${paper.title.substring(0, 70)}...`);
        } catch (e) {
          console.log(`  ℹ️ Seed already present: ${paper.arxiv_id}`);
        }
      } else {
        console.warn('⚠️  Could not fetch seed by ID; aborting seed-based ingestion.');
        return;
      }
      // Fetch seed PDF and extract arXiv IDs from references
      let pdfText = '';
      try {
        pdfText = await this.pdfParser.fetchPDFText(`https://arxiv.org/pdf/${seedId}.pdf`);
        console.log(`  ✓ Fetched SEED PDF (${pdfText.length} chars)`);
      } catch (e) {
        console.warn('  ⚠ Could not fetch SEED PDF; citation expansion will be limited.');
      }
      const citedIds = new Set<string>();
      if (pdfText) {
        const urlMatches = Array.from(pdfText.matchAll(/arxiv\.org\/abs\/(\d{4}\.\d{4,5})/gi)).map(m => m[1]);
        const bareMatches = Array.from(pdfText.matchAll(/\b(\d{4}\.\d{4,5})\b/g)).map(m => m[1]);
        [...urlMatches, ...bareMatches].forEach(id => {
          const norm = id.replace(/v\d+$/, '');
          if (!seenIds.has(norm)) citedIds.add(norm);
        });
      }
      // Fetch and insert cited papers until limit
      for (const id of citedIds) {
        if (inserted >= limit) break;
        try {
          const entry = await this.arxivFetcher.fetchPaperById(id);
          if (!entry) continue;
          const paper = await this.arxivFetcher.convertToPaperFormat(entry);
          await this.db.insertPaper(paper);
          this.stats.totalPapers++;
          inserted++;
          seenIds.add(id);
          console.log(`  ✓ Inserted cited: ${paper.arxiv_id} - ${paper.title.substring(0, 70)}...`);
        } catch (e) {
          // Skip duplicates or insert errors
        }
      }
      console.log(`\nIngestion (seed + citations) complete. Total new: ${inserted}`);
    } catch (error) {
      console.error('Error during seed-based ingestion:', error);
      throw error;
    }
  }
  /**
   * Step 2: Process a single paper
   * Extracts entities, relationships, and stores in database
   * 
   * @param paperId - Database ID of paper to process
   */
  async processPaper(paperId: number): Promise<void> {
    // Get unprocessed papers
    const papers = await this.db.getUnprocessedPapers(1);
    if (papers.length === 0) {
      return;
    }

    // Find the specific paper or use the first one
    const paper = papers.find((p: any) => p.id === paperId) || papers[0];
    if (!paper) {
      return;
    }

    console.log(`\n=== Processing paper ${paper.id}: ${paper.title.substring(0, 70)}... ===`);

    try {
      // Step 2.1: Fetch PDF text
      let pdfText = '';
      if (paper.pdf_url) {
        try {
          pdfText = await this.pdfParser.fetchPDFText(paper.pdf_url);
          console.log(`  ✓ Fetched PDF (${pdfText.length} characters)`);
        } catch (error) {
          console.warn(`  ⚠ Could not fetch PDF, using abstract only`);
          pdfText = paper.abstract || '';
        }
      } else {
        pdfText = paper.abstract || '';
      }

      // Validate we have enough text
      if (!pdfText || pdfText.length < 100) {
        throw new Error('Insufficient text content (need at least 100 characters)');
      }

      // Step 2.2: Extract entities using LLM
      console.log(`  Extracting entities...`);
      const rawEntities = await this.entityExtractor.extractEntities(pdfText, paper.title);
      const validatedEntities = await this.validator.validateEntities(rawEntities);
      console.log(`  ✓ Extracted ${validatedEntities.length} entities (from ${rawEntities.length} candidates)`);

      if (validatedEntities.length === 0) {
        console.log(`  ⚠ No valid entities found, skipping relationship extraction`);
        await this.db.markPaperAsProcessed(paper.id!);
        this.stats.processedPapers++;
        return;
      }

      // Step 2.3: Insert entities and link to paper
      const entityMap = new Map<string, number>(); // canonical_name -> entity_id
      
      for (const entity of validatedEntities) {
        // Check if entity already exists in database
        const existingId = await this.validator.checkEntityDuplicates(
          entity.canonical_name,
          entity.entity_type
        );

        // Insert or reuse existing entity
        const entityId = existingId || await this.db.insertEntity({
          ...entity,
          first_mentioned_in: existingId ? null : (paper.id || null),
        });

        // Store mapping for relationship extraction
        entityMap.set(entity.canonical_name, entityId);

        // Count mentions and find first mention position
        const mentionCount = this.validator.countMentions(pdfText, entity.name);
        const firstMentionPos = this.validator.findFirstMentionPosition(pdfText, entity.name);
        const significanceScore = this.validator.calculateSignificanceScore(
          entity,
          mentionCount,
          firstMentionPos >= 0 ? firstMentionPos : 999999
        );

        // Link paper to entity
        await this.db.linkPaperToEntity(
          paper.id!,
          entityId,
          mentionCount,
          significanceScore
        );
      }
      this.stats.totalEntities += validatedEntities.length;

      // Step 2.4: Extract relationships
      if (validatedEntities.length >= 2) {
        console.log(`  Extracting relationships...`);
        
        // Prepare entity info for relationship mapper
        const entityArray = Array.from(entityMap.entries()).map(([canonical, id]) => {
          const entity = validatedEntities.find((e) => e.canonical_name === canonical);
          return {
            canonical_name: canonical,
            entity_type: entity?.entity_type || 'concept',
            name: entity?.name || canonical,
          };
        });

        // Extract relationships using LLM
        const rawRelationships = await this.relationshipMapper.extractRelationships(
          pdfText,
          entityArray,
          paper.title
        );
        
        // Validate relationships
        const validatedRelationships = await this.validator.validateRelationships(
          rawRelationships,
          validatedEntities
        );
        console.log(`  ✓ Extracted ${validatedRelationships.length} relationships (from ${rawRelationships.length} candidates)`);

        // Step 2.5: Insert relationships
        let insertedCount = 0;
        for (const rel of validatedRelationships) {
          const sourceId = entityMap.get(rel.source_entity);
          const targetId = entityMap.get(rel.target_entity);

          if (!sourceId) {
            console.warn(`  ⚠ Warning: Source entity '${rel.source_entity}' not found in entityMap`);
            continue;
          }
          if (!targetId) {
            console.warn(`  ⚠ Warning: Target entity '${rel.target_entity}' not found in entityMap`);
            continue;
          }

          if (sourceId && targetId && paper.id) {
            try {
              await this.db.insertRelationship({
                source_entity_id: sourceId,
                target_entity_id: targetId,
                relationship_type: rel.relationship_type,
                paper_id: paper.id,
                confidence_score: rel.confidence_score,
                context: rel.context,
              });
              insertedCount++;
            } catch (error) {
              console.error(`  ⚠ Error inserting relationship:`, error);
            }
          }
        }
        console.log(`  ✓ Inserted ${insertedCount} relationships into database`);
        this.stats.totalRelationships += insertedCount;
      } else {
        console.log(`  ⚠ Not enough entities (${validatedEntities.length}) for relationship extraction`);
      }

      // Mark paper as processed successfully
      await this.db.markPaperAsProcessed(paper.id!);
      this.stats.processedPapers++;
      console.log(`  ✓ Paper processed successfully`);

    } catch (error) {
      console.error(`  ✗ Error processing paper:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.db.markPaperAsProcessed(paper.id!, errorMessage);
      this.stats.failedPapers++;
    }
  }

  /**
   * Step 3: Process all unprocessed papers
   * Processes papers in batches with rate limiting
   * 
   * @param batchSize - Number of papers to process in each batch
   */
  async processAllPapers(batchSize: number = 10): Promise<void> {
    console.log(`\n=== STEP 2: Processing all unprocessed papers ===`);
    console.log(`Batch size: ${batchSize}`);
    
    let processed = 0;
    while (true) {
      // Get next batch of unprocessed papers
      const papers = await this.db.getUnprocessedPapers(batchSize);
      if (papers.length === 0) {
        console.log('\n  No more papers to process.');
        break;
      }

      console.log(`\n  Processing batch of ${papers.length} papers...`);

      // Process each paper in the batch
      for (const paper of papers) {
        await this.processPaper(paper.id!);
        processed++;

        // Rate limiting: wait between papers to respect API limits
        // Wait 2 seconds between papers (adjust based on API limits)
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      console.log(`  Completed batch. Total processed: ${processed}`);
    }

    console.log(`\n=== Processing complete ===`);
    this.printStats();
  }

  /**
   * Step 4: Run example queries and display results
   * Demonstrates the knowledge graph queries from requirements
   */
  async runExampleQueries(): Promise<void> {
    console.log(`\n=== STEP 3: Running Example Queries ===\n`);

    try {
      // Query 1: Papers that improve on 3D Gaussian Splatting
      console.log('1. Papers that improve on 3D Gaussian Splatting:');
      console.log('   ─────────────────────────────────────────────────────────');
      const improvements = await this.db.getPapersImprovingMethod('3d gaussian splatting');
      if (improvements.length === 0) {
        console.log('   No papers found.');
      } else {
        improvements.slice(0, 5).forEach((p: any, idx: number) => {
          console.log(`   ${idx + 1}. ${p.title.substring(0, 70)}...`);
          console.log(`      Relationship: ${p.relationship_type} (confidence: ${p.confidence_score?.toFixed(2)})`);
          if (p.context) {
            console.log(`      Context: "${p.context.substring(0, 100)}..."`);
          }
        });
      }
      console.log(`   Total: ${improvements.length} papers\n`);

      // Query 2: Most common methods
      console.log('2. Most commonly used methods:');
      console.log('   ─────────────────────────────────────────────────────────');
      const methods = await this.db.getMostCommonMethods(10);
      if (methods.length === 0) {
        console.log('   No methods found.');
      } else {
        methods.forEach((m: any, idx: number) => {
          console.log(`   ${idx + 1}. ${m.name}`);
          console.log(`      Mentioned in ${m.paper_count} papers`);
          if (m.description) {
            console.log(`      ${m.description.substring(0, 80)}...`);
          }
        });
      }
      console.log();

      // Query 3: Related papers by shared concepts
      console.log('3. Papers related by shared concepts (splatting, rendering):');
      console.log('   ─────────────────────────────────────────────────────────');
      const related = await this.db.getRelatedPapersByConcepts(['splatting', 'rendering'], 5);
      if (related.length === 0) {
        console.log('   No related papers found.');
      } else {
        related.forEach((p: any, idx: number) => {
          console.log(`   ${idx + 1}. ${p.title.substring(0, 70)}...`);
          console.log(`      Shared concepts: ${p.concept_names.join(', ')}`);
          console.log(`      Matching concepts: ${p.matching_concepts}`);
        });
      }
      console.log();

    } catch (error) {
      console.error('Error running example queries:', error);
    }
  }

  /**
   * Print processing statistics
   */
  printStats(): void {
    console.log('\n=== Processing Statistics ===');
    console.log(`Total papers ingested: ${this.stats.totalPapers}`);
    console.log(`Successfully processed: ${this.stats.processedPapers}`);
    console.log(`Failed: ${this.stats.failedPapers}`);
    console.log(`Total entities extracted: ${this.stats.totalEntities}`);
    console.log(`Total relationships extracted: ${this.stats.totalRelationships}`);
    
    if (this.stats.processedPapers > 0) {
      const avgEntities = (this.stats.totalEntities / this.stats.processedPapers).toFixed(1);
      const avgRelationships = (this.stats.totalRelationships / this.stats.processedPapers).toFixed(1);
      console.log(`Average entities per paper: ${avgEntities}`);
      console.log(`Average relationships per paper: ${avgRelationships}`);
    }
  }

  /**
   * Close all connections and cleanup
   */
  async close(): Promise<void> {
    await this.db.close();
  }
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

/**
 * Main function that runs the complete pipeline
 */
async function main() {
  const orchestrator = new PipelineOrchestrator();

  try {
    // Initialize
    await orchestrator.initialize();

    // Step 1: Ingest papers
    const limit = parseInt(process.env.ARXIV_MAX_RESULTS || '50');
    if (process.env.INGEST_MODE === 'seed_citations') {
      await orchestrator.ingestFromSeedAndCitations(limit);
    } else {
      await orchestrator.ingestPapers(undefined, limit);
    }

    // Step 2: Process papers
    const batchSize = parseInt(process.env.BATCH_SIZE || '10');
    await orchestrator.processAllPapers(batchSize);

    // Step 3: Run example queries
    await orchestrator.runExampleQueries();

    // Print final statistics
    orchestrator.printStats();
    
    console.log('\n✓ Pipeline completed successfully!');
  } catch (error) {
    console.error('\n✗ Pipeline error:', error);
    process.exit(1);
  } finally {
    await orchestrator.close();
  }
}

// Run main function if this file is executed directly
if (require.main === module) {
  main();
}

