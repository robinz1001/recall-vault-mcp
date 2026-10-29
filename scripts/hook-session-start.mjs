/**
 * SessionStart Hook — 主动注入压缩上下文摘要（~300 token）
 *
 * 对比旧版（只扫文件名），新版：
 *   1. 直接读 vault 所有 md 记忆的 frontmatter + body 前 150 字符
 *   2. 过滤 superseded（valid_to !== null）和 archived
 *   3. 按时间倒序取最近 3 条 semantic + 最新 1 条 episodic
 *   4. 生成 ~300 token 压缩摘要，塞进 additionalContext
 *
 * 设计原则：
 *   - 零依赖：纯正则解析 YAML frontmatter（20 行代码）
 *   - fail-safe：任何异常都降级到旧版引导文字
 *   - 跨 IDE：TRAE_PROJECT_DIR / CODEBUDDY_PROJECT_DIR / cwd 三兼容
 */

import fs from 'node:fs';
import path from 'node:path';

const cwd = process.env.TRAE_PROJECT_DIR || process.env.CODEBUDDY_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.env.CODEX_PROJECT_DIR || process.env.WINDSURF_PROJECT_DIR || process.env.OPENCODE_PROJECT_DIR || process.cwd();

/** 解析 vault root（与 src/config.ts 完全一致的优先级）
 *  1. COA_VAULT_PATH 环境变量（用户显式指定就尊重）
 *  2. ~/.recall-vault（全局默认）
 *
 * 关键：mcp.json 里的 env 只传给 MCP server，hook 脚本是 IDE 直接 spawn 的，
 * 不会继承 mcp.json 的 env。所以 COA_VAULT_PATH 经常是空的，此时走全局默认。
 */
function resolveVaultRoot() {
  if (process.env.COA_VAULT_PATH) {
    return path.resolve(process.env.COA_VAULT_PATH);
  }
  const homeDir = process.env.USERPROFILE || process.env.HOME || path.dirname(cwd);
  const homeDefault = path.join(homeDir, '.recall-vault');
  return homeDefault;
}

/** 极简 YAML frontmatter 解析（只处理我们用到的几个字段） */
function parseFrontmatter(raw) {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch) return { meta: {}, body: raw.trim() };

  const yaml = fmMatch[1];
  const body = fmMatch[2].trim();
  const meta = {};

  // 逐行解析，支持字符串/数字/数组/布尔
  for (const line of yaml.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();

    // 数组 [a, b, c]
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    } else if (val === 'true') meta[key] = true;
    else if (val === 'false') meta[key] = false;
    else if (/^-?\d+(\.\d+)?$/.test(val)) meta[key] = Number(val);
    else meta[key] = val.replace(/^['"]|['"]$/g, '');
  }

  return { meta, body };
}

/** 递归收集 vault 下所有 md 文件 */
function collectMdFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  function walk(cur) {
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md')) results.push(full);
    }
  }
  walk(dir);
  return results;
}

/** 估算 token（ASCII 4 chars/token, CJK 3 chars/token） */
function estimateTokens(text) {
  let ascii = 0, cjk = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++; else cjk++;
  }
  return Math.ceil(ascii / 4 + cjk / 3);
}

