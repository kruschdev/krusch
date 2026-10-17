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
