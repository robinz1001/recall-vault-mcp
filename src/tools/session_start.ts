/**
 * session_start — Session 启动入口（inhale）
 *
 * 参考 AgentRecall session_start + SLM session_init：
 * agent 在每个新 session 的**第一件事**就调这个，一次拿齐：
 *   1. vault 状态统计
 *   2. 高价值 semantic 记忆 Top 3（compact，省 token）
 *   3. 上一个 session 的 episodic 摘要
 *   4. 跨项目 shared 层有什么经验（提醒 agent 需要时 recall）
 *   5. suggested_actions — 建议 agent 接下来做什么
 *   6. session_id — 自动生成 sess_YYYYMMDD，agent 后续 remember 时带上
 *
 * 参数极简：只有 project_id（可选，不传自动推断）
 */

import { VaultManager } from '../storage/vault.js';
import { walkMdFiles } from './_walk.js';
import { readMemory } from '../storage/frontmatter.js';
import { config } from '../config.js';

export interface SessionStartArgs {
  project_id?: string;
}

export interface SessionStartResult {
  session_id: string;
  project_id: string;
  vault_path: string;
  project_status: {
    semantic_count: number;
    episodic_count: number;
    high_value_count: number; // priority=3 的 semantic
    shared_semantic_count: number;
  };
  recent_high_value: Array<{
    memory_id: string;
    title: string;
    priority: number;
    tags: string[];
    age: string;
    snippet: string;
    wikilink: string;
  }>;
  previous_session: {
    memory_id: string;
    session_id: string;
    age: string;
    snippet: string;
    wikilink: string;
  } | null;
  cross_project_hints: string[];
  suggested_actions: string[];
  compacted_summary: string;
  est_tokens: number;
}

