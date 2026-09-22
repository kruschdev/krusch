import fs from 'fs';
import path from 'path';
import { query } from './pool.js';

/**
 * Krusch AST and Structural Symbol Indexer
 * Extracts functions, classes, methods, interfaces, types, and enums
 * with precise line numbers and signatures across JS/TS, Python, Go, and Rust.
 */
export class KruschSymbolIndexer {
  /**
   * Index symbols across a project or specific file set into krusch_code_symbols.
   */
  static async indexProject(projectPath, options = {}) {
    const maxFiles = options.maxFiles || 150;
    const targetFiles = options.files || KruschSymbolIndexer.discoverSourceFiles(projectPath, maxFiles);

    let indexedCount = 0;
    for (const filePath of targetFiles) {
      const fullPath = path.isAbsolute(filePath) ? filePath : path.join(projectPath, filePath);
      const relPath = path.relative(projectPath, fullPath).replace(/\\/g, '/');

      const symbols = KruschSymbolIndexer.extractSymbolsFromFile(fullPath, relPath, projectPath);
      for (const sym of symbols) {
        try {
          await query(
            `INSERT INTO krusch_code_symbols (project_path, file_path, symbol_name, symbol_type, start_line, end_line, signature)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (project_path, file_path, symbol_name, start_line)
             DO UPDATE SET
               symbol_type = EXCLUDED.symbol_type,
               end_line = EXCLUDED.end_line,
               signature = EXCLUDED.signature,
               created_at = CURRENT_TIMESTAMP`,
            [
              sym.project_path,
              sym.file_path,
              sym.symbol_name,
              sym.symbol_type,
              sym.start_line,
              sym.end_line,
              sym.signature
            ]
          );
          indexedCount++;
        } catch (_) {}
      }
    }

    return { filesScanned: targetFiles.length, symbolsIndexed: indexedCount };
  }

