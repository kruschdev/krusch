import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pool, query } from '../../src/brain/pool.js';
import { KruschContextClient } from '../../src/brain/context-client.js';
import { KruschSymbolIndexer } from '../../src/brain/indexer.js';

test('Invariant Test (c): KruschContextClient reads native memories from krusch_memories table', async () => {
  const testProject = `/tmp/test-project-${Date.now()}`;
  const testContent = `Episodic decision ${Date.now()}: Invariants enforced in PostgreSQL substrate`;

  // 1. Write native memory directly using KruschContextClient.recordMemory
  const recorded = await KruschContextClient.recordMemory({
    projectPath: testProject,
    category: 'architecture',
    content: testContent,
    tags: ['substrate', 'invariants', 'fsm']
  });

  assert.ok(recorded, 'Memory record must be inserted');
  assert.ok(recorded.id, 'Memory record must have ID');
  assert.strictEqual(recorded.content, testContent);

  // 2. Read back memories via KruschContextClient.getRecentMemories
  const memories = await KruschContextClient.getRecentMemories(10);
  assert.ok(Array.isArray(memories), 'Memories must be an array');
  const found = memories.find(m => m.content === testContent);
  assert.ok(found, 'Recorded native memory must be retrieved from krusch_memories');
  assert.strictEqual(found.category, 'architecture');

  // 3. Verify assembleContext incorporates the memory into prompt block
  const ctx = await KruschContextClient.assembleContext(testProject, 'invariants', { indexSymbols: false });
  assert.ok(ctx.memories.length > 0);
  const prompt = KruschContextClient.formatContextPrompt(ctx);
  assert.ok(prompt.includes('Relevant Prior Context & Decisions'));
  assert.ok(prompt.includes(testContent));
});

test('Context & Indexer: KruschSymbolIndexer indexes workspace and searchCodeSymbols discovers native rows', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-index-test-'));
  const srcDir = path.join(tempDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  const sampleFile = path.join(srcDir, 'finance.js');
  fs.writeFileSync(
    sampleFile,
    `export function computeCompoundInterest(principal, rate, years) {\n  return principal * Math.pow(1 + rate, years);\n}\n\nexport class LedgerManager {\n  constructor() {}\n}\n`,
    'utf-8'
  );

  // 1. Index project into krusch_code_symbols
  const indexResult = await KruschSymbolIndexer.indexProject(tempDir);
  assert.ok(indexResult.symbolsIndexed >= 2, 'Must index both function and class symbols');

  // 2. Query symbols via KruschContextClient
  const foundFunc = await KruschContextClient.searchCodeSymbols('computeCompoundInterest', 5);
  assert.ok(foundFunc.length > 0, 'Must discover computeCompoundInterest in krusch_code_symbols');
  assert.strictEqual(foundFunc[0].symbol_name, 'computeCompoundInterest');
  assert.strictEqual(foundFunc[0].symbol_type, 'function');

  const foundClass = await KruschContextClient.searchCodeSymbols('LedgerManager', 5);
  assert.ok(foundClass.length > 0, 'Must discover LedgerManager in krusch_code_symbols');
  assert.strictEqual(foundClass[0].symbol_name, 'LedgerManager');
  assert.strictEqual(foundClass[0].symbol_type, 'class');

  // Cleanup temp files
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test.after(async () => {
  await pool.end();
});
