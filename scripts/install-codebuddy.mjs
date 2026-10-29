#!/usr/bin/env node
/**
 * scripts/install-codebuddy.mjs — 一键安装 recall-vault 到 CodeBuddy
 *
 * 所有配置**用户级**（全局生效，所有项目自动继承）。
 * Hook 脚本部署到 ~/.recall-vault/scripts/，配置里用绝对路径引用。
 *
 * 运行: node scripts/install-codebuddy.mjs
 * 或:   node scripts/install-skills.mjs codebuddy  （等价）
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const homedir = os.homedir();

console.log('🔧 recall-vault → CodeBuddy 用户级全局安装\n');

// ── 路径常量 ──────────────────────────────────────────────────────────────

const VAULT_ROOT = join(homedir, '.recall-vault');
const HOOKS_TARGET = join(VAULT_ROOT, 'scripts');
const HOOKS_SOURCE = join(root, 'scripts');
const skillSource = join(root, 'skills', 'recall-vault', 'SKILL.md');

function hookAbs(filename) {
  return join(HOOKS_TARGET, filename).replace(/\\/g, '/');
}

// ── 工具 ──────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try { return JSON.parse(readFileSync(filePath, 'utf-8')); } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 1: 部署 hook 脚本
// ═══════════════════════════════════════════════════════════════════════════

console.log('[1/4] 部署 hook 脚本 → ' + HOOKS_TARGET);
ensureDir(HOOKS_TARGET);
for (const f of ['hook-session-start.mjs', 'hook-stop.mjs', 'hook-post-tool.mjs']) {
  const src = join(HOOKS_SOURCE, f);
  if (existsSync(src)) {
    copyFileSync(src, join(HOOKS_TARGET, f));
    console.log('  ✅ ' + f);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 2: Skill（用户级）
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n[2/4] 复制 SKILL.md → ~/.codebuddy/skills/recall-vault/');
const skillDest = join(homedir, '.codebuddy', 'skills', 'recall-vault', 'SKILL.md');
ensureDir(dirname(skillDest));
copyFileSync(skillSource, skillDest);
console.log('  ✅ ' + skillDest);

// ═══════════════════════════════════════════════════════════════════════════
// Step 3: MCP 配置（用户级 ~/.codebuddy/.mcp.json）
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n[3/4] 写入 ~/.codebuddy/.mcp.json（用户级 MCP 配置）...');

const mcpFile = join(homedir, '.codebuddy', '.mcp.json');
const existing = readJson(mcpFile) || { mcpServers: {} };
const newServer = { command: 'npx', args: ['-y', 'recall-vault-mcp'] };

existing.mcpServers = existing.mcpServers || {};
existing.mcpServers['recall-vault'] = newServer;

ensureDir(dirname(mcpFile));
writeFileSync(mcpFile, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
console.log('  ✅ recall-vault → npx -y recall-vault-mcp');

// ═══════════════════════════════════════════════════════════════════════════
// Step 4: Hooks 配置（用户级 ~/.codebuddy/settings.json）
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n[4/4] 写入 ~/.codebuddy/settings.json（用户级 Hook 配置）...');

const settingsFile = join(homedir, '.codebuddy', 'settings.json');
let settings = readJson(settingsFile) || {};

settings.hooks = {
  ...(settings.hooks || {}),
  SessionStart: [
    {
      hooks: [
        {
          type: 'command',
          command: `node "${hookAbs('hook-session-start.mjs')}"`,
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
          command: `node "${hookAbs('hook-stop.mjs')}"`,
          timeout: 15,
        },
      ],
    },
  ],
  PostToolUse: [
    {
      matcher: 'RunCommand|Bash|runCommand|run_command|ReadFile|FileRead|WriteFile|write_file|Write|Edit|EditFile|Glob|SearchGlob|Grep',
      hooks: [
        {
          type: 'command',
          command: `node "${hookAbs('hook-post-tool.mjs')}"`,
          timeout: 15,
        },
      ],
    },
  ],
};

ensureDir(dirname(settingsFile));
writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
console.log('  ✅ SessionStart, Stop, PostToolUse hooks');

// ═══════════════════════════════════════════════════════════════════════════
// 完成
// ═══════════════════════════════════════════════════════════════════════════

console.log(`
✅ 安装完成！所有配置都是**用户级全局生效**。

📂 部署的文件:
   ${join(HOOKS_TARGET, 'hook-session-start.mjs')}
   ${join(homedir, '.codebuddy', '.mcp.json')}
   ${join(homedir, '.codebuddy', 'settings.json')}
   ${skillDest}

💡 下一步:
   1. 重启 CodeBuddy（或新开 session）
   2. Settings → MCP → 确认 recall-vault 已启用
   3. 新开对话 → agent 自动调 recall 取回 vault 记忆

🔄 跨 IDE 接力:
   vault 路径: ${VAULT_ROOT}
   所有 IDE 共用这个 vault，CodeBuddy 存的记忆 Trae/Claude 都能读到
`);