  /**
   * Snapshot symbols specifically associated with a task for reproducible context and replay.
   */
  static async snapshotTaskSymbols(taskId, projectPath, filePaths = []) {
    if (!filePaths || filePaths.length === 0) return 0;

    let snapshotCount = 0;
    for (const relPath of filePaths) {
      const fullPath = path.resolve(projectPath, relPath);
      const symbols = KruschSymbolIndexer.extractSymbolsFromFile(fullPath, relPath, projectPath);

      for (const sym of symbols) {
        try {
          await query(
            `INSERT INTO krusch_task_symbols (task_id, file_path, symbol_name, symbol_type, start_line, end_line, signature)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              taskId,
              sym.file_path,
              sym.symbol_name,
              sym.symbol_type,
              sym.start_line,
              sym.end_line,
              sym.signature
            ]
          );
          snapshotCount++;
        } catch (_) {}
      }
    }

    return snapshotCount;
  }

  /**
   * Discover source code files across project hierarchy.
   */
  static discoverSourceFiles(dir, maxFiles = 150) {
    const files = [];

    function walk(currentDir) {
      if (files.length >= maxFiles) return;
      let entries = [];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch (_) {
        return;
      }

      for (const entry of entries) {
        if (
          entry.name.startsWith('.') ||
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === 'coverage' ||
          entry.name === 'build'
        ) {
          continue;
        }

        const full = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && /\.(js|ts|jsx|tsx|mjs|cjs|py|go|rs)$/.test(entry.name)) {
          files.push(full);
          if (files.length >= maxFiles) break;
        }
      }
    }

    walk(dir);
    return files;
  }

  /**
   * Extract code symbols with precise signatures and line spans.
   */
  static extractSymbolsFromFile(filePath, relativePath, projectPath) {
    const symbols = [];
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (_) {
      return symbols;
    }

    const ext = path.extname(filePath).toLowerCase();
    const lines = content.split('\n');

    if (['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'].includes(ext)) {
      KruschSymbolIndexer._extractJsTsSymbols(lines, relativePath, projectPath, symbols);
    } else if (ext === '.py') {
      KruschSymbolIndexer._extractPythonSymbols(lines, relativePath, projectPath, symbols);
    } else if (ext === '.go') {
      KruschSymbolIndexer._extractGoSymbols(lines, relativePath, projectPath, symbols);
    } else if (ext === '.rs') {
      KruschSymbolIndexer._extractRustSymbols(lines, relativePath, projectPath, symbols);
    }

    return symbols;
  }

  /**
   * Extract JS/TS symbols (functions, methods, classes, interfaces, types, enums)
   */
  static _extractJsTsSymbols(lines, relativePath, projectPath, symbols) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const lineNum = i + 1;

      // Skip comments
      if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;

      // 1. Function declarations: [export] [default] [async] function name(args) [: returnType]
      const funcMatch = line.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*([a-zA-Z0-9_$]+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)/);
      if (funcMatch) {
        symbols.push({
          project_path: projectPath,
          file_path: relativePath,
          symbol_name: funcMatch[1],
          symbol_type: 'function',
          start_line: lineNum,
          end_line: lineNum,
          signature: `function ${funcMatch[1]}(${funcMatch[2].trim()})`
        });
        continue;
      }

      // 2. Class declarations: [export] [default] class Name [extends Base] [implements Interface]
      const classMatch = line.match(/^(?:export\s+)?(?:default\s+)?class\s+([a-zA-Z0-9_$]+)(?:\s+extends\s+([a-zA-Z0-9_$]+))?/);
      if (classMatch) {
        symbols.push({
          project_path: projectPath,
          file_path: relativePath,
          symbol_name: classMatch[1],
          symbol_type: 'class',
          start_line: lineNum,
          end_line: lineNum,
          signature: classMatch[2] ? `class ${classMatch[1]} extends ${classMatch[2]}` : `class ${classMatch[1]}`
        });
        continue;
      }

      // 3. TypeScript Interface: [export] interface Name [extends Base]
      const ifaceMatch = line.match(/^(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)(?:\s+extends\s+([a-zA-Z0-9_$,\s]+))?/);
      if (ifaceMatch) {
        symbols.push({
          project_path: projectPath,
          file_path: relativePath,
          symbol_name: ifaceMatch[1],
          symbol_type: 'interface',
          start_line: lineNum,
          end_line: lineNum,
          signature: ifaceMatch[2] ? `interface ${ifaceMatch[1]} extends ${ifaceMatch[2].trim()}` : `interface ${ifaceMatch[1]}`
        });
        continue;
      }

      // 4. TypeScript Type alias: [export] type Name = ...
      const typeMatch = line.match(/^(?:export\s+)?type\s+([a-zA-Z0-9_$]+)\s*=/);
      if (typeMatch) {
        symbols.push({
          project_path: projectPath,
          file_path: relativePath,
          symbol_name: typeMatch[1],
          symbol_type: 'type',
          start_line: lineNum,
          end_line: lineNum,
          signature: `type ${typeMatch[1]}`
        });
        continue;
      }

      // 5. TypeScript Enum: [export] enum Name
      const enumMatch = line.match(/^(?:export\s+)?enum\s+([a-zA-Z0-9_$]+)/);
      if (enumMatch) {
        symbols.push({
          project_path: projectPath,
          file_path: relativePath,
          symbol_name: enumMatch[1],
          symbol_type: 'enum',
          start_line: lineNum,
          end_line: lineNum,
          signature: `enum ${enumMatch[1]}`
        });
        continue;
      }

      // 6. Exported const/let arrow or function assignments
      const exportVarMatch = line.match(/^(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*(?::\s*[^=]+)?\s*=\s*(\([^)]*\)\s*=>|async\s*\([^)]*\)\s*=>)?/);
      if (exportVarMatch) {
        const isArrow = Boolean(exportVarMatch[2]);
        symbols.push({
          project_path: projectPath,
          file_path: relativePath,
          symbol_name: exportVarMatch[1],
          symbol_type: isArrow ? 'function' : 'constant',
          start_line: lineNum,
          end_line: lineNum,
          signature: isArrow ? `const ${exportVarMatch[1]} = ${exportVarMatch[2].trim()}` : `const ${exportVarMatch[1]}`
        });
        continue;
      }

      // 7. Class methods: [static] [async] methodName(args) [: returnType] {
      const methodMatch = line.match(/^(?:static\s+)?(?:async\s+)?([a-zA-Z0-9_$]+)\s*\(([^)]*)\)(?:\s*:\s*[^{]+)?\s*\{/);
      if (methodMatch && !['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(methodMatch[1])) {
        symbols.push({
          project_path: projectPath,
          file_path: relativePath,
          symbol_name: methodMatch[1],
          symbol_type: 'method',
          start_line: lineNum,
          end_line: lineNum,
          signature: `${methodMatch[1]}(${methodMatch[2].trim()})`
        });
      }
    }
  }

  /**
   * Extract Python symbols (def, class)
   */
  static _extractPythonSymbols(lines, relativePath, projectPath, symbols) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const trimmed = line.trim();

      // def function_or_method(args):
      const defMatch = trimmed.match(/^def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
      if (defMatch) {
        const isMethod = line.startsWith('    ') || line.startsWith('\t');
        symbols.push({
          project_path: projectPath,
          file_path: relativePath,
          symbol_name: defMatch[1],
          symbol_type: isMethod ? 'method' : 'function',
          start_line: lineNum,
          end_line: lineNum,
          signature: `def ${defMatch[1]}(${defMatch[2].trim()})`
        });
        continue;
      }

      // class ClassName(Base):
      const classMatch = trimmed.match(/^class\s+([a-zA-Z0-9_]+)(?:\(([^)]*)\))?:/);
      if (classMatch) {
        symbols.push({
          project_path: projectPath,
          file_path: relativePath,
          symbol_name: classMatch[1],
          symbol_type: 'class',
          start_line: lineNum,
          end_line: lineNum,
          signature: classMatch[2] ? `class ${classMatch[1]}(${classMatch[2]})` : `class ${classMatch[1]}`
        });
      }
    }
  }

  /**
   * Extract Go symbols (func, type struct/interface)
   */
  static _extractGoSymbols(lines, relativePath, projectPath, symbols) {
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      const lineNum = i + 1;

      const funcMatch = trimmed.match(/^func\s+(?:\([^)]+\)\s+)?([a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
      if (funcMatch) {
        symbols.push({
          project_path: projectPath,
          file_path: relativePath,
          symbol_name: funcMatch[1],
          symbol_type: 'function',
          start_line: lineNum,
          end_line: lineNum,
          signature: `func ${funcMatch[1]}(${funcMatch[2].trim()})`
        });
        continue;
      }

      const typeMatch = trimmed.match(/^type\s+([a-zA-Z0-9_]+)\s+(struct|interface)/);
      if (typeMatch) {
        symbols.push({
          project_path: projectPath,
          file_path: relativePath,
          symbol_name: typeMatch[1],
          symbol_type: typeMatch[2],
          start_line: lineNum,
          end_line: lineNum,
          signature: `type ${typeMatch[1]} ${typeMatch[2]}`
        });
      }
    }
  }

  /**
   * Extract Rust symbols (fn, struct, enum, trait)
   */
  static _extractRustSymbols(lines, relativePath, projectPath, symbols) {
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      const lineNum = i + 1;

      const fnMatch = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)/);
      if (fnMatch) {
        symbols.push({
          project_path: projectPath,
          file_path: relativePath,
          symbol_name: fnMatch[1],
          symbol_type: 'function',
          start_line: lineNum,
          end_line: lineNum,
          signature: `fn ${fnMatch[1]}(${fnMatch[2].trim()})`
        });
        continue;
      }

      const typeMatch = trimmed.match(/^(?:pub\s+)?(struct|enum|trait)\s+([a-zA-Z0-9_]+)/);
      if (typeMatch) {
        symbols.push({
          project_path: projectPath,
          file_path: relativePath,
          symbol_name: typeMatch[2],
          symbol_type: typeMatch[1],
          start_line: lineNum,
          end_line: lineNum,
          signature: `${typeMatch[1]} ${typeMatch[2]}`
        });
      }
    }
  }
}
