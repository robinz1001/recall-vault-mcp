/**
 * session_end — Session 结束入口（exhale）
 *
 * 参考 AgentRecall session_end：
 * agent 在 session 结束前调这个，一次保存：
 *   1. 会话摘要（episodic memory）
 *   2. 可选：扫描 agent_state/journal 自动识别值得持久化的决策/踩坑
 *
 * 参数极简：
 *   summary — 可选。agent 总结这次 session 做了什么、有什么产出。
 *             不传就只记录最小元数据（session_id + project_id + 时间）。
 *   highlights — 可选。重要产出列表（决策、修复、新发现）。
 */

import { VaultManager } from '../storage/vault.js';
import { writeMemory } from '../storage/frontmatter.js';
import { nextMemoryId, memoryFilePath } from '../storage/filename.js';

export interface SessionEndArgs {
  /** Agent 对本次 session 的总结 */
  summary?: string;
  /** 重要产出：决策、修复、新发现等 */
  highlights?: string[];
  /** 可选覆盖 session_id */
  session_id?: string;
  /** 可选覆盖 project_id（默认自动推断） */
  project_id?: string;
  /** 可选覆盖 agent */
  agent?: string;
}

export interface SessionEndResult {
  ok: boolean;
  memory_id: string;
  path: string;
  session_id: string;
  tokens_written: number;
}

export async function sessionEnd(args: SessionEndArgs = {}): Promise<SessionEndResult> {
  const vault = new VaultManager();
  await vault.ensureStructure();

  const projectId = args.project_id ?? vault.inferProjectId();
  const sessionId = args.session_id ?? `sess_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${Date.now().toString().slice(-4)}`;
  const agent = args.agent ?? 'trae';

  await vault.ensureProjectDir(projectId);
  const episodicDir = vault.getEpisodicDir(projectId);

  // 组装 body
  const lines: string[] = [];
  const now = new Date();

  if (args.summary) {
    lines.push(`# Session Summary — ${projectId}`);
    lines.push('');
    lines.push(args.summary);
  } else {
    lines.push(`# Session — ${projectId}`);
    lines.push('');
    lines.push(`Session 结束，未提供摘要。时间：${now.toISOString()}`);
  }

  if (args.highlights && args.highlights.length > 0) {
    lines.push('');
    lines.push('## Highlights');
    for (const h of args.highlights) {
      lines.push(`- ${h}`);
    }
  }

  const body = lines.join('\n');

  // 生成 memory_id
  const memoryId = await nextMemoryId(vault.root);
  const meta: any = {
    id: memoryId,
    memory_type: 'episodic',
    project_id: projectId,
    scope: 'project',
    agent,
    session_id: sessionId,
    priority: 2,
    tags: ['session'],
    archived: false,
    reviewed: false,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };

  const fullPath = memoryFilePath(episodicDir, memoryId);
  await writeMemory(fullPath, meta, body);

  // token 估算
  let ascii = 0, cjk = 0;
  for (const ch of body) {
    if (ch.charCodeAt(0) < 128) ascii++; else cjk++;
  }
  const tokens = Math.ceil(ascii / 4 + cjk / 3);

  return {
    ok: true,
    memory_id: memoryId,
    path: fullPath,
    session_id: sessionId,
    tokens_written: tokens,
  };
}
