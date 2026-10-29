#!/usr/bin/env node
/**
 * RecallVault CLI — 子命令入口
 *
 *   node scripts/cli.mjs init           初始化 vault 目录结构
 *   node scripts/cli.mjs doctor         诊断 MCP 配置和服务状态
 *   node scripts/cli.mjs remember <args> 保存记忆（args: --content, --type, --scope, --tags, --priority）
 *   node scripts/cli.mjs recall <query>  搜索记忆
 *   node scripts/cli.mjs list            列出记忆
 *   node scripts/cli.mjs archive <id>    归档/取消归档
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const DIST_INDEX = path.join(PROJECT_ROOT, 'dist', 'index.js');
const MCP_JSON = path.join(PROJECT_ROOT, '.trae', 'mcp.json');

// ── 通过 stdio 向 MCP server 发送 JSON-RPC 请求 ────────────────────────────

function callMcp(method, params = {}, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [DIST_INDEX], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, COA_VAULT_PATH: PROJECT_ROOT, ...envOverrides },
      cwd: PROJECT_ROOT,
    });

    let buffer = '';
    let id = 0;

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            // 第一次 response 是 initialize
            proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }) + '\n');
          } else if (msg.id === 2) {
            proc.stdin.end();
            if (msg.error) reject(new Error(JSON.stringify(msg.error)));
            else resolve(msg.result);
          }
        } catch { /* skip */ }
      }
    });

    proc.stderr.on('data', () => {});
    proc.on('error', reject);

    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'rv-cli', version: '1' } },
    }) + '\n');

    // 3 秒超时
    setTimeout(() => { try { proc.kill(); } catch {}; reject(new Error('timeout')); }, 5000);
  });
}

// ── 子命令实现 ──────────────────────────────────────────────────────────────

async function cmdInit(_args) {
  const hc = await callMcp('tools/call', { name: 'health_check', arguments: {} });
  const info = JSON.parse(hc.content[0].text);
  console.log('✅ RecallVault 已初始化');
  console.log(`   vault_path : ${info.vault_path}`);
  console.log(`   vault_root : ${info.vault_root}`);
  console.log(`   dirs_ok    : ${info.dirs_ok}`);
  console.log(`   tools      : ${info.tools.join(', ')}`);
}

async function cmdDoctor(_args) {
  let ok = true;
  console.log('🔍 RecallVault 诊断\n');

  // 1. 编译产物
  const hasDist = fs.existsSync(DIST_INDEX);
  console.log(`1. dist/index.js 存在 : ${hasDist ? '✅' : '❌ 请先 npm run build'}`);
  if (!hasDist) ok = false;

  // 2. MCP 配置文件
  const hasMcpJson = fs.existsSync(MCP_JSON);
  console.log(`2. .trae/mcp.json 存在 : ${hasMcpJson ? '✅' : '❌ 缺失'}`);
  if (hasMcpJson) {
    try {
      const cfg = JSON.parse(fs.readFileSync(MCP_JSON, 'utf-8'));
      const server = cfg.mcpServers?.['recall-vault'];
      const hasCmd = server?.command === 'node';
      const hasArgs = Array.isArray(server?.args) && server.args.some((a) => a.includes('index.js'));
      console.log(`   command=node       : ${hasCmd ? '✅' : '❌'}`);
      console.log(`   args 含 index.js   : ${hasArgs ? '✅' : '❌'}`);
    } catch { ok = false; }
  } else { ok = false; }

  // 3. MCP 服务实际能启动吗？
  if (hasDist) {
    try {
      const hc = await callMcp('tools/call', { name: 'health_check', arguments: {} });
      const info = JSON.parse(hc.content[0].text);
      console.log(`3. MCP server 启动    : ✅`);
      console.log(`   vault_path         : ${info.vault_path}`);
      console.log(`   vault_root         : ${info.vault_root}`);
      console.log(`   路径冲突检查       : ${info.vault_path === info.vault_root ? '✅ vault_path == vault_root' : '⚠️  有嵌套层级'}`);
      console.log(`   目录健康           : ${info.dirs_ok ? '✅' : '❌'}`);
      console.log(`   工具数量           : ${info.tools_registered} (应为 9)`);
      console.log(`   版本               : ${info.version}`);
    } catch (e) {
      console.log(`3. MCP server 启动    : ❌ ${e.message}`);
      ok = false;
    }
  } else {
    console.log(`3. MCP server 启动    : ⏭  跳过（dist 未编译）`);
  }

  // 4. 项目级 MCP 开关（无法文件检测，提示用户）
  console.log(`4. Trae 项目级 MCP开关: 🔍 需手动确认 → Settings → MCP → 打开「项目级 MCP」`);

  console.log(`\n${ok ? '✅ 核心组件正常' : '⚠️  有问题需修复'}`);
  process.exit(ok ? 0 : 1);
}

