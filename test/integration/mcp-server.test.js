import test from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { createMcpServer } from '../../src/server/mcp-server.js';
import { KruschStateManager } from '../../src/brain/state-manager.js';
import { HARNESS_PHASES } from '../../src/workflow/fsm.js';
import { pool } from '../../src/brain/pool.js';

test('Integration: MCP Harness lifecycle end-to-end', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-mcp-test-'));
  const testFile = path.join(testDir, 'index.js');
  fs.writeFileSync(testFile, 'export function greet() { return "hello"; }\n', 'utf-8');

  const taskId = `task_mcp_${Date.now()}`;

  // 1. Initialize Task synchronously as krusch_run does
  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Update greet function in index.js',
    projectPath: testDir,
    phase: HARNESS_PHASES.INIT
  });

  const taskBefore = await KruschStateManager.getTask(taskId);
  assert.strictEqual(taskBefore.id, taskId);
  assert.strictEqual(taskBefore.phase, HARNESS_PHASES.INIT);

  // 2. Stage a diff as a model would during IMPLEMENT
  const staged = await KruschStateManager.stageDiff(taskId, {
    filePath: 'index.js',
    projectPath: testDir,
    originalContent: 'export function greet() { return "hello"; }\n',
    stagedContent: 'export function greet() { return "hello world"; }\n',
    diffPatch: 'Update return value'
  });
  assert.strictEqual(staged.file_path, 'index.js');
  assert.strictEqual(staged.status, 'PENDING');

  // 3. Record verification run passing
  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'node -e "process.exit(0)"',
    exitCode: 0,
    passed: true,
    stdout: 'Tests passed',
    stderr: ''
  });

  // Transition through legal FSM phases
  await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.PLAN });
  await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.IMPLEMENT });
  await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.VERIFY });
  await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.APPROVAL_GATE });

  // 4. Test explain
  const explanation = await KruschStateManager.explainTaskStatus(taskId);
  assert.ok(explanation);
  assert.strictEqual(explanation.taskId, taskId);
  assert.strictEqual(explanation.phase, HARNESS_PHASES.APPROVAL_GATE);

  // 5. Test applyDiffBatch as krusch_apply_diff does
  const applyRes = await KruschStateManager.applyDiffBatch(taskId, null, testDir);
  assert.strictEqual(applyRes.status, 'APPLIED');
  assert.strictEqual(applyRes.appliedCount, 1);

  // Verify disk mutation
  const diskContent = fs.readFileSync(testFile, 'utf-8');
  assert.strictEqual(diskContent, 'export function greet() { return "hello world"; }\n');

  // Task commit transition
  await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.COMMITTED });
  const taskAfter = await KruschStateManager.getTask(taskId);
  assert.strictEqual(taskAfter.phase, HARNESS_PHASES.COMMITTED);

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('Integration: MCP Server exposes exactly 7 canonical tools with valid schemas', async () => {
  const server = createMcpServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);

  const { tools } = await client.listTools();
  assert.strictEqual(tools.length, 7);

  const toolNames = tools.map(t => t.name).sort();
  const expectedNames = [
    'krusch_abort',
    'krusch_apply_diff',
    'krusch_diff',
    'krusch_explain',
    'krusch_reject',
    'krusch_run',
    'krusch_task_status'
  ];
  assert.deepStrictEqual(toolNames, expectedNames);

  // Verify schema properties
  const runTool = tools.find(t => t.name === 'krusch_run');
  assert.ok(runTool.inputSchema.properties.goal);
  assert.ok(runTool.inputSchema.required.includes('goal'));

  const statusTool = tools.find(t => t.name === 'krusch_task_status');
  assert.ok(statusTool.inputSchema.properties.taskId);
  assert.ok(statusTool.inputSchema.required.includes('taskId'));

  const applyTool = tools.find(t => t.name === 'krusch_apply_diff');
  assert.ok(applyTool.inputSchema.properties.taskId);
  assert.ok(applyTool.inputSchema.properties.diffId);
  assert.ok(applyTool.inputSchema.required.includes('taskId'));

  await client.close();
  await server.close();
});

