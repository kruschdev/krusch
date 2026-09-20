#!/usr/bin/env node

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
import { query } from '../brain/pool.js';
import crypto from 'crypto';

/**
 * Krusch MCP Server
 *
 * Exposes a thin, 4-tool async control plane interface for KD Code / IDEs:
 * 1. krusch_run: Non-blocking asynchronous task dispatch.
 * 2. krusch_task_status: Polling status endpoint with event timeline and verification state.
 * 3. krusch_diff: Unified diff inspector for staged modifications in PostgreSQL.
 * 4. krusch_apply_diff: Human approval trigger to 2PC journal and write working tree.
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

  const server = new Server(
    { name: 'krusch-harness', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  const stateMachine = new KruschStateMachine();

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
              autoApprove: { type: 'boolean', description: 'Whether to auto-apply diffs upon passing verification' }
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
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === 'krusch_run') {
        const taskId = `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const projectPath = args.projectPath || process.cwd();

        // Initialize task record synchronously so taskId is immediately valid
        await KruschStateManager.createTask({
          id: taskId,
          goal: args.goal,
          projectPath,
          phase: 'INIT'
        });

        // Launch execution asynchronously in background (non-blocking for stdio transport)
        stateMachine.runTask({
          taskId,
          goal: args.goal,
          projectPath,
          modelOverride: args.modelOverride,
          autoApprove: Boolean(args.autoApprove)
        }).catch(err => {
          console.error(`[krusch:mcp] Background execution error for ${taskId}: ${err.message}`);
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
        const task = await KruschStateManager.getTask(args.taskId);
        if (!task) {
          throw new McpError(ErrorCode.InvalidParams, `Task not found: ${args.taskId}`);
        }

        // Fetch recent events for timeline
        const eventsRes = await query(
          'SELECT event_type, payload, created_at FROM krusch_events WHERE task_id = $1 ORDER BY id DESC LIMIT 10',
          [args.taskId]
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
        const task = await KruschStateManager.getTask(args.taskId);
        if (!task) {
          throw new McpError(ErrorCode.InvalidParams, `Task not found: ${args.taskId}`);
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
        const task = await KruschStateManager.getTask(args.taskId);
        if (!task) {
          throw new McpError(ErrorCode.InvalidParams, `Task not found: ${args.taskId}`);
        }

        const diffIds = args.diffId ? [args.diffId] : null;
        const batchRes = await KruschStateManager.applyDiffBatch(args.taskId, diffIds, task.project_path || process.cwd());
        const remainingPending = await KruschStateManager.getPendingDiffs(args.taskId);
        if (remainingPending.length === 0) {
          await KruschStateManager.updateTask(args.taskId, { phase: 'COMMITTED' });
        }
        return { content: [{ type: 'text', text: JSON.stringify(batchRes, null, 2) }] };
      }

      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Krusch Error: ${err.message}` }]
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[krusch:mcp] Krusch MCP Server connected over stdio');
}

if (process.argv[1] && process.argv[1].endsWith('mcp-server.js')) {
  startMcpServer().catch(err => {
    console.error('Failed to start Krusch MCP server:', err);
    process.exit(1);
  });
}