function extractTitle(body: string): string {
  const firstLine = body.split('\n').find((l) => l.trim().length > 0) ?? '';
  const h1 = firstLine.match(/^#\s+(.+)/);
  if (h1) return h1[1].trim();
  return firstLine.slice(0, 60).trim();
}

function cleanSnippet(body: string, maxLen: number): string {
  const lines = body.split('\n').filter((l) => l.trim().length > 0);
  const contentStart = lines.find((l) => !/^#+\s+/.test(l)) ?? lines[0] ?? '';
  const cleaned = contentStart.replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '…' : cleaned;
}

function ageLabel(isoStr: string): string {
  const ageMs = Date.now() - new Date(isoStr).getTime();
  const ageMin = ageMs / 60000;
  if (ageMin < 1) return '刚刚';
  if (ageMin < 60) return `${Math.round(ageMin)}分钟前`;
  const ageH = ageMin / 60;
  if (ageH < 24) return `${Math.round(ageH)}小时前`;
  const ageD = ageH / 24;
  if (ageD < 30) return `${Math.round(ageD)}天前`;
  return `${Math.round(ageD / 30)}月前`;
}

function formatWikilink(meta: any): string {
  if (meta.scope === 'shared') return `[[shared/semantic/${meta.id}]]`;
  const pid = meta.project_id ?? '';
  return `[[projects/${pid}/${meta.memory_type}/${meta.id}]]`;
}

export async function sessionStart(args: SessionStartArgs = {}): Promise<SessionStartResult> {
  const vault = new VaultManager();
  await vault.ensureStructure();

  const projectId = args.project_id ?? vault.inferProjectId();
  const sessionId = `sess_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

  // 扫描所有有效记忆
  const allEntries: any[] = [];
  for await (const fp of walkMdFiles(vault.root)) {
    const entry = await readMemory(fp);
    if (!entry) continue;
    if (entry.meta.archived) continue;
    if (entry.meta.valid_to) continue; // superseded
    allEntries.push(entry);
  }

  const projectEntries = allEntries.filter((e) => e.meta.project_id === projectId);
  const sharedEntries = allEntries.filter((e) => e.meta.scope === 'shared');

  const semantic = projectEntries.filter((e) => e.meta.memory_type === 'semantic');
  const episodic = projectEntries.filter((e) => e.meta.memory_type === 'episodic');
  const highValue = semantic.filter((e) => e.meta.priority === 3);

  // 排序：priority DESC → updated_at DESC
  const sortByValue = (arr: any[]) =>
    [...arr].sort((a, b) => {
      const p = (b.meta.priority ?? 2) - (a.meta.priority ?? 2);
      if (p !== 0) return p;
      return new Date(b.meta.updated_at).getTime() - new Date(a.meta.updated_at).getTime();
    });

  // 高价值 Top 3
  const topHigh = sortByValue(highValue).slice(0, 3);
  const recentHighValue = topHigh.map((e) => ({
    memory_id: e.meta.id,
    title: extractTitle(e.body),
    priority: e.meta.priority ?? 2,
    tags: e.meta.tags ?? [],
    age: ageLabel(e.meta.updated_at),
    snippet: cleanSnippet(e.body, 120),
    wikilink: formatWikilink(e.meta),
  }));

  // 上一个 session 的 episodic
  const prevEpisodic = sortByValue(episodic)[0] ?? null;
  const previous_session = prevEpisodic
    ? {
        memory_id: prevEpisodic.meta.id,
        session_id: prevEpisodic.meta.session_id ?? '',
        age: ageLabel(prevEpisodic.meta.updated_at),
        snippet: cleanSnippet(prevEpisodic.body, 100),
        wikilink: formatWikilink(prevEpisodic.meta),
      }
    : null;

  // cross-project hints
  const crossProjectHints: string[] = [];
  if (sharedEntries.length > 0) {
    crossProjectHints.push(
      `shared/semantic 有 ${sharedEntries.length} 条跨项目通用经验 — recall({ include_shared: true, query: '${extractTitle(sortByValue(sharedEntries)[0].body).slice(0, 30)}', compact: true })`,
    );
  } else {
    crossProjectHints.push('shared/semantic 还没有跨项目经验 — 值得复用到新场景的知识记得用 scope: "shared" 存');
  }

  // suggested_actions — 明确告诉 agent 接下来做什么
  const suggestedActions: string[] = [];
  if (topHigh.length > 0) {
    suggestedActions.push(
      `📌 项目有 ${topHigh.length} 条 priority=3 的关键经验（见 recent_high_value）— 如果当前任务相关，先用 recall 深挖`,
    );
  }
  if (previous_session) {
    suggestedActions.push(
      `📝 上一个 session (${previous_session.session_id}, ${previous_session.age}) 有上下文 — 考虑是否和当前任务相关`,
    );
  }
  suggestedActions.push(
    `🔄 开始任务后，遇到架构决策/踩坑记得主动 remember（参数简化：只传 content 即可，type/scope/priority 自动推断）`,
  );
  suggestedActions.push(
    `🏁 session 结束前调 session_end — 自动保存会话摘要到 episodic`,
  );

  // 压缩摘要文本（给 agent 直接读）
  const summaryLines: string[] = [];
  summaryLines.push(`# Session Start — ${projectId} · ${new Date().toISOString().slice(0, 10)}`);
  summaryLines.push('');
  summaryLines.push(`📂 Vault: ${semantic.length} semantic + ${episodic.length} episodic${highValue.length > 0 ? ` · ${highValue.length} ⚠️ priority=3` : ''}`);
  summaryLines.push('');
  for (const item of recentHighValue) {
    const star = item.priority === 3 ? ' ⚠️' : '';
    const tags = (item.tags ?? ([] as string[])).slice(0, 3).map((t: string) => `#${t}`).join(' ');
    summaryLines.push(`📌 ${item.title}${star} (${item.age})${tags ? ' ' + tags : ''}`);
    summaryLines.push(`   ${item.snippet}`);
  }
  if (previous_session) {
    summaryLines.push(`📝 上session ${previous_session.age}: ${previous_session.snippet}`);
  }
  summaryLines.push('');
  summaryLines.push('💡 建议行动：');
  for (const a of suggestedActions) summaryLines.push(`  ${a}`);

  const compactedSummary = summaryLines.join('\n');

  // token 估算
  let ascii = 0, cjk = 0;
  for (const ch of compactedSummary) {
    if (ch.charCodeAt(0) < 128) ascii++; else cjk++;
  }
  const estTokens = Math.ceil(ascii / 4 + cjk / 3);

  return {
    session_id: sessionId,
    project_id: projectId,
    vault_path: config.vaultPath,
    project_status: {
      semantic_count: semantic.length,
      episodic_count: episodic.length,
      high_value_count: highValue.length,
      shared_semantic_count: sharedEntries.length,
    },
    recent_high_value: recentHighValue,
    previous_session,
    cross_project_hints: crossProjectHints,
    suggested_actions: suggestedActions,
    compacted_summary: compactedSummary,
    est_tokens: estTokens,
  };
}
