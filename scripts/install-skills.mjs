#!/usr/bin/env node
/**
 * recall-vault-mcp install-skills
 *
 * 一键把 RecallVault 配置到所有支持的 IDE。
 * 所有配置统一**用户级**（全局生效，所有项目自动继承）。
 * Hook 脚本部署到 ~/.recall-vault/scripts/，配置里用绝对路径引用。
 *
 * 支持的 IDE：
 *   ✅ Trae CN      — skill + ~/.trae-cn/hooks.json + %APPDATA%\Trae CN\User\mcp.json
 *   ✅ Trae (intl)  — skill + ~/.trae/hooks.json + %APPDATA%\Trae\User\mcp.json
 *   ✅ CodeBuddy    — skill + ~/.codebuddy/settings.json hooks + ~/.codebuddy/.mcp.json
 *   ✅ Claude Code  — skill + ~/.claude/settings.json (hooks + MCP，已经是用户级)
 *   ✅ Codex        — skill + ~/.codex/config.toml MCP
 *   ✅ Windsurf     — skill + ~/.windsurf/hooks.json + ~/.codeium/windsurf/mcp_config.json
 *   ✅ Cursor       — skill + ~/.cursor/hooks.json + ~/.cursor/mcp.json
 *   ✅ OpenCode     — skill + ~/.config/opencode/opencode.json MCP + ~/.config/opencode/AGENTS.md 规则
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const homedir = os.homedir();
const appdata = process.env.APPDATA || join(homedir, 'AppData', 'Roaming');

// ── 路径常量 ──────────────────────────────────────────────────────────────

/** RecallVault 全局 vault 根目录（MCP 默认 vault 路径） */
const VAULT_ROOT = join(homedir, '.recall-vault');
/** Hook 脚本部署目标目录（和 vault 同根，配套基础设施） */
const HOOKS_TARGET = join(VAULT_ROOT, 'scripts');
/** Hook 脚本源目录（本仓库 scripts/ 下的 hook-*.mjs） */
const HOOKS_SOURCE = join(root, 'scripts');

// ── 通用工具 ──────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, obj) {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

function deployHookScripts() {
  ensureDir(HOOKS_TARGET);
  const scripts = ['hook-session-start.mjs', 'hook-stop.mjs', 'hook-post-tool.mjs'];
  for (const f of scripts) {
    const src = join(HOOKS_SOURCE, f);
    const dst = join(HOOKS_TARGET, f);
    if (existsSync(src)) {
      copyFileSync(src, dst);
    }
  }
  return HOOKS_TARGET;
}

/** 跨平台 hook 脚本绝对路径（Windows cmd 用反斜杠，sh/bash 用正斜杠，都能接受） */
function hookAbsPath(filename) {
  return join(HOOKS_TARGET, filename).replace(/\\/g, '/');
}

// ── 统一 MCP 配置（所有 IDE 通用，用户级）────────────────────────────────

const MCP_CONFIG = {
  command: 'npx',
  args: ['-y', 'recall-vault-mcp'],
};

// Trae / Windsurf / OpenCode 等用 "mcpServers" 包裹
function wrapMcp(obj) {
  return { mcpServers: { 'recall-vault': obj } };
}

// ── 统一 hooks 配置生成（Trae / CodeBuddy / Cursor 格式通用）────────────

const HOOKS_CONFIG = {
  SessionStart: [
    {
      hooks: [
        {
          type: 'command',
          command: `node ${hookAbsPath('hook-session-start.mjs')}`,
          timeout: 30,
        },
      ],
    },
  ],
  Stop: [
    {
      loop_limit: 3,
      hooks: [
        {
          type: 'command',
          command: `node ${hookAbsPath('hook-stop.mjs')}`,
          timeout: 15,
        },
      ],
    },
  ],
  PostToolUse: [
    {
      matcher: 'RunCommand|runCommand|run_command|Bash|WriteFile|write_file|Write|Edit|EditFile|Glob|SearchGlob|Grep|ReadFile|FileRead|Read',
      hooks: [
        {
          type: 'command',
          command: `node ${hookAbsPath('hook-post-tool.mjs')}`,
          timeout: 15,
        },
      ],
    },
  ],
};

function mergeHooks(existingHooks) {
  const merged = existingHooks ? { ...existingHooks } : {};
  for (const [event, handlers] of Object.entries(HOOKS_CONFIG)) {
    merged[event] = handlers;
  }
  return merged;
}

