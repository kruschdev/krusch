/**
 * Diff & Unified Patch Generator (Myers Algorithm)
 * Generates PR-ready unified diff patches fully compatible with `git apply`.
 */

export function computeLCS(aLines, bLines) {
  const n = aLines.length;
  const m = bLines.length;

  // Compute longest common subsequence matrix
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (aLines[i] === bLines[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // Backtrack to build diff edits
  const edits = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      edits.push({ type: 'equal', text: aLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      edits.push({ type: 'add', text: bLines[j - 1] });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      edits.push({ type: 'delete', text: aLines[i - 1] });
      i--;
    }
  }

  return edits.reverse();
}

export function generateUnifiedDiff(filePath, oldContent = '', newContent = '', contextLines = 3) {
  // If both empty or identical, return empty string
  if (oldContent === newContent) {
    return '';
  }

  const isNewFile = !oldContent && Boolean(newContent);
  const isDeletedFile = Boolean(oldContent) && !newContent;

  const rawOld = oldContent || '';
  const rawNew = newContent || '';

  const aLines = rawOld.length > 0 ? (rawOld.endsWith('\n') ? rawOld.slice(0, -1) : rawOld).split('\n') : [];
  const bLines = rawNew.length > 0 ? (rawNew.endsWith('\n') ? rawNew.slice(0, -1) : rawNew).split('\n') : [];

  let patchHeader = `diff --git a/${filePath} b/${filePath}\n`;
  if (isNewFile) {
    patchHeader += `new file mode 100644\n--- /dev/null\n+++ b/${filePath}\n`;
  } else if (isDeletedFile) {
    patchHeader += `deleted file mode 100644\n--- a/${filePath}\n+++ /dev/null\n`;
  } else {
    patchHeader += `--- a/${filePath}\n+++ b/${filePath}\n`;
  }

  const edits = computeLCS(aLines, bLines);

  // Group edits into hunks with contextLines
  const hunks = [];
  let currentHunk = null;
  let oldLine = 1;
  let newLine = 1;

  for (let idx = 0; idx < edits.length; idx++) {
    const edit = edits[idx];

    if (edit.type === 'delete' || edit.type === 'add') {
      if (!currentHunk) {
        // Start a new hunk, gathering preceding context
        const contextStart = Math.max(0, idx - contextLines);
        const leadingContext = [];

        for (let k = contextStart; k < idx; k++) {
          if (edits[k].type === 'equal') {
            leadingContext.push({ type: 'equal', text: edits[k].text });
          }
        }

        const hunkOldStart = Math.max(1, oldLine - leadingContext.length);
        const hunkNewStart = Math.max(1, newLine - leadingContext.length);

        currentHunk = {
          oldStart: hunkOldStart,
          newStart: hunkNewStart,
          lines: [...leadingContext]
        };
      }

      currentHunk.lines.push(edit);

      if (edit.type === 'delete') oldLine++;
      if (edit.type === 'add') newLine++;
    } else {
      // Equal line
      if (currentHunk) {
        // Check if there are further modifications within 2 * contextLines
        let hasUpcomingChanges = false;
        for (let k = idx; k < Math.min(edits.length, idx + contextLines * 2); k++) {
          if (edits[k].type !== 'equal') {
            hasUpcomingChanges = true;
            break;
          }
        }

        if (hasUpcomingChanges) {
          currentHunk.lines.push(edit);
        } else {
          // Add trailing context lines and finalize hunk
          for (let k = idx; k < Math.min(edits.length, idx + contextLines); k++) {
            if (edits[k].type === 'equal') {
              currentHunk.lines.push(edits[k]);
            }
          }
          hunks.push(currentHunk);
          currentHunk = null;
        }
      }

      oldLine++;
      newLine++;
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  if (hunks.length === 0) return '';

  let patch = patchHeader;

  for (const hunk of hunks) {
    let oldCount = 0;
    let newCount = 0;

    for (const l of hunk.lines) {
      if (l.type === 'equal' || l.type === 'delete') oldCount++;
      if (l.type === 'equal' || l.type === 'add') newCount++;
    }

    patch += `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@\n`;

    for (const l of hunk.lines) {
      if (l.type === 'equal') {
        patch += ` ${l.text}\n`;
      } else if (l.type === 'delete') {
        patch += `-${l.text}\n`;
      } else if (l.type === 'add') {
        patch += `+${l.text}\n`;
      }
    }
  }

  return patch;
}
