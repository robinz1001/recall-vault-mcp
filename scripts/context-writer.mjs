/**
 * context-writer.mjs — 项目本地 .recall-vault/context.md 生成器
 *
 * 被三个 hook 共用：
 *   - hook-session-start.mjs  → session 开始时自动生成
 *   - hook-post-tool.mjs      → 产出事件后刷新（throttle 5 分钟）
 *   - hook-stop.mjs           → session 结束时刷新
 *
 * 调用方式：
 *   import { syncContextMd } from './context-writer.mjs';
 *   const result = syncContextMd(workspacePath);
 *   // result = { contextPath, neighborCount, byteSize }
 */

import fs from 'node:fs';
import path from 'node:path';

const IDE_PROJECT_DIR_ENV = [
  'TRAE_PROJECT_DIR', 'CODEBUDDY_PROJECT_DIR', 'CLAUDE_PROJECT_DIR',
  'CODEX_PROJECT_DIR', 'WINDSURF_PROJECT_DIR', 'OPENCODE_PROJECT_DIR',
];

export function resolveWorkspacePath() {
  for (const env of IDE_PROJECT_DIR_ENV) {
    if (process.env[env]) return process.env[env];
  }
  return process.cwd();
}

export function resolveVaultRoot() {
  if (process.env.COA_VAULT_PATH) return path.resolve(process.env.COA_VAULT_PATH);
  const home = process.env.USERPROFILE || process.env.HOME;
  return path.join(home, '.recall-vault');
}

export function inferProjectId(workspacePath, vaultRoot) {
  let pid = path.basename(workspacePath).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  // 如果 workspace 在 vault/projects/ 下 → 直接用目录名
  const inVaultProjects = path.relative(path.join(vaultRoot, 'projects'), workspacePath);
  if (!inVaultProjects.startsWith('..') && path.dirname(inVaultProjects) === '.') {
    pid = path.basename(workspacePath).toLowerCase();
  }
  return pid;
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const lm = line.match(/^(\w+):\s*(.*)$/);
    if (lm) {
      let val = lm[2].trim();
      if (val.startsWith("'") || val.startsWith('"')) val = val.slice(1, -1);
      // 数组简易解析
      if (val.startsWith('[') && val.endsWith(']')) {
        val = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
      }
      meta[lm[1]] = val;
    }
  }
  return { meta, body: m[2] };
}