// ── Skill 源 ──────────────────────────────────────────────────────────────

const skillSource = join(root, 'skills', 'recall-vault', 'SKILL.md');

// ── OpenCode sentinel ────────────────────────────────────────────────────

const OC_SENTINEL_START = '<!-- recall-vault:start -->';
const OC_SENTINEL_END = '<!-- recall-vault:end -->';

const OC_RULES = `${OC_SENTINEL_START}
# RecallVault Memory Rules

You have access to RecallVault memory via MCP tools: health_check, remember, recall, list_memories, archive_memory, update_memory, delete_memory, set_memory_priority, memory_setup, memory_import.

## SAVE (PROACTIVE — do not wait for me to ask)
Call remember immediately after:
- Architecture decisions (memory_type: semantic, scope: project or shared)
- Bugs fixed (priority: 3, tags: ['regression'])
- Project conventions (scope: project)
- Cross-project patterns (scope: shared)
- Session summary (memory_type: episodic, before conversation ends)

## RECALL (PROACTIVE)
Call recall with include_shared=true:
- At session start — refresh prior context
- Before starting related tasks — "have we done this before?"
- When debugging — "what caused this last time?"
- When I reference prior work — "before", "previously", "we discussed"

## ⚡ Token-saving
Use compact mode by default: recall({ query: "setup", compact: true }) — saves ~58% tokens.

## Params
- project_id: workspace folder basename
- agent: 'opencode'
- scope: 'project' (project-only) or 'shared' (cross-project reusable)
${OC_SENTINEL_END}`;

// ── Cursor rules source ───────────────────────────────────────────────────

const cursorRuleSource = join(__dirname, 'ide-configs', 'cursor-rules-recall-vault.mdc');

// ═══════════════════════════════════════════════════════════════════════════
// IDE 安装函数
// ═══════════════════════════════════════════════════════════════════════════

function copySkill(destDir) {
  ensureDir(destDir);
  copyFileSync(skillSource, join(destDir, 'SKILL.md'));
}

function mergeMcpServers(existing, newServer) {
  const base = existing?.mcpServers ? { ...existing.mcpServers } : {};
  base['recall-vault'] = newServer;
  return { ...(existing || {}), mcpServers: base };
}

// ── Trae CN ────────────────────────────────────────────────────────────────

function installTraeCN() {
  copySkill(join(homedir, '.trae-cn', 'skills', 'recall-vault'));

  // 全局 MCP：%APPDATA%\Trae CN\User\mcp.json
  const mcpFile = join(appdata, 'Trae CN', 'User', 'mcp.json');
  const existing = readJson(mcpFile);
  writeJson(mcpFile, mergeMcpServers(existing, MCP_CONFIG));

  // 全局 Hooks：~/.trae-cn/hooks.json
  const hooksFile = join(homedir, '.trae-cn', 'hooks.json');
  const hc = readJson(hooksFile) || { version: 1 };
  hc.version = 1;
  hc.hooks = mergeHooks(hc.hooks);
  writeJson(hooksFile, hc);

  console.log('✅ Trae CN: skill + global MCP + global hooks');
}

// ── Trae (国际版) ─────────────────────────────────────────────────────────

function installTrae() {
  copySkill(join(homedir, '.trae', 'skills', 'recall-vault'));

  // 全局 MCP：%APPDATA%\Trae\User\mcp.json
  const mcpFile = join(appdata, 'Trae', 'User', 'mcp.json');
  const existing = readJson(mcpFile);
  writeJson(mcpFile, mergeMcpServers(existing, MCP_CONFIG));

  // 全局 Hooks：~/.trae/hooks.json（参考 CN 版路径约定）
  const hooksFile = join(homedir, '.trae', 'hooks.json');
  const hc = readJson(hooksFile) || { version: 1 };
  hc.version = 1;
  hc.hooks = mergeHooks(hc.hooks);
  writeJson(hooksFile, hc);

  console.log('✅ Trae (intl): skill + global MCP + global hooks');
}

// ── CodeBuddy ──────────────────────────────────────────────────────────────

