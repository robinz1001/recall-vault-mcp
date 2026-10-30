/**
 * Stop Hook — 建议模式（不阻断）
 *
 * 设计原则：
 *   Hook 做 Hook 擅长的事（注入上下文提示），不做 agent 擅长的事（调 MCP）。
 *   如果 agent 没有 recall-vault MCP 工具，Stop Hook 阻断只会让 agent 卡住。
 *   所以：只建议，不阻断。让 agent 先把 session 正常跑完。
 *
 * 对比旧版（强制阻断）的问题：
 *   Stop Hook 阻断 → agent 没有 MCP 工具 → 卡住 → 回答不了 → loop_limit=3 后放行
 *   → marker 没被清理 → 下次新 session 还阻断 → 循环
 *
 * 新版行为：
 *   1. 如果有 priority>=3 的 worthy activity → 通过 additionalContext 提示
 *   2. 每次都清理过期 activity + 更新 last_remember_ts（防止堆积）
 *   3. 永远 return continue:true（不 block）
 */

import fs from 'node:fs';
import path from 'node:path';

const cwd = process.env.TRAE_PROJECT_DIR || process.env.CODEBUDDY_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.env.CODEX_PROJECT_DIR || process.env.WINDSURF_PROJECT_DIR || process.env.OPENCODE_PROJECT_DIR || process.cwd();
const markerFile = path.join(cwd, 'agent-state', 'activity.json');
const REMEMBER_COOLDOWN_MS = 30 * 60 * 1000;
const ACTIVITY_TTL_MS = 2 * 60 * 60 * 1000;

function loadMarker() {
  try {
    if (!fs.existsSync(markerFile)) return { activities: [], last_remember_ts: null };
    return JSON.parse(fs.readFileSync(markerFile, 'utf-8'));
  } catch { return { activities: [], last_remember_ts: null }; }
}

function filterWorthy(activities, lastRememberTs) {
  if (!activities || activities.length === 0) return [];
  const now = Date.now();
  const lastRememberMs = lastRememberTs ? new Date(lastRememberTs).getTime() : 0;
  if (now - lastRememberMs < REMEMBER_COOLDOWN_MS) return [];

  return activities.filter((a) => {
    const ageMs = now - new Date(a.ts).getTime();
    if (ageMs > ACTIVITY_TTL_MS) return false;
    if (a.priority < 3) return false;
    if (lastRememberMs > new Date(a.ts).getTime()) return false;
    return true;
  });
}

const marker = loadMarker();
const worthy = filterWorthy(marker.activities, marker.last_remember_ts);

// 每次都清理过期 activity + 更新 last_remember_ts
const updated = {
  ...marker,
  last_remember_ts: new Date().toISOString(),
  activities: marker.activities.filter((a) => {
    const ageMs = Date.now() - new Date(a.ts).getTime();
    return ageMs < ACTIVITY_TTL_MS;
  }),
};
try {
  const dir = path.dirname(markerFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(markerFile, JSON.stringify(updated, null, 2), 'utf-8');
} catch { /* ignore */ }

if (worthy.length > 0) {
  const top = worthy[0];
  const typeLabel = {
    test_pass: '测试通过', build_pass: '构建成功',
    git_commit: '代码提交', install: '新增依赖',
    deploy: '部署发布', command_success: '命令成功',
  }[top.type] || top.type;

  const ageMin = Math.round((Date.now() - new Date(top.ts).getTime()) / 60000);
  const hint = `[RecallVault Stop Hook] 📝 有 ${worthy.length} 个值得保存的产出（最近：${typeLabel} · ${ageMin}分钟前 · priority=${top.priority}）。如果 recall-vault MCP 可用，可以在下次 session 用 session_start 恢复上下文，或手动 remember。`;

  process.stdout.write(JSON.stringify({
    continue: true,  // 关键：永远不阻断
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: hint,
    },
  }));
} else {
  process.stdout.write(JSON.stringify({ continue: true }));
}
