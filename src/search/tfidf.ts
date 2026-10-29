/**
 * TF-IDF 计算管道（纯 JS）
 *
 * 为什么 FTS5 BM25 还需要 TF-IDF？
 *   - BM25 是 Okapi BM25，有文档长度归一化和 term frequency saturation
 *   - TF-IDF 是更简单的 tf * idf，分数尺度 [0,1] 归一化（我们额外做 min-max 归一化）
 *   - 两者排序结果不同 → RRF 融合价值高
 *   - FTS5 没有原生 TF-IDF，纯 JS 实现 50 行
 *
 * 输入：所有候选 MemoryEntry + query tokens
 * 输出：Map<memory_id, rank>  — rank 越低越相关（供 RRF 融合）
 */

import type { MemoryEntry } from '../types.js';

export function computeTFIDFRanks(
  queryTokens: string[],
  entries: MemoryEntry[],
): { memory_id: string; rank: number }[] {
  if (queryTokens.length === 0 || entries.length === 0) return [];

  const N = entries.length;

  // --- Step 1: 统计每个 entry 的词频 ---
  // 同时统计每个 query token 出现在多少个 entry 里（doc freq）
  const docFreq = new Map<string, number>(); // token → 包含它的文档数
  const entryTokens = new Map<string, { tf: Map<string, number>; total: number; tags: string[] }>();

  for (const entry of entries) {
    const bodyLower = entry.body.toLowerCase();
    const tagsArr = (entry.meta.tags ?? []).map((t) => t.toLowerCase());
    const tagsStr = tagsArr.join(' ');
    const fullText = bodyLower + ' ' + tagsStr;
    const tokens = fullText.split(/[\s\p{P}]+/u).filter((t: string) => t.length > 0);

    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    entryTokens.set(entry.meta.id, { tf, total: tokens.length, tags: tagsArr });

    for (const qt of new Set(queryTokens)) {
      if (fullText.includes(qt)) {
        docFreq.set(qt, (docFreq.get(qt) ?? 0) + 1);
      }
    }
  }

  // --- Step 2: 计算每个 entry 的 TF-IDF score ---
  const scores = new Map<string, number>();
  for (const [entryId, { tf, total, tags }] of entryTokens) {
    let score = 0;
    for (const qt of queryTokens) {
      const f = tf.get(qt) ?? 0;
      if (f === 0) continue;
      const tfNorm = f / Math.max(total, 1);
      const df = docFreq.get(qt) ?? 0;
      const idf = df > 0 ? Math.log((N + 1) / (df + 1)) + 1 : 0;
      score += tfNorm * idf;
      // tags 权重加倍（query token 在 tags 里时）
      if (tags.includes(qt)) score *= 1.5;
    }
    scores.set(entryId, score);
  }

  // --- Step 3: 按 score 排序，输出 rank ---
  return [...scores.entries()]
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([memoryId], i) => ({ memory_id: memoryId, rank: i }));
}
