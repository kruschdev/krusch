import test from 'node:test';
import assert from 'node:assert/strict';
import {
  redactSecrets,
  routePipeline,
  checkSibling,
  ECOSYSTEM_SIBLINGS,
  startBridgeServer,
} from '../../src/control/control-plane.js';
import { createMcpServer } from '../../src/server/mcp-server.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

test('Control Plane: redactSecrets masks API keys, bearer tokens, and Postgres URLs', () => {
  const sample = [
    'OPENAI=sk-proj1234567890abcdefghijklmnop',
    'ANTHROPIC=sk-ant-api03-1234567890abcdefghijklmnop',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secretpayload',
    'DATABASE_URL=postgresql://kdcode:supersecretpass@localhost:5432/kdcode',
    'api_key: "my_super_secret_value_12345"',
  ].join('\n');

  const redacted = redactSecrets(sample);
  assert.ok(redacted.includes('[REDACTED_API_KEY]'), 'Should redact OpenAI key');
  assert.ok(redacted.includes('[REDACTED_ANTHROPIC_KEY]'), 'Should redact Anthropic key');
  assert.ok(redacted.includes('Bearer [REDACTED_TOKEN]'), 'Should redact Bearer token');
  assert.ok(
    redacted.includes('postgresql://kdcode:****@localhost:5432/kdcode'),
    'Should mask Postgres password',
  );
  assert.ok(redacted.includes('[REDACTED_SECRET]'), 'Should redact generic api_key assignment');
  assert.ok(!redacted.includes('supersecretpass'), 'Plaintext password must not remain');
});

test('Control Plane: routePipeline dispatches L1 fast-path and L2 neural centroid', async () => {
  const l1Res = await routePipeline('SELECT id, email FROM users WHERE active = true;');
  assert.equal(l1Res.stage, 'L1_FAST_PATH');
  assert.equal(l1Res.confidence, 1.0);

  const l2Res = await routePipeline(
    'Analyze the distributed Two-Phase Commit apply journal and identify split-brain failure modes',
  );
  assert.ok(
    l2Res.stage === 'L2_NEURAL_CENTROID' || l2Res.stage === 'L2_FALLBACK' || l2Res.stage === 'L2_CENTROID',
    `Expected L2 stage, got ${l2Res.stage}`,
  );
  assert.ok(typeof l2Res.recommendedModel === 'string' && l2Res.recommendedModel.length > 0);
});

test('Control Plane: checkSibling validates ecosystem sibling repositories', () => {
  const ctxCheck = checkSibling('krusch-context-mcp', ECOSYSTEM_SIBLINGS['krusch-context-mcp']);
  assert.equal(ctxCheck.ok, true, `Expected krusch-context-mcp sibling check to pass: ${ctxCheck.error}`);
});