/** 从 body 提取标题（第一行非空文本或 # 开头的标题） */
function extractTitle(body) {
  const firstLine = body.split('\n').find((l) => l.trim().length > 0) ?? '';
  const h1 = firstLine.match(/^#\s+(.+)/);
  if (h1) return h1[1].trim();
  return firstLine.slice(0, 60).trim();
}

/** 格式化 staleness 为人类可读字符串（"2天前" / "3小时前"） */
function ageLabel(isoStr) {
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

/** 生成压缩摘要 */
function buildCompressedSummary(vaultRoot) {
  const allMd = collectMdFiles(vaultRoot);
  if (allMd.length === 0) return null;

  const entries = [];
  for (const fp of allMd) {
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      const { meta, body } = parseFrontmatter(raw);

      // 过滤
      if (meta.archived) continue;
      if (meta.valid_to) continue; // superseded
      if (!meta.id) continue;

      const isShared = fp.includes(path.sep + 'shared' + path.sep);
      const type = meta.memory_type || 'semantic';
      if (type === 'episodic') continue; // episodic 单独处理

      // snippet：跳过第一行 markdown 标题行，避免跟 title 重复
      const bodyLines = body.split('\n').filter((l) => l.trim().length > 0);
      let snippetText = bodyLines.find((l) => !/^#+\s+/.test(l)) || bodyLines[0] || '';
      snippetText = snippetText.replace(/\s+/g, ' ').trim();

      entries.push({
        id: meta.id,
        title: extractTitle(body),
        snippet: snippetText.slice(0, 150),
        priority: meta.priority || 2,
        tags: (meta.tags || []).slice(0, 4).join(' '),
        updated_at: meta.updated_at || meta.created_at || fs.statSync(fp).mtime.toISOString(),
        isShared,
      });
    } catch { /* 跳过损坏文件 */ }
  }

  if (entries.length === 0) return null;

  // 按 priority DESC, updated_at DESC 排序
  entries.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  // 取最近 3 条（priority >= 2 的优先）
  const top = entries.slice(0, 3);

  // 找最新 episodic
  let episodicNote = null;
  for (const fp of allMd) {
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      const { meta, body } = parseFrontmatter(raw);
      if (meta.memory_type !== 'episodic') continue;
      if (meta.valid_to) continue;
      episodicNote = {
        snippet: body.replace(/\s+/g, ' ').trim().slice(0, 120),
        updated_at: meta.updated_at || meta.created_at || fs.statSync(fp).mtime.toISOString(),
      };
      break; // 取第一个（episodic 按时间排序过，但我们只取一条）
    } catch { /* skip */ }
  }

  // 生成文本
  const lines = [''];
  for (const e of top) {
    const star = e.priority === 3 ? ' ⚠️' : e.priority === 1 ? '' : '';
    lines.push(`📌 [${e.title.slice(0, 50)}]${star} (${ageLabel(e.updated_at)}${e.isShared ? ' · shared' : ''})`);
    if (e.tags) lines.push(`   #${e.tags.replace(/ /g, ' #')}`);
    lines.push(`   ${e.snippet}${e.snippet.length >= 150 ? '…' : ''}`);
    lines.push('');
  }
  if (episodicNote) {
    lines.push(`📝 上 session: ${ageLabel(episodicNote.updated_at)}`);
    lines.push(`   ${episodicNote.snippet}${episodicNote.snippet.length >= 120 ? '…' : ''}`);
    lines.push('');
  }

  const summary = lines.join('\n');
  return {
    text: summary,
    est_tokens: estimateTokens(summary),
    memory_count: top.length + (episodicNote ? 1 : 0),
  };
}

// === 主流程 ===
try {
  const vaultRoot = resolveVaultRoot();

  const bundle = buildCompressedSummary(vaultRoot);

  let context;
  if (bundle && bundle.memory_count > 0) {
    context = `[RecallVault SessionStart Hook] 新 session 开始，已为你准备压缩上下文摘要（~${bundle.est_tokens} tokens）：
${bundle.text}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

使用建议：
1. 以上是最近的高价值记忆。直接作为上下文参考，避免重复踩坑。
2. 需要更精确的搜索或更多结果时，调用 recall({ query: "关键词", include_shared: true, limit: 5 })。
3. 完成工作后主动调 remember 沉淀决策和发现。`;
  } else {
    // vault 是空的，给引导
    context = `[RecallVault SessionStart Hook] 新 session 开始。

Vault 是空的 — 这是全新 start。记得在工作过程中主动 remember：
- 架构决策 → remember({ memory_type: 'semantic', scope: 'project', priority: 2, tags: ['architecture'] })
- 踩坑经验 → remember({ memory_type: 'semantic', scope: 'project', priority: 3, tags: ['regression'] })
- 跨项目知识 → remember({ memory_type: 'semantic', scope: 'shared' })
- Session 结束 → remember({ memory_type: 'episodic', session_id: 'sess_' + new Date().toISOString().slice(0, 10).replace(/-/g, '') })

工作遇到相关问题时，调用 recall({ query: "关键词", include_shared: true, limit: 5 }) 取回上下文。`;
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    }),
  );
} catch (err) {
  // fail-safe：任何异常都输出引导文字
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `[RecallVault SessionStart Hook] 摘要生成失败（${err.message}）。请手动调用 health_check + recall 取回上下文。`,
      },
    }),
  );
}
