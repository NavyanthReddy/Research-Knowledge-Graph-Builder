/**
 * Query execution metadata
 * Tracks reasoning and execution details for transparency
 */
export interface QueryMetadata {
  // Original question
  question?: string; // The original question that was asked
  
  // Intent detection
  detectedIntent: string; // e.g., "filter", "aggregate", "search", "list"
  intentConfidence?: number;

  // Tool/route used
  executionRoute: 'graph' | 'fts' | 'nl2sql' | 'pattern_match' | 'rule_based' | 'hybrid';
  
  // Exact query executed
  sqlQuery?: string;
  graphQuery?: string;
  patternMatched?: string;
  
  // Ranking/sorting signals
  rankingSignals?: {
    signal: string; // e.g., "published_date", "confidence_score", "ts_rank", "focus_score"
    direction: 'ASC' | 'DESC';
    weight?: number;
  };
  
  // Fallbacks applied
  fallbacks: FallbackInfo[];
  
  // Execution details
  executionTimeMs: number;
  resultCount: number;
  
  // Errors/warnings
  warnings?: string[];
  errors?: string[];
}

export interface FallbackInfo {
  from: string; // e.g., "nl_to_sql", "hf_api"
  to: string; // e.g., "rule_based", "full_text_search"
  reason: string; // e.g., "HF API returned 400", "SQL parse failed"
  timestamp: Date;
}

/**
 * Query result with metadata
 */
export interface QueryResultWithMetadata<T = any> {
  results: T[];
  metadata: QueryMetadata;
}

