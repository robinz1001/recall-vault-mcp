/**
 * recall — 检索记忆
 *
 * 检索流程：
 * 1. 确定搜索目录范围（project 子目录 + 可选 shared）
 * 2. 遍历所有 md → readMemory → 过滤 → 关键词匹配 → 排序 → 窗口适配 → 返回
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { VaultManager } from '../storage/vault.js';
import { readMemory } from '../storage/frontmatter.js';
import { walkMdFiles } from './_walk.js';
import { logger } from '../logger.js';
import { getFtsIndex } from '../storage/fts.js';
import { computeTFIDFRanks } from '../search/tfidf.js';
import { reciprocalRankFusion, DEFAULT_RRF_K } from '../search/rrf.js';
import { computeStaleness, recencyScore } from '../search/staleness.js';
import type { MemoryEntry, MemoryType, MemoryAgent } from '../types.js';

export type RecallSortBy = 'relevance' | 'priority' | 'time_desc' | 'time_asc';

export interface RecallArgs {
  query: string;
  project_id?: string;
  memory_type?: MemoryType | 'all';
  include_shared?: boolean;
  tags?: string[];
  agent?: MemoryAgent;
  session_id?: string;
  include_archived?: boolean;
  /** 默认 true。设 false 排除 valid_to !== null 的旧版本 */
  include_superseded?: boolean;
  reviewed_only?: boolean;
  limit?: number;
  sort_by?: RecallSortBy;
  context_window_size?: number;
}

export interface RecallResultItem {
  memory_id: string;
  path: string;
  wikilink: string;
  title: string;
  snippet: string;
  est_tokens: number;
  priority: number;
  memory_type: MemoryType;
  scope: string;
  tags: string[];
  reviewed?: boolean;
  created_at: string;
  updated_at: string;
  relevance_score: number;
  /** Phase 2: 新鲜度信号 */
  staleness: {
    age_days: number;
    stale: boolean;
    recency_score: number;
  };
  /** Phase 2: 双时钟字段 */
  valid_from?: string;
  valid_to?: string;
  supersedes?: string;
}

