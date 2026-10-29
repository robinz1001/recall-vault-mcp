/**
 * remember — 写入记忆
 *
 * 两种模式：
 * 1. 新建：不传 append_to → 生成 memory_id → 写新文件
 * 2. 追加：传 append_to → 找已有记忆 → 追加正文 → 更新 updated_at
 */

import { VaultManager } from '../storage/vault.js';
import { nextMemoryId, memoryFilePath } from '../storage/filename.js';
import { writeMemory, readMemory, appendToMemory } from '../storage/frontmatter.js';
import { logger } from '../logger.js';
import { getFtsIndex } from '../storage/fts.js';
import type {
  MemoryMeta,
  MemoryType,
  MemoryScope,
  MemoryAgent,
  MemoryPriority,
} from '../types.js';

export interface RememberArgs {
  content: string;
  memory_type: MemoryType;
  scope?: MemoryScope;
  project_id?: string;
  session_id?: string;
  agent?: MemoryAgent;
  tags?: string[];
  related_files?: string[];
  priority?: MemoryPriority;
  append_to?: string;
  /** Phase 2: 取代旧记忆（事实变更场景）。旧记忆 valid_to 自动设为 now + superseded_by=<新id> */
  replaces?: string;
}

export interface RememberResult {
  memory_id: string;
  path: string;
  created: boolean; // true=新建, false=追加
  /** Phase 2: 如果 replaces 了某条旧记忆，这里返回旧记忆 id */
  superseded?: string;
}

const MEMORY_TITLE_MAX_LEN = 80;

export async function remember(args: RememberArgs): Promise<RememberResult> {
  const vault = new VaultManager();
  const now = new Date().toISOString();

  // === scope + memory_type 校验 ===
  const scope: MemoryScope = args.scope ?? 'project';
  const memoryType: MemoryType = args.memory_type;

  if (memoryType === 'episodic' && scope === 'shared') {
    throw new Error('episodic memories cannot have scope=shared — session context is project-bound');
  }

  // === 确定目录 ===
  let dirPath: string;
  let effectiveProjectId: string;

  if (scope === 'shared') {
    dirPath = vault.getSharedSemanticDir();
    effectiveProjectId = 'shared';
  } else {
    const pid = args.project_id;
    if (!pid) throw new Error('project_id is required for scope=project memories');
    const safePid = pid.replace(/[\\/]/g, '_'); // 防止路径遍历
    const { episodic, semantic } = await vault.ensureProjectDir(safePid);
    dirPath = memoryType === 'episodic' ? episodic : semantic;
    effectiveProjectId = safePid;
  }

  // === 追加模式 ===
  if (args.append_to) {
    // 在整个 vault 里找这个 memory_id
    const target = await findMemoryById(vault, args.append_to);
    if (!target) {
      throw new Error(`Memory not found for append_to: ${args.append_to}`);
    }
    const appended = await appendToMemory(target.path, args.content);
    logger.info('Remember append:', args.append_to, '→', target.path);
    getFtsIndex().upsertByPath(target.path); // FTS5 同步钩子
    return {
      memory_id: args.append_to,
      path: target.path,
      created: false,
    };
  }

  // === 新建模式 ===
  const id = await nextMemoryId(vault.root);
  const filePath = memoryFilePath(dirPath, id);

  // Phase 2: replaces 流程 — 先关闭旧记忆
  let supersededId: string | undefined;
  if (args.replaces) {
    supersededId = await closeSupersededMemory(vault, args.replaces, id, now);
  }

  const rawMeta: Record<string, unknown> = {
    id,
    scope,
    project_id: effectiveProjectId,
    memory_type: memoryType,
    created_at: now,
    updated_at: now,
    archived: false,
    priority: args.priority ?? 2,
    agent: args.agent ?? 'manual',
    session_id: args.session_id,
    reviewed: memoryType === 'semantic' ? false : undefined,
    tags: args.tags ?? [],
    related_files: args.related_files ?? [],
    // Phase 2: 双时钟
    valid_from: now,
    valid_to: undefined, // 当前仍有效
    supersedes: supersededId, // 如果 replaces 了旧记忆，记录
  };

  // 过滤掉 undefined 字段——js-yaml 不接受
  const meta = Object.fromEntries(
    Object.entries(rawMeta).filter(([, v]) => v !== undefined),
  ) as unknown as MemoryMeta;

  await writeMemory(filePath, meta, args.content);
  logger.info('Remember create:', id, scope, memoryType, supersededId ? `supersedes=${supersededId}` : '', '→', filePath);
  getFtsIndex().upsertByPath(filePath); // FTS5 同步钩子

  return { memory_id: id, path: filePath, created: true, superseded: supersededId };
}

/**
 * Phase 2: 关闭被取代的旧记忆
 * 设 valid_to = now + superseded_by = <新记忆 id>
 * 如果旧记忆已有关闭标记，跳过（防重复操作）
 */
async function closeSupersededMemory(
  vault: VaultManager,
  oldId: string,
  newId: string,
  now: string,
): Promise<string | undefined> {
  const oldEntry = await findMemoryEntryById(vault, oldId);
  if (!oldEntry) {
    logger.warn('remember replaces: old memory not found:', oldId);
    return undefined;
  }
  if (oldEntry.meta.valid_to) {
    logger.warn('remember replaces: old memory already closed:', oldId);
    return undefined;
  }

  const oldMeta: Record<string, unknown> = {
    ...oldEntry.meta,
    valid_to: now,
    superseded_by: newId,
    updated_at: now,
  };
  await writeMemory(oldEntry.path, oldMeta as unknown as MemoryMeta, oldEntry.body);
  getFtsIndex().upsertByPath(oldEntry.path);
  logger.info('Remember replaces:', oldId, '→', newId, 'valid_to set');
  return oldId;
}

/** 在整个 vault 里查找一个 memory_id 对应的 entry（完整 entry） */
async function findMemoryEntryById(vault: VaultManager, memoryId: string) {
  const allMdFiles = await collectAllMdFiles(vault.root);
  for (const fp of allMdFiles) {
    const entry = await readMemory(fp);
    if (entry?.meta.id === memoryId) return entry;
  }
  return null;
}

/** 在整个 vault 里查找一个 memory_id 对应的文件（读 frontmatter id 字段） */
async function findMemoryById(vault: VaultManager, memoryId: string): Promise<{ path: string } | null> {
  const entry = await findMemoryEntryById(vault, memoryId);
  return entry ? { path: entry.path } : null;
}

async function collectAllMdFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (dir: string) => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          results.push(full);
        }
      }
    } catch {
      // 忽略无权限目录
    }
  };
  await walk(rootDir);
  return results;
}

// Node.js import
import fs from 'node:fs/promises';
import path from 'node:path';

export { findMemoryById };
