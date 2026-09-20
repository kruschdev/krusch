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
import { KruschCascadeRouter, DEFAULT_SPECIALISTS } from '../router/cascade.js';
import { KruschTools } from '../tools/index.js';
import { KruschApprovalPolicy } from '../approvals/policy.js';

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
  const router = new KruschCascadeRouter();

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'krusch_run',
          description: 'Execute an engineering task through the Krusch invariant coding harness (Postgres state authority + interchangeable models).',
          inputSchema: {
            type: 'object',
            properties: {
              goal: { type: 'string', description: 'Engineering task or objective' },
              projectPath: { type: 'string', description: 'Working directory path (defaults to current)' },
              modelOverride: { type: 'string', description: 'Optional model override' }
            },
            required: ['goal']
          }
        },
        {
          name: 'krusch_route',
          description: 'Inspect which model specialist Krusch would select for a given prompt without executing it.',
          inputSchema: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Task prompt or code snippet' }
            },
            required: ['prompt']
          }
        },
        {
          name: 'krusch_task_status',
          description: 'Inspect full state, turns, events, and staged diffs of a Krusch task in PostgreSQL.',
          inputSchema: {
            type: 'object',
            properties: {
              taskId: { type: 'string', description: 'Task ID' }
            },
            required: ['taskId']
          }
        },
        {
          name: 'krusch_explain',
          description: 'Explain why transitions or actions are allowed or blocked for a task based on PostgreSQL invariants.',
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
          description: 'View unified diff of all staged modifications for a task in PostgreSQL.',
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
          description: 'Approve and apply staged diffs from PostgreSQL to physical disk (guarded by verification passing and APPROVAL_GATE).',
          inputSchema: {
            type: 'object',
            properties: {
              taskId: { type: 'string', description: 'Task ID' },
              diffId: { type: 'integer', description: 'Staged diff row ID' }
            },
            required: ['taskId', 'diffId']
          }
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === 'krusch_run') {
        const result = await stateMachine.runTask({
          goal: args.goal,
          projectPath: args.projectPath || process.cwd(),
          modelOverride: args.modelOverride
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (name === 'krusch_route') {
        const route = router.route(args.prompt);
        return { content: [{ type: 'text', text: JSON.stringify(route, null, 2) }] };
      }

      if (name === 'krusch_task_status') {
        const task = await KruschStateManager.getTask(args.taskId);
        if (!task) {
          throw new McpError(ErrorCode.InvalidParams, `Task not found: ${args.taskId}`);
        }
        return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
      }

      if (name === 'krusch_explain') {
        const explanation = await KruschStateManager.explainTaskStatus(args.taskId);
        if (!explanation) {
          throw new McpError(ErrorCode.InvalidParams, `Task not found: ${args.taskId}`);
        }
        return { content: [{ type: 'text', text: JSON.stringify(explanation, null, 2) }] };
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
          sha256: d.sha256_hash
        }));
        return { content: [{ type: 'text', text: JSON.stringify(diffs, null, 2) }] };
      }

      if (name === 'krusch_apply_diff') {
        const tools = new KruschTools(args.taskId, process.cwd(), {
          policy: new KruschApprovalPolicy({ autoApprove: true })
        });
        const res = await tools.executeTool('apply_staged_diff', { diffId: args.diffId });
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
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
