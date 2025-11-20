/**
 * Utility functions for extracting and parsing JSON from Llama LLM responses
 * Handles various response formats and common JSON issues
 */

/**
 * Parse JSON from Llama response text
 * Tries multiple strategies to extract and parse JSON
 * @param text - Raw text response from Llama
 * @returns Parsed JSON object
 * @throws Error if JSON cannot be extracted or parsed
 */
export function parseJsonFromLlama(text: string): any {
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid input: text must be a non-empty string');
  }

  console.log('[JSONParser] Attempting to parse JSON from Llama response...');
  console.log('[JSONParser] Input text length:', text.length);

  let extractedJson: string | null = null;
  let strategy = '';

  // Strategy 1: Look for JSON between ```json and ``` markers
  console.log('[JSONParser] Strategy 1: Looking for JSON between ```json and ``` markers...');
  const jsonFenceMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (jsonFenceMatch && jsonFenceMatch[1]) {
    extractedJson = jsonFenceMatch[1].trim();
    strategy = 'json code fence';
    console.log('[JSONParser] ✅ Found JSON using strategy 1 (json code fence)');
  }

  // Strategy 2: Look for JSON between ``` and ``` markers (any language)
  if (!extractedJson) {
    console.log('[JSONParser] Strategy 2: Looking for JSON between ``` and ``` markers...');
    const fenceMatch = text.match(/```[\s\S]*?\n([\s\S]*?)\s*```/);
    if (fenceMatch && fenceMatch[1]) {
      const potentialJson = fenceMatch[1].trim();
      // Check if it looks like JSON (starts with { or [)
      if (potentialJson.startsWith('{') || potentialJson.startsWith('[')) {
        extractedJson = potentialJson;
        strategy = 'code fence';
        console.log('[JSONParser] ✅ Found JSON using strategy 2 (code fence)');
      }
    }
  }

  // Strategy 3: Look for JSON between { and } (greedy match)
  if (!extractedJson) {
    console.log('[JSONParser] Strategy 3: Looking for JSON between { and } (greedy match)...');
    const jsonObjectMatch = text.match(/\{[\s\S]*\}/);
    if (jsonObjectMatch && jsonObjectMatch[0]) {
      extractedJson = jsonObjectMatch[0];
      strategy = 'greedy object match';
      console.log('[JSONParser] ✅ Found JSON using strategy 3 (greedy object match)');
    }
  }

  // Strategy 4: Look for JSON array between [ and ]
  if (!extractedJson) {
    console.log('[JSONParser] Strategy 4: Looking for JSON array between [ and ]...');
    const jsonArrayMatch = text.match(/\[[\s\S]*\]/);
    if (jsonArrayMatch && jsonArrayMatch[0]) {
      extractedJson = jsonArrayMatch[0];
      strategy = 'array match';
      console.log('[JSONParser] ✅ Found JSON using strategy 4 (array match)');
    }
  }

  // Strategy 5: Try to find JSON anywhere using comprehensive regex
  if (!extractedJson) {
    console.log('[JSONParser] Strategy 5: Looking for JSON anywhere using comprehensive regex...');
    // Try to find JSON object or array
    const comprehensiveMatch = text.match(/(?:\{|\[)[\s\S]*(?:\}|\])/);
    if (comprehensiveMatch && comprehensiveMatch[0]) {
      extractedJson = comprehensiveMatch[0];
      strategy = 'comprehensive regex';
      console.log('[JSONParser] ✅ Found JSON using strategy 5 (comprehensive regex)');
    }
  }

  if (!extractedJson) {
    console.error('[JSONParser] ❌ Could not extract JSON using any strategy');
    console.error('[JSONParser] Text preview:', text.substring(0, 500));
    throw new Error('Could not extract JSON from response text');
  }

  console.log('[JSONParser] Extracted JSON length:', extractedJson.length);
  console.log('[JSONParser] Using strategy:', strategy);

  // Clean the extracted text
  console.log('[JSONParser] Cleaning extracted JSON...');
  let cleanedJson = cleanJsonText(extractedJson);
  console.log('[JSONParser] Cleaned JSON length:', cleanedJson.length);

  // Attempt to parse the JSON
  console.log('[JSONParser] Attempting to parse JSON...');
  try {
    const parsed = JSON.parse(cleanedJson);
    console.log('[JSONParser] ✅ Successfully parsed JSON');
    return parsed;
  } catch (parseError: any) {
    console.warn('[JSONParser] ⚠️  Initial parse failed:', parseError.message);
    console.log('[JSONParser] Attempting to fix common JSON issues...');

    // Try to fix common issues
    try {
      const fixedJson = fixJsonIssues(cleanedJson);
      console.log('[JSONParser] Fixed JSON, attempting to parse again...');
      const parsed = JSON.parse(fixedJson);
      console.log('[JSONParser] ✅ Successfully parsed JSON after fixing issues');
      return parsed;
    } catch (fixError: any) {
      console.error('[JSONParser] ❌ Failed to fix and parse JSON:', fixError.message);
      console.error('[JSONParser] Original error:', parseError.message);
      console.error('[JSONParser] JSON preview:', cleanedJson.substring(0, 500));
      throw new Error(
        `Failed to parse JSON: ${parseError.message}. Fix attempt error: ${fixError.message}`
      );
    }
  }
}

