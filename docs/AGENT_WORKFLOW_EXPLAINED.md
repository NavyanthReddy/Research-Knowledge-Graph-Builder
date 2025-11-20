# Agent Workflow Explained - Beginner's Guide

This document explains step-by-step what happens when you ask a question to the knowledge graph system.

---

## 🎯 Overview: From Question to Answer

When you type a question like **"Which papers improve on Gaussian Splatting?"**, the system goes through 6 main steps:

1. **Detect Intent** - "What does the user want?"
2. **Choose Route** - "Which strategy should I use?"
3. **Build Query Plan** - "What SQL do I need?"
4. **Validate & Sanitize** - "Is this query safe?"
5. **Execute Query** - "Run the query and get results"
6. **Format & Return** - "Show the answer nicely"

Let's go through each step in detail!

---

## 📝 Step-by-Step Breakdown

### Step 1: You Ask a Question

**Example:** `"Which papers improve on Gaussian Splatting?"`

The question enters the system through `askQuestion.ts`, which is the main entry point.

---

### Step 2: Detect Intent & Route (Router)

**File:** `src/router.ts`  
**Function:** `detectIntentAndRoute(question)`

**What happens:**

The router reads your question and tries to figure out:
- **What type of question is this?**
- **Which strategy should I use to answer it?**

It checks your question against patterns (like a flowchart):

```
┌─────────────────────────────────────────┐
│ Is it asking about improvements?        │
│ Pattern: "improves on X", "better than" │
└──────────────┬──────────────────────────┘
               │ YES
               ▼
        Intent: "lineage"
        Route: "graph" (use graph query)
        Confidence: 95%

┌─────────────────────────────────────────┐
│ Is it asking for "most common"?         │
│ Pattern: "most common X", "top X"       │
└──────────────┬──────────────────────────┘
               │ YES
               ▼
        Intent: "most_common"
        Route: "graph"
        Confidence: 90%

┌─────────────────────────────────────────┐
│ Is it asking "how many"?                │
│ Pattern: "how many papers..."           │
└──────────────┬──────────────────────────┘
               │ YES
               ▼
        Intent: "count"
        Route: "fts" (full-text search)
        Confidence: 85%

┌─────────────────────────────────────────┐
│ None of the above match?                │
└──────────────┬──────────────────────────┘
               │ YES
               ▼
        Intent: "nl2sql" (let AI figure it out)
        Route: "nl2sql"
        Confidence: 70%
```

**For our example:** `"Which papers improve on Gaussian Splatting?"`

- ✅ Matches pattern: "improves on X"
- **Intent detected:** `lineage` (finding papers that improve on a method)
- **Route chosen:** `graph` (use graph-based query templates)
- **Parameters extracted:** `target_method: "Gaussian Splatting"`
- **Confidence:** 95%

**Output:** The router returns:
```javascript
{
  intent: "lineage",
  route: "graph",
  confidence: 0.95,
  parameters: {
    target_method: "Gaussian Splatting"
  }
}
```

---

### Step 3: Build Query Plan (Query Executors)

**File:** `src/queries/queryExecutors.ts`  
**Function:** `executeGraphQuery()`, `executeFTSQuery()`, or `executeNL2SQLQuery()`

**What happens:**

Based on the route chosen, the system goes to the appropriate executor:

#### Route: "graph" (Template-Based)

**For "lineage" intent:**

The executor looks at the intent and builds a pre-written SQL template:

```sql
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
WHERE e.canonical_name ILIKE '%Gaussian Splatting%'
  AND e.entity_type = 'method'
  AND r.relationship_type IN ('improves', 'extends', 'enhances')
ORDER BY p.published_date DESC, r.confidence_score DESC
LIMIT 20
```

**How it works:**
- Takes the `target_method` from parameters: "Gaussian Splatting"
- Inserts it into the template: `%Gaussian Splatting%`
- This template is optimized and tested - very fast!

#### Route: "fts" (Full-Text Search)

**For "count" or "focus" intent:**

Uses PostgreSQL full-text search to find papers matching keywords.

```sql
SELECT p.*, 
       ts_rank(to_tsvector('english', p.title || ' ' || p.abstract), query) as rank
FROM papers p,
     to_tsquery('english', 'gaussian') query
WHERE to_tsvector('english', p.title || ' ' || p.abstract) @@ query
ORDER BY rank DESC
LIMIT 20
```

#### Route: "nl2sql" (AI-Powered SQL Generation)

