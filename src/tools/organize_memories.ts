/**
 * organize_memories — 自动整理 vault
 *
 * 三个动作（保守优先，默认 light 模式不动数据）：
 *
 *   1. 补 tags — tags 为空的 semantic 记忆，从 content 自动提取
 *   2. promote stale-but-important — priority=3 但长期没更新的，刷新 updated_at
 *   3. dedup — 同 project + 同 memory_type + 内容高度相似（Jaccard > 0.85）
 *      → 较旧的设 valid_to + superseded_by（deep 模式才执行）
 *
 * 参数极简：只有 mode（light/deep）+ project_id（可选）
 * 返回每类动作的数量 + 处理详情
 */

import { VaultManager } from '../storage/vault.js';
import { walkMdFiles } from './_walk.js';
import { readMemory, writeMemory } from '../storage/frontmatter.js';
import { getFtsIndex } from '../storage/fts.js';
import { inferMemoryMeta } from './remember.js';
import { logger } from '../logger.js';

export interface OrganizeArgs {
  mode?: 'light' | 'deep';
  project_id?: string;
}

export interface OrganizeResult {
  ok: boolean;
  mode: 'light' | 'deep';
  scanned: number;
  promoted: number;
  tags_filled: number;
  deduped: number;
  raw_archived: number;  // v0.4.9: distilled 替代 raw 归档
  suggestions: string[];
  details: {
    promoted: Array<{ memory_id: string; reason: string }>;
    tags_filled: Array<{ memory_id: string; new_tags: string[] }>;
    deduped: Array<{ older: string; newer: string; similarity: number }>;
    raw_archived: Array<{ raw_id: string; distilled_id: string; raw_size: number; distilled_size: number }>;
  };
}

/** 简单文本 → token 集合（中英文分词） */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  // ASCII：按非字母数字分割，小写
  const asciiMatches = text.match(/[a-z0-9_]+/gi);
  if (asciiMatches) {
    for (const m of asciiMatches) tokens.add(m.toLowerCase());
  }
  // 中文/CJK：按双字滑窗
  const cjkOnly = text.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjkOnly.length - 1; i++) {
    tokens.add(cjkOnly.slice(i, i + 2));
  }
  return tokens;
}

