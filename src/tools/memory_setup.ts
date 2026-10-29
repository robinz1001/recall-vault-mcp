/**
 * memory_setup — Vault 初始化 + Agent Onboard
 *
 * Phase 3 新增
 * 功能：
 *   1. 检测 vault 状态（空/已存在/部分损坏）
 *   2. 写入 fence block — 让 agent "知道" 这个 vault 是 recall-vault 管理的
 *   3. 可选：自动生成第一批 starter semantic（项目级约定模板）
 *   4. 返回 onboarding bundle — agent 读完就能开始工作
 *
 * Fence block 格式（写入 vault/README.md 首段）：
 * ```
 * <!-- recall-vault fence: v1, setup_at=2026-10-28T10:00:00Z, agent=trae -->
 * This vault is managed by recall-vault. Do not manually delete files here.
 * ```
 */

import fs from 'node:fs';
import path from 'node:path';
import { VaultManager } from '../storage/vault.js';

const FENCE_PREFIX = '<!-- recall-vault fence:';

export interface SetupArgs {
  /** 默认 false。设 true 生成 starter semantic 模板 */
  generate_starters?: boolean;
  /** 默认 trae */
  agent?: string;
}

export interface SetupResult {
  vault_root: string;
  status: 'initialized' | 'already_configured' | 'repaired';
  fence_written: boolean;
  starters_generated: number;
  message: string;
  onboarding_bundle: {
    next_actions: string[];
    tool_quick_ref: string;
    session_id_format: string;
  };
}

export async function memorySetup(args: SetupArgs = {}): Promise<SetupResult> {
  const vault = new VaultManager();
  await vault.ensureStructure();

  let fenceWritten = false;
  let startersGenerated = 0;
  let status: SetupResult['status'] = 'initialized';

  // 1. 写 fence block 到 README.md
  const readmePath = path.join(vault.root, 'README.md');
  const fence = generateFence(args.agent ?? 'trae');

  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, fence + '\n\n# RecallVault\n\nLocal-first memory store for this project.\n');
    fenceWritten = true;
  } else {
    const existing = fs.readFileSync(readmePath, 'utf-8');
    if (!existing.startsWith(FENCE_PREFIX)) {
      fs.writeFileSync(readmePath, fence + '\n\n' + existing);
      fenceWritten = true;
    } else {
      status = 'already_configured';
    }
  }

  // 2. 可选：starter semantic 模板
  if (args.generate_starters) {
    startersGenerated = await generateStarters(vault.root);
  }

  // 3. 组装 onboarding bundle
  const result: SetupResult = {
    vault_root: vault.root,
    status,
    fence_written: fenceWritten,
    starters_generated: startersGenerated,
    message: buildMessage(status, fenceWritten, startersGenerated),
    onboarding_bundle: {
      next_actions: [
        '1. health_check — 确认 tools 就绪，看 suggested_context',
        '2. recall(query="project conventions", include_shared=true) — 看看有没有可复用的',
        '3. 开始工作时 remember 架构决策和踩坑经验',
        '4. session 结束前 remember episodic 摘要',
      ],
      tool_quick_ref: [
        'remember: 写记忆（新建或追加）',
        'recall: 搜索记忆（支持 query + tags + filters + window_size）',
        'list_memories: 列出记忆概览',
        'archive_memory / delete_memory: 归档或删除',
        'update_memory / set_memory_priority: 修改内容或优先级',
        'health_check: 看 vault 状态 + suggested_context + journal_backlog',
      ].join('\n'),
      session_id_format: 'sess_YYYYMMDD (e.g. sess_20261028)',
    },
  };

  return result;
}

function generateFence(agent: string): string {
  const now = new Date().toISOString();
  return `${FENCE_PREFIX} v1, setup_at=${now}, agent=${agent} -->\nThis vault is managed by recall-vault. Do not manually delete files here.`;
}

function buildMessage(status: SetupResult['status'], fenceWritten: boolean, starters: number): string {
  if (status === 'already_configured') {
    return 'Vault already has recall-vault fence. Nothing to do.';
  }
  const parts: string[] = [];
  if (fenceWritten) parts.push('Fence block written.');
  if (starters > 0) parts.push(`${starters} starter memories generated.`);
  if (parts.length === 0) parts.push('Vault initialized.');
  return parts.join(' ');
}

/**
 * 生成 starter semantic 模板（空 vault 时有用）
 * 最多 3 条：项目约定 / 技术栈 / 注意事项
 */
async function generateStarters(vaultRoot: string): Promise<number> {
  const dir = path.join(vaultRoot, 'projects', 'recall-vault', 'semantic');
  if (!fs.existsSync(dir)) return 0;

  // 看看 vault 里有没有已有记忆，有的话跳过 starters
  const existing = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  if (existing.length > 0) return 0;

  // 写一条 starter
  const starterPath = path.join(dir, 'mem_onboarding_starter.md');
  const now = new Date().toISOString();
  const starter = `---
id: mem_onboarding_starter
scope: project
project_id: recall-vault
memory_type: semantic
created_at: ${now}
updated_at: ${now}
archived: false
priority: 2
agent: trae
tags: [onboarding, starter]
valid_from: ${now}
---

## 项目约定（starter 模板）

> 这是一条 onboarding 时自动生成的 starter 模板。按实际项目替换内容。

### 技术栈
- Node.js / TypeScript
- MCP (Model Context Protocol)

### 命名约定
- memory_id: \`mem_YYYYMMDD_NNN\`
- tags: 无 # 前缀

### 什么时候 remember
- 架构决策 → priority 2
- 踩坑经验 → priority 3
- 项目约定 → priority 2
- 会话摘要 → memory_type: episodic
`;

  fs.writeFileSync(starterPath, starter);
  return 1;
}
