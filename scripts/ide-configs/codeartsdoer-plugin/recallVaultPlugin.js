/**
 * RecallVault 华为云码道代码智能体 (CodeArts) 插件
 *
 * 放在:
 *   项目级: {project}/.codeartsdoer/plugin/recallVaultPlugin.js
 *   个人级: %USERPROFILE%/.codeartsdoer/plugin/recallVaultPlugin.js
 *
 * 依赖: 零（只 spawn node 命令，不需要 npm install）
 *
 * Hook 事件映射:
 *   CodeArts              →  RecallVault 对应能力
 *   ──────────────────────────────────────────────
 *   tool.execute.after    →  PostToolUse（检测 Bash/git_commit 等产出 → 刷新 context.md）
 *   turn.end              →  Stop（强制刷新 context.md + 显示 additionalContext 提醒）
 *   chat.message          →  SessionStart（首次消息 → 刷新 context.md）
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { homedir } from 'node:os';
import fs from 'node:fs';

const VAULT_ROOT = path.join(homedir(), '.recall-vault');
const CONTEXT_WRITER = path.join(VAULT_ROOT, 'scripts', 'context-writer.mjs');
const LAST_REFRESH_FILE = path.join(VAULT_ROOT, '_logs', '.codearts-last-refresh');
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000; // 5 分钟 throttle

function getWorkspacePath(input) {
  // CodeArts input 里没有直接给 cwd，尝试多种方式推断
  // 1. 从环境变量（如果用户配置了）
  if (process.env.CODEARTS_PROJECT_DIR) return process.env.CODEARTS_PROJECT_DIR;
  if (process.env.CODEARTSDOER_PROJECT_DIR) return process.env.CODEARTSDOER_PROJECT_DIR;
  // 2. input 里可能有 cwd（CodeArts 文档提到过）
  if (input?.cwd && typeof input.cwd === 'string') return input.cwd;
  // 3. 默认 cwd
  return process.cwd();
}

function runContextWriter(workspacePath, force = false) {
  if (!force) {
    try {
      if (fs.existsSync(LAST_REFRESH_FILE)) {
        const last = parseInt(fs.readFileSync(LAST_REFRESH_FILE, 'utf-8').trim(), 10) || 0;
        if (Date.now() - last < REFRESH_COOLDOWN_MS) return null;
      }
    } catch { /* ignore */ }
  }

  return new Promise((resolve) => {
    const env = { ...process.env, CODEARTS_PROJECT_DIR: workspacePath };
    const proc = spawn(process.execPath, [CONTEXT_WRITER], { env, cwd: workspacePath });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => {
      try { fs.mkdirSync(path.dirname(LAST_REFRESH_FILE), { recursive: true }); } catch { /* ignore */ }
      try { fs.writeFileSync(LAST_REFRESH_FILE, String(Date.now()), 'utf-8'); } catch { /* ignore */ }
      try { resolve({ code, result: JSON.parse(out.trim()), stderr: err }); } catch { resolve({ code, raw: out.trim(), stderr: err }); }
    });
    proc.on('error', () => resolve({ code: -1 }));
  });
}

// 检测 Bash 命令是否有产出意义（简化版，比 shell hook 粗）
function isMeaningfulBash(toolName, args) {
  if (toolName !== 'bash' && toolName !== 'shell' && toolName !== 'runCommand') return false;
  const cmd = String(args || '').toLowerCase();
  const patterns = ['git commit', 'git push', 'npm test', 'npm run build', 'npm run test', 'make', 'pytest', 'cargo test', 'cargo build', 'go test', 'go build', 'yarn build', 'pnpm build'];
  return patterns.some((p) => cmd.includes(p));
}

export const RecallVaultPlugin = async () => {
  return {
    // Tool 执行后 → 类似 PostToolUse hook
    'tool.execute.after': async (input, output) => {
      try {
        const toolName = input?.tool || '';
        const args = input?.args || '';

        // 只有有产出意义的 Bash 命令才触发（throttle）
        if (isMeaningfulBash(toolName, args)) {
          const ws = getWorkspacePath(input);
          const result = await runContextWriter(ws);
          if (result?.result?.ok) {
            // 在 output metadata 里加一条轻量提醒（不阻塞）
            output.metadata = output.metadata || {};
            output.metadata.recallVault = {
              contextRefreshed: true,
              byteSize: result.result.byteSize,
              neighbors: result.result.neighborCount,
            };
          }
        }
      } catch { /* 静默失败，不影响工具执行结果 */ }
    },

    // Turn 结束 → 类似 Stop hook，强制刷新
    'turn.end': async (input, output) => {
      try {
        const ws = getWorkspacePath(input);
        const result = await runContextWriter(ws, true); // force
        if (result?.result?.ok) {
          // output 里只能改 metadata，不能改聊天内容
          output.metadata = output.metadata || {};
          output.metadata.recallVaultRefresh = {
            contextPath: result.result.contextPath,
            byteSize: result.result.byteSize,
            neighbors: result.result.neighborCount,
          };
        }
      } catch { /* 静默 */ }
    },

    // 聊天消息 → 类似 SessionStart hook
    'chat.message': async (input, output) => {
      try {
        const ws = getWorkspacePath(input);
        await runContextWriter(ws, true); // force：新 session 开始时必须刷新
      } catch { /* 静默 */ }
    },
  };
};

export default RecallVaultPlugin;
