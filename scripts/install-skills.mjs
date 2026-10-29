#!/usr/bin/env node
/**
 * recall-vault-mcp install-skills
 * 把 skills/recall-vault/SKILL.md 复制到各 IDE 的全局 skill 目录
 *
 * 检测当前系统有哪些 IDE 在使用（看 skill 目录是否存在），
 * 存在就复制过去。不存在就跳过。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const homedir = os.homedir();

const skillSource = join(root, 'skills', 'recall-vault', 'SKILL.md');

if (!existsSync(skillSource)) {
  console.error('❌ SKILL.md not found at:', skillSource);
  console.error('Are you running from the right directory?');
  process.exit(1);
}

// 各 IDE 的全局 skill 目录
const ideSkillDirs = [
  { name: 'Trae', path: join(homedir, '.trae', 'skills', 'recall-vault') },
  { name: 'CodeBuddy', path: join(homedir, '.codebuddy', 'skills', 'recall-vault') },
  { name: 'Claude Code', path: join(homedir, '.claude', 'skills', 'recall-vault') },
  { name: 'Codex', path: join(homedir, '.codex', 'skills', 'recall-vault') },
  { name: 'Windsurf', path: join(homedir, '.windsurf', 'skills', 'recall-vault') },
  { name: 'Cursor', path: join(homedir, '.cursor', 'skills', 'recall-vault') },
  { name: 'OpenCode', path: join(homedir, '.opencode', 'skills', 'recall-vault') },
];

let installed = 0;
let skipped = 0;
let errors = 0;

console.log('🔧 Installing recall-vault skill to IDEs...\n');
console.log('Source:', skillSource, '\n');

for (const ide of ideSkillDirs) {
  const configDir = dirname(dirname(ide.path)); // ~/.trae, ~/.codebuddy, etc.
  const skillFile = join(ide.path, 'SKILL.md');

  try {
    // 创建目录
    if (!existsSync(ide.path)) {
      mkdirSync(ide.path, { recursive: true });
    }

    // 复制（如果已存在，覆盖）
    copyFileSync(skillSource, skillFile);

    const alreadyExists = existsSync(join(configDir, 'mcp.json'));
    const marker = alreadyExists ? '✅' : '📝';
    console.log(`${marker} ${ide.name}: ${skillFile}`);

    if (!alreadyExists) {
      console.log(`   ℹ️  ${ide.name} MCP 配置也需要添加 recall-vault：`);
      console.log(`      见 recall-vault-mcp doctor 或 README.md`);
    }

    installed++;
  } catch (e) {
    console.error(`❌ ${ide.name}: ${e.message}`);
    errors++;
  }
}

console.log(`\n✅ Done: ${installed} installed, ${skipped} skipped, ${errors} errors`);
console.log('\n💡 重启 IDE 生效。MCP server 配置：');
console.log('   mcp.json → {"command": "npx", "args": ["-y", "recall-vault-mcp"]}');

if (errors > 0) process.exit(1);