function installCodeBuddy() {
  copySkill(join(homedir, '.codebuddy', 'skills', 'recall-vault'));

  // 全局 MCP：~/.codebuddy/.mcp.json
  const mcpFile = join(homedir, '.codebuddy', '.mcp.json');
  const existing = readJson(mcpFile);
  writeJson(mcpFile, mergeMcpServers(existing, MCP_CONFIG));

  // 全局 Hooks：~/.codebuddy/settings.json（内嵌 hooks 字段）
  const settingsFile = join(homedir, '.codebuddy', 'settings.json');
  let settings = readJson(settingsFile) || {};
  settings.hooks = mergeHooks(settings.hooks);
  writeJson(settingsFile, settings);

  console.log('✅ CodeBuddy: skill + ~/.codebuddy/.mcp.json + ~/.codebuddy/settings.json');
}

// ── Claude Code ────────────────────────────────────────────────────────────

function installClaudeCode() {
  copySkill(join(homedir, '.claude', 'skills', 'recall-vault'));

  // 用户级 settings.json（已经是用户级，无需改范围）
  const settingsFile = join(homedir, '.claude', 'settings.json');
  let settings = readJson(settingsFile) || {};

  // MCP
  settings.mcpServers = settings.mcpServers || {};
  settings.mcpServers['recall-vault'] = MCP_CONFIG;

  // Hooks — Claude Code 的 hook 格式和 Trae/CodeBuddy 一致
  settings.hooks = mergeHooks(settings.hooks);

  writeJson(settingsFile, settings);

  console.log('✅ Claude Code: skill + ~/.claude/settings.json');
}

// ── Codex ──────────────────────────────────────────────────────────────────

function installCodex() {
  copySkill(join(homedir, '.codex', 'skills', 'recall-vault'));

  // ~/.codex/config.toml — 追加 MCP（Codex 用 toml 格式，我们只给命令行提示）
  const tomlPath = join(homedir, '.codex', 'config.toml');
  let content = '';
  if (existsSync(tomlPath)) {
    content = readFileSync(tomlPath, 'utf-8');
  }
  // 简单去重：已存在 recall-vault 就不重复追加
  if (!content.includes('recall-vault')) {
    const block = `\n[recall-vault]\ncommand = "npx"\nargs = ["-y", "recall-vault-mcp"]\n`;
    content += block;
    ensureDir(dirname(tomlPath));
    writeFileSync(tomlPath, content, 'utf-8');
  }

  console.log('✅ Codex: skill + ~/.codex/config.toml');
}

// ── Windsurf ───────────────────────────────────────────────────────────────

function installWindsurf() {
  copySkill(join(homedir, '.windsurf', 'skills', 'recall-vault'));

  // 全局 MCP：~/.codeium/windsurf/mcp_config.json
  const mcpFile = join(homedir, '.codeium', 'windsurf', 'mcp_config.json');
  const existing = readJson(mcpFile);
  writeJson(mcpFile, mergeMcpServers(existing, MCP_CONFIG));

  // Windsurf 的 Hook 只有 pre_user_prompt / post_user_prompt（没有 SessionStart）
  // 全局 hooks.json：~/.windsurf/hooks.json
  // 每轮 prompt 前注入 vault 摘要（替代缺失的 SessionStart）
  const wsHooksFile = join(homedir, '.windsurf', 'hooks.json');
  const wsc = readJson(wsHooksFile) || { hooks: {} };
  wsc.hooks = wsc.hooks || {};
  wsc.hooks.pre_user_prompt = [
    {
      command: ['node', hookAbsPath('hook-session-start.mjs')],
      timeout: 30,
    },
  ];
  writeJson(wsHooksFile, wsc);

  console.log('✅ Windsurf: skill + ~/.codeium/windsurf/mcp_config.json + ~/.windsurf/hooks.json');
}

// ── Cursor ─────────────────────────────────────────────────────────────────

