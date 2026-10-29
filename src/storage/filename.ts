/**
 * memory_id 生成器
 *
 * 格式：mem_YYYYMMDD_XXX（3 位序号，每天从 001 开始，vault 全局唯一）
 *
 * 关键：序号在 vault 范围内全局递增，不按目录重置。
 * 否则 episodic/semantic/shared 会出现不同目录下相同 id，导致
 * archive_memory / updateMemory 按 id 查找时歧义。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { VaultManager } from './vault.js';

const ID_PATTERN = /^mem_(\d{8})_(\d{3})\.md$/;

export function today(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${dd}`;
}

/**
 * 查找当天 vault 全局最大序号，+1 返回。
 * @param vaultRoot recall-vault 根目录的绝对路径
 */
export async function nextMemoryId(vaultRoot: string): Promise<string> {
  const todayStr = today();
  let maxSeq = 0;

  const dirsToScan: string[] = [];

  // 所有项目目录下的 episodic/semantic
  try {
    const projectsDir = path.join(vaultRoot, 'projects');
    const projectEntries = await fs.readdir(projectsDir, { withFileTypes: true });
    for (const proj of projectEntries) {
      if (proj.isDirectory()) {
        dirsToScan.push(path.join(projectsDir, proj.name, 'episodic'));
        dirsToScan.push(path.join(projectsDir, proj.name, 'semantic'));
      }
    }
  } catch { /* no projects yet */ }

  // shared/semantic
  dirsToScan.push(path.join(vaultRoot, 'shared', 'semantic'));

  for (const dir of dirsToScan) {
    try {
      const entries = await fs.readdir(dir);
      for (const name of entries) {
        const match = ID_PATTERN.exec(name);
        if (match && match[1] === todayStr) {
          const seq = parseInt(match[2], 10);
          if (seq > maxSeq) maxSeq = seq;
        }
      }
    } catch { /* dir doesn't exist yet */ }
  }

  const seq = String(maxSeq + 1).padStart(3, '0');
  return `mem_${todayStr}_${seq}`;
}

export function memoryFilePath(dirPath: string, id: string): string {
  return path.join(dirPath, `${id}.md`);
}