**For complex questions that don't match templates:**

The system asks an AI (Llama-3.1-8B) to generate SQL:

1. **Analyze the question:**
   ```
   Question: "What are the most common methods?"
   
   AI Analysis:
   {
     "intent": "aggregate",
     "entity_type": "entities",
     "fields_needed": ["method"],
     "aggregations": ["COUNT"],
     "sorting": {"field": "COUNT(method)", "direction": "DESC"}
   }
   ```

2. **Generate SQL:**
   ```
   AI Prompt: "Generate SQL for: What are the most common methods?"
   
   AI Response:
   SELECT 
     e.name,
     COUNT(DISTINCT pe.paper_id) as paper_count
   FROM entities e
   JOIN paper_entities pe ON e.id = pe.entity_id
   WHERE e.entity_type = 'method'
   GROUP BY e.id, e.name
   ORDER BY paper_count DESC
   LIMIT 10
   ```

3. **Extract parameters:**
   - Looks for numbers: "5 methods" → limit = 5
   - Looks for entity names: "Gaussian Splatting" → normalize to "gaussian splatting"

---

### Step 4: Validate & Sanitize SQL

**File:** `src/queries/sqlValidator.ts`  
**Function:** `validateAndSanitizeSQL(sql)`

**What happens:**

Before executing any SQL, the system checks:

#### Security Checks (Critical!)

```
❌ BLOCKED: INSERT, UPDATE, DELETE
✅ ALLOWED: SELECT only (read-only mode)

❌ BLOCKED: DROP TABLE, DROP DATABASE
✅ ALLOWED: SELECT queries

❌ BLOCKED: GRANT, REVOKE, ALTER
✅ ALLOWED: Reading data only
```

**Why?** You should never be able to delete or modify data through queries!

#### Syntax Checks

- Are all table names valid? (`papers`, `entities`, `relationships`)
- Are column names correct?
- Are JOINs properly formatted?
- Does the query make sense?

#### Parameter Validation

- If SQL has `$1`, `$2` placeholders → Are there enough parameters?
- Example: `WHERE id = $1` needs exactly 1 parameter
- Example: `WHERE name = $1 AND type = $2` needs exactly 2 parameters

**If validation fails:** The system either:
1. Tries to fix the SQL automatically
2. Falls back to a simpler query
3. Returns an error (better than breaking!)

---

### Step 5: Execute Query

**File:** `src/database/client.ts`  
**Function:** `db.query(sql, params)`

**What happens:**

```javascript
// Example execution
const results = await db.query(
  "SELECT ... WHERE method ILIKE $1",
  ["%Gaussian Splatting%"]
);
```

**Behind the scenes:**

1. **Connection:** Gets a database connection from the pool
2. **Prepare:** PostgreSQL prepares the query with parameters
3. **Execute:** Runs the query against the database
4. **Fetch:** Gets all matching rows
5. **Return:** Converts rows to JavaScript objects

**Example result:**
```javascript
[
  {
    id: 1,
    arxiv_id: "2511.09944",
    title: "TSPE-GS: Probabilistic Depth Extraction...",
    relationship_type: "extends",
    confidence_score: 0.90,
    ...
  },
  {
    id: 2,
    arxiv_id: "2511.09397",
    title: "OUGS: Active View Selection...",
    relationship_type: "extends",
    confidence_score: 0.90,
    ...
  },
  // ... more results
]
```

---

### Step 6: Format & Return Results

**File:** `src/queries/answerCard.ts`  
**Function:** `formatAnswerCard(question, results, metadata)`

**What happens:**

The system creates a nice, human-readable answer:

```
╔════════════════════════════════════════════════════════════════╗
║                    ANSWER CARD                                  ║
╚════════════════════════════════════════════════════════════════╝

📝 Question:
   "Which papers improve on Gaussian Splatting?"

🎯 Intent Detection:
   Intent: lineage
   Route: graph
   Confidence: 95.0%

⚙️  Execution:
   Route: graph
   Time: 15ms
   SQL: SELECT DISTINCT p.title, ...

📊 Results: 20 found

   1. TSPE-GS: Probabilistic Depth Extraction... (11/12/2025)
   2. OUGS: Active View Selection... (11/12/2025)
   ...
```

---

## 🔄 Complete Flow Example

Let's trace a real example from start to finish:

### Example: "What are the 5 least common methods?"

#### Step 1: Question Entered
```
Input: "What are the 5 least common methods?"
```

