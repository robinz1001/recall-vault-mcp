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

/** 从 workspace 路径推断 project_id（与 src/storage/vault.ts 一致）
 *  关键：优先用目录名（basename），因为 package.json name 可能含中文
 */
function inferProjectId(workspacePath, vaultRoot) {
  const basenameId = path.basename(workspacePath).toLowerCase().replace(/[^a-z0-9_-]/g, '_');

  // 1. 目录名已经在 vault 里 → 直接用
  const basenameDir = path.join(vaultRoot, 'projects', basenameId);
  if (fs.existsSync(basenameDir)) return basenameId;

  // 2. 找 git root 的 basename
  let dir = workspacePath;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      const gitId = path.basename(dir).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      if (fs.existsSync(path.join(vaultRoot, 'projects', gitId))) return gitId;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 3. 尝试 package.json name（但如果包含非 ASCII 字符就跳过）
  const pkgPath = path.join(workspacePath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.name && /^[a-zA-Z0-9_\-@/]+$/.test(pkg.name)) {
        const pkgId = pkg.name.replace(/^@[^/]+\//, '').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
        if (fs.existsSync(path.join(vaultRoot, 'projects', pkgId))) return pkgId;
      }
    } catch { /* ignore */ }
  }

  // 4. fallback: basename（即使 vault 里还没有，也让后续写入正确）
  return basenameId;
}

/** 扫描记忆 body 是否包含 vault 里其他项目的名称
 *
 * 场景：agent 在 recall-vault 工作，但 remember 了 tournament-master 的内容，
 *       frontmatter project_id 被推断成 recall-vault → 污染上下文。
 *
 * 防御：如果 vault 里存在其他项目目录 X，且记忆内容提到 "X"，
 *       但 frontmatter project_id !== X（也不是 shared）→ 排除。
 */
let _vaultProjectIdsCache = null;
function getVaultProjectIds(vaultRoot) {
  if (_vaultProjectIdsCache) return _vaultProjectIdsCache;
  const dir = path.join(vaultRoot, 'projects');
  if (!fs.existsSync(dir)) { _vaultProjectIdsCache = []; return []; }
  _vaultProjectIdsCache = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name.toLowerCase());
  return _vaultProjectIdsCache;
}

function contentCrossCheck(body, pid, vaultRoot, meta) {
  const projectIds = getVaultProjectIds(vaultRoot);
  if (projectIds.length <= 1) return true;

  const contentLower = body.toLowerCase();
  for (const otherPid of projectIds) {
    if (otherPid === pid) continue;
    if (meta?.project_id === otherPid) continue;

    // 短项目名（≤5字符）跳过 — 容易误伤（如 "robin" 同时是用户名）
    if (otherPid.length <= 5) continue;

    // 用单词边界匹配 — 避免把路径片段（.recall-vault/）里的 pid 算进去
    // tournament-master → 匹配独立出现（不是作为其他 pid 的子串）
    const escaped = otherPid.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
    if (regex.test(contentLower)) {
      return false;
    }
  }
  return true;
}

/** 判断 md 文件是否属于当前项目（或 shared）
 *
 * 四层检查，**严格按优先级**：
 *
 *   1. frontmatter 精确匹配当前 pid → ✅ 直接通过（不管内容！）
 *      场景：mfel-studio 的记忆提到了 recall-vault（它用了 recall-vault MCP）
 *      → 这是正常的，不该排除
 *
 *   2. frontmatter 标记了其他项目 → ❌ 排除
 *
 *   3. frontmatter 标记 shared 或未标记 + 物理路径在 shared/
 *      → 才用 contentCrossCheck 查内容（只在模糊场景下启用）
 *
 *   4. 物理路径 fallback（老记忆没 project_id）
 */
