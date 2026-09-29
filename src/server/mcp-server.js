import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';

import { KruschStateMachine } from '../workflow/state-machine.js';
import { KruschStateManager } from '../brain/state-manager.js';
import { KruschFSM, HARNESS_PHASES } from '../workflow/fsm.js';
import { query, pool } from '../brain/pool.js';

/**
 * Factory function creating and configuring the Krusch MCP Server instance.
 * Allows in-memory testing without spawning stdio child processes.
 */
export function createMcpServer() {
  const server = new Server(
    { name: 'krusch-harness', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  const activeTasks = new Map();
  server.activeTasks = activeTasks;

  const originalClose = server.close.bind(server);
  server.close = async () => {
    if (activeTasks.size > 0) {
      await Promise.allSettled(Array.from(activeTasks.values()));
    }
    return originalClose();
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'krusch_run',
          description: 'Asynchronously launch an engineering task in the Krusch harness. Returns immediately with taskId for polling.',
          inputSchema: {
            type: 'object',
            properties: {
              goal: { type: 'string', description: 'Engineering task or objective' },
              projectPath: { type: 'string', description: 'Working directory path (defaults to current)' },
              modelOverride: { type: 'string', description: 'Optional model override' },
              autoApprove: { type: 'boolean', description: 'Whether to auto-apply diffs upon passing verification' },
              useMock: { type: 'boolean', description: 'Run with local deterministic mock adapter (offline/testing)' }
            },
            required: ['goal']
          }
        },
        {
          name: 'krusch_task_status',
          description: 'Poll real-time task status, phase transitions, latest verification, and recent events from PostgreSQL.',
          inputSchema: {
            type: 'object',
            properties: {
              taskId: { type: 'string', description: 'Task ID' }
            },
            required: ['taskId']
          }
        },
        {
          name: 'krusch_diff',
          description: 'Inspect unified diffs of all staged modifications held in PostgreSQL for review in KD Code.',
          inputSchema: {
            type: 'object',
            properties: {
              taskId: { type: 'string', description: 'Task ID' }
            },
            required: ['taskId']
          }
        },
        {
          name: 'krusch_apply_diff',
          description: 'Approve and apply verified staged diffs from PostgreSQL to physical disk via 2PC apply journal.',
          inputSchema: {
            type: 'object',
            properties: {
              taskId: { type: 'string', description: 'Task ID' },
              diffId: { type: 'integer', description: 'Optional specific diff ID; applies all verified diffs if omitted' }
            },
            required: ['taskId']
          }
        },
        {
          name: 'krusch_explain',
          description: 'Explain transition feasibility, invariant blockers, and ground-truth verification diagnostics for a task.',
          inputSchema: {
            type: 'object',
            properties: {
              taskId: { type: 'string', description: 'Task ID' }
            },
            required: ['taskId']
          }
        },
        {
          name: 'krusch_reject',
          description: 'Reject one or all staged diffs for a task, preventing apply and releasing leases.',
          inputSchema: {
            type: 'object',
            properties: {
              taskId: { type: 'string', description: 'Task ID' },
              diffId: { type: 'integer', description: 'Optional specific diff ID to reject' },
              reason: { type: 'string', description: 'Rationale for rejection' }
            },
            required: ['taskId']
          }
        },
        {
          name: 'krusch_abort',
          description: 'Explicitly abort an active or waiting task, releasing all file concurrency leases.',
          inputSchema: {
            type: 'object',
            properties: {
              taskId: { type: 'string', description: 'Task ID' },
              reason: { type: 'string', description: 'Rationale for aborting' }
            },
            required: ['taskId']
          }
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      if (name === 'krusch_run') {
        if (!args.goal || typeof args.goal !== 'string' || args.goal.trim().length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "'goal' must be a non-empty string");
        }
        if (args.goal.length > 50000) {
          throw new McpError(ErrorCode.InvalidParams, "'goal' exceeds maximum allowed length of 50,000 characters");
        }

        let projectPath = process.cwd();
        if (args.projectPath) {
          if (typeof args.projectPath !== 'string' || args.projectPath.trim().length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "'projectPath' must be a non-empty string path");
          }
          const resolved = path.resolve(args.projectPath);
          if (!fs.existsSync(resolved)) {
            throw new McpError(ErrorCode.InvalidParams, `Directory not found for projectPath: ${args.projectPath}`);
          }
          try {
            const stat = fs.statSync(resolved);
            if (!stat.isDirectory()) {
              throw new McpError(ErrorCode.InvalidParams, `Target projectPath is not a directory: ${args.projectPath}`);
            }
          } catch (e) {
            throw new McpError(ErrorCode.InvalidParams, `Cannot access projectPath: ${e.message}`);
          }
          projectPath = resolved;
        }

        const taskId = `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const autoApprove = Boolean(args.autoApprove);
        const useMock = Boolean(args.useMock);
        const modelOverride = (typeof args.modelOverride === 'string' && args.modelOverride.trim()) ? args.modelOverride.trim() : null;

        // Initialize task record synchronously so taskId is immediately valid
        await KruschStateManager.createTask({
          id: taskId,
          goal: args.goal.trim(),
          projectPath,
          phase: 'INIT'
        });

        // Launch execution asynchronously in background (non-blocking for stdio transport)
        const harness = new KruschStateMachine({
          autoApprove,
          useMock,
          simulateMockTrajectory: useMock,
          pinnedModel: modelOverride
        });

        const taskPromise = harness.runTask({
          taskId,
          goal: args.goal.trim(),
          projectPath,
          modelOverride,
          autoApprove
        }).catch(err => {
          console.error(`[krusch:mcp] Background execution error for ${taskId}: ${err.message}`);
        });

        activeTasks.set(taskId, taskPromise);
        taskPromise.finally(() => {
          activeTasks.delete(taskId);
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              taskId,
              status: 'STARTED',
              phase: 'INIT',
              message: 'Task successfully initialized. Poll krusch_task_status to monitor execution.'
            }, null, 2)
          }]
        };
      }

      if (name === 'krusch_task_status') {
        if (!args.taskId || typeof args.taskId !== 'string' || args.taskId.trim().length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "'taskId' must be a non-empty string");
        }
        const taskId = args.taskId.trim();
        const task = await KruschStateManager.getTask(taskId);
        if (!task) {
          throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
        }

        // Fetch recent events for timeline
        const eventsRes = await query(
          'SELECT event_type, payload, created_at FROM krusch_events WHERE task_id = $1 ORDER BY id DESC LIMIT 10',
          [taskId]
        );

        const statusReport = {
          taskId: task.id,
          goal: task.goal,
          phase: task.phase,
          currentModel: task.current_model,
          turnsCount: task.turns.length,
          stagedDiffsCount: task.stagedDiffs.length,
          pendingDiffsCount: task.stagedDiffs.filter(d => d.status === 'PENDING').length,
          appliedDiffsCount: task.stagedDiffs.filter(d => d.status === 'APPLIED' || d.status === 'COMMITTED').length,
          committedDiffsCount: task.stagedDiffs.filter(d => d.status === 'COMMITTED').length,
          latestVerification: task.verifications[0] || null,
          isCompleted: ['COMMITTED', 'ABORTED'].includes(task.phase),
          isWaitingApproval: task.phase === 'APPROVAL_GATE',
          recentEvents: eventsRes.rows
        };

        return { content: [{ type: 'text', text: JSON.stringify(statusReport, null, 2) }] };
      }

      if (name === 'krusch_diff') {
        if (!args.taskId || typeof args.taskId !== 'string' || args.taskId.trim().length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "'taskId' must be a non-empty string");
        }
        const taskId = args.taskId.trim();
        const task = await KruschStateManager.getTask(taskId);
        if (!task) {
          throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
        }
        const diffs = task.stagedDiffs.map(d => ({
          id: d.id,
          filePath: d.file_path,
          status: d.status,
          patch: d.diff_patch,
          sha256: d.sha256_hash,
          leaseExpiresAt: d.lease_expires_at
        }));
        return { content: [{ type: 'text', text: JSON.stringify(diffs, null, 2) }] };
      }

      if (name === 'krusch_apply_diff') {
        if (!args.taskId || typeof args.taskId !== 'string' || args.taskId.trim().length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "'taskId' must be a non-empty string");
        }
        if (args.diffId !== undefined && args.diffId !== null && (!Number.isInteger(args.diffId) || args.diffId <= 0)) {
          throw new McpError(ErrorCode.InvalidParams, "'diffId' must be a positive integer");
        }
        const taskId = args.taskId.trim();
        const task = await KruschStateManager.getTask(taskId);
        if (!task) {
          throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
        }

        const diffIds = args.diffId ? [args.diffId] : null;
        const batchRes = await KruschStateManager.applyDiffBatch(taskId, diffIds, task.project_path || process.cwd());
        const remainingPending = await KruschStateManager.getPendingDiffs(taskId);
        if (remainingPending.length === 0) {
          try {
            const fsm = new KruschFSM(taskId, task.phase);
            await fsm.transitionTo(HARNESS_PHASES.COMMITTED);
          } catch (_) {
            await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.COMMITTED });
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(batchRes, null, 2) }] };
      }

      if (name === 'krusch_explain') {
        if (!args.taskId || typeof args.taskId !== 'string' || args.taskId.trim().length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "'taskId' must be a non-empty string");
        }
        const taskId = args.taskId.trim();
        const exp = await KruschStateManager.explainTaskStatus(taskId);
        if (!exp) {
          throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
        }
        return { content: [{ type: 'text', text: JSON.stringify(exp, null, 2) }] };
      }

      if (name === 'krusch_reject') {
        if (!args.taskId || typeof args.taskId !== 'string' || args.taskId.trim().length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "'taskId' must be a non-empty string");
        }
        if (args.diffId !== undefined && args.diffId !== null && (!Number.isInteger(args.diffId) || args.diffId <= 0)) {
          throw new McpError(ErrorCode.InvalidParams, "'diffId' must be a positive integer");
        }
        const taskId = args.taskId.trim();
        const task = await KruschStateManager.getTask(taskId);
        if (!task) {
          throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
        }
        const reason = (typeof args.reason === 'string' && args.reason.trim()) ? args.reason.trim() : 'Rejected via MCP';
        const rejectRes = await KruschStateManager.rejectStagedDiff(taskId, args.diffId || null, reason);
        return { content: [{ type: 'text', text: JSON.stringify(rejectRes, null, 2) }] };
      }

      if (name === 'krusch_abort') {
        if (!args.taskId || typeof args.taskId !== 'string' || args.taskId.trim().length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "'taskId' must be a non-empty string");
        }
        const taskId = args.taskId.trim();
        const task = await KruschStateManager.getTask(taskId);
        if (!task) {
          throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
        }
        const reason = (typeof args.reason === 'string' && args.reason.trim()) ? args.reason.trim() : 'Aborted via MCP';
        const abortRes = await KruschStateManager.abortTask(taskId, reason);
        return { content: [{ type: 'text', text: JSON.stringify(abortRes, null, 2) }] };
      }

      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    } catch (err) {
      if (err instanceof McpError) {
        throw err;
      }
      return {
        isError: true,
        content: [{ type: 'text', text: `Krusch Error: ${err.message}` }]
      };
    }
  });

  return server;
}

/**
 * Krusch MCP Server CLI runner
 *
 * Exposes a thin, 7-tool async control plane interface for KD Code / IDEs:
 * 1. krusch_run: Non-blocking asynchronous task dispatch.
 * 2. krusch_task_status: Polling status endpoint with event timeline and verification state.
 * 3. krusch_diff: Unified diff inspector for staged modifications in PostgreSQL.
 * 4. krusch_apply_diff: Human approval trigger to 2PC journal and write working tree.
 * 5. krusch_explain: Invariant blocker diagnostics & transition feasibility.
 * 6. krusch_reject: Reject staged diffs and release file concurrency leases.
 * 7. krusch_abort: Explicitly abort task and unlock working tree leases.
 */
export async function startMcpServer() {
  // Startup Crash Recovery & Lease Maintenance for long-lived MCP server
  try {
    const recovered = await KruschStateManager.recoverInFlightApplies();
    if (recovered.length > 0) {
      console.error(`[krusch:mcp] Recovered ${recovered.length} in-flight diff apply operation(s)`);
    }
    const pruned = await KruschStateManager.pruneExpiredLeases();
    if (pruned.length > 0) {
      console.error(`[krusch:mcp] Pruned ${pruned.length} expired file lease(s)`);
    }
  } catch (err) {
    console.error(`[krusch:mcp] Startup recovery warning: ${err.message}`);
  }

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[krusch:mcp] Krusch MCP Server connected over stdio');

  const shutdown = async () => {
    console.error('[krusch:mcp] Shutting down...');
    try { await server.close(); } catch (_) { }
    try { await pool.end(); } catch (_) { }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);

  return server;
}

if (process.argv[1] && process.argv[1].endsWith('mcp-server.js')) {
  startMcpServer().catch(err => {
    console.error('Failed to start Krusch MCP server:', err);
    process.exit(1);
  });
}
