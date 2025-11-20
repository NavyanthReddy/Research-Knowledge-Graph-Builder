#!/usr/bin/env ts-node
/**
 * Setup Verification Script
 * Comprehensive verification of environment, database, and API connectivity
 */

import * as dotenv from 'dotenv';
import { Pool } from 'pg';
import { HfInference } from '@huggingface/inference';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

interface VerificationResult {
  name: string;
  status: 'pass' | 'fail' | 'warning';
  message: string;
  details?: any;
}

const results: VerificationResult[] = [];

function addResult(name: string, status: 'pass' | 'fail' | 'warning', message: string, details?: any) {
  results.push({ name, status, message, details });
}

async function checkEnvironmentVariables(): Promise<void> {
  console.log('\n📋 Checking Environment Variables...\n');

  const requiredVars = [
    'DATABASE_URL',
    'HUGGINGFACE_API_KEY',
  ];

  const optionalVars = [
    'ARXIV_MAX_RESULTS',
    'ARXIV_QUERY',
    'INGEST_MODE',
    'BATCH_SIZE',
  ];

  // Check required variables
  for (const varName of requiredVars) {
    const value = process.env[varName];
    if (!value) {
      addResult(
        `Required: ${varName}`,
        'fail',
        'Missing required environment variable'
      );
    } else if (varName === 'DATABASE_URL') {
      // Validate DATABASE_URL format
      try {
        const url = new URL(value);
        if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
          addResult(
            `Required: ${varName}`,
            'warning',
            'DATABASE_URL should use postgresql:// or postgres:// protocol',
            { protocol: url.protocol }
          );
        } else {
          addResult(
            `Required: ${varName}`,
            'pass',
            `Set (${url.hostname}:${url.port || '5432'})`
          );
        }
      } catch (e) {
        addResult(
          `Required: ${varName}`,
          'fail',
          'Invalid DATABASE_URL format (must be a valid URL)'
        );
      }
    } else if (varName === 'HUGGINGFACE_API_KEY') {
      // Check if it looks like a valid API key (starts with hf_ or is 32+ chars)
      if (value.startsWith('hf_') || value.length >= 32) {
        addResult(
          `Required: ${varName}`,
          'pass',
          `Set (${value.substring(0, 10)}...)`
        );
      } else {
        addResult(
          `Required: ${varName}`,
          'warning',
          'Set but may not be valid (should start with "hf_" or be 32+ characters)'
        );
      }
    } else {
      addResult(
        `Required: ${varName}`,
        'pass',
        'Set'
      );
    }
  }

  // Check optional variables
  for (const varName of optionalVars) {
    const value = process.env[varName];
    if (value) {
      addResult(
        `Optional: ${varName}`,
        'pass',
        `Set to: ${value}`
      );
    } else {
      addResult(
        `Optional: ${varName}`,
        'warning',
        'Not set (using default value)'
      );
    }
  }
}

async function checkDatabaseConnection(): Promise<void> {
  console.log('\n🗄️  Checking Database Connection...\n');

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    addResult(
      'Database Connection',
      'fail',
      'Cannot check - DATABASE_URL not set'
    );
    return;
  }

  let pool: Pool | null = null;

  try {
    pool = new Pool({
      connectionString: dbUrl,
      connectionTimeoutMillis: 5000,
    });

    // Test connection
    const client = await pool.connect();
    addResult(
      'Database Connection',
      'pass',
      'Successfully connected to PostgreSQL'
    );

    // Check PostgreSQL version
    const versionResult = await client.query('SELECT version()');
    const version = versionResult.rows[0].version;
    addResult(
      'PostgreSQL Version',
      'pass',
      version.split(',')[0] // Just the PostgreSQL version line
    );

    // Check required tables
    const requiredTables = ['papers', 'entities', 'relationships', 'paper_entities'];
    const tableCheck = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    const existingTables = tableCheck.rows.map(r => r.table_name);

    for (const table of requiredTables) {
      if (existingTables.includes(table)) {
        // Get row count
        const countResult = await client.query(`SELECT COUNT(*) as count FROM ${table}`);
        const count = parseInt(countResult.rows[0].count);
        addResult(
          `Table: ${table}`,
          'pass',
          `Exists (${count} rows)`,
          { count }
        );
      } else {
        addResult(
          `Table: ${table}`,
          'fail',
          'Table does not exist. Run schema.sql to create it.'
        );
      }
    }

    // Check indexes
    const indexCheck = await client.query(`
      SELECT indexname, tablename 
      FROM pg_indexes 
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname
    `);
    const indexCount = indexCheck.rows.length;
    addResult(
      'Database Indexes',
      'pass',
      `${indexCount} indexes found on ${new Set(indexCheck.rows.map(r => r.tablename)).size} tables`
    );

    client.release();
  } catch (error: any) {
    addResult(
      'Database Connection',
      'fail',
      `Failed to connect: ${error.message}`,
      { error: error.message }
    );
  } finally {
    if (pool) {
      await pool.end();
    }
  }
}

