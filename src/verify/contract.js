import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { KruschTestRunner } from './test-runner.js';
import { KruschSandbox } from './sandbox.js';

export class KruschVerificationContract {
  /**
   * Load project-local verification contract configuration if present.
   */
  static loadContract(projectPath = process.cwd()) {
    const candidates = [
      path.join(projectPath, 'krusch.verify.json'),
      path.join(projectPath, '.krusch', 'verify.json')
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try {
          const raw = fs.readFileSync(candidate, 'utf-8');
          return JSON.parse(raw);
        } catch (err) {
          console.error(`[krusch:verify] Warning: Could not parse ${candidate}: ${err.message}`);
        }
      }
    }

    return null;
  }

  /**
   * Check invariant path rules (requiredPaths, forbiddenPaths) against staged diffs.
   */
  static checkPathContracts(contract, stagedDiffs = []) {
    if (!contract) return { valid: true };

    const modifiedPaths = new Set(stagedDiffs.map(d => d.file_path || d.filePath));

    // 1. Check requiredPaths
    if (Array.isArray(contract.requiredPaths)) {
      for (const req of contract.requiredPaths) {
        if (!modifiedPaths.has(req)) {
          return {
            valid: false,
            error: `Verification Contract Violation: Required path '${req}' was not modified by staged diffs.`
          };
        }
      }
    }

    // 2. Check forbiddenPaths
    if (Array.isArray(contract.forbiddenPaths)) {
      for (const forb of contract.forbiddenPaths) {
        if (modifiedPaths.has(forb)) {
          return {
            valid: false,
            error: `Verification Contract Violation: Forbidden path '${forb}' was modified in staged diffs.`
          };
        }
      }
    }

    return { valid: true };
  }

  /**
   * Execute verification against an isolated staged-tree sandbox.
   * Ensures the physical working tree is never touched during test verification.
   */
  static async runInStagedTree(projectPath, stagedDiffs, options = {}) {
    const contract = KruschVerificationContract.loadContract(projectPath);
    const effectiveCommand = options.command || contract?.command || KruschTestRunner.detectTestCommand(projectPath, options);

    if (!effectiveCommand) {
      throw new Error('No verification command configured or detected.');
    }

    // Check path contract first
    const pathCheck = KruschVerificationContract.checkPathContracts(contract, stagedDiffs);
    if (!pathCheck.valid) {
      return {
        command: effectiveCommand,
        exitCode: 1,
        stdout: '',
        stderr: pathCheck.error,
        passed: false,
        durationMs: 0,
        extractedErrors: [{ type: 'ContractViolation', message: pathCheck.error }],
        stagedTreeExecuted: true
      };
    }

    const timeoutMs = options.timeoutMs || contract?.timeoutMs || 60000;
    const isSandboxDisabled = options.sandbox === false || contract?.sandbox === false;

    // If sandboxing is disabled or no staged diffs, run directly in projectPath
    if (isSandboxDisabled || !stagedDiffs || stagedDiffs.length === 0) {
      return KruschTestRunner.runCommand(effectiveCommand, projectPath, { timeoutMs });
    }

    // Build isolated staged tree sandbox in temp directory
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-staged-tree-'));

    try {
      // Copy project files to sandbox (excluding .git, node_modules, temp files)
      KruschVerificationContract.copyTree(projectPath, sandboxDir, {
        excludeDirs: ['.git', '.krusch', 'dist', 'build']
      });

      // Overlay symlink for node_modules if present to avoid reinstall
      const srcNodeModules = path.join(projectPath, 'node_modules');
      const dstNodeModules = path.join(sandboxDir, 'node_modules');
      if (fs.existsSync(srcNodeModules) && !fs.existsSync(dstNodeModules)) {
        try {
          fs.symlinkSync(srcNodeModules, dstNodeModules, 'junction');
        } catch (_) {
          // Fallback if symlink fails
        }
      }

      // Overlay staged diff contents inside sandbox
      for (const diff of stagedDiffs) {
        const filePath = diff.file_path || diff.filePath;
        const stagedContent = diff.staged_content !== undefined ? diff.staged_content : diff.content;
        if (filePath && stagedContent !== undefined && stagedContent !== null) {
          const destPath = path.resolve(sandboxDir, filePath);
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.writeFileSync(destPath, stagedContent, 'utf-8');
        }
      }

      // Run verification command inside sandbox via KruschSandbox
      const result = await KruschSandbox.run({
        command: effectiveCommand,
        cwd: sandboxDir,
        stagedDir: sandboxDir,
        stagedDiffs,
        options: {
          ...options,
          allowedCommand: contract?.command,
          verificationCommand: options.verificationCommand || contract?.command,
          timeoutMs
        }
      });
      result.stagedTreeExecuted = true;
      result.extractedErrors = KruschTestRunner.parseErrors(result.stdout, result.stderr);
      return result;
    } finally {
      // Clean up sandbox directory
      try {
        fs.rmSync(sandboxDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }

  /**
   * Helper to recursively copy directories with exclusions
   */
  static copyTree(src, dest, options = {}) {
    const excludeDirs = options.excludeDirs || ['.git'];
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        if (!excludeDirs.includes(entry.name)) {
          KruschVerificationContract.copyTree(srcPath, destPath, options);
        }
      } else if (entry.isFile()) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}