function isRelevantProject(filePath, vaultRoot, pid, meta, body) {
  const rel = path.relative(vaultRoot, filePath);

  // 1. frontmatter 精确匹配当前 pid → 但还是做 contentCrossCheck
  //    因为 frontmatter 可能被 agent 错误推断（如在 recall-vault 工作时 remember 了 tournament-master，project_id 被推断成 recall-vault）
  if (meta?.project_id && String(meta.project_id).toLowerCase() === pid) {
    if (body && !contentCrossCheck(body, pid, vaultRoot, meta)) {
      return false;
    }
    return true;
  }

  // 2. frontmatter 标记了其他项目 → 排除
  if (meta?.project_id && String(meta.project_id).toLowerCase() !== 'shared') {
    return false;
  }

  // 3. frontmatter 标记 shared 或未标记 + 物理路径在 shared/
  if (rel.startsWith('shared' + path.sep)) {
    if (body && !contentCrossCheck(body, pid, vaultRoot, meta)) {
      return false;
    }
    return true;
  }

  // 4. 物理路径 fallback
  if (rel.startsWith(path.join('projects', pid) + path.sep)) {
    if (body && !contentCrossCheck(body, pid, vaultRoot, meta)) {
      return false;
    }
    return true;
  }
  return false;
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

/** 判断快照内容是否是空模板 */
function isTemplateBody(body) {
  if (!body) return true;
  if (body.includes('<!-- 一句话描述') && body.includes('<!-- 3-5 条')) return true;
  // 模板占位符：表格标题 | 组件 | 职责 | 位置 |
  if (body.includes('| 组件 |') && body.includes('| 职责 |')) return true;
  // 模板红线：R1: XXX — 破坏后果
  if (/R\d+: XXX/.test(body)) return true;
  const comments = (body.match(/<!--[\s\S]*?-->/g) || []).length;
  return comments >= 3;
}

/** 读快照目录（projects/{pid}/_snapshot/）生成项目画像摘要 */
function buildSnapshotSummary(vaultRoot, pid) {
  const snapshotDir = path.join(vaultRoot, 'projects', pid, '_snapshot');
  if (!fs.existsSync(snapshotDir)) return null;

  const files = ['project', 'stack', 'architecture', 'conventions'];
  const parts = [];

  for (const name of files) {
    const fp = path.join(snapshotDir, `${name}.md`);
    if (!fs.existsSync(fp)) continue;
    const content = fs.readFileSync(fp, 'utf-8');
    if (isTemplateBody(content)) continue;

    if (name === 'stack') {
      const techs = [];
      for (const line of content.split('\n')) {
        if (!line.startsWith('|')) continue;
        const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
        if (cells.some((c) => c.includes('---') || c === '层' || c === '技术')) continue;
        if (cells[1] && !cells[1].includes('<!--')) techs.push(cells[1]);
        if (techs.length >= 4) break;
      }
      if (techs.length > 0) parts.push(`技术栈: ${techs.join(' · ')}`);
    } else if (name === 'project') {
      const goals = content.match(/-\s*\[[ x]\]\s*([^\n{]+)/g)?.slice(0, 2) || [];
      const goalText = goals
        .map((g) => g.replace(/-\s*\[[ x]\]\s*/, '').slice(0, 40))
        .filter((t) => !t.includes('<!--') && !t.includes('目标 1'));
      if (goalText.length > 0) parts.push(`目标: ${goalText.join('；')}`);
    } else if (name === 'conventions') {
      const redlines = content.match(/R\d+[：:][^\n]*/g)?.slice(0, 2) || [];
      // 过滤模板占位符 "R1: XXX — 破坏后果"
      const realRedlines = redlines.filter((r) => !r.includes('XXX'));
      if (realRedlines.length > 0) parts.push(`红线: ${realRedlines.join('；').slice(0, 100)}`);
    } else if (name === 'architecture') {
      const firstMeaningful = content
        .split('\n')
        .find((l) => {
          const t = l.trim();
          if (!t || t.startsWith('#') || t.includes('<!--')) return false;
          if (/^\|[\s\-|:]+\|$/.test(t)) return false;
          if (t.includes('组件') && t.includes('职责')) return false;
          return true;
        });
      if (firstMeaningful) parts.push(`架构: ${firstMeaningful.trim().slice(0, 60)}`);
    }
  }

  if (parts.length === 0) return null;
  const text = parts.join(' · ');
  let ascii = 0, cjk = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++; else cjk++;
  }
  return { text, est_tokens: Math.ceil(ascii / 4 + cjk / 3) };
}

/** 生成压缩摘要（只取当前项目 + shared 的记忆） */
function buildCompressedSummary(vaultRoot, pid) {
  const allMd = collectMdFiles(vaultRoot);
  if (allMd.length === 0) return null;

  const entries = [];
  for (const fp of allMd) {
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      const { meta, body } = parseFrontmatter(raw);

      // 🔴 两层检查：物理路径 + frontmatter project_id
      if (!isRelevantProject(fp, vaultRoot, pid, meta, body)) continue;

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

  // 找最新 episodic（也要只看当前项目 + shared）
  let episodicNote = null;
  for (const fp of allMd) {
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      const { meta, body } = parseFrontmatter(raw);
      if (!isRelevantProject(fp, vaultRoot, pid, meta, body)) continue;
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

/** 🔗 邻居项目发现 — 向上扫 parent dirs + 向下广度优先
 *
 * 算法：
 *   1. 从 workspace 开始向上扫 3 层 parent
 *   2. 在每层 parent 下，广度优先找 .recall-vault/context.md（最多 2 层子目录）
 *   3. 排除自身，去重，按 distance 排序
 *
 * 这个设计让你把所有项目放在同一个祖先目录下（如 d:\Users\robin\source\），
 * 任何一个项目启动时都能自动发现其他有 .recall-vault/ 的邻居。
 */
function discoverNeighbors(workspacePath, vaultRoot) {
  const neighbors = [];
  const visited = new Set();
  const foundPaths = new Set();

  let parentDepth = 0;
  let dir = path.resolve(workspacePath);
  for (; parentDepth <= 3; parentDepth++) {
    if (visited.has(dir)) break;
    visited.add(dir);

    // 在当前 dir 下广度优先扫 2 层
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
        if (sub === workspacePath) continue; // 排除自身
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
          // 只向下扫一层非 .recall-vault 目录
          if (depth < 2 && !e.name.startsWith('node_modules') && !e.name.startsWith('.git')) {
            queue.push({ cur: sub, depth: depth + 1 });
          }
        }
      }
    }

    // 上一层
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 去重 + 按 distance 排序 + 取前 8 个
  const unique = neighbors
    .sort((a, b) => a.distance - b.distance)
    .filter((n, i, arr) => arr.findIndex((x) => x.abs_path === n.abs_path) === i)
    .slice(0, 8);

  return unique;
}

/** 读 vault 里某个邻居项目的 snapshot 摘要（用于 cross-refs 里的一行描述） */
function peekNeighborSummary(vaultRoot, neighborPid) {
  const snapshotDir = path.join(vaultRoot, 'projects', neighborPid, '_snapshot');
  if (!fs.existsSync(snapshotDir)) return null;

  const projectFp = path.join(snapshotDir, 'project.md');
  if (!fs.existsSync(projectFp)) return null;
  const content = fs.readFileSync(projectFp, 'utf-8');
  if (isTemplateBody(content)) return null;

  // 取第一行非空非模板文本
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.includes('<!--') || t.includes('[ ]') || t.includes('[x]')) continue;
    return t.slice(0, 60);
  }
  return null;
}