/**
 * Clean extracted JSON text
 * Removes markdown code fences, whitespace, and fixes common issues
 */
function cleanJsonText(jsonText: string): string {
  let cleaned = jsonText.trim();

  // Remove markdown code fences if still present
  cleaned = cleaned.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '');

  // Remove leading/trailing whitespace
  cleaned = cleaned.trim();

  // Remove common prefixes/suffixes that Llama might add
  cleaned = cleaned.replace(/^Here's?\s+(the\s+)?(JSON|json)\s*:?\s*/i, '');
  cleaned = cleaned.replace(/^(The|Here is)\s+(JSON|json)\s*:?\s*/i, '');

  return cleaned;
}

/**
 * Fix common JSON issues
 * Attempts to repair malformed JSON
 */
function fixJsonIssues(jsonText: string): string {
  let fixed = jsonText;

  // Fix trailing commas before closing braces/brackets
  console.log('[JSONParser] Fixing trailing commas...');
  fixed = fixed.replace(/,(\s*[}\]])/g, '$1');

  // Fix single quotes to double quotes (but be careful with apostrophes)
  console.log('[JSONParser] Fixing single quotes...');
  // Only replace single quotes that are around keys or values, not apostrophes in words
  fixed = fixed.replace(/'([^']*)':/g, '"$1":'); // Keys
  fixed = fixed.replace(/: '([^']*)'/g, ': "$1"'); // String values (simple case)
  
  // More sophisticated: handle escaped quotes and apostrophes
  // This is tricky, so we'll be conservative
  const singleQuotePattern = /:\s*'([^']*(?:'[^']*)*)'/g;
  fixed = fixed.replace(singleQuotePattern, (match, content) => {
    // If it's a simple string without apostrophes, replace
    if (!content.includes("'")) {
      return `: "${content}"`;
    }
    // Otherwise, escape the apostrophes and keep double quotes
    return `: "${content.replace(/"/g, '\\"')}"`;
  });

  // Fix unescaped quotes in values
  console.log('[JSONParser] Fixing unescaped quotes...');
  // This is complex - we'll use a regex that's more conservative
  // Match "key": "value" where value might have unescaped quotes
  fixed = fixed.replace(/: "([^"]*)"([^,}\]]*)/g, (match, value, rest) => {
    // If rest contains quote before comma/brace/bracket, it might be an issue
    // But this is hard to fix automatically, so we'll be conservative
    return match;
  });

  // Add missing quotes around keys
  console.log('[JSONParser] Fixing missing quotes around keys...');
  // Match unquoted keys (word characters, possibly with spaces)
  fixed = fixed.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_\s]*)\s*:/g, (match, prefix, key) => {
    // Only fix if it looks like a key (word characters, maybe with spaces)
    if (/^[a-zA-Z_][a-zA-Z0-9_\s]*$/.test(key.trim())) {
      return `${prefix}"${key.trim()}":`;
    }
    return match;
  });

  // Fix escaped quotes issues
  console.log('[JSONParser] Fixing escaped quotes...');
  // Replace \\" with \"
  fixed = fixed.replace(/\\\\"/g, '\\"');
  
  // Remove double-escaped backslashes
  fixed = fixed.replace(/\\\\\\\\/g, '\\\\');

  // Fix common issues with boolean/null values
  console.log('[JSONParser] Fixing boolean/null values...');
  fixed = fixed.replace(/:\s*(true|false|null)\s*([,}])/g, ': $1$2');
  
  // Fix numeric values
  fixed = fixed.replace(/:\s*"(\d+\.?\d*)"\s*([,}])/g, ': $1$2');

  return fixed;
}

/**
 * Validate entity JSON structure
 * Verifies that the parsed JSON has the correct structure for entities
 * @param obj - Parsed JSON object
 * @returns true if valid, false otherwise
 */
