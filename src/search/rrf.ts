/**
 * Reciprocal Rank Fusion (RRF) — 多路排序融合
 *
 * 来自 enquire-mcp rrf.ts（源码已验证）和 Cormack et al 2009 论文
 *
 * 公式：RRF_score(d) = Σ over rankers r: 1 / (k + rank_r(d) + 1)
 *
 * k = 60（Cormack 推荐默认值）
 *
 * 关键设计：
 *   - 只用 rank position，不用分数值 → 解决 BM25 无界 / TF-IDF [0,1] / countOccurrences int 的尺度差异
 *   - 文档在某个 ranker 不存在 → 该 ranker 贡献 0（不是惩罚）→ union-safe
 *   - 同一 ranker 内重复 id → 只保留最佳 rank → 防 double-add
 */

export const DEFAULT_RRF_K = 60;

export interface RankResult {
  memory_id: string;
  rank: number; // 0-based，越低越好
}

/**
 * 融合多路排序 → 返回 { memory_id: rrfScore }
 *
 * @param rankers 多路排序，每路是 RankResult[]
 * @param k RRF 参数，默认 60
 * @returns memory_id → 融合分数（越大越好）
 */
export function reciprocalRankFusion(
  rankers: RankResult[][],
  k: number = DEFAULT_RRF_K,
): Map<string, number> {
  const scores = new Map<string, number>();

  for (const ranker of rankers) {
    const seen = new Set<string>(); // 防同一 ranker 内重复 id double-add
    for (const { memory_id: id, rank } of ranker) {
      if (seen.has(id)) continue;
      seen.add(id);
      const s = 1 / (k + rank + 1);
      scores.set(id, (scores.get(id) ?? 0) + s);
    }
  }

  return scores;
}

/**
 * 便捷方法：直接返回排序后的 { memory_id, score, rank } 数组
 */
export function rrfRanked(
  rankers: RankResult[][],
  k: number = DEFAULT_RRF_K,
): { memory_id: string; rrf_score: number; rank: number }[] {
  const fused = reciprocalRankFusion(rankers, k);
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score], i) => ({ memory_id: id, rrf_score: Number(score.toFixed(6)), rank: i }));
}