export interface RecallResult {
  results: RecallResultItem[];
  total: number;
  included_shared: boolean;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export async function recall(args: RecallArgs): Promise<RecallResult> {
  const vault = new VaultManager();
  const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const sortBy: RecallSortBy = args.sort_by ?? 'relevance';

  // === Step 1: 确定搜索范围 ===
  const searchDirs = await buildSearchDirs(vault, args);
  const includedShared = searchDirs.some((d) => d.includes('shared'));

  // === Step 2: 收集并过滤候选（walk + 所有 filter 逻辑）===
  const candidates: MemoryEntry[] = [];
  const queryTokens = tokenize(args.query);

  for await (const fp of walkMdFiles(vault.root)) {
    if (!isInDir(fp, searchDirs)) continue;
    const entry = await readMemory(fp);
    if (!entry) continue;
    if (!passesFilters(entry, args)) continue;
    candidates.push(entry);
  }

  // === Step 3: 计算分数 ===
  const scored: ScoredEntry[] = await computeScores(candidates, queryTokens, args);

  // === Step 4: 排序 ===
  sortCandidates(scored, sortBy);

  // === Step 5: 窗口适配 + limit ===
  const windowSize = args.context_window_size;
  const filteredByWindow = windowSize ? applyWindowConstraint(scored, windowSize, sortBy) : scored;
  const sliced = filteredByWindow.slice(0, limit);

  // === Step 6: 格式化输出 ===
  const results: RecallResultItem[] = sliced.map(({ entry, score }) => formatResult(entry, score, windowSize));

  logger.info('Recall:', args.query ? `"${args.query}"` : '(no query)', '→', results.length, 'results (total scanned:', candidates.length, ')');

  return {
    results,
    total: candidates.length,
    included_shared: includedShared,
  };
}

/**
 * 三路评分 + RRF 融合
 *
 *   Channel A: FTS5 BM25（SQLite 全文检索）
 *   Channel B: TF-IDF（纯 JS，tags + body）
 *   Channel C: 原有 countOccurrences（保留，tags 权重加倍）
 *   → RRF(k=60) 融合 → 得到 fused base score
 *   → 乘 priority + reviewed + freshness 权重
 */
async function computeScores(
  candidates: MemoryEntry[],
  queryTokens: string[],
  args: RecallArgs,
): Promise<ScoredEntry[]> {
  // 空 query → 所有候选等权（list_memories 会按时间排序，这里只给基础分）
  if (queryTokens.length === 0) {
    return candidates.map((entry) => ({ entry, score: 1 }));
  }

  // Channel C: countOccurrences rank（在候选集上跑）
  const legacyRanks = computeLegacyRanks(queryTokens, candidates);

  // Channel A + B: 只在 relevance sort 时才跑（priority/time sort 不需要融合）
  let ftsRanks: { memory_id: string; rank: number }[] = [];
  let tfidfRanks: { memory_id: string; rank: number }[] = [];

  try {
    // Channel A: flexsearch 全文检索 — 注意 scope 与 candidates 对齐
    const fts = getFtsIndex();
    ftsRanks = await fts.bm25Search(args.query, 50, {
      project_id: args.project_id,
      memory_type: args.memory_type,
      include_shared: args.include_shared,
    });

    // 交集：只保留在 candidates 里的
    const candIds = new Set(candidates.map((c) => c.meta.id));
    ftsRanks = ftsRanks.filter((r) => candIds.has(r.memory_id));
  } catch (err) {
    logger.debug('FTS5 search failed (falling back to legacy only):', (err as Error).message);
  }

  // Channel B: TF-IDF — 在候选集上跑
  tfidfRanks = computeTFIDFRanks(queryTokens, candidates);

  // RRF 融合
  const fused = reciprocalRankFusion([ftsRanks, tfidfRanks, legacyRanks], DEFAULT_RRF_K);

  // 映射回 candidates，乘权重
  const result: ScoredEntry[] = [];
  for (const entry of candidates) {
    const id = entry.meta.id;
    const baseScore = fused.get(id) ?? 0;
    if (baseScore === 0) continue; // RRF 三路都没命中 → 排除

    let finalScore = baseScore;

    // priority 权重: 1→0.75, 2→1.0, 3→1.25
    finalScore *= 0.5 + entry.meta.priority * 0.25;

    // reviewed semantic 额外 boost 1.2x
    if (entry.meta.memory_type === 'semantic' && entry.meta.reviewed) {
      finalScore *= 1.2;
    }

    // Phase 2: 双曲衰减 recency（替换旧的手写 freshness）
    const staleness = computeStaleness(entry.meta.updated_at);
    finalScore *= staleness.recency_score;

    result.push({ entry, score: Number(finalScore.toFixed(6)) });
  }

  // 没有任何候选有匹配 → 退化成空（不是 list_memories 调用者会自己处理）
  return result;
}

/**
 * Channel C: 原有 countOccurrences 逻辑 → rank list
 * 保留 tags×3 + 正文 count + token 长度加权
 */
function computeLegacyRanks(
  queryTokens: string[],
  entries: MemoryEntry[],
): { memory_id: string; rank: number }[] {
  if (queryTokens.length === 0) return [];

  const scored = entries.map((entry) => {
    const bodyLower = entry.body.toLowerCase();
    const tagsLower = (entry.meta.tags ?? []).map((t) => t.toLowerCase()).join(' ');

    let score = 0;
    for (const token of queryTokens) {
      if (tagsLower.includes(token)) score += 3;
      score += countOccurrences(bodyLower, token);
      score += token.length * 0.1;
    }
    return { memory_id: entry.meta.id, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s, i) => ({ memory_id: s.memory_id, rank: i }));
}

// ======================== 内部函数 ========================

async function buildSearchDirs(vault: VaultManager, args: RecallArgs): Promise<string[]> {
  const dirs: string[] = [];

  if (args.project_id) {
    const safePid = args.project_id.replace(/[\\/]/g, '_');
    const { episodic, semantic } = await vault.ensureProjectDir(safePid);
    if (!args.memory_type || args.memory_type === 'all' || args.memory_type === 'episodic') dirs.push(episodic);
    if (!args.memory_type || args.memory_type === 'all' || args.memory_type === 'semantic') dirs.push(semantic);
  }

  if (args.include_shared) {
    dirs.push(vault.getSharedSemanticDir());
  }

  // 都没指定 → 搜全部
  if (dirs.length === 0) {
    // 所有项目目录 + shared
    try {
      const projects = await fs.readdir(vault.projectsDir, { withFileTypes: true });
      for (const p of projects) {
        if (p.isDirectory()) {
          dirs.push(path.join(vault.projectsDir, p.name, 'episodic'));
          dirs.push(path.join(vault.projectsDir, p.name, 'semantic'));
        }
      }
    } catch { /* no projects dir */ }
    dirs.push(vault.getSharedSemanticDir());
  }

  return dirs;
}

function isInDir(filePath: string, dirs: string[]): boolean {
  // filePath 必须在某个 dir 下
  const normalized = filePath.replace(/\\/g, '/');
  return dirs.some((d) => normalized.startsWith(d.replace(/\\/g, '/') + '/') || normalized === d.replace(/\\/g, '/'));
}

function passesFilters(entry: MemoryEntry, args: RecallArgs): boolean {
  if ((args.include_archived ?? false) === false && entry.meta.archived) return false;

  // Phase 2: 默认排除 valid_to 已设的旧版本（事实已被取代）
  // include_superseded 默认 false — 只看当前有效事实
  if (args.include_superseded !== true && entry.meta.valid_to) return false;

  if (args.memory_type && args.memory_type !== 'all' && entry.meta.memory_type !== args.memory_type) return false;
  if (args.agent && entry.meta.agent !== args.agent) return false;
  if (args.session_id && entry.meta.session_id !== args.session_id) return false;
  if (args.reviewed_only && entry.meta.memory_type === 'semantic' && !entry.meta.reviewed) return false;

  // tags AND 逻辑：所有指定标签必须都在 entry.tags 里
  if (args.tags && args.tags.length > 0) {
    const entryTags = (entry.meta.tags ?? []).map((t) => t.toLowerCase());
    const queryTags = args.tags.map((t) => t.toLowerCase());
    if (!queryTags.every((t) => entryTags.includes(t))) return false;
  }

  return true;
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

interface ScoredEntry {
  entry: MemoryEntry;
  score: number;
}

function countOccurrences(text: string, sub: string): number {
  if (!sub) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(sub, idx)) !== -1) {
    count++;
    idx += sub.length;
  }
  return count;
}

function sortCandidates(candidates: ScoredEntry[], sortBy: RecallSortBy): void {
  switch (sortBy) {
    case 'relevance':
      candidates.sort((a, b) => b.score - a.score);
      break;
    case 'priority':
      candidates.sort((a, b) => b.entry.meta.priority - a.entry.meta.priority);
      // priority 相同按时间倒序
      candidates.sort((a, b) => {
        if (b.entry.meta.priority !== a.entry.meta.priority) return b.entry.meta.priority - a.entry.meta.priority;
        return new Date(b.entry.meta.updated_at).getTime() - new Date(a.entry.meta.updated_at).getTime();
      });
      break;
    case 'time_desc':
      candidates.sort((a, b) => new Date(b.entry.meta.updated_at).getTime() - new Date(a.entry.meta.updated_at).getTime());
      break;
    case 'time_asc':
      candidates.sort((a, b) => new Date(a.entry.meta.updated_at).getTime() - new Date(b.entry.meta.updated_at).getTime());
      break;
  }
}

function applyWindowConstraint(candidates: ScoredEntry[], windowSize: number, sortBy: RecallSortBy): ScoredEntry[] {
  // recall 默认 relevance 排序
  const sorted = sortBy === 'relevance' ? candidates : candidates.slice().sort((a, b) => b.score - a.score);

  if (windowSize > 64_000) {
    // 大窗口：全部 priority 都保留
    return sorted;
  } else if (windowSize >= 32_000) {
    // 中窗口：排除 priority=1
    return sorted.filter((c) => c.entry.meta.priority >= 2);
  } else {
    // 小窗口：只拉 priority>=2 的 semantic
    return sorted.filter(
      (c) => c.entry.meta.priority >= 2 && c.entry.meta.memory_type === 'semantic',
    );
  }
}

/**
 * Phase 3: 中英文差异 token 估算
 * Kontexta 启发式：ASCII ~4 chars/token, 中文/UTF-8 ~3 chars/token
 * 检测：code point > 127 视为非 ASCII
 */
function estimateTokens(text: string): number {
  let asciiChars = 0;
  let nonAsciiChars = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 128) asciiChars++;
    else nonAsciiChars++;
  }
  return Math.ceil(asciiChars / 4 + nonAsciiChars / 3);
}

