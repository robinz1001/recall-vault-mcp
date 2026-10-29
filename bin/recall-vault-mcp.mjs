#!/usr/bin/env node
/**
 * recall-vault-mcp — MCP server CLI 入口
 *
 * 用法:
 *   recall-vault-mcp              启动 MCP stdio server（默认）
 *   recall-vault-mcp --help       显示帮助
 *   recall-vault-mcp --version    显示版本
 *   recall-vault-mcp doctor       健康检查
 *   recall-vault-mcp list         列出 vault 记忆
 *   recall-vault-mcp recall <q>   搜索 vault
 *   recall-vault-mcp remember     保存记忆
 *   recall-vault-mcp archive      归档记忆
 *   recall-vault-mcp install-skills  安装全局 SKILL.md 到各 IDE
 *
 * 环境变量:
 *   COA_VAULT_PATH     vault 路径（默认 ~/.recall-vault）
 *   COA_PROJECT_ID     项目 ID（默认从 cwd 推断）
 *   COA_LOG_LEVEL      debug | info | warn | error（默认 info）
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const args = process.argv.slice(2);

function printHelp() {
  console.log(`recall-vault-mcp v${pkg.version}

跨会话跨项目本地记忆管理系统 — MCP stdio server

用法:
  recall-vault-mcp                  启动 MCP stdio server（默认）
  recall-vault-mcp --help           显示帮助
  recall-vault-mcp --version        显示版本
  recall-vault-mcp doctor           健康检查
  recall-vault-mcp list             列出 vault 记忆
  recall-vault-mcp recall <query>   搜索 vault
  recall-vault-mcp remember         保存记忆（交互式或 --content）
  recall-vault-mcp archive <id>     归档记忆
  recall-vault-mcp install-skills   安装 SKILL.md 到各 IDE 全局目录

安装到 IDE:
  npx -y recall-vault-mcp install-skills

  然后在 mcp.json 里加:
  {
    "mcpServers": {
      "recall-vault": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "recall-vault-mcp"]
      }
    }
  }

环境变量:
  COA_VAULT_PATH              vault 根目录（默认 ~/.recall-vault）
  COA_PROJECT_ID              项目 ID（默认从 cwd 推断）
  COA_LOG_LEVEL               日志级别（默认 info）

更多: https://github.com/<your-user>/recall-vault-mcp
`);
}

// 子命令模式（非 MCP server 模式）
const mcpCliSubcommands = ['doctor', 'list', 'recall', 'remember', 'archive'];
const specialSubcommands = ['install-skills'];
const sub = args[0];

if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  console.log(pkg.version);
  process.exit(0);
}

if (sub === 'install-skills') {
  // 独立子命令 → spawn 脚本（跨 IDE 更可靠）
  const scriptPath = join(__dirname, '..', 'scripts', 'install-skills.mjs');
  const child = spawn('node', [scriptPath], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
} else if (sub && mcpCliSubcommands.includes(sub)) {
  // CLI 子命令 → 转发到 scripts/cli.mjs
  const cliPath = join(__dirname, '..', 'scripts', 'cli.mjs');
  spawn('node', [cliPath, ...args], { stdio: 'inherit' });
  setTimeout(() => process.exit(0), 100);
} else {
  // 默认：启动 MCP stdio server
  const indexPath = join(__dirname, '..', 'dist', 'index.js');
  import(indexPath).catch((e) => {
    console.error('Failed to start recall-vault-mcp:', e.message);
    console.error('Did you run `npm run build` first?');
    console.error('Or install globally: npm install -g recall-vault-mcp');
    process.exit(1);
  });
}
