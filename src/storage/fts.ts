/**
 * 全文检索索引层 — flexsearch（纯 JS，零编译）
 *
 * 为什么替换 better-sqlite3：
 *   - better-sqlite3 是 native 模块，Windows Node 22+ 经常 Access Violation crash
 *   - node:sqlite（内置）缺少 FTS5 扩展
 *   - flexsearch 是纯 JS 全文搜索引擎，add/update/remove/clear 全支持
 *   - tokenize: 'full' 同时支持 CJK 中文和英文
 *   - 返回排序好的 id 数组 → 直接转 RRF rank 列表
 *
 * 索引是纯内存的：每次启动或 fullRebuild 时从 vault md 文件重建。
 * 数据量小（<1000 条 md），重建 <500ms，可接受。
 */

import fs from 'node:fs/promises';
import { Index } from 'flexsearch';
import type { MemoryEntry } from '../types.js';
import { VaultManager } from './vault.js';
import { walkMdFiles } from '../tools/_walk.js';
import { readMemory } from './frontmatter.js';
import { logger } from '../logger.js';

// ==================== FtsIndex 类 ====================

export class FtsIndex {
  private idx: Index<string>;
  private metaMap: Map<string, { memory_id: string; mtime: number }>; // path → meta
  private vaultRoot: string;
  private _initialized: boolean;

  constructor(vaultRoot: string) {
    this.vaultRoot = vaultRoot;
    this.idx = new Index({
      tokenize: 'full',   // CJK + 英文分词
      resolution: 9,      // 评分精度
      context: true,      // 上下文感知评分
    });
    this.metaMap = new Map();
    this._initialized = false;
  }

  /** flexsearch 纯 JS，永远可用 */
  get enabled(): boolean { return true; }

  private async ensureInit(): Promise<void> {
    if (this._initialized) return;
    await this.fullRebuild();
    this._initialized = true;
  }

  private entryToText(entry: MemoryEntry): string {
    const meta = entry.meta;
    const title =
      (entry.body.split('\n').find((l: string) => l.trim().length > 0) ?? '').replace(/^#\s+/, '').slice(0, 200) ||
      '(no title)';
    const tagsStr = (meta.tags ?? []).join(' ');
    return `${title} ${entry.body} ${tagsStr}`;
  }

  async fullRebuild(): Promise<{ indexed: number }> {
    this.idx.clear();
    this.metaMap.clear();
    let indexed = 0;
    for await (const fp of walkMdFiles(this.vaultRoot)) {
      const entry = await readMemory(fp);
      if (!entry) continue;
      const stat = await fs.stat(fp);
      this.upsertEntry(entry, stat.mtimeMs);
      indexed++;
    }
    logger.info('FTS (flexsearch) full rebuild:', indexed, 'entries');
    return { indexed };
  }

  async incrementalSync(): Promise<{ upserted: number; removed: number; unchanged: number }> {
    await this.ensureInit();

    const diskMap = new Map<string, number>();
    for await (const fp of walkMdFiles(this.vaultRoot)) {
      diskMap.set(fp, (await fs.stat(fp)).mtimeMs);
    }

    let upserted = 0, removed = 0, unchanged = 0;
    for (const [fp, mtime] of diskMap) {
      if (this.metaMap.get(fp)?.mtime === mtime) { unchanged++; continue; }
      const entry = await readMemory(fp);
      if (entry) { this.upsertEntry(entry, mtime); upserted++; }
    }
    for (const [fp] of this.metaMap) {
      if (!diskMap.has(fp)) { this.deleteByPath(fp); removed++; }
    }

    logger.info('FTS incremental:', `upserted=${upserted}`, `removed=${removed}`, `unchanged=${unchanged}`);
    return { upserted, removed, unchanged };
  }

  async upsertByPath(filePath: string): Promise<void> {
    await this.ensureInit();
    const entry = await readMemory(filePath);
    if (!entry) return;
    const stat = await fs.stat(filePath);
    this.upsertEntry(entry, stat.mtimeMs);
  }

  deleteByPath(filePath: string): void {
    const meta = this.metaMap.get(filePath);
    if (!meta) return;
    this.idx.remove(meta.memory_id);
    this.metaMap.delete(filePath);
  }

  private upsertEntry(entry: MemoryEntry, mtime: number): void {
    const text = this.entryToText(entry);
    // flexsearch update: 已存在则更新，不存在则添加
    this.idx.update(entry.meta.id, text);
    this.metaMap.set(entry.path, { memory_id: entry.meta.id, mtime });
  }

  /**
   * 全文搜索 → 返回 { memory_id, rank }[]
   * opts 过滤（project_id/memory_type/include_shared）由 recall.ts 在候选集上做交集。
   */
  async bm25Search(
    query: string,
    limit = 50,
    _opts?: { project_id?: string; memory_type?: string; include_shared?: boolean },
  ): Promise<{ memory_id: string; rank: number }[]> {
    if (!query.trim()) return [];
    await this.ensureInit();

    // flexsearch Index.search — TS 类型声明说 Promise，实际运行是同步 string[]
    const ids = this.idx.search(query, { limit }) as unknown as string[];
    return ids.map((memoryId: string, i: number) => ({ memory_id: memoryId, rank: i }));
  }

  stats(): { total: number; indexed: number } {
    return { total: this.metaMap.size, indexed: this.metaMap.size };
  }

  close(): void {
    this.idx.clear();
    this.metaMap.clear();
  }
}

let _instance: FtsIndex | null = null;
export function getFtsIndex(vaultRoot?: string): FtsIndex {
  if (!_instance) {
    const root = vaultRoot ?? new VaultManager().root;
    _instance = new FtsIndex(root);
  }
  return _instance;
}
