import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { KruschVerificationContract } from '../../src/verify/contract.js';

test('Verification Contract: checkPathContracts enforces required and forbidden paths', () => {
  const contract = {
    requiredPaths: ['src/math.js'],
    forbiddenPaths: ['package.json', 'db/schema.sql']
  };

  // 1. Missing required path fails
  const missingReq = KruschVerificationContract.checkPathContracts(contract, [
    { filePath: 'src/other.js' }
  ]);
  assert.strictEqual(missingReq.valid, false);
  assert.ok(missingReq.error.includes("Required path 'src/math.js' was not modified"));

  // 2. Modifying forbidden path fails
  const forbiddenTouched = KruschVerificationContract.checkPathContracts(contract, [
    { filePath: 'src/math.js' },
    { filePath: 'package.json' }
  ]);
  assert.strictEqual(forbiddenTouched.valid, false);
  assert.ok(forbiddenTouched.error.includes("Forbidden path 'package.json' was modified"));

  // 3. Compliant modifications pass
  const compliant = KruschVerificationContract.checkPathContracts(contract, [
    { filePath: 'src/math.js' },
    { filePath: 'src/utils.js' }
  ]);
  assert.strictEqual(compliant.valid, true);
});

test('Verification Contract: runInStagedTree executes tests on staged tree without touching working tree', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-verify-contract-'));
  const targetFile = path.join(testDir, 'index.js');
  const originalContent = 'module.exports = { value: 10 };\n';
  fs.writeFileSync(targetFile, originalContent, 'utf-8');

  // Staged diff modifies value to 42
  const stagedDiffs = [
    {
      filePath: 'index.js',
      content: 'module.exports = { value: 42 };\n'
    }
  ];

  // Test command verifies value === 42 in the staged tree
  const verifyCmd = `node -e "const m = require('./index.js'); if (m.value !== 42) process.exit(1); console.log('OK');"`;

  const result = await KruschVerificationContract.runInStagedTree(testDir, stagedDiffs, {
    command: verifyCmd,
    sandbox: true
  });

  assert.strictEqual(result.passed, true);
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stagedTreeExecuted, true);

  // CRITICAL INVARIANT: Physical working tree file must remain 100% UNTOUCHED
  const diskContentAfter = fs.readFileSync(targetFile, 'utf-8');
  assert.strictEqual(diskContentAfter, originalContent, 'Physical working tree on disk was mutated during verification!');

  fs.rmSync(testDir, { recursive: true, force: true });
});