test('Control Plane: HTTP Bridge serves /api/centroids and /api/route cleanly', async () => {
  const server = startBridgeServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const centroidsRes = await fetch(`${baseUrl}/api/centroids`);
    assert.equal(centroidsRes.status, 200);
    const centroidsData = await centroidsRes.json();
    assert.ok(Array.isArray(centroidsData.centroids));

    const routeRes = await fetch(`${baseUrl}/api/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Refactor this TypeScript function to use async/await' }),
    });
    assert.equal(routeRes.status, 200);
    const routeData = await routeRes.json();
    assert.ok(routeData.recommendedModel);
  } finally {
    server.close();
  }
});

test('Invariant #567: All 7 MCP tools declare readOnlyHint, destructiveHint, idempotentHint, and openWorldHint', async () => {
  const mcpServer = createMcpServer();
  const handler = mcpServer._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
  assert.ok(handler, 'ListTools handler must be registered');

  const response = await handler({ method: 'tools/list', params: {} });
  assert.equal(response.tools.length, 7);

  for (const tool of response.tools) {
    assert.ok(tool.annotations, `Tool ${tool.name} is missing annotations`);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', `${tool.name}.readOnlyHint`);
    assert.equal(typeof tool.annotations.destructiveHint, 'boolean', `${tool.name}.destructiveHint`);
    assert.equal(typeof tool.annotations.idempotentHint, 'boolean', `${tool.name}.idempotentHint`);
    assert.equal(typeof tool.annotations.openWorldHint, 'boolean', `${tool.name}.openWorldHint`);
  }
});

test('ARCH-01 & ARCH-02: MCP server encapsulates activeTasks with bounded capacity and enforces close() timeout', async () => {
  const mcpServer = createMcpServer({ shutdownTimeoutMs: 30, maxActiveTasks: 2 });
  assert.equal(mcpServer.activeTasks, undefined, 'activeTasks Map must remain private to createMcpServer closure');
  assert.equal(typeof mcpServer.registerTask, 'function');
  assert.equal(typeof mcpServer.listTasks, 'function');

  mcpServer.registerTask('stalled-1', new Promise(() => {}));
  mcpServer.registerTask('stalled-2', new Promise(() => {}));
  assert.deepEqual(mcpServer.listTasks(), ['stalled-1', 'stalled-2']);

  assert.throws(
    () => mcpServer.registerTask('overflow-3', new Promise(() => {})),
    /Maximum active task limit reached/
  );

  const start = Date.now();
  await mcpServer.close();
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `Expected bounded shutdown within 1000ms, took ${elapsed}ms`);
});

test('BUG-01: registerTask rejects duplicate taskKey below limit and enforces maxActiveTasks unconditionally', () => {
  const mcpServer = createMcpServer({ maxActiveTasks: 2 });

  mcpServer.registerTask('task-1', new Promise(() => {}));

  // Registering a duplicate taskKey below maxActiveTasks limit throws Duplicate active task ID
  assert.throws(
    () => mcpServer.registerTask('task-1', new Promise(() => {})),
    /Duplicate active task ID: task-1/
  );

  mcpServer.registerTask('task-2', new Promise(() => {}));

  // Registering a duplicate taskKey when activeTasks.size >= maxActiveTasks throws Maximum active task limit reached
  assert.throws(
    () => mcpServer.registerTask('task-1', new Promise(() => {})),
    /Maximum active task limit reached \(2\)/
  );
});

test('Control Plane: Software Factory Control Room UI (GET / and /factory) and portable AST Blast Radius (GET /api/ast/graph)', async () => {
  const server = startBridgeServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const uiRes = await fetch(`${baseUrl}/`);
    assert.equal(uiRes.status, 200);
    assert.ok((uiRes.headers.get('content-type') || '').includes('text/html'));
    const html = await uiRes.text();
    assert.ok(html.includes('Krusch Software Factory'), 'Should render Software Factory Control Room HTML');
    assert.ok(html.includes('STATION 01'), 'Should render STATION 01');
    assert.ok(html.includes('STATION 04'), 'Should render STATION 04');

    const astRes = await fetch(`${baseUrl}/api/ast/graph?symbol=startBridgeServer`);
    assert.equal(astRes.status, 200);
    const astData = await astRes.json();
    assert.equal(astData.ok, true);
    assert.ok(astData.filesScanned > 0, 'Should scan local files without requiring external database');
    assert.ok(Array.isArray(astData.matchingSymbols) && astData.matchingSymbols.length > 0);
    assert.ok(Array.isArray(astData.inboundCallers) && astData.inboundCallers.length > 0);
    assert.ok(Array.isArray(astData.outboundCallees));
  } finally {
    server.close();
  }
});

test('BUG-01 & SEC-01: validates KRUSCH_DEBUG boolean flags and rejects task registration during MCP server close', async () => {
  const { isKruschDebugEnabled } = await import('../../src/brain/context-client.js');
  const { createMcpServer } = await import('../../src/server/mcp-server.js');

  assert.equal(isKruschDebugEnabled({}), false);
  assert.equal(isKruschDebugEnabled({ KRUSCH_DEBUG: 'false' }), false);
  assert.equal(isKruschDebugEnabled({ KRUSCH_DEBUG: '0' }), false);
  assert.equal(isKruschDebugEnabled({ KRUSCH_DEBUG: 'true' }), true);
  assert.equal(isKruschDebugEnabled({ KRUSCH_DEBUG: '1' }), true);

  const mcp = createMcpServer({ shutdownTimeoutMs: 500 });
  let resolveTask;
  const pending = new Promise((r) => { resolveTask = r; });
  mcp.registerTask('task-before-close', pending);
  assert.deepEqual(mcp.listTasks(), ['task-before-close']);

  const closePromise = mcp.close();
  assert.throws(
    () => mcp.registerTask('task-during-close', Promise.resolve()),
    /Cannot register task: MCP server is shutting down/
  );
  resolveTask('ok');
  await closePromise;
  assert.deepEqual(mcp.listTasks(), []);
});
