/**
 * Query Router
 * Detects intent from natural language questions and routes to appropriate query strategy
 * Implements a hierarchical routing system: GRAPH templates → FTS templates → NL→SQL
 */

export type Intent =
  | "lineage"           // improves_on, better_than, advances_over
  | "introduces"        // introduces, introduces_concept, introduces_method
  | "extends"           // extends, builds_on, generalizes
  | "uses"              // uses_dataset, uses_metric, uses_method
  | "compares"          // compares, vs, versus, comparison, benchmark
  | "authored_by"       // authored_by, written_by, by_author
  | "neighbors"         // neighbors, around, connected_to, related_to
  | "focus"             // focus_on, talks_about, centered_on
  | "count"             // how_many, number_of, count (including NOT)
  | "most_common"       // most common/popular methods/concepts/datasets/metrics
  | "nl2sql";           // general analytics

export type Route = "graph" | "fts" | "nl2sql";

export interface RoutingResult {
  intent: Intent;
  route: Route;
  confidence: number;  // 0.0 - 1.0
  parameters?: Record<string, any>;  // Extracted parameters (method names, entity names, etc.)
}

/**
 * Detects intent and routes the question to the appropriate query strategy
 * Follows hierarchical routing: stop at first confident match
 * 
 * A) GRAPH templates (high precision)
 * B) FTS templates (lexical/topic style)
 * C) NL→SQL (general analytics)
 */
