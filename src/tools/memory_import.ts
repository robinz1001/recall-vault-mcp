/**
 * memory_import — 追溯索引导入
 *
 * Phase 4 新增
 * 来源：deja-vu 追溯索引模式（只做 2 种 driver）
 *
 * Driver 1: .trae/documents/ → 扫描 batch plan / spec / task 文档
 * Driver 2: docs/ → 扫描架构文档、研究报告
 *
 * 转换规则：每个文件 → 一个 semantic memory
 *   - memory_id = 文件 slug（architecture-design）
 *   - valid_from = 文件 mtime
 *   - agent = 'import'
 *   - tags = 从目录名推断
 *   - 幂等：memory_id 已存在则跳过
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { VaultManager } from '../storage/vault.js';
import { writeMemory } from '../storage/frontmatter.js';
import { logger } from '../logger.js';
import { getFtsIndex } from '../storage/fts.js';
import type { MemoryMeta } from '../types.js';

export interface ImportArgs {
  /** 默认 true. Driver 1: .trae/documents/ */
  from_trae_documents?: boolean;
  /** 默认 true. Driver 2: docs/ */
  from_docs?: boolean;
  /** scope project/shared，默认 project */
  scope?: 'project' | 'shared';
  /** 默认 project_id = vault basename */
  project_id?: string;
}

export interface ImportResult {
  driver: string;
  scanned: number;
  created: number;
  skipped: number;
  failed: number;
  duration_ms: number;
  errors: string[];
}

const DRIVERS = [
  { driver: 'trae-documents', label: '.trae/documents', subPath: ['.trae', 'documents'] },
  { driver: 'docs', label: 'docs/', subPath: ['docs'] },
] as const;

/** 文件名 → slug */
function slugify(filename: string): string {
  const name = path.basename(filename, path.extname(filename));
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

/** 从目录层级推断 tags */
function inferTags(fileRelPath: string): string[] {
  const parts = fileRelPath.split(path.sep).filter((p) => p && p !== 'documents' && p !== 'docs');
  const tags = parts.map((p) => slugify(p)).filter(Boolean);
  if (tags.length > 3) return tags.slice(0, 3);
  return tags;
}

/** 递归扫描目录下所有 .md / .txt / .spec 文件 */
async function walkImportFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const stat = await fsp.stat(dir);
    if (!stat.isDirectory()) return results;
  } catch {
    return results;
  }

  const queue = [dir];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        queue.push(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (['.md', '.txt', '.markdown', '.spec'].includes(ext)) {
          results.push(full);
        }
      }
    }
  }
  return results;
}

/** 把 driver 目录下的文件全导入 */
async function runDriver(
  driverName: string,
  driverLabel: string,
  driverRoot: string,
  vault: VaultManager,
  scope: 'project' | 'shared',
  projectId: string,
  existingIds: Set<string>,
): Promise<ImportResult> {
  const t0 = performance.now();
  const result: ImportResult = {
    driver: driverName,
    scanned: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    duration_ms: 0,
    errors: [],
  };

  const files = await walkImportFiles(driverRoot);
  result.scanned = files.length;

  const typeDir = path.join(
    vault.root,
    scope === 'shared' ? 'shared' : path.join('projects', projectId),
    'semantic',
  );

  for (const filePath of files) {
    try {
      const stat = await fsp.stat(filePath);
      const content = await fsp.readFile(filePath, 'utf-8');
      const rel = path.relative(driverRoot, filePath);
      const slug = slugify(path.basename(filePath));
      const memoryId = `mem_import_${slug}`;

      // 幂等：已存在则跳过
      if (existingIds.has(memoryId)) {
        result.skipped++;
        continue;
      }

      const tags = ['import', driverName, ...inferTags(rel)];
      const mtime = stat.mtime.toISOString();
      const now = new Date().toISOString();

      const meta: MemoryMeta = {
        id: memoryId,
        scope,
        project_id: projectId,
        memory_type: 'semantic',
        created_at: now,
        updated_at: now,
        archived: false,
        priority: 2,
        agent: 'import',
        reviewed: false,
        tags,
        related_files: [path.relative(vault.root, filePath)],
        valid_from: mtime,
      };

      const targetPath = path.join(typeDir, `${memoryId}.md`);
      await writeMemory(targetPath, meta, content);
      getFtsIndex().upsertByPath(targetPath);

      existingIds.add(memoryId);
      result.created++;
    } catch (err: any) {
      result.failed++;
      result.errors.push(`${filePath}: ${err?.message ?? String(err)}`);
    }
  }

  result.duration_ms = Math.round(performance.now() - t0);
  logger.info(`memory_import [${driverLabel}]: created=${result.created} skipped=${result.skipped} failed=${result.failed}`);
  return result;
}

/** 扫描 vault 已有所有 memory_id（幂等检查用） */
async function collectExistingIds(vault: VaultManager): Promise<Set<string>> {
  const ids = new Set<string>();
  const queue = [vault.root];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'journal' || e.name === 'node_modules') continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) queue.push(full);
      else if (e.isFile() && e.name.endsWith('.md')) {
        try {
          const buf = await fsp.readFile(full, 'utf-8');
          const m = buf.match(/^---\s*\n([\s\S]*?)\n---/);
          if (m) {
            const idm = m[1].match(/^id:\s*['"]?([^\s'"]+)['"]?/m);
            if (idm) ids.add(idm[1]);
          }
        } catch { /* skip */ }
      }
    }
  }
  return ids;
}

export async function memoryImport(args: ImportArgs = {}): Promise<ImportResult[]> {
  const vault = new VaultManager();
  await vault.ensureStructure();

  const scope = args.scope ?? 'project';
  const projectId = args.project_id ?? path.basename(vault.root);
  const runTrae = args.from_trae_documents ?? true;
  const runDocs = args.from_docs ?? true;

  const existingIds = await collectExistingIds(vault);
  const cwd = process.cwd();
  const results: ImportResult[] = [];

  for (const d of DRIVERS) {
    if (d.driver === 'trae-documents' && !runTrae) continue;
    if (d.driver === 'docs' && !runDocs) continue;

    const driverRoot = path.join(cwd, ...d.subPath);
    const r = await runDriver(d.driver, d.label, driverRoot, vault, scope, projectId, existingIds);
    results.push(r);
  }

  return results;
}
