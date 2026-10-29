/**
 * Stop Hook — 强制 agent 在结束前 remember
 *
 * Trae 在 agent 完成输出、准备结束当前 query 时触发。
 * 如果 agent 最近做了值得记住的事（执行过 RunCommand 但没 remember），
 * 阻断它停止，要求先调 remember。
 * loop_limit=3 防无限循环。
 */

import fs from 'node:fs';
import path from 'node:path';

// 双 IDE 兼容：Trae 用 TRAE_PROJECT_DIR，CodeBuddy 用 CODEBUDDY_PROJECT_DIR
const journalDir = path.join(process.env.TRAE_PROJECT_DIR || process.env.CODEBUDDY_PROJECT_DIR || process.cwd(), 'journal');
const RECENT_WINDOW_MS = 5 * 60 * 1000;

function hasWorthyActivity() {
  if (!fs.existsSync(journalDir)) return { worthy: false, reason: 'no_journal' };

  const now = Date.now();
  const files = fs.readdirSync(journalDir).filter((f) => f.endsWith('.jsonl'));

  let hasRunCommand = false;
  let lastRemember = 0;

  for (const f of files) {
    const lines = fs.readFileSync(path.join(journalDir, f), 'utf-8').split('\n').filter((l) => l.trim());
    for (const line of lines.slice(-30)) {
      try {
        const entry = JSON.parse(line);
        const ts = new Date(entry.ts).getTime();
        if (now - ts > RECENT_WINDOW_MS) continue;
        if (entry.tool === 'RunCommand' || entry.tool === 'run_command') hasRunCommand = true;
        if (entry.tool === 'remember') lastRemember = ts;
      } catch { /* skip */ }
    }
  }

  if (hasRunCommand && Date.now() - lastRemember > RECENT_WINDOW_MS) {
    return { worthy: true, reason: 'commands_executed_not_saved' };
  }
  return { worthy: false, reason: 'ok' };
}

const { worthy, reason } = hasWorthyActivity();

if (worthy) {
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason: `[RecallVault Stop Hook] 检测到本 session 有值得保存的产出。请先调用 remember：\n\n如果是技术决策或修复方案:\n  remember({ memory_type: 'semantic', content: '决策/修复内容', priority: 2, tags: ['implementation'] })\n\n如果是 session 摘要:\n  remember({ memory_type: 'episodic', session_id: 'sess_' + new Date().toISOString().slice(0, 10).replace(/-/g, '') })`,
    }),
  );
} else {
  process.stdout.write(JSON.stringify({ continue: true }));
}