function extractTitle(body) {
  const firstLine = body.split('\n').find((l) => l.trim().length > 0) ?? '';
  const t = firstLine.replace(/^#+\s*/, '').trim();
  return t || '(无标题)';
}

function ageLabel(isoStr) {
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days}天前`;
  if (days < 30) return `${Math.floor(days / 7)}周前`;
  return `${Math.floor(days / 30)}月前`;
}

function isTemplateBody(body) {
  if (!body) return true;
  const t = body.trim();
  if (t.length < 20) return true;
  let score = 0;
  if (t.includes('<!--')) score++;
  if (/^- \[.\]/.test(t)) score++;
  if (/^\|/.test(t.split('\n').find((l) => l.startsWith('|')) || '')) score++;
  if (/R\d+:/.test(t)) score++;
  const commentCount = (t.match(/<!--/g) || []).length;
  score += Math.min(commentCount, 2);
  return score >= 2;
}

function collectMdFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && !e.name.startsWith('_') && e.name !== 'node_modules' && e.name !== '.git') {
        walk(full);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        result.push(full);
      }
    }
  };
  walk(dir);
  return result;
}

function getVaultProjectIds(vaultRoot) {
  const dir = path.join(vaultRoot, 'projects');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name.toLowerCase());
}

function contentCrossCheck(body, pid, vaultRoot, meta) {
  const projectIds = getVaultProjectIds(vaultRoot);
  if (projectIds.length <= 1) return true;

  const contentLower = body.toLowerCase();
  for (const otherPid of projectIds) {
    if (otherPid === pid) continue;
    if (meta?.project_id === otherPid) continue;
    if (otherPid.length <= 5) continue; // 短项目名跳过（如 "robin" 同时是用户名）

    const escaped = otherPid.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
    if (regex.test(contentLower)) return false;
  }
  return true;
}

function isRelevantProject(filePath, vaultRoot, pid, meta, body) {
  const rel = path.relative(vaultRoot, filePath);

  if (meta?.project_id && String(meta.project_id).toLowerCase() === pid) {
    if (body && !contentCrossCheck(body, pid, vaultRoot, meta)) return false;
    return true;
  }

  if (meta?.project_id && String(meta.project_id).toLowerCase() !== 'shared') return false;

  if (rel.startsWith('shared' + path.sep)) {
    if (body && !contentCrossCheck(body, pid, vaultRoot, meta)) return false;
    return true;
  }

  if (rel.startsWith(path.join('projects', pid) + path.sep)) {
    if (body && !contentCrossCheck(body, pid, vaultRoot, meta)) return false;
    return true;
  }
  return false;
}

function buildSnapshotSummary(vaultRoot, pid) {
  const snapshotDir = path.join(vaultRoot, 'projects', pid, '_snapshot');
  if (!fs.existsSync(snapshotDir)) return null;

  const files = ['project.md', 'stack.md', 'architecture.md', 'conventions.md'];
  const parts = [];
  let estTokens = 0;

  for (const f of files) {
    const fp = path.join(snapshotDir, f);
    if (!fs.existsSync(fp)) continue;
    const content = fs.readFileSync(fp, 'utf-8');
    if (isTemplateBody(content)) continue;
    const shortName = f.replace('.md', '');
    const summary = content.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).slice(0, 4).join(' | ').slice(0, 120);
    if (summary) {
      parts.push(`${shortName}: ${summary}`);
      estTokens += Math.ceil(summary.length / 4);
    }
  }

  if (parts.length === 0) return null;
  return { text: parts.join('\n'), est_tokens: estTokens };
}

export function discoverNeighbors(workspacePath, vaultRoot) {
  const neighbors = [];
  const foundPaths = new Set();

  let parentDepth = 0;
  let dir = path.resolve(workspacePath);
  for (; parentDepth <= 3; parentDepth++) {
    const queue = [{ cur: dir, depth: 0 }];
    const scannedDirs = new Set();

    while (queue.length > 0) {
      const { cur, depth } = queue.shift();
      if (depth > 2) continue;
      if (scannedDirs.has(cur)) continue;
      scannedDirs.add(cur);

      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }

      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith('.') && e.name !== '.recall-vault') continue;

        const sub = path.join(cur, e.name);
        if (sub === workspacePath) continue;
        if (foundPaths.has(sub)) continue;

        const contextPath = path.join(sub, '.recall-vault', 'context.md');
        if (fs.existsSync(contextPath)) {
          foundPaths.add(sub);
          const pid = path.basename(sub).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
          neighbors.push({
            project_id: pid,
            name: path.basename(sub),
            rel_path: path.relative(workspacePath, contextPath).replace(/\\/g, '/'),
            abs_path: contextPath,
            distance: parentDepth + depth,
            has_context: true,
          });
        } else {
          if (depth < 2 && !e.name.startsWith('node_modules') && !e.name.startsWith('.git')) {
            queue.push({ cur: sub, depth: depth + 1 });
          }
        }
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return neighbors
    .sort((a, b) => a.distance - b.distance)
    .filter((n, i, arr) => arr.findIndex((x) => x.abs_path === n.abs_path) === i)
    .slice(0, 8);
}

function peekNeighborSummary(vaultRoot, neighborPid) {
  const snapshotDir = path.join(vaultRoot, 'projects', neighborPid, '_snapshot');
  if (!fs.existsSync(snapshotDir)) return null;
  const projectFp = path.join(snapshotDir, 'project.md');
  if (!fs.existsSync(projectFp)) return null;
  const content = fs.readFileSync(projectFp, 'utf-8');
  if (isTemplateBody(content)) return null;
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.includes('<!--') || t.includes('[ ]') || t.includes('[x]')) continue;
    return t.slice(0, 60);
  }
  return null;
}

function buildFullContextMd(vaultRoot, workspacePath, pid, snapshot, neighbors) {
  const now = new Date();
  const nowStr = now.toISOString().replace('T', ' ').slice(0, 19);
  const projName = path.basename(workspacePath);
  const vaultProjDir = path.join(vaultRoot, 'projects', pid);

  const lines = [];
  lines.push(`# ${projName} — RecallVault 上下文`);
  lines.push(`> 同步: ${nowStr}  |  Vault: \`${vaultProjDir.replace(/\\/g, '/')}\``);
  lines.push(`> **这是磁盘上的真实文件，任何 IDE 的 agent 都可以直接 ReadFile**`);
  lines.push('');

  // 1. 项目画像
  lines.push('## 📋 项目画像');
  if (snapshot) {
    lines.push(snapshot.text);
  } else {
    lines.push('_（未填写快照，建议在 vault 的 `_snapshot/` 下创建 project.md / stack.md / architecture.md / conventions.md）_');
  }
  lines.push('');

  // 2. Top 5 记忆
  lines.push('## 🔥 关键记忆');
  const allMd = collectMdFiles(vaultRoot);
  const entries = [];
  for (const fp of allMd) {
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      const { meta, body } = parseFrontmatter(raw);
      if (!isRelevantProject(fp, vaultRoot, pid, meta, body)) continue;
      if (meta.archived || meta.valid_to || !meta.id) continue;
      const type = meta.memory_type || 'semantic';
      if (type === 'episodic') continue;

      const stat = fs.statSync(fp);
      entries.push({
        id: meta.id,
        title: extractTitle(body),
        snippet: body.replace(/\s+/g, ' ').trim().slice(0, 120),
        priority: meta.priority || 2,
        tags: (meta.tags || []).slice(0, 3).join(' '),
        updated_at: meta.updated_at || meta.created_at || stat.mtime.toISOString(),
        fp: fp.replace(/\\/g, '/'),
      });
    } catch { /* skip */ }
  }
  entries.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });
  const top5 = entries.slice(0, 5);
  if (top5.length > 0) {
    for (const e of top5) {
      const star = e.priority === 3 ? '⚠️ ' : '';
      lines.push(`- ${star}**${e.title.slice(0, 60)}** (${ageLabel(e.updated_at)})`);
      if (e.tags) lines.push(`  - #${e.tags.replace(/ /g, ' #')}`);
      lines.push(`  - ${e.snippet}${e.snippet.length >= 120 ? '…' : ''}`);
      lines.push(`  - 📎 \`${e.fp}\``);
      lines.push('');
    }
  } else {
    lines.push('_（暂无记忆）_');
    lines.push('');
  }

  // 3. 关联项目
  lines.push('## 🔗 关联项目');
  if (neighbors.length > 0) {
    for (const n of neighbors) {
      const summary = peekNeighborSummary(vaultRoot, n.project_id);
      const desc = summary ? ` — ${summary}` : '';
      lines.push(`- **${n.name}** → \`${n.rel_path}\`${desc}`);
    }
  } else {
    lines.push('_（未发现邻居项目 — 把多个项目放在同一个祖先目录下会自动发现）_');
  }
  lines.push('');
  lines.push('> 💡 跨项目读取: `ReadFile("../{neighbor}/.recall-vault/context.md")` 即可拿到邻居的完整上下文。');
  lines.push('');

  // 4. 记忆索引
  lines.push('## 📖 记忆索引');
  let idx = 1;
  for (const e of entries.slice(0, 20)) {
    lines.push(`${idx}. **${e.title.slice(0, 50)}** — ${ageLabel(e.updated_at)} — \`${e.id}\``);
    idx++;
  }

  // 上 session 摘要
  const episodicFiles = allMd
    .filter((fp) => {
      try {
        const raw = fs.readFileSync(fp, 'utf-8');
        const { meta, body } = parseFrontmatter(raw);
        return isRelevantProject(fp, vaultRoot, pid, meta, body)
          && meta.memory_type === 'episodic' && !meta.valid_to && !meta.archived;
      } catch { return false; }
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (episodicFiles.length > 0) {
    lines.push('');
    lines.push('**上 session 摘要:**');
    try {
      const latest = fs.readFileSync(episodicFiles[0], 'utf-8');
      const { body } = parseFrontmatter(latest);
      lines.push(body.replace(/\s+/g, ' ').trim().slice(0, 300));
    } catch { /* skip */ }
  }
  lines.push('');

  // 5. 使用指引
  lines.push('---');
  lines.push('');
  lines.push('### Agent 使用指引');
  lines.push('');
  lines.push('1. **开始工作前**: 已经在看这个文件了 ✅');
  lines.push('2. **需要更精确搜索**: `recall({ query: "关键词", include_shared: true, limit: 5 })`');
  lines.push('3. **完成重要决策**: `remember({ content: "决策内容", tags: ["architecture"] })`');
  lines.push('4. **查看邻居项目**: `ReadFile("../{neighbor}/.recall-vault/context.md")`');
  lines.push('5. **Session 结束前**: `session_end({ summary: "...", highlights: ["...", "..."] })`');

  return lines.join('\n');
}

export function writeProjectLocal(workspacePath, pid, contextMd, neighbors, vaultRoot) {
  const localDir = path.join(workspacePath, '.recall-vault');
  fs.mkdirSync(localDir, { recursive: true });

  const contextPath = path.join(localDir, 'context.md');
  fs.writeFileSync(contextPath, contextMd, 'utf-8');

  const crossRefs = {
    self: {
      project_id: pid,
      context_path: '.recall-vault/context.md',
      vault_project_dir: path.join(vaultRoot, 'projects', pid).replace(/\\/g, '/'),
      last_sync: new Date().toISOString(),
    },
    neighbors: neighbors.map((n) => ({
      project_id: n.project_id,
      name: n.name,
      rel_path: n.rel_path,
      abs_path: n.abs_path.replace(/\\/g, '/'),
      distance: n.distance,
      has_context: n.has_context,
    })),
  };
  fs.writeFileSync(path.join(localDir, 'cross-refs.json'), JSON.stringify(crossRefs, null, 2), 'utf-8');

  const gitignorePath = path.join(localDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '# RecallVault auto-generated sync directory\n_logs/\ncache/\n', 'utf-8');
  }

  return { contextPath };
}

/**
 * 🔴 主入口 — 同步 context.md
 *
 * @param {string} workspacePath - 项目路径（默认自动推断）
 * @returns {{ contextPath: string, neighborCount: number, byteSize: number, ok: boolean }}
 */
export function syncContextMd(workspacePath) {
  const ws = workspacePath || resolveWorkspacePath();
  const vaultRoot = resolveVaultRoot();
  const pid = inferProjectId(ws, vaultRoot);

  try {
    const snapshot = buildSnapshotSummary(vaultRoot, pid);
    const neighbors = discoverNeighbors(ws, vaultRoot);
    const contextMd = buildFullContextMd(vaultRoot, ws, pid, snapshot, neighbors);
    const { contextPath } = writeProjectLocal(ws, pid, contextMd, neighbors, vaultRoot);
    const stat = fs.statSync(contextPath);

    return {
      ok: true,
      contextPath,
      neighborCount: neighbors.length,
      byteSize: stat.size,
      project_id: pid,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      project_id: pid,
    };
  }
}

// 直接运行（用于 CLI 测试）
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = syncContextMd();
  console.log(JSON.stringify(result, null, 2));
}