export function detectIntentAndRoute(question: string): RoutingResult {
  const q = question.toLowerCase().trim();
  const qWords = q.split(/\s+/);

  // ============================================================================
  // A) GRAPH TEMPLATES (High Precision) - Stop at first confident match
  // ============================================================================

  // 1. LINEAGE: improves_on, better_than, advances_over
  // Patterns: "improves on X", "better than X", "advances over X", "enhances X"
  const lineagePatterns = [
    /(?:which|what|find|show).*(?:papers?|methods?).*(?:improve|enhance|advance|better).*(?:on|upon|over|than)\s+(.+?)(?:\?|$)/i,
    /(?:which|what|find|show).*(?:papers?|methods?).*(?:improvement|enhancement|advancement).*(?:of|over|to)\s+(.+?)(?:\?|$)/i,
    /(?:papers?|methods?).*(?:improve|enhance|advance|better).*(?:on|upon|over|than)\s+(.+?)(?:\?|$)/i,
  ];
  for (const pattern of lineagePatterns) {
    const match = q.match(pattern);
    if (match && match[1]) {
      const methodName = match[1].trim();
      if (isValidEntityName(methodName)) {
        return {
          intent: "lineage",
          route: "graph",
          confidence: 0.95,
          parameters: { target_method: methodName },
        };
      }
    }
  }

  // 2. INTRODUCES: introduces, introduces_concept, introduces_method
  // Patterns: "introduces X", "presents X", "novel X", "new method/concept X"
  const introducesPatterns = [
    /(?:which|what|find|show).*(?:papers?|paper).*(?:introduce|present|propose|novel).*(?:the\s+)?(?:concept|method|technique|algorithm|approach)\s+(.+?)(?:\?|$)/i,
    /(?:what|which).*(?:concepts?|methods?|techniques?).*(?:did|does|were|are).*(?:paper|arxiv).*(\d{4}\.\d{5})\s*(?:introduce|present)/i,
    /paper.*(\d{4}\.\d{5}).*(?:introduce|present|propose).*(?:the\s+)?(?:concepts?|methods?)/i,
  ];
  for (const pattern of introducesPatterns) {
    const match = q.match(pattern);
    if (match && match[1]) {
      return {
        intent: "introduces",
        route: "graph",
        confidence: 0.90,
        parameters: { paper_id: match[1], entity_name: match[2] || null },
      };
    }
  }

  // 3. EXTENDS: extends, builds_on, generalizes
  // Patterns: "extends X", "builds on X", "generalizes X"
  const extendsPatterns = [
    /(?:which|what|find|show).*(?:papers?|methods?).*(?:extend|build|generalize|base).*(?:on|upon)\s+(.+?)(?:\?|$)/i,
    /(?:extending|building|generalizing).*(?:on|upon)\s+(.+?)(?:\?|$)/i,
  ];
  for (const pattern of extendsPatterns) {
    const match = q.match(pattern);
    if (match && match[1]) {
      const entityName = match[1].trim();
      if (isValidEntityName(entityName)) {
        return {
          intent: "extends",
          route: "graph",
          confidence: 0.90,
          parameters: { base_entity: entityName },
        };
      }
    }
  }

  // 4. USES: uses_dataset, uses_metric, uses_method
  // Patterns: "uses X dataset", "evaluates with X metric", "employs X method"
  const usesPatterns = [
    /(?:which|what|find|show).*(?:papers?).*(?:use|uses|using|employ|employs|evaluate|evaluates|evaluating).*(?:the\s+)?(.+?)\s+(?:dataset|metric|method)(?:\?|$)/i,
    /(?:papers?).*(?:using|evaluating|employing).*(?:the\s+)?(.+?)\s+(?:dataset|metric|method)(?:\?|$)/i,
    /(?:which|what).*(?:dataset|metric|method).*(?:is|are).*(?:used|evaluated|employed)(?:\?|$)/i,
  ];
  for (const pattern of usesPatterns) {
    const match = q.match(pattern);
    if (match && match[1]) {
      const entityName = match[1].trim();
      if (isValidEntityName(entityName)) {
        return {
          intent: "uses",
          route: "graph",
          confidence: 0.90,
          parameters: { entity_name: entityName },
        };
      }
    }
  }

  // 5. COMPARES: compares, vs, versus, comparison, benchmark
  // Patterns: "compares with X", "vs X", "versus X", "comparison to X"
  const comparesPatterns = [
    /(?:which|what|find|show).*(?:papers?).*(?:compare|compares|comparison|benchmark).*(?:with|against|to|vs|versus)\s+(.+?)(?:\?|$)/i,
    /(?:what|which).*(?:compare|compares).*(?:against|with|to)\s+(.+?)(?:\?|$)/i,
    /(?:papers?).*(?:comparing|benchmarking).*(?:with|against|to|vs|versus)\s+(.+?)(?:\?|$)/i,
  ];
  for (const pattern of comparesPatterns) {
    const match = q.match(pattern);
    if (match && match[1]) {
      const methodName = match[1].trim();
      if (isValidEntityName(methodName)) {
        return {
          intent: "compares",
          route: "graph",
          confidence: 0.90,
          parameters: { compared_method: methodName },
        };
      }
    }
  }

  // 6. AUTHORED_BY: authored_by, written_by, by_author
  // Patterns: "authored by X", "written by X", "by author X"
  const authoredByPatterns = [
    /(?:which|what|find|show).*(?:papers?).*(?:authored|written|by)\s+(?:author\s+)?(.+?)(?:\?|$)/i,
    /(?:papers?).*(?:by|from|authored|written)\s+(?:author\s+)?(.+?)(?:\?|$)/i,
  ];
  for (const pattern of authoredByPatterns) {
    const match = q.match(pattern);
    if (match && match[1]) {
      const authorName = match[1].trim();
      if (isValidAuthorName(authorName)) {
        return {
          intent: "authored_by",
          route: "graph",
          confidence: 0.85,
          parameters: { author_name: authorName },
        };
      }
    }
  }

  // 7. NEIGHBORS: neighbors, around, connected_to, related_to
  // Patterns: "neighbors of X", "around X", "connected to X", "related to X"
  const neighborsPatterns = [
    /(?:show|find|what|which).*(?:neighbors?|neighborhood|connections?|relations?).*(?:of|around|to|connected|related)\s+(?:the\s+)?(.+?)(?:\?|$)/i,
    /(?:neighbors?|neighborhood|connections?|relations?).*(?:of|around|to)\s+(?:the\s+)?(.+?)(?:\?|$)/i,
    /(?:what|which).*(?:is|are).*(?:connected|related).*(?:to|with)\s+(?:the\s+)?(.+?)(?:\?|$)/i,
  ];
  for (const pattern of neighborsPatterns) {
    const match = q.match(pattern);
    if (match && match[1]) {
      const entityName = match[1].trim();
      if (isValidEntityName(entityName)) {
        return {
          intent: "neighbors",
          route: "graph",
          confidence: 0.85,
          parameters: { entity_name: entityName },
        };
      }
    }
  }

  // ============================================================================
  // B) FTS TEMPLATES (Lexical/Topic Style)
  // ============================================================================

  // 8. FOCUS: focus_on, talks_about, centered_on
  // Patterns: "focus on X", "talks about X", "centered on X", "about X"
  const focusPatterns = [
    /(?:which|what|find|show).*(?:papers?).*(?:focus|focuses|focused|talks|talk|centered|centers|about|on)\s+(?:on|about|regarding)?\s*(.+?)(?:\?|$)/i,
    /(?:papers?).*(?:focus|focuses|focused|talks|talk|centered|centers|about)\s+(?:on|about|regarding)?\s*(.+?)(?:\?|$)/i,
    /(?:what|which).*(?:paper|papers).*(?:focus|focuses|talks|centered).*(?:on|about)\s+(.+?)(?:\?|$)/i,
  ];
  for (const pattern of focusPatterns) {
    const match = q.match(pattern);
    if (match && match[1]) {
      const topic = match[1].trim();
      // Also check for negation: "not about", "doesn't focus on", etc.
      const hasNegation = /\b(not|doesn't|does not|don't|do not|excluding|without|except)\b/i.test(q);
      return {
        intent: hasNegation ? "count" : "focus",
        route: "fts",
        confidence: 0.80,
        parameters: { topic: topic, negation: hasNegation },
      };
    }
  }

  // 9. MOST_COMMON / LEAST_COMMON: most/least common/popular methods/concepts/datasets/metrics
  // Patterns: "most common X", "most popular X", "top X", "frequently used X"
  // Also: "least common X", "least popular X", "bottom X", "rarely used X"
  const mostCommonPatterns = [
    /(?:what|which|find|show).*(?:most|top|popular|frequently|commonly|common).*(?:methods?|concepts?|datasets?|metrics?|entities?)/i,
    /(?:most|top|popular|frequently|commonly|common).*(?:methods?|concepts?|datasets?|metrics?|entities?)/i,
    /(?:what|which).*(?:are|is).*(?:the|some).*(?:most|top|popular|frequently|commonly|common).*(?:methods?|concepts?|datasets?|metrics?)/i,
  ];
  
  const leastCommonPatterns = [
    /(?:what|which|find|show).*(?:least|bottom|rarely|uncommon|infrequent).*(?:methods?|concepts?|datasets?|metrics?|entities?)/i,
    /(?:least|bottom|rarely|uncommon|infrequent).*(?:methods?|concepts?|datasets?|metrics?|entities?)/i,
    /(?:what|which).*(?:are|is).*(?:the|some).*(?:least|bottom|rarely|uncommon|infrequent).*(?:methods?|concepts?|datasets?|metrics?)/i,
  ];
  
  // Check for "least common" first (more specific)
  for (const pattern of leastCommonPatterns) {
    const match = q.match(pattern);
    if (match) {
      // Extract entity type
      const entityTypeMatch = q.match(/\b(methods?|concepts?|datasets?|metrics?|entities?)\b/i);
      const entityType = entityTypeMatch ? entityTypeMatch[1].toLowerCase().replace(/s$/, '') : 'method';
      
      // Extract limit if specified - handle multiple patterns:
      // "5 least common methods", "least 5 methods", "bottom 5 methods", "least common 5 methods"
      const limitPatterns = [
        /\b(\d+)\s+(?:least|bottom|rarely|uncommon)/i,  // "5 least common"
        /\b(?:least|bottom|rarely|uncommon)\s+(\d+)/i,  // "least 5 methods"
        /\b(?:least|bottom).*?\b(\d+)\b/i,              // "least common 5 methods"
      ];
      let limit = 10;
      for (const limitPattern of limitPatterns) {
        const limitMatch = q.match(limitPattern);
        if (limitMatch && limitMatch[1]) {
          limit = parseInt(limitMatch[1]);
          break;
        }
      }
      
      return {
        intent: "most_common", // Reuse same intent, but with order: ASC
        route: "graph",
        confidence: 0.90,
        parameters: { 
          entity_type: entityType,
          limit: limit,
          order: "ASC", // Least common = ascending order
        },
      };
    }
  }
  
  // Check for "most common" (default)
  for (const pattern of mostCommonPatterns) {
    const match = q.match(pattern);
    if (match) {
      // Extract entity type
      const entityTypeMatch = q.match(/\b(methods?|concepts?|datasets?|metrics?|entities?)\b/i);
      const entityType = entityTypeMatch ? entityTypeMatch[1].toLowerCase().replace(/s$/, '') : 'method';
      
      // Extract limit if specified - handle multiple patterns:
      // "5 most common methods", "top 5 methods", "most popular 10 methods", "most common 5"
      const limitPatterns = [
        /\b(\d+)\s+(?:most|top|popular|frequently|commonly|common)/i,  // "5 most common"
        /\b(?:top|most|popular)\s+(\d+)/i,                             // "top 5 methods"
        /\b(?:most|popular|common).*?\b(\d+)\b/i,                      // "most common 5 methods"
      ];
      let limit = 10;
      for (const limitPattern of limitPatterns) {
        const limitMatch = q.match(limitPattern);
        if (limitMatch && limitMatch[1]) {
          limit = parseInt(limitMatch[1]);
          break;
        }
      }
      
      return {
        intent: "most_common",
        route: "graph",
        confidence: 0.90,
        parameters: { 
          entity_type: entityType,
          limit: limit,
          order: "DESC", // Most common = descending order (default)
        },
      };
    }
  }

  // 10. COUNT: how_many, number_of, count (including NOT)
  // Patterns: "how many", "number of", "count", "how many ... not"
  const countPatterns = [
    /(?:how\s+many|number\s+of|count|counts?)\s+(?:papers?|entities?|relationships?|methods?|concepts?|datasets?|metrics?)(?:\s+.*)?(?:\?|$)/i,
    /(?:how\s+many|number\s+of).*(?:not|don't|do not|doesn't|does not|excluding|without|except)/i,
  ];
  for (const pattern of countPatterns) {
    const match = q.match(pattern);
    if (match) {
      // Check for negation
      const hasNegation = /\b(not|doesn't|does not|don't|do not|excluding|without|except|are not)\b/i.test(q);
      // Extract what to count
      const entityTypeMatch = q.match(/\b(papers?|entities?|relationships?|methods?|concepts?|datasets?|metrics?)\b/i);
      const entityType = entityTypeMatch ? entityTypeMatch[1] : "papers";
      
      // Extract filter condition if present
      let filterCondition: string | null = null;
      if (hasNegation) {
        const notMatch = q.match(/(?:not|doesn't|does not|don't|do not|excluding|without|except)\s+(?:about|on|in|containing|contain)?\s*(.+?)(?:\?|$)/i);
        if (notMatch && notMatch[1]) {
          filterCondition = notMatch[1].trim();
        }
      } else {
        const aboutMatch = q.match(/(?:about|on|in|containing|contain|mentioning|mention)\s+(.+?)(?:\?|$)/i);
        if (aboutMatch && aboutMatch[1]) {
          filterCondition = aboutMatch[1].trim();
        }
      }

      return {
        intent: "count",
        route: "fts",
        confidence: 0.85,
        parameters: { 
          entity_type: entityType.toLowerCase().replace(/s$/, ''),
          negation: hasNegation,
          filter_condition: filterCondition,
        },
      };
    }
  }

  // ============================================================================
  // C) NL→SQL (General Analytics)
  // ============================================================================

  // 10. NL2SQL: Everything else goes to NL→SQL
  // This is the fallback for general analytics queries
  return {
    intent: "nl2sql",
    route: "nl2sql",
    confidence: 0.70,  // Lower confidence since it's a fallback
    parameters: {},
  };
}