async function checkHuggingFaceAPI(): Promise<void> {
  console.log('\n🤖 Checking Hugging Face API...\n');

  const apiKey = process.env.HUGGINGFACE_API_KEY;
  if (!apiKey) {
    addResult(
      'Hugging Face API Key',
      'fail',
      'HUGGINGFACE_API_KEY not set'
    );
    return;
  }

  try {
    const hf = new HfInference(apiKey);
    const model = 'meta-llama/Llama-3.1-8B-Instruct';

    // Test API with a simple prompt
    addResult(
      'Hugging Face API Key',
      'pass',
      `Set (${apiKey.substring(0, 10)}...)`
    );

    console.log('  Testing API connectivity...');
    const startTime = Date.now();
    const response = await hf.chatCompletion({
      model: model,
      messages: [
        { role: 'user', content: 'Say "API test successful" and nothing else.' }
      ],
      max_tokens: 10,
    });

    const elapsed = Date.now() - startTime;

    if (response.choices && response.choices.length > 0) {
      const content = response.choices[0].message.content || '';
      if (content.toLowerCase().includes('successful')) {
        addResult(
          'Hugging Face API Connectivity',
          'pass',
          `API responding correctly (${elapsed}ms)`,
          { response_time_ms: elapsed }
        );
      } else {
        addResult(
          'Hugging Face API Connectivity',
          'warning',
          `API responded but unexpected content: ${content.substring(0, 50)}`
        );
      }
    } else {
      addResult(
        'Hugging Face API Connectivity',
        'warning',
        'API responded but no choices in response'
      );
    }

    // Check model availability
    addResult(
      'Model: meta-llama/Llama-3.1-8B-Instruct',
      'pass',
      'Model is accessible via API'
    );

  } catch (error: any) {
    if (error.status === 401) {
      addResult(
        'Hugging Face API Authentication',
        'fail',
        'Invalid API key (401 Unauthorized)'
      );
    } else if (error.status === 429) {
      addResult(
        'Hugging Face API Rate Limit',
        'warning',
        'Rate limit reached (429). API is working but temporarily throttled.'
      );
    } else {
      addResult(
        'Hugging Face API Connectivity',
        'fail',
        `API error: ${error.message}`,
        { error: error.message, status: error.status }
      );
    }
  }
}

async function checkDependencies(): Promise<void> {
  console.log('\n📦 Checking Dependencies...\n');

  try {
    // Check package.json exists
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      addResult(
        'package.json',
        'pass',
        `Found (version: ${packageJson.version || 'N/A'})`
      );

      // Check critical dependencies
      const criticalDeps = [
        '@huggingface/inference',
        'pg',
        'pdf-parse',
        'dotenv',
      ];

      for (const dep of criticalDeps) {
        try {
          require.resolve(dep);
          addResult(
            `Dependency: ${dep}`,
            'pass',
            'Installed'
          );
        } catch (e) {
          addResult(
            `Dependency: ${dep}`,
            'fail',
            'Not installed. Run: npm install'
          );
        }
      }
    } else {
      addResult(
        'package.json',
        'fail',
        'Not found in project root'
      );
    }

    // Check node_modules exists
    const nodeModulesPath = path.join(process.cwd(), 'node_modules');
    if (fs.existsSync(nodeModulesPath)) {
      addResult(
        'node_modules',
        'pass',
        'Directory exists'
      );
    } else {
      addResult(
        'node_modules',
        'fail',
        'Not found. Run: npm install'
      );
    }

    // Check TypeScript compilation
    try {
      const { execSync } = require('child_process');
      console.log('  Checking TypeScript compilation...');
      execSync('npx tsc --noEmit', { stdio: 'pipe', timeout: 30000 });
      addResult(
        'TypeScript Compilation',
        'pass',
        'No compilation errors'
      );
    } catch (e: any) {
      addResult(
        'TypeScript Compilation',
        'fail',
        `Compilation errors found. Run: npm run build`,
        { stderr: e.stderr?.toString().substring(0, 200) }
      );
    }

  } catch (error: any) {
    addResult(
      'Dependencies Check',
      'fail',
      `Error checking dependencies: ${error.message}`
    );
  }
}

function printResults(): void {
  console.log('\n' + '═'.repeat(70));
  console.log('📊 VERIFICATION RESULTS');
  console.log('═'.repeat(70) + '\n');

  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const warnings = results.filter(r => r.status === 'warning').length;

  for (const result of results) {
    const icon = result.status === 'pass' ? '✅' : result.status === 'fail' ? '❌' : '⚠️ ';
    console.log(`${icon} ${result.name}: ${result.message}`);
    if (result.details) {
      if (typeof result.details === 'object') {
        console.log(`   Details: ${JSON.stringify(result.details)}`);
      } else {
        console.log(`   Details: ${result.details}`);
      }
    }
  }

  console.log('\n' + '═'.repeat(70));
  console.log(`✅ Passed: ${passed} | ⚠️  Warnings: ${warnings} | ❌ Failed: ${failed}`);
  console.log('═'.repeat(70) + '\n');

  if (failed > 0) {
    console.log('❌ Some checks failed. Please fix the issues above before proceeding.\n');
    process.exit(1);
  } else if (warnings > 0) {
    console.log('⚠️  Some warnings were found. Review them above, but you can proceed.\n');
    process.exit(0);
  } else {
    console.log('✅ All checks passed! System is ready to use.\n');
    process.exit(0);
  }
}

async function main() {
  console.log('🔍 Verifying System Setup');
  console.log('═'.repeat(70));

  await checkEnvironmentVariables();
  await checkDatabaseConnection();
  await checkHuggingFaceAPI();
  await checkDependencies();

  printResults();
}

if (require.main === module) {
  main().catch((error) => {
    console.error('\n❌ Verification script error:', error);
    process.exit(1);
  });
}

