import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { KruschStateManager, canonicalizePaths } from '../brain/state-manager.js';
import { KruschContextClient } from '../brain/context-client.js';
import { KruschTestRunner } from '../verify/test-runner.js';
import { KruschApprovalPolicy } from '../approvals/policy.js';

export class KruschTools {
  constructor(taskId, projectPath, options = {}) {
    this.taskId = taskId;
    this.projectPath = projectPath;
    this.policy = options.policy || new KruschApprovalPolicy(options);
    this.verificationCommand = options.verificationCommand || null;
  }

  getDefinitions() {
    return [
      {
        name: 'read_file',
        description: 'Read the token-bounded text content of a file from the repository with line citations.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to file' },
            startLine: { type: 'integer', description: 'Starting line number (1-indexed, default 1)' },
            endLine: { type: 'integer', description: 'Ending line number (inclusive)' },
            maxLines: { type: 'integer', description: 'Maximum lines to return (default 200, max 500)' }
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
        description: `Execute a test, build, or verification command.${this.verificationCommand ? ` Target project test command: "${this.verificationCommand}".` : ''}`,
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
      const { projectPath, filePath } = canonicalizePaths(this.projectPath, args.path);
      const fullPath = path.resolve(projectPath, filePath);
      if (!fs.existsSync(fullPath)) {
        return { error: `File not found: ${args.path}` };
      }
      const rawContent = fs.readFileSync(fullPath, 'utf-8');
      const lines = rawContent.split('\n');
      const totalLines = lines.length;

      const startLine = Math.max(1, parseInt(args.startLine || args.start_line || 1, 10));
      const maxLines = Math.min(parseInt(args.maxLines || args.max_lines || 200, 10), 500);
      const endLine = args.endLine || args.end_line
        ? Math.min(parseInt(args.endLine || args.end_line, 10), totalLines)
        : Math.min(startLine + maxLines - 1, totalLines);

      const slice = lines.slice(startLine - 1, endLine);
      const numberedContent = slice.map((line, idx) => `${startLine + idx} | ${line}`).join('\n');

      return {
        path: filePath,
        startLine,
        endLine,
        totalLines,
        isTruncated: endLine < totalLines,
        citation: `${filePath}:${startLine}-${endLine}`,
        content: numberedContent
      };
    }

    if (name === 'stage_diff') {
      if (!args.path || typeof args.path !== 'string') {
        return { error: 'Invalid path: file path must be a non-empty string.' };
      }
      if (args.content === undefined || args.content === null || typeof args.content !== 'string') {
        return { error: 'Invalid content: staged content must be a valid string.' };
      }
      if (args.content.includes('\0')) {
        return { error: 'Invalid content: binary null bytes detected in staged text content.' };
      }

      const { projectPath, filePath } = canonicalizePaths(this.projectPath, args.path);
      const fullPath = path.resolve(projectPath, filePath);
      const originalContent = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : '';
      const stagedRow = await KruschStateManager.stageDiff(this.taskId, {
        filePath: args.path,
        projectPath: this.projectPath,
        originalContent,
        stagedContent: args.content,
        diffPatch: args.explanation || 'Staged modification'
      });
      return {
        status: 'STAGED',
        diffId: stagedRow.id,
        filePath: stagedRow.file_path,
        hash: stagedRow.sha256_hash,
        leaseExpiresAt: stagedRow.lease_expires_at,
        message: `Changes staged in PostgreSQL (ID: ${stagedRow.id}). Ready for verification.`
      };
    }

    if (name === 'search_symbols') {
      if (!args.query || typeof args.query !== 'string') {
        return { error: 'Invalid query: search query must be a non-empty string.' };
      }
      const symbols = await KruschContextClient.searchCodeSymbols(args.query, 10);
      return { query: args.query, results: symbols };
    }

    if (name === 'run_command') {
      if (!args.command || typeof args.command !== 'string') {
        return { error: 'Invalid command: command must be a non-empty string.' };
      }
      const result = await KruschTestRunner.runCommand(args.command, this.projectPath);
      await KruschStateManager.recordVerificationRun(this.taskId, {
        command: args.command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        passed: result.passed,
        extractedErrors: result.extractedErrors || []
      });
      return result;
    }

    if (name === 'apply_staged_diff') {
      if (!args.diffId || typeof args.diffId !== 'number') {
        return { error: 'Invalid diffId: diffId must be an integer.' };
      }
      try {
        const batchResult = await KruschStateManager.applyDiffBatch(this.taskId, [args.diffId], this.projectPath);
        if (batchResult.status === 'APPLIED') {
          return { status: 'APPLIED', diffId: args.diffId, filePath: batchResult.diffs[0]?.filePath };
        }
        return batchResult;
      } catch (err) {
        return { error: err.code || 'CRASH_SAFE_APPLY_FAILED', message: err.message };
      }
    }

    return { error: `Unknown tool: ${name}` };
  }
}
