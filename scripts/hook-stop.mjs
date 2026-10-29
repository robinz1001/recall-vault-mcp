/**
 * Stop Hook — 强制 agent 在结束前 remember（真正可用版本）
 *
 * 旧版 bug：从 recall-vault 的 journal 里找 RunCommand，但 journal 里只有 MCP tool 调用，
 * RunCommand 是 IDE 自带工具，根本不会写入 journal → Stop Hook 从来没阻断过。
 *
 * 新版：读 agent-state/activity.json marker（由 PostToolUse Hook 写入），
 * 判断是否有 worthy activity 且最近没 remember → 阻断停止 + 打包建议。
 * loop_limit=3 防无限循环。
 */

import fs from 'node:fs';
import path from 'node:path';

const cwd = process.env.TRAE_PROJECT_DIR || process.env.CODEBUDDY_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.env.CODEX_PROJECT_DIR || process.env.WINDSURF_PROJECT_DIR || process.env.OPENCODE_PROJECT_DIR || process.cwd();
const markerFile = path.join(cwd, 'agent-state', 'activity.json');
const REMEMBER_WINDOW_MS = 10 * 60 * 1000; // 10 分钟内有 remember 就算

function loadMarker() {
  try {
    if (!fs.existsSync(markerFile)) return { activities: [], last_remember_ts: null };
    return JSON.parse(fs.readFileSync(markerFile, 'utf-8'));
  } catch { return { activities: [], last_remember_ts: null }; }
}

/** 过滤出"值得阻断"的 activity：高价值 + 最近 + 没被 remember 过 */
function filterWorthy(activities, lastRememberTs) {
  if (!activities || activities.length === 0) return [];
  const now = Date.now();
  const lastRememberMs = lastRememberTs ? new Date(lastRememberTs).getTime() : 0;

  return activities.filter((a) => {
    const ageMs = now - new Date(a.ts).getTime();
    // 超过 2 小时的 activity 不再阻断（太久了）
    if (ageMs > 2 * 60 * 60 * 1000) return false;
    // priority=1 的（command_success）不阻断
    if (a.priority <= 1) return false;
    // 如果 remember 比 activity 新 → 这条已经被记住了
    if (lastRememberMs > new Date(a.ts).getTime()) return false;
    return true;
  });
}

function formatBlockingMessage(worthy) {
  const lines = [
    `[RecallVault Stop Hook] 检测到 ${worthy.length} 个值得保存的产出，请先调用 remember 再结束：`,
    '',
  ];

  for (let i = 0; i < worthy.length; i++) {
    const a = worthy[i];
    const ageMin = Math.round((Date.now() - new Date(a.ts).getTime()) / 60000);
    const typeLabel = {
      test_pass: '测试通过',
      build_pass: '构建成功',
      git_commit: '代码提交',
      install: '新增依赖',
      deploy: '部署发布',
      command_success: '命令成功',
    }[a.type] || a.type;

    lines.push(`【${i + 1}】${typeLabel} · ${ageMin}分钟前 · priority=${a.priority}`);
    lines.push(`  tags: ${(a.tags || []).join(', ')}`);
    if (a.suggested_content) lines.push(`  建议内容: ${a.suggested_content}`);
    if (a.detail) {
      const short = a.detail.slice(0, 200);
      lines.push(`  上下文: ${short}${a.detail.length > 200 ? '…' : ''}`);
    }
    lines.push('');
  }

  // 给出完整的 remember 调用模板
  const top = worthy[0];
  lines.push('—— 快速调用示例 ——');
  lines.push(`remember({`);
  lines.push(`  memory_type: 'semantic',`);
  lines.push(`  scope: 'project',`);
  lines.push(`  priority: ${top.priority},`);
  lines.push(`  tags: ${JSON.stringify(top.tags || [])},`);
  lines.push(`  content: '<结合上下文写一句完整的决策描述>'`);
  lines.push(`})`);
  lines.push('');
  lines.push(`如果这些 activity 不值得保存，回复"跳过"即可（下次不再阻断）。`);

  return lines.join('\n');
}

const marker = loadMarker();
const worthy = filterWorthy(marker.activities, marker.last_remember_ts);

if (worthy.length > 0) {
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason: formatBlockingMessage(worthy),
    }),
  );
} else {
  // 干净：更新 last_remember_ts（每次正常结束都标记）
  // 这样下次 Stop Hook 不会重复阻断旧 activity
  const updated = {
    ...marker,
    last_remember_ts: new Date().toISOString(),
    activities: marker.activities.filter((a) => {
      // 清理掉超过 2 小时的 activity
      const ageMs = Date.now() - new Date(a.ts).getTime();
      return ageMs < 2 * 60 * 60 * 1000;
    }),
  };
  try {
    ensureStateDir();
    fs.writeFileSync(markerFile, JSON.stringify(updated, null, 2), 'utf-8');
  } catch { /* ignore */ }
  process.stdout.write(JSON.stringify({ continue: true }));
}

function ensureStateDir() {
  if (!fs.existsSync(path.join(cwd, 'agent-state'))) {
    try { fs.mkdirSync(path.join(cwd, 'agent-state'), { recursive: true }); } catch { /* ignore */ }
  }
}
