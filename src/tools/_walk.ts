/**
 * 共享：遍历 recall-vault 根目录下所有 .md 文件
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export async function* walkMdFiles(rootDir: string): AsyncGenerator<string> {
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          yield full;
        }
      }
    } catch { /* skip */ }
  }
}
