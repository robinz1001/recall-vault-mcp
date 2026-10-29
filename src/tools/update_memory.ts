/**
 * update_memory — 更新记忆
 *
 * 三种修改：
 * 1. content → 替换正文
 * 2. tags / related_files → 整个替换（简化方案，不做合并）
 * 3. reviewed / priority / archived 等 frontmatter 字段 → patch
 */

import { VaultManager } from '../storage/vault.js';
import { readMemory, writeMemory } from '../storage/frontmatter.js';
import { logger } from '../logger.js';
import { walkMdFiles } from './_walk.js';
import { getFtsIndex } from '../storage/fts.js';
import type { MemoryMeta } from '../types.js';

export interface UpdateArgs {
  memory_id: string;
  scope?: 'project' | 'shared';
  project_id?: string;
  content?: string;
  tags?: string[];
  related_files?: string[];
  reviewed?: boolean;
  priority?: 1 | 2 | 3;
  archived?: boolean;
}

export interface UpdateResult {
  memory_id: string;
  path: string;
  updated: string[]; // 哪些字段被改了
}

export async function updateMemory(args: UpdateArgs): Promise<UpdateResult> {
  const targetPath = await resolveMemoryFile(args.memory_id, args.scope, args.project_id);
  const entry = await readMemory(targetPath);
  if (!entry) throw new Error(`Memory not found: ${args.memory_id}`);

  const now = new Date().toISOString();
  const updated: string[] = [];

  const newBody = args.content !== undefined ? args.content.trim() : entry.body;
  if (args.content !== undefined) updated.push('content');

  // 用 null / undefined 标记哪些字段没传
  const rawMeta: Record<string, unknown> = {
    ...entry.meta,
    updated_at: now,
    tags: args.tags !== undefined ? args.tags : entry.meta.tags,
    related_files: args.related_files !== undefined ? args.related_files : entry.meta.related_files,
    reviewed: args.reviewed !== undefined ? args.reviewed : entry.meta.reviewed,
    priority: args.priority !== undefined ? args.priority : entry.meta.priority,
    archived: args.archived !== undefined ? args.archived : entry.meta.archived,
  };

  if (args.tags !== undefined) updated.push('tags');
  if (args.related_files !== undefined) updated.push('related_files');
  if (args.reviewed !== undefined) updated.push('reviewed');
  if (args.priority !== undefined) updated.push('priority');
  if (args.archived !== undefined) updated.push('archived');

  // 过滤 undefined
  const meta = Object.fromEntries(
    Object.entries(rawMeta).filter(([, v]) => v !== undefined),
  ) as unknown as MemoryMeta;

  await writeMemory(targetPath, meta, newBody);
  logger.info('update_memory:', args.memory_id, 'updated:', updated.join(', '));
  getFtsIndex().upsertByPath(targetPath); // FTS5 同步钩子

  return { memory_id: args.memory_id, path: targetPath, updated };
}

async function resolveMemoryFile(
  memoryId: string,
  scope?: 'project' | 'shared',
  projectId?: string,
): Promise<string> {
  const vault = new VaultManager();
  const candidates: string[] = [];
  for await (const fp of walkMdFiles(vault.root)) {
    const entry = await readMemory(fp);
    if (!entry || entry.meta.id !== memoryId) continue;
    if (scope && entry.meta.scope !== scope) continue;
    if (projectId && entry.meta.project_id !== projectId) continue;
    candidates.push(fp);
  }
  if (candidates.length === 0) throw new Error(`Memory not found: ${memoryId}`);
  if (candidates.length > 1) {
    throw new Error(
      `Ambiguous memory_id: ${memoryId} matches ${candidates.length} files. Provide scope/project_id.`,
    );
  }
  return candidates[0];
}
