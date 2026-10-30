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
/** remember 冷却期：一次 remember 后 30 分钟内不再阻断（避免频繁打扰） */
const REMEMBER_COOLDOWN_MS = 30 * 60 * 1000;
/** activity 过期时间：超过 2 小时的不再阻断 */
const ACTIVITY_TTL_MS = 2 * 60 * 60 * 1000;

function loadMarker() {
  try {
    if (!fs.existsSync(markerFile)) return { activities: [], last_remember_ts: null };
    return JSON.parse(fs.readFileSync(markerFile, 'utf-8'));
  } catch { return { activities: [], last_remember_ts: null }; }
}

/**
 * 过滤出"值得阻断"的 activity
 * 规则（严格收敛，Stop Hook 是最后防线，不是日常提醒）：
 *   1. priority >= 3（只有 test_pass 和有验证的 commit 才会到 3）
 *   2. 在冷却期外（最近 30 分钟内没 remember 过）
 *   3. activity 没过期（2 小时内）
 *   4. 没被 remember 过（remember 比 activity 新的不算）
 */
function filterWorthy(activities, lastRememberTs) {
  if (!activities || activities.length === 0) return [];
  const now = Date.now();
  const lastRememberMs = lastRememberTs ? new Date(lastRememberTs).getTime() : 0;

  // 冷却期内 → 整体放弃阻断
  if (now - lastRememberMs < REMEMBER_COOLDOWN_MS) return [];

  return activities.filter((a) => {
    const ageMs = now - new Date(a.ts).getTime();
    // 过期
    if (ageMs > ACTIVITY_TTL_MS) return false;
    // 只有 priority >= 3 才阻断（priority 1=commit 静默过，2=build/install/deploy 静默过）
    if (a.priority < 3) return false;
    // 已被 remember 过
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
      const ageMs = Date.now() - new Date(a.ts).getTime();
      return ageMs < ACTIVITY_TTL_MS;
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
