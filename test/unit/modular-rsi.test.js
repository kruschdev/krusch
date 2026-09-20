import test from 'node:test';
import assert from 'node:assert';
import { KruschModularRSI, KruschFailureClassifier, RSI_MODULES } from '../../src/workflow/modular-rsi.js';

test('KruschModularRSI: attributes missing module to ContextManagement', () => {
  const testRun = {
    stdout: 'Error: Cannot find module "./missing-helper.js"',
    stderr: 'ERR_MODULE_NOT_FOUND'
  };

  const attr = KruschModularRSI.attributeFailure(testRun);
  assert.strictEqual(attr.module, RSI_MODULES.CONTEXT_MGMT);
  assert.ok(attr.remediation.includes('AST symbol'));
});

test('KruschModularRSI: attributes syntax error to ToolUse', () => {
  const testRun = {
    stdout: '',
    stderr: 'SyntaxError: Unexpected token "{" at line 14'
  };

  const attr = KruschModularRSI.attributeFailure(testRun);
  assert.strictEqual(attr.module, RSI_MODULES.TOOL_USE);
  assert.ok(attr.diagnosis.includes('Syntactic'));
});

test('KruschModularRSI: attributes assertion failure to ObservationManagement', () => {
  const testRun = {
    stdout: 'AssertionError [ERR_ASSERTION]: Expected 42, received 0',
    stderr: ''
  };

  const attr = KruschModularRSI.attributeFailure(testRun);
  assert.strictEqual(attr.module, RSI_MODULES.OBSERVATION_MGMT);
  assert.ok(attr.diagnosis.includes('mismatch'));
});

test('KruschFailureClassifier: alias provides identical classification API', () => {
  assert.strictEqual(KruschFailureClassifier, KruschModularRSI);
  const attr = KruschFailureClassifier.attributeFailure({ stderr: 'cannot find module "foo"' });
  assert.strictEqual(attr.module, RSI_MODULES.CONTEXT_MGMT);
});
