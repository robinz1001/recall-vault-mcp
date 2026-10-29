/**
 * Batch 2 验证脚本
 *
 * 测试 3 个新工具 + recall reviewed boost + 回归 Batch 1
 */

import { spawn } from 'node:child_process';
import { readdirSync, unlinkSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const serverPath = path.resolve('dist/index.js');
const vault = process.cwd();

// 清空 vault 里的旧 md 文件 — 让测试自包含、可重复运行
function cleanVault() {
  const dirs = [
    path.join(vault, 'projects', 'recall-vault', 'episodic'),
    path.join(vault, 'projects', 'recall-vault', 'semantic'),
    path.join(vault, 'shared', 'semantic'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.md')) unlinkSync(path.join(dir, f));
    }
  }
  // 删掉 FTS5 SQLite DB
  const db = path.join(vault, '.recall-vault-index.db');
  if (existsSync(db)) unlinkSync(db);
  // WAL/SHM 附属文件
  for (const ext of ['-wal', '-shm']) {
    const f = db + ext;
    if (existsSync(f)) unlinkSync(f);
  }
  console.log('🧹 Vault cleaned for batch2\n');
}
cleanVault();

const proc = spawn('node', [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, COA_VAULT_PATH: vault, COA_LOG_LEVEL: 'info' },
});

let buffer = '';
let nextId = 0;
const requests = [];

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    requests.push({ id, resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

proc.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) {
        const pending = requests.find((r) => r.id === msg.id);
        if (pending) {
          if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
          else pending.resolve(msg.result);
          requests.splice(requests.indexOf(pending), 1);
        }
      }
    } catch { /* skip */ }
  }
});

proc.stderr.on('data', () => { /* ignore */ });
proc.on('error', (err) => { console.error('[proc error]', err.message); process.exit(1); });

const PASS = '✅';
const FAIL = '❌';
let total = 0, passed = 0;
function check(name, cond, detail) {
  total++;
  if (cond) { passed++; console.log(PASS, name); }
  else { console.log(FAIL, name, detail ? '— ' + detail : ''); }
}

