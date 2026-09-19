import { spawn } from 'child_process';

export class KruschTestRunner {
  /**
   * Run a test or lint command and capture structured ground truth.
   */
  static async runCommand(command, cwd = process.cwd(), timeoutMs = 60000) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const parts = command.split(' ');
      const proc = spawn(parts[0], parts.slice(1), {
        cwd,
        shell: true,
        env: { ...process.env, CI: 'true', FORCE_COLOR: '0' }
      });

      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve({
          command,
          exitCode: -1,
          stdout,
          stderr: `${stderr}\nCommand timed out after ${timeoutMs}ms.`,
          passed: false,
          durationMs: Date.now() - startTime
        });
      }, timeoutMs);

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (exitCode) => {
        clearTimeout(timer);
        const passed = exitCode === 0;
        resolve({
          command,
          exitCode: exitCode ?? -1,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          passed,
          durationMs: Date.now() - startTime
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          command,
          exitCode: -1,
          stdout,
          stderr: err.message,
          passed: false,
          durationMs: Date.now() - startTime
        });
      });
    });
  }
}
