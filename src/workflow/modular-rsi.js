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

export const RSI_ACTION_TYPES = {
  REFETCH_SYMBOLS: 'REFETCH_SYMBOLS',
  SWITCH_TOOL_NORMALIZER: 'SWITCH_TOOL_NORMALIZER',
  FORMAT_ASSERTION_DIFF: 'FORMAT_ASSERTION_DIFF',
  ESCALATE_TIER_OR_ABORT: 'ESCALATE_TIER_OR_ABORT'
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
      // Extract missing identifier if possible
      let missingSymbol = null;
      const modMatch = combined.match(/cannot find module ['"]([^'"]+)['"]/);
      const defMatch = combined.match(/([a-zA-Z0-9_$]+) is not defined/);
      if (modMatch) missingSymbol = modMatch[1];
      else if (defMatch) missingSymbol = defMatch[1];

      return {
        module: RSI_MODULES.CONTEXT_MGMT,
        actionType: RSI_ACTION_TYPES.REFETCH_SYMBOLS,
        missingSymbol,
        diagnosis: 'Dependency or symbol resolution failure. The model lacked file/import context.',
        remediation: 'Inject missing AST symbol definitions, file paths, and package imports into the next turn prompt.'
      };
    }

    // 2. Syntax errors, invalid JSON, or invalid tool params -> ToolUse
    if (
      combined.includes('syntaxerror') ||
      combined.includes('unexpected token') ||
      combined.includes('invalid tool call') ||
      combined.includes('typeerror: cannot read properties')
    ) {
      return {
        module: RSI_MODULES.TOOL_USE,
        actionType: RSI_ACTION_TYPES.SWITCH_TOOL_NORMALIZER,
        diagnosis: 'Syntactic or parameter formatting error in code patch or tool execution.',
        remediation: 'Provide exact line-level syntax diagnostics and require strict AST verification.'
      };
    }

    // 3. Assertion failures, test expectation mismatches -> ObservationManagement
    if (
      combined.includes('assertionerror') ||
      (combined.includes('expected') && combined.includes('received')) ||
      combined.includes('failed')
    ) {
      return {
        module: RSI_MODULES.OBSERVATION_MGMT,
        actionType: RSI_ACTION_TYPES.FORMAT_ASSERTION_DIFF,
        diagnosis: 'Logical behavioral mismatch against ground-truth test assertions.',
        remediation: 'Present the exact failing assertion diff to the model with instruction to preserve invariants.'
      };
    }

    // Default attribution -> AgentLoop
    return {
      module: RSI_MODULES.AGENT_LOOP,
      actionType: RSI_ACTION_TYPES.ESCALATE_TIER_OR_ABORT,
      diagnosis: 'Execution did not satisfy verification criteria within allotted turn budget.',
      remediation: 'Escalate to higher reasoning model tier or reformulate planning hypothesis.'
    };
  }
}
