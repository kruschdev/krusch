import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { KruschSymbolIndexer } from '../../src/brain/ast-indexer.js';

test('AST Indexer: extracts JS and TS functions, classes, interfaces, and types', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-ast-test-'));
  const tsFile = path.join(testDir, 'models.ts');

  const content = `
export interface TaskState {
  id: string;
  phase: string;
}

export type PhaseType = 'PLAN' | 'IMPLEMENT' | 'VERIFY';

export enum TaskPriority {
  LOW,
  HIGH
}

export class TaskManager extends BaseManager {
  private taskId: string;

  constructor(id: string) {
    this.taskId = id;
  }

  async runWorkflow(step: number): Promise<boolean> {
    return true;
  }
}

export async function executeStep(task: TaskState): Promise<void> {
  // execute
}

export const calculateCost = (tokens: number) => tokens * 0.0001;
`;

  fs.writeFileSync(tsFile, content, 'utf-8');

  const symbols = KruschSymbolIndexer.extractSymbolsFromFile(tsFile, 'models.ts', testDir);
  const symbolMap = new Map(symbols.map(s => [s.symbol_name, s]));

  assert.ok(symbolMap.has('TaskState'));
  assert.strictEqual(symbolMap.get('TaskState').symbol_type, 'interface');

  assert.ok(symbolMap.has('PhaseType'));
  assert.strictEqual(symbolMap.get('PhaseType').symbol_type, 'type');

  assert.ok(symbolMap.has('TaskPriority'));
  assert.strictEqual(symbolMap.get('TaskPriority').symbol_type, 'enum');

  assert.ok(symbolMap.has('TaskManager'));
  assert.strictEqual(symbolMap.get('TaskManager').symbol_type, 'class');

  assert.ok(symbolMap.has('runWorkflow'));
  assert.strictEqual(symbolMap.get('runWorkflow').symbol_type, 'method');

  assert.ok(symbolMap.has('executeStep'));
  assert.strictEqual(symbolMap.get('executeStep').symbol_type, 'function');

  assert.ok(symbolMap.has('calculateCost'));
  assert.strictEqual(symbolMap.get('calculateCost').symbol_type, 'function');

  fs.rmSync(testDir, { recursive: true, force: true });
});

test('AST Indexer: extracts Python functions, methods, and classes', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-py-ast-'));
  const pyFile = path.join(testDir, 'agent.py');

  const content = `
class AgentExecutor(BaseExecutor):
    def __init__(self, name):
        self.name = name

    def execute(self, prompt: str):
        return prompt.upper()

def run_agent(goal: str):
    pass
`;

  fs.writeFileSync(pyFile, content, 'utf-8');

  const symbols = KruschSymbolIndexer.extractSymbolsFromFile(pyFile, 'agent.py', testDir);
  const names = symbols.map(s => s.symbol_name);

  assert.ok(names.includes('AgentExecutor'));
  assert.ok(names.includes('execute'));
  assert.ok(names.includes('run_agent'));

  fs.rmSync(testDir, { recursive: true, force: true });
});

test('AST Indexer: extracts Go and Rust symbols', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-poly-ast-'));

  const goFile = path.join(testDir, 'server.go');
  fs.writeFileSync(goFile, `
func HandleRequest(w ResponseWriter, r *Request) {
}

type Config struct {
}
`, 'utf-8');

  const rsFile = path.join(testDir, 'engine.rs');
  fs.writeFileSync(rsFile, `
pub async fn verify_patch(patch: &str) -> bool {
    true
}

pub struct PatchVerifier {
}
`, 'utf-8');

  const goSymbols = KruschSymbolIndexer.extractSymbolsFromFile(goFile, 'server.go', testDir);
  assert.ok(goSymbols.some(s => s.symbol_name === 'HandleRequest'));
  assert.ok(goSymbols.some(s => s.symbol_name === 'Config'));

  const rsSymbols = KruschSymbolIndexer.extractSymbolsFromFile(rsFile, 'engine.rs', testDir);
  assert.ok(rsSymbols.some(s => s.symbol_name === 'verify_patch'));
  assert.ok(rsSymbols.some(s => s.symbol_name === 'PatchVerifier'));

  fs.rmSync(testDir, { recursive: true, force: true });
});