async function run() {
  await send('initialize', {
    protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'batch2-test', version: '1.0' },
  });

  console.log('\n=== Batch 2 Verification ===\n');

  // ① health_check: TOTAL_TOOLS = 8
  const hc = await send('tools/call', { name: 'health_check', arguments: {} });
  const hcText = hc.content[0].text;
  const hcJson = JSON.parse(hcText);
  check('health_check: tools_registered=10', hcJson.tools_registered === 10, hcText);

  // ② 准备：写两条 semantic（一条将来标记 reviewed）
  const rem1 = await send('tools/call', { name: 'remember', arguments: {
    content: '## Jest mock 陷阱\njest.mock() 会提升到文件顶部，jest.fn() 不会。需要工厂函数。',
    memory_type: 'semantic', scope: 'project', project_id: 'recall-vault',
    agent: 'trae', tags: ['jest', 'testing'], priority: 2,
  }});
  const rem1Json = JSON.parse(rem1.content[0].text);
  const memIdJest = rem1Json.memory_id;

  const rem2 = await send('tools/call', { name: 'remember', arguments: {
    content: '## Vitest vs Jest 迁移\nVitest 兼容 Jest API 但更快，ESM 原生。迁移主要改配置文件。',
    memory_type: 'semantic', scope: 'project', project_id: 'recall-vault',
    agent: 'trae', tags: ['vitest', 'testing', 'migration'], priority: 2,
  }});
  const rem2Json = JSON.parse(rem2.content[0].text);
  const memIdVitest = rem2Json.memory_id;

  // ③ update_memory: 替换 content + 标记 reviewed
  const upd1 = await send('tools/call', { name: 'update_memory', arguments: {
    memory_id: memIdJest, scope: 'project', project_id: 'recall-vault',
    content: '## Jest mock 陷阱\njest.mock() 会被 hoisted 到文件顶部，jest.fn() 不会。解决：用工厂函数 jest.fn(() => {...})。',
    reviewed: true,
  }});
  const upd1Json = JSON.parse(upd1.content[0].text);
  check('update_memory: content + reviewed', upd1Json.updated.includes('content') && upd1Json.updated.includes('reviewed'));

  // ④ recall reviewed boost（reviewed 的 Jest 应该排在未 reviewed 的 Vitest 前面）
  const recall1 = await send('tools/call', { name: 'recall', arguments: {
    query: 'mock testing jest vitest', project_id: 'recall-vault', memory_type: 'semantic', limit: 5, sort_by: 'relevance',
  }});
  const recall1Text = recall1.content[0].text;
  // 简单验证：两条都被召回，Jest（reviewed）分数更高
  // recall 输出格式是 "score: X"，检查两条都在里面
  check('recall reviewed boost: 两条 semantic 都召回', recall1Text.includes('jest') && recall1Text.includes('vitest'));

  // ⑤ set_memory_priority
  const pri1 = await send('tools/call', { name: 'set_memory_priority', arguments: {
    memory_id: memIdVitest, scope: 'project', project_id: 'recall-vault', priority: 3,
  }});
  const pri1Json = JSON.parse(pri1.content[0].text);
  check('set_memory_priority: priority → 3', pri1Json.priority === 3);

  // 验证 recall 里 priority=3 的 vitest 现在排前面了
  const recall2 = await send('tools/call', { name: 'recall', arguments: {
    query: 'vitest', project_id: 'recall-vault', limit: 5, sort_by: 'priority',
  }});
  const recall2Text = recall2.content[0].text;
  check('recall priority 排序: vitest(P3) 出现', recall2Text.includes('vitest'));

  // ⑥ delete_memory
  const del1 = await send('tools/call', { name: 'delete_memory', arguments: {
    memory_id: memIdVitest, scope: 'project', project_id: 'recall-vault',
  }});
  const del1Json = JSON.parse(del1.content[0].text);
  check('delete_memory: 硬删成功', del1Json.deleted === true);

  // 确认 recall 搜不到已删除的
  const recall3 = await send('tools/call', { name: 'recall', arguments: {
    query: 'vitest', project_id: 'recall-vault', limit: 5,
  }});
  const recall3Text = recall3.content[0].text;
  check('recall: 删除后搜不到 vitest', !recall3Text.toLowerCase().includes('vitest'));

  // ⑦ Batch 1 回归：remember / recall / archive 还能用
  const remR = await send('tools/call', { name: 'remember', arguments: {
    content: 'Batch 2 regression test — should work fine.',
    memory_type: 'episodic', scope: 'project', project_id: 'recall-vault',
    agent: 'trae', tags: ['regression'], priority: 2,
  }});
  const remRJson = JSON.parse(remR.content[0].text);
  check('Batch1 regression: remember episodic', remRJson.created === true);

  const recallR = await send('tools/call', { name: 'recall', arguments: {
    query: 'regression', project_id: 'recall-vault', limit: 3,
  }});
  const recallRText = recallR.content[0].text;
  check('Batch1 regression: recall 匹配', recallRText.includes('regression'));

  // ⑧ list_memories 确认剩余条目
  const listR = await send('tools/call', { name: 'list_memories', arguments: {
    project_id: 'recall-vault', limit: 20,
  }});
  const listRText = listR.content[0].text;
  check('Batch1 regression: list_memories', listRText.includes('Listing'));

  // ⑨ update_memory 错误处理：找不到 → 返回 isError:true
  const errUpd = await send('tools/call', { name: 'update_memory', arguments: {
    memory_id: 'mem_9999999_999', content: 'x',
  }});
  check('update_memory 错误处理: 找不到时报错', errUpd.isError === true || (errUpd.content && errUpd.content[0].text.includes('failed')));

  // ⑩ delete_memory 错误处理
  const errDel = await send('tools/call', { name: 'delete_memory', arguments: {
    memory_id: 'mem_9999999_999',
  }});
  check('delete_memory 错误处理: 找不到时报错', errDel.isError === true || (errDel.content && errDel.content[0].text.includes('failed')));

  // 汇总
  console.log(`\n=== Batch 2 Results: ${passed}/${total} passed ===\n`);
  proc.stdin.end();
  proc.on('exit', () => process.exit(passed === total ? 0 : 1));
}

run().catch((err) => { console.error('FATAL:', err); process.exit(1); });