function extractTitle(entry: MemoryEntry): string {
  // 第一行 markdown 标题，否则正文前 60 字符
  const firstLine = entry.body.split('\n').find((l) => l.trim().length > 0) ?? '';
  const h1 = firstLine.match(/^#\s+(.+)/);
  if (h1) return h1[1].trim();
  return firstLine.slice(0, 60).trim();
}

function truncateBody(body: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  return body.slice(0, maxChars) + '...';
}

function formatResult(entry: MemoryEntry, score: number, windowSize?: number): RecallResultItem {
  // snippet 长度根据窗口大小
  let snippetMax = 300;
  if (windowSize !== undefined) {
    if (windowSize > 64_000) snippetMax = 300;
    else if (windowSize >= 32_000) snippetMax = 200;
    else snippetMax = 100;
  }

  const snippet = truncateBody(entry.body.replace(/\n+/g, ' ').trim(), snippetMax);
  const wikilink = entry.meta.scope === 'shared'
    ? `[[shared/semantic/${entry.meta.id}]]`
    : `[[projects/${entry.meta.project_id}/${entry.meta.memory_type}/${entry.meta.id}]]`;

  return {
    memory_id: entry.meta.id,
    path: entry.path,
    wikilink,
    title: extractTitle(entry),
    snippet,
    est_tokens: estimateTokens(entry.body),
    priority: entry.meta.priority,
    memory_type: entry.meta.memory_type,
    scope: entry.meta.scope,
    tags: entry.meta.tags ?? [],
    reviewed: entry.meta.reviewed,
    created_at: entry.meta.created_at,
    updated_at: entry.meta.updated_at,
    relevance_score: Number(score.toFixed(4)),
    staleness: computeStaleness(entry.meta.updated_at),
    valid_from: entry.meta.valid_from,
    valid_to: entry.meta.valid_to,
    supersedes: entry.meta.supersedes,
  };
}