async function cmdRemember(args) {
  const params = { memory_type: args.type || 'semantic', scope: args.scope || 'project' };
  if (args.content) params.content = args.content;
  else { console.error('❌ 需要 --content'); process.exit(1); }
  if (args.project_id) params.project_id = args.project_id;
  else params.project_id = path.basename(PROJECT_ROOT);
  if (args.tags) params.tags = args.tags.split(',').map((t) => t.trim());
  if (args.priority) params.priority = parseInt(args.priority, 10);

  const result = await callMcp('tools/call', { name: 'remember', arguments: params });
  const info = JSON.parse(result.content[0].text);
  console.log(`✅ 记忆已保存`);
  console.log(`   memory_id : ${info.memory_id}`);
  console.log(`   path      : ${info.path}`);
  console.log(`   created   : ${info.created}`);
}

async function cmdRecall(args) {
  const query = args._.slice(1).join(' ');
  const params = { query, limit: 10, include_shared: true };
  const result = await callMcp('tools/call', { name: 'recall', arguments: params });
  const info = JSON.parse(result.content[0].text);
  console.log(`🔎 搜索 "${query}" → 共 ${info.total} 条\n`);
  for (const r of info.results) {
    console.log(`  ${r.rank}. [${r.score.toFixed(2)}] ${r.title}`);
    console.log(`     id=${r.memory_id}  priority=${r.priority}  ${r.memory_type}/${r.scope}`);
    console.log(`     snippet: ${r.snippet?.slice(0, 80)}...`);
    console.log();
  }
}

async function cmdList(args) {
  const params = {};
  if (args.project_id) params.project_id = args.project_id;
  if (args.memory_type) params.memory_type = args.memory_type;
  if (args.limit) params.limit = parseInt(args.limit, 10);

  const result = await callMcp('tools/call', { name: 'list_memories', arguments: params });
  const info = JSON.parse(result.content[0].text);
  console.log(`📋 ${info.summary}\n`);
  for (const i of info.items) {
    const tagStr = i.tags?.length ? ` [${i.tags.join(',')}]` : '';
    const archStr = i.archived ? ' [ARCHIVED]' : '';
    console.log(`  ${i.memory_id}  ${i.memory_type.padEnd(9)} ${i.scope.padEnd(7)} P${i.priority}${archStr}${tagStr}  ${i.updated_at}`);
  }
}

async function cmdArchive(args) {
  const id = args._[1];
  if (!id) { console.error('❌ 需要 memory_id 参数'); process.exit(1); }
  const result = await callMcp('tools/call', { name: 'archive_memory', arguments: { memory_id: id } });
  const info = JSON.parse(result.content[0].text);
  console.log(`📦 memory_id=${info.memory_id}  archived=${info.archived}`);
}

// ── CLI 入口 ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1]?.startsWith('--') ? undefined : argv[++i];
      args[key] = val ?? true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const sub = args._[0];

const HELP = `
RecallVault CLI

用法:
  node scripts/cli.mjs init                        初始化 vault 目录结构
  node scripts/cli.mjs doctor                      诊断 MCP 配置和服务状态
  node scripts/cli.mjs remember --content "..."    保存记忆
    [--type episodic|semantic] [--scope project|shared]
    [--project_id xxx] [--tags a,b,c] [--priority 1|2|3]
  node scripts/cli.mjs recall <query>              搜索记忆
  node scripts/cli.mjs list                        列出记忆 [--project_id xxx] [--type semantic] [--limit 20]
  node scripts/cli.mjs archive <memory_id>        归档记忆
`;

if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }

const handlers = { init: cmdInit, doctor: cmdDoctor, remember: cmdRemember, recall: cmdRecall, list: cmdList, archive: cmdArchive };
const handler = handlers[sub];
if (!handler) { console.error(`❌ 未知子命令: ${sub}`); console.log(HELP); process.exit(1); }

try {
  await handler(args);
} catch (e) {
  console.error('❌', e.message);
  process.exit(1);
}