/**
 * Helper: Check if a string looks like a valid entity name
 * Filters out common words, personal names, and irrelevant terms
 */
function isValidEntityName(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed || trimmed.length < 2) return false;

  // Common stop words that aren't entity names
  const stopWords = [
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were',
    'this', 'that', 'these', 'those', 'it', 'they', 'them',
    'how', 'what', 'which', 'who', 'when', 'where', 'why',
  ];
  if (stopWords.includes(trimmed)) return false;

  // Common first names (likely personal names, not methods)
  const commonFirstNames = [
    'john', 'jane', 'mike', 'david', 'sarah', 'chris', 'emily',
    'michael', 'jennifer', 'robert', 'lisa', 'william', 'maria', 'james',
    'susan', 'richard', 'karen', 'thomas', 'nancy', 'daniel', 'betty',
    'navyanth', 'paul', 'andrew', 'michelle', 'joshua', 'laura', 'kenneth',
  ];
  // Only flag if it's a single word that exactly matches a common name
  if (trimmed.split(/\s+/).length === 1 && commonFirstNames.includes(trimmed)) {
    // But allow if it contains research terms
    const researchTerms = ['gaussian', 'splatting', 'nerf', 'neural', 'method', 'algorithm', '3d', 'gs'];
    if (!researchTerms.some(term => trimmed.includes(term))) {
      return false;
    }
  }

  // Irrelevant terms (job search, cooking, etc.)
  const irrelevantTerms = [
    'job', 'resume', 'interview', 'career', 'salary', 'hiring',
    'recipe', 'cooking', 'food', 'restaurant', 'movie', 'music', 'sports',
  ];
  if (irrelevantTerms.some(term => trimmed.includes(term))) return false;

  return true;
}

/**
 * Helper: Check if a string looks like a valid author name
 */
function isValidAuthorName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length < 2) return false;
  
  // Author names are typically 2+ words or initials
  // This is a simple check - could be enhanced
  return trimmed.length >= 2 && !/^(the|a|an|and|or|but)$/i.test(trimmed);
}