/** Jaccard 相似度 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

export async function organizeMemories(args: OrganizeArgs = {}): Promise<OrganizeResult> {
  const vault = new VaultManager();
  await vault.ensureStructure();
  const mode = args.mode ?? 'light';
  const now = new Date();

  // 扫描全部有效记忆
  const allEntries: any[] = [];
  for await (const fp of walkMdFiles(vault.root)) {
    const entry = await readMemory(fp);
    if (!entry) continue;
    if (entry.meta.archived) continue;
    if (entry.meta.valid_to) continue; // 已 superseded 的跳过
    if (args.project_id && entry.meta.project_id !== args.project_id) continue;
    allEntries.push(entry);
  }

  const result: OrganizeResult = {
    ok: true,
    mode,
    scanned: allEntries.length,
    promoted: 0,
    tags_filled: 0,
    deduped: 0,
    raw_archived: 0,
    suggestions: [],
    details: { promoted: [], tags_filled: [], deduped: [], raw_archived: [] },
  };

  // === 按 (project_id, memory_type) 分组 ===
  const groups = new Map<string, any[]>();
  for (const e of allEntries) {
    const key = `${e.meta.project_id}/${e.meta.memory_type}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }

  // === Step 1: 补 tags ===
  for (const entry of allEntries) {
    const existingTags = entry.meta.tags ?? [];
    // 只处理 semantic 且 tags 为空的
    if (entry.meta.memory_type !== 'semantic') continue;
    if (existingTags.length > 0) continue;

    const inferred = inferMemoryMeta(entry.body);
    const newTags = inferred.tags ?? [];
    if (newTags.length === 0) continue;

    if (mode === 'deep') {
      const updatedMeta = { ...entry.meta, tags: newTags, updated_at: now.toISOString() };
      await writeMemory(entry.path, updatedMeta, entry.body);
      // 不在循环里调 upsertByPath → 最后统一 rebuild
      logger.info('Organize tags filled:', entry.meta.id, '→', newTags);
    }

    result.tags_filled++;
    result.details.tags_filled.push({ memory_id: entry.meta.id, new_tags: newTags });
  }

  // === Step 2: promote stale-but-important ===
  for (const entry of allEntries) {
    if (entry.meta.priority !== 3) continue;
    const ageMs = now.getTime() - new Date(entry.meta.updated_at).getTime();
    if (ageMs < STALE_THRESHOLD_MS) continue;

    if (mode === 'deep') {
      const updatedMeta = { ...entry.meta, updated_at: now.toISOString() };
      await writeMemory(entry.path, updatedMeta, entry.body);
      // 不在循环里调 upsertByPath
      logger.info('Organize promoted:', entry.meta.id, 'age=', Math.round(ageMs / 86400000), 'days');
    }

    result.promoted++;
    result.details.promoted.push({
      memory_id: entry.meta.id,
      reason: `priority=3 但 ${Math.round(ageMs / 86400000)} 天未更新`,
    });
  }

  // === Step 3: dedup（deep 模式才执行）===
  if (mode === 'deep') {
    for (const [, group] of groups) {
      if (group.length < 2) continue;

      // 按 updated_at DESC，较新的是"赢家"
      group.sort((a, b) => new Date(b.meta.updated_at).getTime() - new Date(a.meta.updated_at).getTime());

      const tokenCache = new Map<string, Set<string>>();
      for (const e of group) {
        tokenCache.set(e.meta.id, tokenize(e.body));
      }

      for (let i = 0; i < group.length; i++) {
        const newer = group[i];
        for (let j = i + 1; j < group.length; j++) {
          const older = group[j];
          const sim = jaccard(tokenCache.get(newer.meta.id)!, tokenCache.get(older.meta.id)!);
          if (sim > 0.85) {
            // 关闭旧记忆
            const closedMeta = {
              ...older.meta,
              valid_to: now.toISOString(),
              superseded_by: newer.meta.id,
              updated_at: now.toISOString(),
            };
            await writeMemory(older.path, closedMeta, older.body);
            // 不在循环里调 upsertByPath
            logger.info('Organize dedup:', older.meta.id, '→', newer.meta.id, `sim=${sim.toFixed(2)}`);
            result.deduped++;
            result.details.deduped.push({
              older: older.meta.id,
              newer: newer.meta.id,
              similarity: Math.round(sim * 100) / 100,
            });
          }
        }
      }
    }
  }

  // === Step 4: distilled 替代 raw 归档（deep 模式才执行，v0.4.9）===
  // 判断规则：同 project 下，agent=import 的 raw 记忆，若存在 agent!=import 的语义记忆
  // 且 body 长度比 raw 短（说明蒸馏过了）→ raw 归档为 archived=true
  if (mode === 'deep') {
    // 按 project 分组
    const byProject = new Map<string, any[]>();
    for (const e of allEntries) {
      if (e.meta.memory_type !== 'semantic') continue;
      const key = e.meta.project_id;
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key)!.push(e);
    }

    for (const [pid, entries] of byProject) {
      const raws = entries.filter((e) => e.meta.agent === 'import');
      // 蒸馏层：agent != import 的都是（agent 手写的 distilled 或 manual）
      const distilledOrManual = entries.filter((e) => e.meta.agent !== 'import');

      if (raws.length === 0 || distilledOrManual.length === 0) continue;

      // 计算蒸馏层的中位 body 长度
      const distillSizes = distilledOrManual.map((e) => e.body.length).sort((a, b) => a - b);
      const medianSize = distillSizes[Math.floor(distillSizes.length / 2)];

      for (const raw of raws) {
        // raw body 长度至少是蒸馏层中位的 2 倍 → 大概率原文被蒸馏替代
        if (raw.body.length >= medianSize * 2) {
          // 找最可能替代它的蒸馏记忆（body 最短的）
          const bestDistill = [...distilledOrManual].sort((a, b) => a.body.length - b.body.length)[0];

          if (mode === 'deep') {
            const archivedMeta = {
              ...raw.meta,
              archived: true,
              superseded_by: bestDistill.meta.id,
              updated_at: now.toISOString(),
              tags: [...(raw.meta.tags ?? []), 'archived', 'superseded-by-distill'],
            };
            await writeMemory(raw.path, archivedMeta, raw.body);
            // 不在循环里调 upsertByPath
            logger.info('Organize raw archived:', raw.meta.id, '→ distilled', bestDistill.meta.id,
              `raw=${raw.body.length} distilled=${bestDistill.body.length}`);
          }

          result.raw_archived++;
          result.details.raw_archived.push({
            raw_id: raw.meta.id,
            distilled_id: bestDistill.meta.id,
            raw_size: raw.body.length,
            distilled_size: bestDistill.body.length,
          });
        }
      }
    }
  }

  // === 生成建议 ===
  if (result.tags_filled === 0) result.suggestions.push('所有 semantic 记忆已有 tags');
  if (result.promoted === 0) result.suggestions.push('无 stale priority=3 记忆');
  if (mode === 'light') {
    result.suggestions.push(`当前 light 模式只做建议，不动数据。如需执行去重/promote，调 organize_memories({ mode: "deep" })`);
  }
  if (mode === 'deep' && result.deduped === 0) {
    result.suggestions.push('无高度重复的记忆（Jaccard > 0.85 阈值）');
  }
  if (mode === 'deep' && result.raw_archived === 0) {
    result.suggestions.push('无 raw 原文被蒸馏替代（可能还没蒸馏）');
  }

  // === 统一 FTS rebuild（deep 模式改过数据，只 rebuild 一次）===
  if (mode === 'deep') {
    await getFtsIndex().fullRebuild();
  }

  return result;
}
