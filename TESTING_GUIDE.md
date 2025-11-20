# Manual Testing Guide

This guide walks you through testing the Knowledge Graph system step-by-step.

---

## 📋 Prerequisites

Before testing, ensure you have:

1. **Node.js 18+** installed
2. **PostgreSQL 14+** installed and running
3. **Hugging Face API Key** (get from https://huggingface.co/settings/tokens)
4. **Dependencies installed** (`npm install`)

---

## 🚀 Step-by-Step Testing

### Step 1: Install Dependencies

```bash
npm install
```

**Expected Output:**
- Should install all packages without errors
- Creates `node_modules/` folder

---

### Step 2: Set Up Database

#### 2.1 Create Database

```bash
# Option 1: Using createdb
createdb gaussian_splatting_db

# Option 2: Using psql
psql -U postgres -c "CREATE DATABASE gaussian_splatting_db;"
```

**Expected Output:**
- Database created successfully (or "database already exists" - that's fine)

#### 2.2 Run Schema

```bash
# Using psql
psql -U postgres -d gaussian_splatting_db -f src/database/schema.sql

# Or using the npm script (if you have psql configured)
npm run setup-db
```

**Expected Output:**
```
CREATE TABLE
CREATE TABLE
CREATE TABLE
CREATE TABLE
CREATE INDEX
CREATE INDEX
... (more indexes)
```

**Verify tables were created:**
```bash
psql -U postgres -d gaussian_splatting_db -c "\dt"
```

**Expected:** Should see 4 tables:
- `papers`
- `entities`
- `relationships`
- `paper_entities`

---

### Step 3: Configure Environment Variables

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Database Configuration
DATABASE_URL=postgresql://username:password@localhost:5432/gaussian_splatting_db

# Hugging Face API (required)
HUGGINGFACE_API_KEY=your_huggingface_api_key_here

# arXiv Configuration (optional)
ARXIV_MAX_RESULTS=50
ARXIV_QUERY=cat:cs.CV AND all:"gaussian splatting"

# Ingestion Mode (optional)
INGEST_MODE=seed_citations

# Processing Configuration (optional)
BATCH_SIZE=10
MAX_CONCURRENT_PROCESSING=5
```

**Replace:**
- `username:password` with your PostgreSQL credentials
- `your_huggingface_api_key_here` with your actual Hugging Face API key

---

### Step 4: Verify Setup

Run the comprehensive verification script:

```bash
npm run verify
```

**Expected Output:**
```
✅ Environment Variables: PASS
   - DATABASE_URL: Set
   - HUGGINGFACE_API_KEY: Set

✅ Database Connection: PASS
   - Connected successfully

✅ Database Schema: PASS
   - Table 'papers' exists
   - Table 'entities' exists
   - Table 'relationships' exists
   - Table 'paper_entities' exists

✅ Indexes: PASS
   - All indexes created

✅ Hugging Face API: PASS
   - API accessible
   - Model available

✅ Dependencies: PASS
   - All packages installed

✅ TypeScript Compilation: PASS
   - No compilation errors

✅ All checks passed!
```

**If any check fails:**
- Fix the issue (database connection, missing env vars, etc.)
- Re-run `npm run verify` until all pass

---

### Step 5: Test LLM API (Optional but Recommended)

Test if Hugging Face API is working:

```bash
npm run test-llama
```

**Expected Output:**
```
🤖 Testing Hugging Face LLM API...

✅ API Response received:
{
  "generated_text": "...some text response..."
}

✅ LLM API is working!
```

**If this fails:**
- Check your `HUGGINGFACE_API_KEY` is correct
- Verify you have API access on Hugging Face
- Check your internet connection

---

### Step 6: Test Entity Extraction (Optional)

Test if entity extraction works on a sample text:

```bash
npm run test-entity-extraction
```

**Expected Output:**
```
🧪 Testing Entity Extraction...

✅ Extracted 5 entities:
  1. 3D Gaussian Splatting (method, confidence: 0.92)
  2. NeRF (method, confidence: 0.88)
  ...

✅ Entity extraction is working!
```

---

### Step 7: Test Relationship Extraction (Optional)

Test if relationship extraction works:

```bash
npm run test-relationship-extraction
```

**Expected Output:**
```
🧪 Testing Relationship Extraction...

✅ Extracted 3 relationships:
  1. Paper --[improves]--> 3D Gaussian Splatting
  2. Paper --[uses]--> NeRF
  ...

✅ Relationship extraction is working!
```

---

### Step 8: End-to-End Pipeline Test (Recommended)

Test the complete pipeline with ONE paper:

```bash
npm run test:pipeline
```

**What this does:**
- Fetches paper arXiv:2308.04079 (3D Gaussian Splatting)
- Downloads PDF
- Extracts entities
- Extracts relationships
- Stores in database
- Prints detailed results

**Expected Output:**
```
🧪 Testing Complete Pipeline...

=== Fetching Test Paper ===
✅ Fetched: 3D Gaussian Splatting for Real-Time Radiance Field Rendering

=== Extracting Entities ===
✅ Extracted 12 entities:
  - 3D Gaussian Splatting (method)
  - NeRF (method)
  ...

=== Extracting Relationships ===
✅ Extracted 8 relationships:
  - Paper --[improves]--> NeRF
  ...

=== Database Insertion ===
✅ Paper inserted: ID 1
✅ Entities inserted: 12
✅ Relationships inserted: 8

=== Verification ===
✅ Database contains:
  - 1 paper
  - 12 entities
  - 8 relationships

✅ Pipeline test PASSED!
```

**Time:** Takes ~30-60 seconds (depends on API speed)

**If this passes:** Your system is working! 🎉

---

### Step 9: Process Small Corpus (Recommended)

Process 5 papers to test batch processing:

```bash
npm run process:test
```

**What this does:**
- Processes 5 papers (seed + 4 citations)
- Extracts entities and relationships for each
- Stores everything in database
- Shows progress for each paper

**Expected Output:**
```
🚀 Processing Corpus (5 papers)...

=== Processing paper 1: 3D Gaussian Splatting ===
  ✓ Extracted 12 entities
  ✓ Extracted 8 relationships
  ✓ Paper processed successfully

=== Processing paper 2: Instant Neural Graphics Primitives ===
  ✓ Extracted 9 entities
  ✓ Extracted 6 relationships
  ✓ Paper processed successfully

...

✅ Processing complete!
Total Papers: 5
Total Entities: 47
Total Relationships: 32
```

**Time:** Takes ~3-5 minutes for 5 papers

**If this passes:** Your system can handle batch processing! 🎉

---

### Step 10: Test Query System

#### 10.1 Run Example Queries

```bash
npm run demo:queries
```

**What this does:**
- Runs 5 example queries:
  1. Papers improving on 3D Gaussian Splatting
  2. Most popular methods
  3. Common evaluation datasets
  4. Research trends over time
  5. Papers with most novel contributions

**Expected Output:**
```
📊 Running Example Queries...

Query 1: Papers improving on 3D Gaussian Splatting
✅ Found 3 results:
  1. Paper Title (arXiv ID)
  2. ...

Query 2: Most popular methods
✅ Found 10 results:
  1. 3D Gaussian Splatting (41 papers)
  2. NeRF (33 papers)
  ...

...
```

**If this passes:** Query system is working! 🎉

#### 10.2 Test Natural Language Query

Ask a question interactively:

```bash
npm run ask "Which papers improve on Gaussian Splatting?"
```

**Expected Output:**
```
📝 Question: "Which papers improve on Gaussian Splatting?"

🎯 Intent: lineage
Route: graph
Confidence: 95.0%

📊 Results: 3 found

1. Paper Title (Published Date)
2. ...
```

**Try more questions:**
```bash
npm run ask "What are the most common methods?"
npm run ask "Which papers use the DTU dataset?"
npm run ask "How many papers are in the database?"
```

---

### Step 11: Validate Data Quality

Check data quality metrics:

```bash
npm run validate:data
```

**Expected Output:**
```
📊 Data Quality Validation Report

=== Database Statistics ===
Total Papers: 5
Total Entities: 47
Total Relationships: 32

=== Data Quality Metrics ===
✅ Average entity confidence: 0.91
✅ Average relationship confidence: 0.87
✅ No orphaned entities found
✅ No missing relationships found

✅ Data quality checks PASSED!
```

---

### Step 12: Run Performance Benchmark (Optional)

```bash
npm run benchmark
```

**Expected Output:**
```
⏱️  Performance Benchmark (5 papers)

Average Processing Time: 45.2 seconds/paper
  - Entity Extraction: 18.3s
  - Relationship Extraction: 16.8s
  - PDF Download: 0.8s
  - Database Insertion: 4.2s

✅ Benchmark complete!
```

---

## 🧪 Quick Test Checklist

Use this checklist to verify everything works:

- [ ] `npm install` - Dependencies installed
- [ ] Database created and schema applied
- [ ] `.env` file configured with credentials
- [ ] `npm run verify` - All checks pass
- [ ] `npm run test:pipeline` - Single paper processes successfully
- [ ] `npm run process:test` - Batch processing works
- [ ] `npm run demo:queries` - Example queries return results
- [ ] `npm run ask "..."` - Natural language queries work

---

## 🐛 Troubleshooting

### Issue: "Cannot connect to database"

**Solution:**
1. Check PostgreSQL is running: `pg_isready`
2. Verify `DATABASE_URL` in `.env` is correct
3. Check database exists: `psql -U postgres -l | grep gaussian_splatting_db`

### Issue: "Hugging Face API error"

**Solution:**
1. Verify `HUGGINGFACE_API_KEY` is set in `.env`
2. Test API manually: `npm run test-llama`
3. Check you have API access on Hugging Face website

### Issue: "No papers found"

**Solution:**
1. Run `npm run test:pipeline` to process at least one paper first
2. Check database: `psql -U postgres -d gaussian_splatting_db -c "SELECT COUNT(*) FROM papers;"`

### Issue: "TypeScript compilation errors"

**Solution:**
1. Check Node.js version: `node --version` (should be 18+)
2. Reinstall dependencies: `rm -rf node_modules package-lock.json && npm install`
3. Check TypeScript: `npx tsc --version`

### Issue: "Module not found"

**Solution:**
1. Run `npm install` again
2. Check `node_modules/` exists
3. Verify `package.json` dependencies are correct

---

## ✅ Success Criteria

Your system is working correctly if:

1. ✅ `npm run verify` passes all checks
2. ✅ `npm run test:pipeline` processes one paper successfully
3. ✅ `npm run process:test` processes 5 papers successfully
4. ✅ `npm run demo:queries` returns results for all 5 example queries
5. ✅ `npm run ask` can answer natural language questions
6. ✅ Database contains papers, entities, and relationships
7. ✅ Data quality validation shows good metrics (confidence > 0.8)

---

## 🎯 Full Pipeline Test (Optional)

Once everything works, test processing a larger corpus:

```bash
# Process 50 papers (default)
npm run process

# Process 100 papers
npm run process:full
```

**Note:** This takes 30-60 minutes depending on API speed.

---

## 📊 Verify Database Contents

Manually check the database:

```bash
# Connect to database
psql -U postgres -d gaussian_splatting_db

# Check counts
SELECT COUNT(*) FROM papers;
SELECT COUNT(*) FROM entities;
SELECT COUNT(*) FROM relationships;

# View sample data
SELECT title, arxiv_id FROM papers LIMIT 5;
SELECT name, entity_type FROM entities LIMIT 10;
SELECT relationship_type, COUNT(*) FROM relationships GROUP BY relationship_type;

# Exit
\q
```

---

## 🎉 Next Steps

Once testing is complete:

1. Process your full corpus: `npm run process`
2. Run data validation: `npm run validate:data`
3. Explore queries: `npm run ask "your question"`
4. Check documentation in `README.md` and `DOCUMENTATION.md`

---

**Good luck with testing!** 🚀

