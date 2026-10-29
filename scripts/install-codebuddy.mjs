#!/usr/bin/env node
// scripts/install-codebuddy.mjs — 一键安装 recall-vault 到 CodeBuddy
// 运行: node scripts/install-codebuddy.mjs

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

console.log('🔧 recall-vault CodeBuddy 安装程序\n');

// Step 1: 确保 build 产物存在
console.log('[1/4] 检查/编译 MCP server...');
try {
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
} catch (e) {
  console.error('❌ npm run build 失败');
  process.exit(1);
}
console.log('✅ dist/index.js 就绪\n');

// Step 2: 写入项目级 .mcp.json（CodeBuddy + Trae 通用）
console.log('[2/4] 写入 .mcp.json（项目级 MCP 配置）...');
const mcpConfig = {
  mcpServers: {
    'recall-vault': {
      type: 'stdio',
      command: 'node',
      args: ['dist/index.js'],
      cwd: '${workspaceFolder}',
      env: {
        COA_VAULT_PATH: '${workspaceFolder}',
        COA_LOG_LEVEL: 'info',
        START_MCP_TIMEOUT_MS: '30000',
        RUN_MCP_TIMEOUT_MS: '60000',
      },
    },
  },
};

const mcpPath = join(root, '.mcp.json');
writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf-8');
console.log(`✅ 已写入 ${mcpPath}\n`);

// Step 3: 写入 .codebuddy/settings.json（Hook 配置）
console.log('[3/4] 写入 .codebuddy/settings.json（Hook 配置）...');
const codebuddyDir = join(root, '.codebuddy');
if (!existsSync(codebuddyDir)) mkdirSync(codebuddyDir, { recursive: true });

const settingsConfig = {
  hooks: {
    SessionStart: [
      {
        matcher: 'startup',
        hooks: [
          {
            type: 'command',
            command: 'node "$CODEBUDDY_PROJECT_DIR/scripts/hook-session-start.mjs"',
            timeout: 30,
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command: 'node "$CODEBUDDY_PROJECT_DIR/scripts/hook-stop.mjs"',
            timeout: 15,
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: 'RunCommand|Bash',
        hooks: [
          {
            type: 'command',
            command: 'node "$CODEBUDDY_PROJECT_DIR/scripts/hook-post-tool.mjs"',
            timeout: 15,
          },
        ],
      },
    ],
  },
};

const settingsPath = join(codebuddyDir, 'settings.json');
writeFileSync(settingsPath, JSON.stringify(settingsConfig, null, 2) + '\n', 'utf-8');
console.log(`✅ 已写入 ${settingsPath}\n`);

// Step 4: 总结
console.log('[4/4] 安装完成 ✅\n');
console.log('📂 生成的文件:');
console.log(`   ${mcpPath}`);
console.log(`   ${settingsPath}`);
console.log(`   ${join(root, '.codebuddy/skills/recall-vault/SKILL.md')}`);
console.log('');
console.log('🚀 下一步:');
console.log('   1. 在 CodeBuddy Settings → MCP 里启用 recall-vault');
console.log('   2. 新建对话 → agent 应自动调 recall');
console.log('   3. 如有问题，手动在 CodeBuddy 终端运行:');
console.log('      export CODEBUDDY_PROJECT_DIR="$(pwd)"');
console.log('      node scripts/hook-session-start.mjs');
console.log('');
console.log('💡 注意: Windows 上 CodeBuddy Hook 用 Git Bash 执行，');
console.log('   请确保已安装 Git for Windows 并包含 bash.exe');
