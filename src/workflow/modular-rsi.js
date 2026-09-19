/**
 * Modular Recursive Self-Improvement (ModularRSI)
 * Decomposes agent trajectory and verification failures into 5 modular components,
 * providing structured error attribution and targeted repair instructions.
 */

export const RSI_MODULES = {
  AGENT_LOOP: 'AgentLoop',
  TOOL_USE: 'ToolUse',
  OBSERVATION_MGMT: 'ObservationManagement',
  CONTEXT_MGMT: 'ContextManagement',
  TASK_COMPLETION: 'TaskCompletionDetection'
};

export class KruschModularRSI {
  /**
   * Attribute a test or verification failure to a specific harness module.
   */
  static attributeFailure(testRun = {}) {
    const stdout = (testRun.stdout || '').toLowerCase();
    const stderr = (testRun.stderr || '').toLowerCase();
    const combined = `${stdout} ${stderr}`;

    // 1. Missing imports, modules, or unknown symbols -> ContextManagement
    if (
      combined.includes('cannot find module') ||
      combined.includes('err_module_not_found') ||
      combined.includes('is not defined') ||
      combined.includes('no such file or directory')
    ) {
      return {
        module: RSI_MODULES.CONTEXT_MGMT,
        diagnosis: 'Dependency or symbol resolution failure. The model lacked file/import context.',
        remediation: 'Inject missing AST symbol definitions, file paths, and package imports into the next turn prompt.'
      };
    }

    // 2. Syntax errors, invalid JSON, or invalid tool params -> ToolUse
    if (
      combined.includes('syntaxerror') ||
      combined.includes('unexpected token') ||
      combined.includes('invalid tool call') ||
      combined.includes('typeerror: Cannot read properties')
    ) {
      return {
        module: RSI_MODULES.TOOL_USE,
        diagnosis: 'Syntactic or parameter formatting error in code patch or tool execution.',
        remediation: 'Provide exact line-level syntax diagnostics and require strict AST verification.'
      };
    }

    // 3. Assertion failures, test expectation mismatches -> ObservationManagement or AgentLoop
    if (
      combined.includes('assertionerror') ||
      combined.includes('expected') && combined.includes('received') ||
      combined.includes('failed')
    ) {
      return {
        module: RSI_MODULES.OBSERVATION_MGMT,
        diagnosis: 'Logical behavioral mismatch against ground-truth test assertions.',
        remediation: 'Present the exact failing assertion diff to the model with instruction to preserve invariants.'
      };
    }

    // Default attribution
    return {
      module: RSI_MODULES.AGENT_LOOP,
      diagnosis: 'Execution did not satisfy verification criteria within allotted turn budget.',
      remediation: 'Escalate to higher reasoning model tier or reformulate planning hypothesis.'
    };
  }
}