#### Step 2: Router Detection

**Router checks patterns:**

```javascript
// Pattern 1: Does it match "least common"?
/(?:what|which|find|show).*(?:least|bottom|rarely|uncommon).*(?:methods?)/i
✅ MATCH! "What are the 5 least common methods?"

// Extract entity type
entity_type = "method" (found "methods" in question)

// Extract limit
/\b(\d+)\s+(?:least|bottom)/i
✅ MATCH! "5 least common" → limit = 5

// Extract order
order = "ASC" (ascending = least common)
```

**Router returns:**
```javascript
{
  intent: "most_common",
  route: "graph",
  confidence: 0.90,
  parameters: {
    entity_type: "method",
    limit: 5,
    order: "ASC"
  }
}
```

#### Step 3: Query Executor

**Goes to `executeGraphQuery()`:**

```javascript
switch (routing.intent) {
  case "most_common":
    const entityType = "method";  // from parameters
    const limit = 5;              // from parameters
    const order = "ASC";          // from parameters
    
    sql = `
      SELECT 
        e.name,
        e.description,
        COUNT(DISTINCT pe.paper_id) as paper_count,
        AVG(pe.significance_score) as avg_significance
      FROM entities e
      JOIN paper_entities pe ON e.id = pe.entity_id
      WHERE e.entity_type = $1
      GROUP BY e.id, e.name, e.description
      ORDER BY paper_count ${order}, avg_significance ${order}
      LIMIT $2
    `;
    params = ["method", 5];
    break;
}
```

#### Step 4: Validation

**SQL Validator checks:**

```javascript
✅ No INSERT/UPDATE/DELETE (safe!)
✅ Only SELECT statements (read-only)
✅ Table names exist: entities, paper_entities ✅
✅ Column names valid: name, description, etc. ✅
✅ 2 placeholders ($1, $2) and 2 parameters ✅
✅ ORDER BY uses only ASC/DESC (safe, not user input directly)
```

**Result:** ✅ Query is safe and valid!

#### Step 5: Execution

**Database query runs:**

```sql
SELECT 
  e.name,
  e.description,
  COUNT(DISTINCT pe.paper_id) as paper_count,
  AVG(pe.significance_score) as avg_significance
FROM entities e
JOIN paper_entities pe ON e.id = pe.entity_id
WHERE e.entity_type = 'method'
GROUP BY e.id, e.name, e.description
ORDER BY paper_count ASC, avg_significance ASC
LIMIT 5
```

**Database returns:**
```javascript
[
  {
    name: "Reduction of view-dependent appearance parameters",
    paper_count: 1,
    avg_significance: 0.49
  },
  {
    name: "Quantization of per-Gaussian attributes",
    paper_count: 1,
    avg_significance: 0.52
  },
  // ... 3 more results
]
```

#### Step 6: Format Results

**Answer Card created:**

```
📝 Question: "What are the 5 least common methods?"

🎯 Intent: most_common
Route: graph
Confidence: 90.0%

📊 Results: 5 found

1. Reduction of view-dependent appearance parameters
2. Quantization of per-Gaussian attributes
3. Savant et al.
4. F2NeRF
5. InstantNGP
```

---

## 🛡️ Safety & Fallbacks

### What if something goes wrong?

The system has multiple safety nets:

#### 1. Template Query Fails

```
Graph query fails → Fallback to NL→SQL
NL→SQL fails → Return empty result with error message
```

#### 2. SQL Generation Fails

```
LLM doesn't return SQL → Try pattern matching
Pattern matching fails → Return helpful error
```

#### 3. Database Error

```
Connection error → Retry once
SQL error → Try to fix the SQL automatically
Still fails → Return error message
```

#### 4. Invalid SQL

```
Detects dangerous SQL → Blocks it immediately
Detects syntax error → Tries to fix it
Can't fix → Returns validation error
```

---

## 📊 Three Routing Strategies Compared

### Strategy 1: Graph Templates (Fastest, Most Accurate)

**When used:** Clear patterns like "improves on X", "most common X"

**How it works:**
- Pre-written SQL templates
- Just fill in parameters
- Very fast (~10-20ms)
- 95%+ accuracy

**Example:**
```
Question: "Which papers improve on 3DGS?"
→ Template SQL with "3DGS" filled in
→ Result in 15ms
```

### Strategy 2: Full-Text Search (Good for Keywords)

**When used:** "papers about X", "how many papers mention Y"

