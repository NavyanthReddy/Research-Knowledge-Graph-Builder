import * as dotenv from 'dotenv';
import { PipelineOrchestrator } from '../pipeline/orchestrator';

dotenv.config();

/**
 * Script to process papers (extract entities and relationships)
 * Run this if papers are ingested but not processed yet
 */

async function main() {
	const orchestrator = new PipelineOrchestrator();

	try {
		console.log('🚀 Running process task (optional ingest → process)\n');
		await orchestrator.initialize();

		// Optional ingestion step based on env
		const ingestMode = process.env.INGEST_MODE || '';
		const ingestLimitRaw = process.env.ARXIV_MAX_RESULTS || '0';
		const ingestLimit = Number.isNaN(Number(ingestLimitRaw)) ? 0 : Number(ingestLimitRaw);
		if (ingestMode) {
			console.log(`\nINGEST_MODE=${ingestMode} detected → running ingestion before processing`);
			const limit = ingestLimit > 0 ? Math.floor(ingestLimit) : 50;
			try {
				if (ingestMode === 'seed_citations') {
					await orchestrator.ingestFromSeedAndCitations(limit);
				} else {
					await orchestrator.ingestPapers(undefined, limit);
				}
			} catch (ingErr) {
				console.error('⚠️  Ingestion step failed, continuing to processing:', ingErr);
			}
		} else {
			console.log('No ingestion performed (INGEST_MODE not set).');
		}

		// Process unprocessed papers
		const batchSize = parseInt(process.env.AZ_BATCH_SIZE || process.env.BATCH_SIZE || '10', 10);
		console.log(`Processing papers in batches of ${batchSize}\n`);
		await orchestrator.processAllPapers(batchSizeFix(batchSize));

		console.log('\n✅ Processing complete!\n');
		orchestrator.printStats();
	} catch (error) {
		console.error('\n❌ Processing error:', error);
		process.exit(1);
	} finally {
		await orchestrator.close();
	}
}

function batchSizeFix(n: number): number {
	if (!Number.isFinite(n) || n <= 0) return 10;
	return n;
}

if (require.main === module) {
	main();
}

