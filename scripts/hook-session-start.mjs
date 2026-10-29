/**
 * SessionStart Hook — 自动注入 recall-vault 上下文
 *
 * Trae 在创建 Session 后、发起第一个对话前触发。
 * 输出 additionalContext 让 agent 主动调 health_check + recall。
 */

import fs from 'node:fs';
import path from 'node:path';

// 双 IDE 兼容：Trae 用 TRAE_PROJECT_DIR，CodeBuddy 用 CODEBUDDY_PROJECT_DIR
const cwd = process.env.TRAE_PROJECT_DIR || process.env.CODEBUDDY_PROJECT_DIR || process.cwd();
const vaultDir = path.join(cwd, 'projects', 'recall-vault', 'semantic');
const sharedDir = path.join(cwd, 'shared', 'semantic');

let recentMemories = '';
try {
  const files = [vaultDir, sharedDir]
    .filter((d) => fs.existsSync(d))
    .flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.md')))
    .slice(0, 3);

  if (files.length > 0) {
    recentMemories = files.map((f) => `  - ${f}`).join('\n');
  }
} catch { /* 空 vault 正常 */ }

const context = `[RecallVault SessionStart Hook] 新 session 开始。

1. 立即调用 health_check 工具确认 MCP server 状态。
2. 调用 recall({ query: "当前项目最近讨论 技术决策 踩坑", include_shared: true, limit: 5 }) 取回上次 session 的上下文。
3. 根据 recall 结果判断当前任务是否已有相关决策或历史讨论，避免重复踩坑。

${
  recentMemories
    ? `Vault 里已有记忆文件：\n${recentMemories}\n`
    : 'Vault 是空的 — 这是全新 start，记得在工作过程中随时 remember 决策和发现。\n'
}
`;

// 输出 JSON 格式的 additionalContext
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  }),
);