function installCursor() {
  copySkill(join(homedir, '.cursor', 'skills', 'recall-vault'));

  // 全局 MCP：~/.cursor/mcp.json
  const mcpFile = join(homedir, '.cursor', 'mcp.json');
  const existing = readJson(mcpFile);
  writeJson(mcpFile, mergeMcpServers(existing, MCP_CONFIG));

  // 全局 Hooks：~/.cursor/hooks.json
  const hooksFile = join(homedir, '.cursor', 'hooks.json');
  const hc = readJson(hooksFile) || { version: 1, hooks: {} };
  hc.version = 1;
  hc.hooks = mergeHooks(hc.hooks);
  writeJson(hooksFile, hc);

  // 规则文件：~/.cursor/rules/recall-vault-recall.mdc（alwaysApply: true）
  if (existsSync(cursorRuleSource)) {
    const rulesFile = join(homedir, '.cursor', 'rules', 'recall-vault-recall.mdc');
    ensureDir(dirname(rulesFile));
    copyFileSync(cursorRuleSource, rulesFile);
    console.log('✅ Cursor: skill + MCP + hooks + rules');
  } else {
    console.log('⚠️  Cursor: skill + MCP + hooks（.mdc rule source 缺失）');
  }
}

// ── OpenCode ───────────────────────────────────────────────────────────────

function installOpenCode() {
  copySkill(join(homedir, '.opencode', 'skills', 'recall-vault'));

  // 全局 MCP：~/.config/opencode/opencode.json
  const mcpFile = join(homedir, '.config', 'opencode', 'opencode.json');
  let oc = readJson(mcpFile) || { '$schema': 'https://opencode.ai/config.json' };
  oc.mcp = oc.mcp || {};
  oc.mcp['recall-vault'] = {
    type: 'local',
    command: 'npx',
    args: ['-y', 'recall-vault-mcp'],
  };
  writeJson(mcpFile, oc);

  // 全局 AGENTS.md — sentinel 包装确保幂等
  const agentsFile = join(homedir, '.config', 'opencode', 'AGENTS.md');
  let content = '';
  if (existsSync(agentsFile)) {
    content = readFileSync(agentsFile, 'utf-8');
    const before = content.split(OC_SENTINEL_START)[0];
    const afterSplit = content.split(OC_SENTINEL_END);
    const after = afterSplit.length > 1 ? afterSplit[afterSplit.length - 1] : '';
    content = (before + '\n' + after).trim() + '\n';
  }
  content += '\n' + OC_RULES + '\n';
  writeFileSync(agentsFile, content, 'utf-8');

  console.log('✅ OpenCode: skill + MCP + AGENTS.md rules');
}

// ═══════════════════════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════════════════════

const IDES = {
  trae: installTrae,
  'trae-cn': installTraeCN,
  codebuddy: installCodeBuddy,
  'claude-code': installClaudeCode,
  codex: installCodex,
  windsurf: installWindsurf,
  cursor: installCursor,
  opencode: installOpenCode,
};

const args = process.argv.slice(2);
const targetIdes = args.length > 0 ? args : Object.keys(IDES);

console.log('\n🔧 RecallVault install-skills → 用户级全局配置\n');

// Phase 0: 部署 hook 脚本到 vault 下
console.log('[0/2] 部署 hook 脚本 → ' + HOOKS_TARGET);
deployHookScripts();
console.log('✅ hook-session-start.mjs, hook-stop.mjs, hook-post-tool.mjs\n');

// Phase 1: 安装各 IDE
console.log('[1/2] 写入各 IDE 用户级 MCP + hooks + skills\n');

let ok = 0, fail = 0;
for (const id of targetIdes) {
  const fn = IDES[id];
  if (!fn) {
    console.log(`⚠️  未知 IDE: ${id} — 有效值: ${Object.keys(IDES).join(', ')}`);
    continue;
  }
  try {
    fn();
    ok++;
  } catch (e) {
    console.error(`❌ ${id}: ${e.message}`);
    fail++;
  }
}

console.log(`\n[2/2] 完成: ${ok} 成功, ${fail} 失败`);

// Phase 2: 总结
console.log(`
📂 Hook 脚本部署位置: ${HOOKS_TARGET}
📂 Vault 根目录:       ${VAULT_ROOT}
🚀 MCP 启动命令:       npx -y recall-vault-mcp

💡 首次安装后需要：
   1. 重启各 IDE / 新开 session（IDE 需要重启才能读到新配置）
   2. 部分 IDE 需要在 Settings → MCP 里手动启用 recall-vault
   3. 所有 IDE 共享同一个 ~/.recall-vault vault，跨 IDE 无缝接力

如果 MCP 连接失败，可手动测试：
   npx -y recall-vault-mcp

如果 hook 不触发，检查脚本是否存在：
   ls ${HOOKS_TARGET}
`);

if (fail > 0) process.exit(1);