/** 生成完整 context.md（比 additionalContext 更丰富，写磁盘）
 *
 * 结构：
 *   # {project} — RecallVault 上下文
 *   > 同步时间 + vault 路径
 *
 *   ## 📋 项目画像          ← snapshot 四个文件的摘要
 *   ## 🔥 关键记忆 (Top 5)   ← semantic + episodic，带 wikilink
 *   ## 🔗 关联项目           ← 邻居项目列表
 *   ## 📖 记忆索引           ← 全部记忆清单
 *   ## ⚠️ 待完成             ← 未决项
 */
function buildFullContextMd(vaultRoot, workspacePath, pid, snapshot, bundle, neighbors) {
  const now = new Date();
  const nowStr = now.toISOString().replace('T', ' ').slice(0, 19);
  const projName = path.basename(workspacePath);
  const vaultProjDir = path.join(vaultRoot, 'projects', pid);

  const lines = [];
  lines.push(`# ${projName} — RecallVault 上下文`);
  lines.push(`> 同步: ${nowStr}  |  Vault: \`${vaultProjDir.replace(/\\/g, '/')}\``);
  lines.push(`> **这是磁盘上的真实文件，任何 IDE 的 agent 都可以直接 ReadFile**`);
  lines.push('');

  // === 1. 项目画像 ===
  lines.push('## 📋 项目画像');
  if (snapshot) {
    lines.push(snapshot.text);
  } else {
    lines.push('_（未填写快照，建议在 vault 的 `_snapshot/` 下创建 project.md / stack.md / architecture.md / conventions.md）_');
  }
  lines.push('');

  // === 2. 关键记忆 Top 5 ===
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

  // === 3. 关联项目 ===
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

  // === 4. 记忆索引 ===
  lines.push('## 📖 记忆索引');
  let idx = 1;
  for (const e of entries.slice(0, 20)) {
    lines.push(`${idx}. **${e.title.slice(0, 50)}** — ${ageLabel(e.updated_at)} — \`${e.id}\``);
    idx++;
  }
  const episodicFiles = allMd
    .filter((fp) => {
      try {
        const raw = fs.readFileSync(fp, 'utf-8');
        const { meta } = parseFrontmatter(raw);
        if (!isRelevantProject(fp, vaultRoot, pid, meta, body)) return false;
        return meta.memory_type === 'episodic' && !meta.valid_to && !meta.archived;
      } catch { return false; }
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (episodicFiles.length > 0) {
    lines.push('');
    lines.push('**上 session 摘要:**');
    try {
      const latest = fs.readFileSync(episodicFiles[0], 'utf-8');
      const { body } = parseFrontmatter(latest);
      lines.push(body.replace(/\s+/g, ' ').trim().slice(0, 200));
    } catch { /* skip */ }
  }
  lines.push('');

  // === 5. 使用指引 ===
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

/** 写项目本地 .recall-vault/context.md + cross-refs.json */
function writeProjectLocal(workspacePath, pid, contextMd, neighbors, vaultRoot) {
  const localDir = path.join(workspacePath, '.recall-vault');
  fs.mkdirSync(localDir, { recursive: true });

  const contextPath = path.join(localDir, 'context.md');
  fs.writeFileSync(contextPath, contextMd, 'utf-8');

  // cross-refs.json
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

  // 生成 .gitignore 建议
  const gitignorePath = path.join(localDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '# RecallVault 自动生成的同步目录\n# 建议提交 context.md（项目画像和跨项目引用）\n# 但不要提交 debug 日志或临时缓存\n_logs/\ncache/\n', 'utf-8');
  }

  return { contextPath, neighborCount: neighbors.length };
}

// === 主流程 ===
try {
  const vaultRoot = resolveVaultRoot();
  const projectId = inferProjectId(cwd, vaultRoot);

  // 1. 快照
  const snapshot = buildSnapshotSummary(vaultRoot, projectId);

  // 2. 记忆 bundle
  const bundle = buildCompressedSummary(vaultRoot, projectId);

  // 3. 邻居项目发现
  const neighbors = discoverNeighbors(cwd, vaultRoot);

  // 4. 生成完整 context.md（写磁盘）
  let localWriteResult = null;
  try {
    const contextMd = buildFullContextMd(vaultRoot, cwd, projectId, snapshot, bundle, neighbors);
    localWriteResult = writeProjectLocal(cwd, projectId, contextMd, neighbors, vaultRoot);
  } catch (localErr) {
    // 本地写入失败不影响 additionalContext（可能是 workspace 权限）
    process.stderr.write(`[RecallVault] ⚠️ 本地 context.md 写入失败: ${localErr.message}\n`);
  }

  // 5. 生成 additionalContext（hook 注入用，保持原逻辑）
  let context;
  const sections = [];

  if (snapshot) {
    sections.push(`📋 项目画像（${snapshot.est_tokens} tokens）：\n   ${snapshot.text}`);
  }

  if (bundle && bundle.memory_count > 0) {
    sections.push(bundle.text);
  }

  // 跨项目提示
  if (localWriteResult && localWriteResult.neighborCount > 0) {
    const neighborNames = neighbors.slice(0, 3).map((n) => n.name).join(', ');
    sections.push(`🔗 发现 ${localWriteResult.neighborCount} 个邻居项目（${neighborNames}${localWriteResult.neighborCount > 3 ? ' ...' : ''}）。读 \`.recall-vault/context.md\` 里的 cross-refs 获取路径。`);
  }

  if (sections.length > 0) {
    context = `[RecallVault SessionStart Hook] 新 session 开始，已准备上下文：\n${sections.join('\n')}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n使用建议：\n1. 📂 **项目本地 \`.recall-vault/context.md\` 已生成** — 任何 IDE 的 agent 都能 ReadFile，跨 IDE/跨沙箱可用\n2. 项目画像（如果有）是确定性快照，直接作为工作基准\n3. 高价值记忆是最近的关键决策\n4. 需要更精确搜索时调 recall({ query: "关键词", include_shared: true, limit: 5 })\n5. 完成工作后主动调 remember 沉淀决策和发现`;
  } else {
    context = `[RecallVault SessionStart Hook] 新 session 开始。

Vault 是空的 — 这是全新 start。记得在工作过程中主动 remember：
- 架构决策 → remember({ memory_type: 'semantic', scope: 'project', priority: 2, tags: ['architecture'] })
- 踩坑经验 → remember({ memory_type: 'semantic', scope: 'project', priority: 3, tags: ['regression'] })
- 跨项目知识 → remember({ memory_type: 'semantic', scope: 'shared' })
- Session 结束 → session_end({ summary: "本次做了什么", highlights: ["至少三条"] })

工作遇到相关问题时，调用 recall({ query: "关键词", include_shared: true, limit: 5 }) 取回上下文。

另外建议建立结构化快照（projects/${projectId}/_snapshot/）：
- project.md     项目画像、目标、非目标
- stack.md       技术栈（表格）
- architecture.md 分层、组件、依赖方向
- conventions.md  命名约定、红线 R1-R10

快照会在每次 session 开始时自动注入，不需要 recall 就能用。

📂 提示：项目本地 \`.recall-vault/context.md\` 已创建 — 即使 MCP 断了也能 ReadFile 拿上下文。`;
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
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `[RecallVault SessionStart Hook] 摘要生成失败（${err.message}）。请手动调用 health_check + recall 取回上下文。`,
      },
    }),
  );
}
