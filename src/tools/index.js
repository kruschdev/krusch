import fs from 'fs';
import path from 'path';
import { KruschStateManager } from '../brain/state-manager.js';
import { KruschContextClient } from '../brain/context-client.js';
import { KruschTestRunner } from '../verify/test-runner.js';
import { KruschApprovalPolicy } from '../approvals/policy.js';

export class KruschTools {
  constructor(taskId, projectPath, options = {}) {
    this.taskId = taskId;
    this.projectPath = projectPath;
    this.policy = options.policy || new KruschApprovalPolicy(options);
  }

  getDefinitions() {
    return [
      {
        name: 'read_file',
        description: 'Read the text content of a file from the repository.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to file' }
          },
          required: ['path']
        }
      },
      {
        name: 'stage_diff',
        description: 'Stage an updated file content into PostgreSQL without immediately touching physical disk.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to file' },
            content: { type: 'string', description: 'Full updated content of the file' },
            explanation: { type: 'string', description: 'Rationale for the modification' }
          },
          required: ['path', 'content']
        }
      },
      {
        name: 'search_symbols',
        description: 'Search for code symbols, functions, classes, and types in PostgreSQL AST index.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Symbol or signature name to search' }
          },
          required: ['query']
        }
      },
      {
        name: 'run_command',
        description: 'Execute a test, build, or verification command.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Command to run (e.g. npm test)' }
          },
          required: ['command']
        }
      },
      {
        name: 'apply_staged_diff',
        description: 'Apply a staged diff from PostgreSQL to the physical disk (governed by approval policy).',
        parameters: {
          type: 'object',
          properties: {
            diffId: { type: 'integer', description: 'ID of staged diff row in PostgreSQL' }
          },
          required: ['diffId']
        }
      }
    ];
  }

  async executeTool(name, args = {}) {
    const policyResult = this.policy.evaluate(name, args);

    if (policyResult.status === 'REQUIRE_APPROVAL') {
      // Record approval request in PostgreSQL
      const approval = await KruschStateManager.requestApproval(this.taskId, {
        actionType: name,
        targetResource: JSON.stringify(args),
        status: 'PENDING',
        decisionReason: policyResult.reason
      });
      return {
        status: 'APPROVAL_REQUIRED',
        approvalId: approval.id,
        message: `Action requires user approval: ${policyResult.reason}`
      };
    }

    if (name === 'read_file') {
      const fullPath = path.resolve(this.projectPath, args.path);
      if (!fs.existsSync(fullPath)) {
        return { error: `File not found: ${args.path}` };
      }
      const content = fs.readFileSync(fullPath, 'utf-8');
      return { path: args.path, content };
    }

    if (name === 'stage_diff') {
      const fullPath = path.resolve(this.projectPath, args.path);
      const originalContent = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : '';
      const stagedRow = await KruschStateManager.stageDiff(this.taskId, {
        filePath: args.path,
        originalContent,
        stagedContent: args.content,
        diffPatch: args.explanation || 'Staged modification'
      });
      return {
        status: 'STAGED',
        diffId: stagedRow.id,
        filePath: args.path,
        hash: stagedRow.sha256_hash,
        message: `Changes staged in PostgreSQL (ID: ${stagedRow.id}). Ready for verification.`
      };
    }

    if (name === 'search_symbols') {
      const symbols = await KruschContextClient.searchCodeSymbols(args.query, 10);
      return { query: args.query, results: symbols };
    }

    if (name === 'run_command') {
      const result = await KruschTestRunner.runCommand(args.command, this.projectPath);
      await KruschStateManager.recordVerificationRun(this.taskId, {
        command: args.command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        passed: result.passed
      });
      return result;
    }

    if (name === 'apply_staged_diff') {
      const diffs = await KruschStateManager.getPendingDiffs(this.taskId);
      const target = diffs.find(d => d.id === args.diffId);
      if (!target) {
        return { error: `Pending diff with ID ${args.diffId} not found.` };
      }
      const fullPath = path.resolve(this.projectPath, target.file_path);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, target.staged_content, 'utf-8');
      await KruschStateManager.updateDiffStatus(target.id, 'APPLIED');
      return { status: 'APPLIED', diffId: target.id, filePath: target.file_path };
    }

    return { error: `Unknown tool: ${name}` };
  }
}
