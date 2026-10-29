/**
 * Staleness 信号 — 记忆新鲜度 + 过时判断
 *
 * 抄 enquire-mcp staleness.ts 实现
 * 核心：双曲衰减 halfLife / (halfLife + ageDays)
 *   age=0      → 1.0（完全新鲜）
 *   age=30     → 0.5
 *   age=365    → 0.08（一年）
 *   age→∞      → 0
 *
 * 默认 stale 阈值 = 365 天（一年以上的记忆标记为 stale）
 * 目前 staleness 只作为附加信号返回给 agent，不参与排序。
 * agent 看到 "这条记忆 120 天了" 可以决定要不要完全信任。
 */

export const DEFAULT_STALE_DAYS = 365;
export const DEFAULT_HALF_LIFE_DAYS = 30;

export interface Staleness {
  /** 记忆距今多少天（浮点，0.5 = 12 小时前） */
  age_days: number;
  /** 是否过时（age_days >= staleDays） */
  stale: boolean;
  /** recency 分数 [0, 1]，双曲衰减 */
  recency_score: number;
}

/**
 * 双曲衰减分数
 * halfLife / (halfLife + ageDays)
 */
export function recencyScore(
  ageDays: number,
  halfLife: number = DEFAULT_HALF_LIFE_DAYS,
): number {
  if (ageDays <= 0) return 1;
  return halfLife / (halfLife + ageDays);
}

/**
 * 从 updated_at ISO 字符串计算 staleness
 */
export function computeStaleness(
  updatedAt: string,
  staleDays: number = DEFAULT_STALE_DAYS,
  now: Date = new Date(),
): Staleness {
  const then = new Date(updatedAt);
  const ageMs = now.getTime() - then.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  return {
    age_days: Number(ageDays.toFixed(1)),
    stale: ageDays >= staleDays,
    recency_score: Number(recencyScore(ageDays).toFixed(4)),
  };
}