export function validateEntityJson(obj: any): boolean {
  console.log('[JSONParser] Validating entity JSON structure...');

  if (!obj || typeof obj !== 'object') {
    console.error('[JSONParser] ❌ Invalid: obj is not an object');
    return false;
  }

  // Check for "entities" array
  if (!Array.isArray(obj.entities)) {
    console.error('[JSONParser] ❌ Invalid: missing "entities" array');
    return false;
  }

  console.log(`[JSONParser] Found ${obj.entities.length} entities, validating each...`);

  // Validate each entity
  for (let i = 0; i < obj.entities.length; i++) {
    const entity = obj.entities[i];

    if (!entity || typeof entity !== 'object') {
      console.error(`[JSONParser] ❌ Invalid: entity at index ${i} is not an object`);
      return false;
    }

    // Check required fields
    const requiredFields = ['name', 'type', 'description', 'confidence'];
    for (const field of requiredFields) {
      if (!(field in entity)) {
        console.error(
          `[JSONParser] ❌ Invalid: entity at index ${i} missing required field: ${field}`
        );
        return false;
      }
    }

    // Validate field types
    if (typeof entity.name !== 'string' || entity.name.trim().length === 0) {
      console.error(`[JSONParser] ❌ Invalid: entity at index ${i} has invalid name`);
      return false;
    }

    if (typeof entity.type !== 'string') {
      console.error(`[JSONParser] ❌ Invalid: entity at index ${i} has invalid type`);
      return false;
    }

    if (typeof entity.description !== 'string') {
      console.error(`[JSONParser] ❌ Invalid: entity at index ${i} has invalid description`);
      return false;
    }

    // Validate confidence score
    const confidence = parseFloat(entity.confidence);
    if (isNaN(confidence) || confidence < 0 || confidence > 1) {
      console.error(
        `[JSONParser] ❌ Invalid: entity at index ${i} has invalid confidence: ${entity.confidence}`
      );
      return false;
    }

    console.log(`[JSONParser] ✅ Entity at index ${i} is valid: ${entity.name}`);
  }

  console.log('[JSONParser] ✅ All entities are valid');
  return true;
}

/**
 * Validate relationship JSON structure
 * Verifies that the parsed JSON has the correct structure for relationships
 * @param obj - Parsed JSON object
 * @returns true if valid, false otherwise
 */
export function validateRelationshipJson(obj: any): boolean {
  console.log('[JSONParser] Validating relationship JSON structure...');

  if (!obj || typeof obj !== 'object') {
    console.error('[JSONParser] ❌ Invalid: obj is not an object');
    return false;
  }

  // Check for "relationships" array
  if (!Array.isArray(obj.relationships)) {
    console.error('[JSONParser] ❌ Invalid: missing "relationships" array');
    return false;
  }

  console.log(
    `[JSONParser] Found ${obj.relationships.length} relationships, validating each...`
  );

  // Validate each relationship
  for (let i = 0; i < obj.relationships.length; i++) {
    const relationship = obj.relationships[i];

    if (!relationship || typeof relationship !== 'object') {
      console.error(
        `[JSONParser] ❌ Invalid: relationship at index ${i} is not an object`
      );
      return false;
    }

    // Check required fields
    const requiredFields = ['source', 'target', 'type', 'evidence', 'confidence'];
    for (const field of requiredFields) {
      if (!(field in relationship)) {
        console.error(
          `[JSONParser] ❌ Invalid: relationship at index ${i} missing required field: ${field}`
        );
        return false;
      }
    }

    // Validate field types
    if (typeof relationship.source !== 'string' || relationship.source.trim().length === 0) {
      console.error(
        `[JSONParser] ❌ Invalid: relationship at index ${i} has invalid source`
      );
      return false;
    }

    if (typeof relationship.target !== 'string' || relationship.target.trim().length === 0) {
      console.error(
        `[JSONParser] ❌ Invalid: relationship at index ${i} has invalid target`
      );
      return false;
    }

    if (typeof relationship.type !== 'string') {
      console.error(`[JSONParser] ❌ Invalid: relationship at index ${i} has invalid type`);
      return false;
    }

    if (typeof relationship.evidence !== 'string') {
      console.error(
        `[JSONParser] ❌ Invalid: relationship at index ${i} has invalid evidence`
      );
      return false;
    }

    // Validate confidence score
    const confidence = parseFloat(relationship.confidence);
    if (isNaN(confidence) || confidence < 0 || confidence > 1) {
      console.error(
        `[JSONParser] ❌ Invalid: relationship at index ${i} has invalid confidence: ${relationship.confidence}`
      );
      return false;
    }

    console.log(
      `[JSONParser] ✅ Relationship at index ${i} is valid: ${relationship.source} -> ${relationship.target}`
    );
  }

  console.log('[JSONParser] ✅ All relationships are valid');
  return true;
}

