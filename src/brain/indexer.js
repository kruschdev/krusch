import fs from 'fs';
import path from 'path';
import { query } from './pool.js';

export class KruschSymbolIndexer {
  /**
   * Walk projectPath and index exported AST/code symbols into krusch_code_symbols.
   */
  static async indexProject(projectPath, options = {}) {
    const maxFiles = options.maxFiles || 100;
    const files = [];

    function walk(dir) {
      if (files.length >= maxFiles) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const entry of entries) {
        if (
          entry.name.startsWith('.') ||
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === 'coverage'
        ) {
          continue;
        }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && /\.(js|ts|jsx|tsx|mjs|cjs)$/.test(entry.name)) {
          files.push(fullPath);
          if (files.length >= maxFiles) break;
        }
      }
    }

    walk(projectPath);

    let indexedCount = 0;
    for (const fullPath of files) {
      const relPath = path.relative(projectPath, fullPath).replace(/\\/g, '/');
      const symbols = this.extractSymbolsFromFile(fullPath, relPath, projectPath);
      for (const sym of symbols) {
        try {
          await query(
            `INSERT INTO krusch_code_symbols (project_path, file_path, symbol_name, symbol_type, start_line, end_line, signature)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
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
        } catch (_) {
          // Ignore duplicate / insert errors
        }
      }
    }

    return { filesScanned: files.length, symbolsIndexed: indexedCount };
  }

  /**
   * Extract code symbols with line numbers and signatures using regex parsing.
   */
  static extractSymbolsFromFile(filePath, relativePath, projectPath) {
    const symbols = [];
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (_) {
      return symbols;
    }

    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // 1. Function declarations: (export)? (async)? function name(args)
      const funcMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(([^)]*)\)/);
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

      // 2. Class declarations: (export)? class Name (extends Base)?
      const classMatch = line.match(/(?:export\s+)?class\s+([a-zA-Z0-9_$]+)(?:\s+extends\s+([a-zA-Z0-9_$]+))?/);
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

      // 3. Exported const/let arrow functions or constants: export const name = ...
      const exportConstMatch = line.match(/export\s+(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(\([^)]*\)\s*=>|async\s*\([^)]*\)\s*=>)?/);
      if (exportConstMatch) {
        const isArrow = Boolean(exportConstMatch[2]);
        symbols.push({
          project_path: projectPath,
          file_path: relativePath,
          symbol_name: exportConstMatch[1],
          symbol_type: isArrow ? 'function' : 'constant',
          start_line: lineNum,
          end_line: lineNum,
          signature: isArrow ? `const ${exportConstMatch[1]} = ${exportConstMatch[2].trim()}` : `const ${exportConstMatch[1]}`
        });
      }
    }

    return symbols;
  }
}
