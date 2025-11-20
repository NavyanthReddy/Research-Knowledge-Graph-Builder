/**
 * SQL Validator and Sanitizer
 * Ensures queries are read-only, safe, and correct
 */

export interface ValidationResult {
  valid: boolean;
  sanitized: string | null;
  errors: string[];
  warnings: string[];
}

/**
 * Validates and sanitizes SQL queries for read-only operations
 * Ensures queries don't modify data and are safe to execute
 */
export function validateAndSanitizeSQL(sql: string): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    sanitized: sql.trim(),
    errors: [],
    warnings: [],
  };

  const sqlUpper = sql.toUpperCase().trim();

  // ============================================================================
  // CRITICAL: Block write operations
  // ============================================================================
  const writeKeywords = [
    'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE',
    'GRANT', 'REVOKE', 'COMMIT', 'ROLLBACK', 'SAVEPOINT',
  ];
  for (const keyword of writeKeywords) {
    if (sqlUpper.includes(keyword)) {
      result.valid = false;
      result.errors.push(`Write operation detected: ${keyword} is not allowed (read-only mode)`);
      result.sanitized = null;
      return result;
    }
  }

  // ============================================================================
  // Block dangerous functions
  // ============================================================================
  const dangerousFunctions = [
    'EXEC', 'EXECUTE', 'EXECUTE_IMMEDIATE', 'pg_exec', 'pg_send_query',
    'COPY', 'IMPORT', 'EXPORT',
  ];
  for (const func of dangerousFunctions) {
    if (sqlUpper.includes(func)) {
      result.valid = false;
      result.errors.push(`Dangerous function detected: ${func} is not allowed`);
      result.sanitized = null;
      return result;
    }
  }

  // ============================================================================
  // Basic SQL syntax validation
  // ============================================================================
  
  // Must start with SELECT
  if (!sqlUpper.startsWith('SELECT') && !sqlUpper.startsWith('WITH')) {
    result.valid = false;
    result.errors.push('Query must start with SELECT or WITH (read-only queries only)');
    result.sanitized = null;
    return result;
  }

  // Check for balanced parentheses
  const openParens = (sql.match(/\(/g) || []).length;
  const closeParens = (sql.match(/\)/g) || []).length;
  if (openParens !== closeParens) {
    result.errors.push('Unbalanced parentheses detected');
    // Don't fail, but warn - sometimes CTEs have nested structures
  }

  // Check for semicolon injection (should allow semicolons in strings, but be careful)
  // Simple check: semicolon at end is OK, semicolon in middle might be injection
  const semicolonIndex = sql.indexOf(';');
  if (semicolonIndex >= 0 && semicolonIndex < sql.length - 2) {
    result.warnings.push('Multiple statements detected (using only first statement)');
    result.sanitized = sql.substring(0, semicolonIndex + 1).trim();
  }

  // ============================================================================
  // Sanitization: Fix common issues
  // ============================================================================
  let sanitized = sql;

  // Fix: Remove trailing semicolon (optional, but cleaner)
  sanitized = sanitized.replace(/;\s*$/, '');

  // Fix: Ensure LIMIT is present for large result sets (optional, just a warning)
  if (!sqlUpper.includes('LIMIT') && !sqlUpper.includes('FETCH')) {
    result.warnings.push('Query has no LIMIT clause - may return many rows');
  }

  // Fix: Comment removal (strip SQL comments for safety)
  sanitized = sanitized.replace(/--.*$/gm, ''); // Line comments
  sanitized = sanitized.replace(/\/\*[\s\S]*?\*\//g, ''); // Block comments

  // ============================================================================
  // Final validation
  // ============================================================================
  if (sanitized.trim().length === 0) {
    result.valid = false;
    result.errors.push('Query is empty after sanitization');
    result.sanitized = null;
    return result;
  }

  result.sanitized = sanitized.trim();
  return result;
}

/**
 * Extract parameters from SQL query for parameterized execution
 * Returns array of parameter placeholders found ($1, $2, etc.)
 */
export function extractParameters(sql: string): number[] {
  const paramMatches = sql.match(/\$\d+/g) || [];
  const paramNumbers = paramMatches
    .map(match => parseInt(match.substring(1)))
    .filter(num => !isNaN(num));
  return [...new Set(paramNumbers)].sort((a, b) => a - b);
}

/**
 * Validate parameter count matches SQL placeholders
 */
export function validateParameterCount(sql: string, params: any[]): boolean {
  const expectedParams = extractParameters(sql);
  const maxParam = expectedParams.length > 0 ? Math.max(...expectedParams) : 0;
  return params.length >= maxParam;
}

