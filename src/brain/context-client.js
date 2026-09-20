import fs from 'fs';
import path from 'path';
import { query } from './pool.js';

export class KruschContextClient {
  /**
   * Assemble grounded context for a prompt or file scope.
   */
  static async assembleContext(projectPath, queryText = '', options = {}) {
    const symbolMatches = await this.searchCodeSymbols(queryText, options.limit || 10);
    const recentMemories = await this.getRecentMemories(5);
    const repoFiles = await this.getProjectFiles(projectPath, options.maxFiles || 50);

    const formattedTree = this.formatRepoTree(repoFiles, 30);
    const formattedSymbols = this.formatSymbols(symbolMatches);

    return {
      symbols: symbolMatches,
      memories: recentMemories,
      files: repoFiles,
      formattedTree,
      formattedSymbols,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Format a list of relative file paths into a structured, token-bounded tree.
   */
  static formatRepoTree(files, maxLines = 30) {
    if (!files || files.length === 0) return 'No repository files found.';
    const displayed = files.slice(0, maxLines);
    const lines = displayed.map(f => `  ├── ${f}`);
    if (files.length > maxLines) {
      lines.push(`  └── ... (${files.length - maxLines} more files omitted for brevity)`);
    }
    return lines.join('\n');
  }

  /**
   * Format AST code symbols as concise signatures instead of raw JSON dumps.
   */
  static formatSymbols(symbols) {
    if (!symbols || symbols.length === 0) return 'None detected for active query.';
    return symbols.map(s => {
      const loc = `${s.file_path}:${s.start_line}-${s.end_line}`;
      const sig = s.signature ? ` -> ${s.signature}` : '';
      return `- [${s.symbol_type || 'symbol'}] ${s.symbol_name}${sig} (${loc})`;
    }).join('\n');
  }

  /**
   * Build a token-budgeted markdown context block for the system prompt.
   */
  static formatContextPrompt(context) {
    return `### Repository Structure:
${context.formattedTree}

### Relevant Symbols (AST / Vector Search):
${context.formattedSymbols}`;
  }

  /**
   * Search code symbols in PostgreSQL via exact match, trigram, or tsvector.
   */
  static async searchCodeSymbols(queryTerm, limit = 10) {
    if (!queryTerm || queryTerm.trim() === '') return [];
    try {
      const sql = `
        SELECT file_path, symbol_name, symbol_type, start_line, end_line, signature
        FROM code_symbols
        WHERE symbol_name ILIKE $1 OR signature ILIKE $1
        ORDER BY LENGTH(symbol_name) ASC
        LIMIT $2;
      `;
      const res = await query(sql, [`%${queryTerm.trim()}%`, limit]);
      return res.rows;
    } catch (err) {
      return [];
    }
  }

  /**
   * Retrieve recent episodic memories from PostgreSQL.
   */
  static async getRecentMemories(limit = 5) {
    try {
      const sql = `
        SELECT id, content, category, tags, project, created_at
        FROM ide_agent_memory
        ORDER BY created_at DESC
        LIMIT $1;
      `;
      const res = await query(sql, [limit]);
      return res.rows;
    } catch (err) {
      return [];
    }
  }

  /**
   * Scan local repository file tree to ground the model.
   */
  static async getProjectFiles(projectPath, maxFiles = 50) {
    const files = [];
    if (!fs.existsSync(projectPath)) return files;

    function walk(dir) {
      if (files.length >= maxFiles) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(projectPath, fullPath);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          files.push(relPath);
          if (files.length >= maxFiles) break;
        }
      }
    }

    try {
      walk(projectPath);
    } catch (e) {
      // Ignore scan errors
    }
    return files;
  }
}
