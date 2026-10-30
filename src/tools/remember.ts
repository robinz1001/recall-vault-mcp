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
  /** v0.4.0: 可选。不传则自动推断（默认 semantic） */
  memory_type?: MemoryType;
  /** v0.4.0: 可选。不传则自动推断（默认 project） */
  scope?: MemoryScope;
  /** v0.4.0: 可选。不传则从 cwd 自动推断 */
  project_id?: string;
  session_id?: string;
  agent?: MemoryAgent;
  /** v0.4.0: 可选。不传则从 content 自动提取 */
  tags?: string[];
  related_files?: string[];
  /** v0.4.0: 可选。不传则自动推断（默认 2） */
  priority?: MemoryPriority;
  append_to?: string;
  replaces?: string;
}

/**
 * 自动推断记忆元数据
 *
 * 规则（保守优先，错了 agent 可以手动覆盖）：
 * - memory_type: 含"session/会话/本次" → episodic；默认 semantic
 * - scope: 含"通用/可复用/任何项目/跨项目" → shared；默认 project
 * - priority: 含"坑/错误/修复/踩坑/崩溃/bug/debug/非显而易见" → 3；默认 2
 * - tags: 从关键词表提取（命中则加）
 */
export function inferMemoryMeta(content: string): Partial<{
  memory_type: MemoryType;
  scope: MemoryScope;
  priority: MemoryPriority;
  tags: string[];
}> {
  const c = content.toLowerCase();

  // memory_type
  let memoryType: MemoryType | undefined;
  if (/session|会话|本次|今天/.test(content)) memoryType = 'episodic';

  // scope
  let scope: MemoryScope | undefined;
  if (/(通用|可复用|任何项目|跨项目|所有项目|shared|cross.project|reusable)/i.test(content)) {
    scope = 'shared';
  }

  // priority
  let priority: MemoryPriority | undefined;
  if (/(坑|错误|修复|踩坑|崩溃|bug|debug|非显而易见|access violation|crash|workaround|hack|tricky|gotcha|pitfall|non-obvious)/i.test(content)) {
    priority = 3;
  }

  // tags — 关键词映射（保守，命中才加）
  const tagMap: Record<string, string> = {
    决策: '决策', decision: '决策',
    架构: '架构', architecture: '架构',
    选型: '选型', choice: '选型',
    坑: '踩坑', 踩坑: '踩坑', bug: 'bug', 错误: 'bug', 修复: 'bug',
    debug: 'debug', 定位: 'debug',
    性能: '性能', performance: '性能',
    安全: '安全', security: '安全',
    mcp: 'MCP',
    vite: 'vite', esbuild: 'esbuild', tsc: 'TypeScript', typescript: 'TypeScript',
    react: 'React', vue: 'Vue', node: 'Node', electron: 'Electron',
    windows: 'Windows', linux: 'Linux', mac: 'macOS',
  };
  const tags = new Set<string>();
  for (const [kw, tag] of Object.entries(tagMap)) {
    if (c.includes(kw.toLowerCase())) tags.add(tag);
  }

  return {
    ...(memoryType ? { memory_type: memoryType } : {}),
    ...(scope ? { scope } : {}),
    ...(priority ? { priority } : {}),
    tags: Array.from(tags),
  };
}

export interface RememberResult {
  memory_id: string;
  path: string;
  created: boolean;
  superseded?: string;
  inferred?: {
    memory_type?: boolean;
    scope?: boolean;
    priority?: boolean;
    project_id?: boolean;
    tags?: boolean;
  };
}

const MEMORY_TITLE_MAX_LEN = 80;

export async function remember(args: RememberArgs): Promise<RememberResult> {
  const vault = new VaultManager();
  const now = new Date().toISOString();

  // === 自动推断 ===
  const inferred = inferMemoryMeta(args.content);
  const memoryType: MemoryType = args.memory_type ?? inferred.memory_type ?? 'semantic';
  const scope: MemoryScope = args.scope ?? inferred.scope ?? 'project';
  const priority: MemoryPriority = args.priority ?? inferred.priority ?? 2;
  const autoTags = inferred.tags ?? [];
  const mergedTags = args.tags && args.tags.length > 0
    ? Array.from(new Set([...args.tags, ...autoTags]))
    : autoTags;

  // project_id 自动推断
  const autoProjectId = vault.inferProjectId();
  const projectId = args.project_id ?? autoProjectId;

  // === scope + memory_type 校验 ===
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
    const safePid = projectId.replace(/[\\/]/g, '_');
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
    priority,
    agent: args.agent ?? 'manual',
    session_id: args.session_id,
    reviewed: memoryType === 'semantic' ? false : undefined,
    tags: mergedTags,
    related_files: args.related_files ?? [],
    valid_from: now,
    valid_to: undefined,
    supersedes: supersededId,
  };

  // 过滤掉 undefined 字段——js-yaml 不接受
  const meta = Object.fromEntries(
    Object.entries(rawMeta).filter(([, v]) => v !== undefined),
  ) as unknown as MemoryMeta;

  await writeMemory(filePath, meta, args.content);
  logger.info('Remember create:', id, scope, memoryType, supersededId ? `supersedes=${supersededId}` : '', '→', filePath);
  getFtsIndex().upsertByPath(filePath); // FTS5 同步钩子

  // 哪些字段是推断出来的（agent 没显式传）
  const inferredFields: RememberResult['inferred'] = {
    memory_type: !args.memory_type,
    scope: !args.scope,
    priority: args.priority === undefined,
    project_id: !args.project_id,
    tags: !args.tags || args.tags.length === 0,
  };

  return {
    memory_id: id,
    path: filePath,
    created: true,
    superseded: supersededId,
    inferred: inferredFields,
  };
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
