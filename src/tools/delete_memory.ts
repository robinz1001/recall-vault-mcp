/**
 * delete_memory — 删除记忆（硬删，不可逆）
 *
 * 警告：硬删。Batch 2 简化方案，不做回收站。
 * 工具 description 里已明确 "Permanently deletes. No recovery."
 */

import fs from 'node:fs/promises';
import { readMemory } from '../storage/frontmatter.js';
import { logger } from '../logger.js';
import { walkMdFiles } from './_walk.js';
import { getFtsIndex } from '../storage/fts.js';

export interface DeleteArgs {
  memory_id: string;
  scope?: 'project' | 'shared';
  project_id?: string;
}

export interface DeleteResult {
  memory_id: string;
  path: string;
  deleted: boolean;
}

export async function deleteMemory(args: DeleteArgs): Promise<DeleteResult> {
  const vault = new (await import('../storage/vault.js')).VaultManager();
  const candidates: string[] = [];

  for await (const fp of walkMdFiles(vault.root)) {
    const entry = await readMemory(fp);
    if (!entry || entry.meta.id !== args.memory_id) continue;
    if (args.scope && entry.meta.scope !== args.scope) continue;
    if (args.project_id && entry.meta.project_id !== args.project_id) continue;
    candidates.push(fp);
  }

  if (candidates.length === 0) throw new Error(`Memory not found: ${args.memory_id}`);
  if (candidates.length > 1) {
    throw new Error(
      `Ambiguous memory_id: ${args.memory_id} matches ${candidates.length} files. Provide scope/project_id.`,
    );
  }

  const target = candidates[0];
  await fs.unlink(target);
  getFtsIndex().deleteByPath(target); // FTS5 同步钩子
  logger.info('delete_memory:', args.memory_id, '→', target);

  return { memory_id: args.memory_id, path: target, deleted: true };
}