**How it works:**
- PostgreSQL full-text search
- Ranks results by relevance
- Good for finding papers by topic
- Fast (~20-50ms)

**Example:**
```
Question: "How many papers focus on rendering?"
→ Full-text search on title/abstract
→ Count matching papers
→ Result in 30ms
```

### Strategy 3: NL→SQL (Most Flexible)

**When used:** Complex questions that don't match patterns

**How it works:**
- AI (Llama) analyzes question
- AI generates SQL query
- More flexible but slower
- ~2-3 seconds

**Example:**
```
Question: "What's the average confidence score for relationships involving NeRF?"
→ AI analyzes: needs AVG(), JOIN relationships, WHERE entity = NeRF
→ AI generates SQL
→ Result in 2500ms
```

---

## 🎓 Key Concepts Explained Simply

### What is "Intent Detection"?

**Think of it like:** A receptionist at a hotel desk.

When you ask "Where's the pool?", they immediately know you want directions, not to check in.

The router does the same:
- "improves on X" → You want to find related papers
- "most common X" → You want a ranked list
- "how many" → You want a count

### What is "Route"?

**Think of it like:** Different types of restaurants.

- **Graph route** = Fast food (pre-made templates, instant)
- **FTS route** = Buffet (keyword matching, flexible)
- **NL→SQL route** = Fine dining (AI cooks custom meal, takes longer)

Each "route" is optimized for different types of questions.

### What is "Parameter Extraction"?

**Think of it like:** Filling out a form.

Question: "Which papers improve on **Gaussian Splatting**?"

The system extracts:
- **What entity?** → "Gaussian Splatting"
- **What type?** → "method" (inferred)
- **What relationship?** → "improves" (inferred)

These become parameters in the SQL query.

### What is "SQL Sanitization"?

**Think of it like:** Airport security.

Before SQL runs, it's checked:
- ✅ Is it only reading data? (not deleting/modifying)
- ✅ Are all the commands safe?
- ✅ Does it match the expected format?

**Why?** To prevent "SQL injection" attacks where someone could delete your data!

---

## 🧩 Putting It All Together

### Visual Flow Diagram

```
You Type Question
       │
       ▼
┌──────────────────────┐
│   Router Analyzes    │  ← Pattern matching
│   "What's the intent?"│
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Choose Strategy    │  ← Graph / FTS / NL→SQL
│   "Which route?"     │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Build SQL Query    │  ← Template or AI generates
│   "What SQL do I need?"│
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Validate SQL       │  ← Security & syntax checks
│   "Is it safe?"      │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Execute Query      │  ← Run on database
│   "Get results!"     │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Format Results     │  ← Create answer card
│   "Show nicely!"     │
└──────────┬───────────┘
           │
           ▼
    Answer Displayed!
```

---

## 💡 Why This Design?

### Why Pattern Matching First?

**Speed!** Templates are instant (~10ms), while AI takes ~2 seconds.

**Accuracy!** Templates are tested and reliable.

### Why Fallback to AI?

**Flexibility!** Users can ask anything, even if it doesn't match a pattern.

### Why Validate SQL?

**Security!** Never trust user input or AI-generated code without checking.

---

## 🎯 Summary for Beginners

**In simple terms:**

1. **You ask:** "Which papers improve on Gaussian?"
2. **Router thinks:** "This is asking about improvements → use graph template"
3. **System builds:** SQL query with "Gaussian" filled in
4. **System checks:** "Is this SQL safe? Yes ✅"
5. **System runs:** Query on database
6. **System formats:** Results in a nice card
7. **You see:** List of papers!

**The whole process takes:**
- Template route: ~10-50ms (blink of an eye)
- AI route: ~2-3 seconds (still fast!)

---

## 🔍 Want to See It In Action?

Run the system in dev mode to see all the steps:

```bash
npm run ask
```

This shows you:
- Intent detection
- Route chosen
- SQL generated
- Results found
- Time taken

**Example output:**
```
🔍 Step 1: Detecting intent and routing...
   Intent: lineage
   Route: graph
   Confidence: 95.0%
   Parameters: { target_method: "gaussian" }

🔗 Step 2-4: Executing graph query...
   SQL: SELECT DISTINCT p.title, ...
   ✅ Query executed successfully, returned 20 results

📊 Results: 20 found
   1. TSPE-GS: Probabilistic Depth Extraction...
   ...
```

---

**I hope this helps you understand how the agent workflow operates!** 🤖✨