test('Integration: MCP Server parameter validation and error propagation', async () => {
  const server = createMcpServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);

  // krusch_run: missing goal
  await assert.rejects(
    async () => client.callTool({ name: 'krusch_run', arguments: {} }),
    (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
  );

  // krusch_run: empty goal string
  await assert.rejects(
    async () => client.callTool({ name: 'krusch_run', arguments: { goal: '   ' } }),
    (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
  );

  // krusch_run: non-existent projectPath
  await assert.rejects(
    async () => client.callTool({ name: 'krusch_run', arguments: { goal: 'test', projectPath: '/non/existent/path/999' } }),
    (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
  );

  // krusch_task_status: missing taskId
  await assert.rejects(
    async () => client.callTool({ name: 'krusch_task_status', arguments: {} }),
    (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
  );

  // krusch_task_status: unknown taskId
  await assert.rejects(
    async () => client.callTool({ name: 'krusch_task_status', arguments: { taskId: 'non_existent_task_123' } }),
    (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
  );

  // krusch_diff: missing taskId
  await assert.rejects(
    async () => client.callTool({ name: 'krusch_diff', arguments: {} }),
    (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
  );

  // krusch_apply_diff: missing taskId
  await assert.rejects(
    async () => client.callTool({ name: 'krusch_apply_diff', arguments: {} }),
    (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
  );

  // krusch_apply_diff: negative diffId
  await assert.rejects(
    async () => client.callTool({ name: 'krusch_apply_diff', arguments: { taskId: 'any_id', diffId: -1 } }),
    (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
  );

  // krusch_explain: missing taskId
  await assert.rejects(
    async () => client.callTool({ name: 'krusch_explain', arguments: {} }),
    (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
  );

  // krusch_reject: missing taskId
  await assert.rejects(
    async () => client.callTool({ name: 'krusch_reject', arguments: {} }),
    (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
  );

  // krusch_reject: invalid diffId
  await assert.rejects(
    async () => client.callTool({ name: 'krusch_reject', arguments: { taskId: 'any_id', diffId: 0 } }),
    (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
  );

  // krusch_abort: missing taskId
  await assert.rejects(
    async () => client.callTool({ name: 'krusch_abort', arguments: {} }),
    (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
  );

  // unknown tool name
  await assert.rejects(
    async () => client.callTool({ name: 'krusch_unknown_tool', arguments: {} }),
    (err) => err instanceof McpError && err.code === ErrorCode.MethodNotFound
  );

  await client.close();
  await server.close();
});

test('Integration: MCP Server execution via client (krusch_run mock mode & polling)', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-mcp-run-'));
  const testFile = path.join(testDir, 'app.js');
  fs.writeFileSync(testFile, 'console.log("ready");\n', 'utf-8');

  const server = createMcpServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);

  // 1. Launch task via krusch_run with useMock: true and scoped testDir
  const runResult = await client.callTool({
    name: 'krusch_run',
    arguments: {
      goal: 'Explore codebase architecture and verify MCP interface',
      projectPath: testDir,
      useMock: true
    }
  });

  assert.ok(runResult.content && runResult.content[0]);
  const runData = JSON.parse(runResult.content[0].text);
  assert.strictEqual(runData.status, 'STARTED');
  assert.strictEqual(runData.phase, 'INIT');
  assert.ok(typeof runData.taskId === 'string' && runData.taskId.startsWith('task_'));
  const taskId = runData.taskId;

  // 2. Poll task status via krusch_task_status
  const statusResult = await client.callTool({
    name: 'krusch_task_status',
    arguments: { taskId }
  });
  const statusData = JSON.parse(statusResult.content[0].text);
  assert.strictEqual(statusData.taskId, taskId);
  assert.strictEqual(statusData.goal, 'Explore codebase architecture and verify MCP interface');
  assert.ok(statusData.phase);
  assert.strictEqual(typeof statusData.isCompleted, 'boolean');

  // 3. Inspect diffs via krusch_diff
  const diffResult = await client.callTool({
    name: 'krusch_diff',
    arguments: { taskId }
  });
  const diffData = JSON.parse(diffResult.content[0].text);
  assert.ok(Array.isArray(diffData));

  // 4. Inspect explanation via krusch_explain
  const explainResult = await client.callTool({
    name: 'krusch_explain',
    arguments: { taskId }
  });
  const explainData = JSON.parse(explainResult.content[0].text);
  assert.strictEqual(explainData.taskId, taskId);
  assert.ok(explainData.phase);

  // 5. Abort task via krusch_abort
  const abortResult = await client.callTool({
    name: 'krusch_abort',
    arguments: { taskId, reason: 'Completed MCP contract test' }
  });
  const abortData = JSON.parse(abortResult.content[0].text);
  assert.strictEqual(abortData.status, 'ABORTED');

  // Verify task status reflects ABORTED
  const abortedStatus = await client.callTool({
    name: 'krusch_task_status',
    arguments: { taskId }
  });
  const abortedData = JSON.parse(abortedStatus.content[0].text);
  assert.strictEqual(abortedData.phase, 'ABORTED');
  assert.strictEqual(abortedData.isCompleted, true);

  await client.close();
  await server.close();
  fs.rmSync(testDir, { recursive: true, force: true });
});

test.after(async () => {
  await pool.end();
});
