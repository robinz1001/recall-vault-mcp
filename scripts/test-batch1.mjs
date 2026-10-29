/**
 * Batch 1 全链路验证脚本
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

const serverPath = path.resolve('dist/index.js');
const vault = process.cwd();

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
    clientInfo: { name: 'batch1-test', version: '1.0' },
  });

  // Note: notifications/initialized 是 MCP v2 协议里的通知（无 response），这里跳过

  console.log('\n=== Batch 1 Verification ===\n');

  // 1. health_check
  const hc = await send('tools/call', { name: 'health_check', arguments: {} });
  const hcText = hc.content[0].text;
  const hcJson = JSON.parse(hcText);
  check('health_check: tools_registered=10', hcJson.tools_registered === 10);

  // 2. remember episodic
  const rem1 = await send('tools/call', { name: 'remember', arguments: {
    content: '今天改了 user-api 的分页逻辑，用 cursor-based 替代 page-number。',
    memory_type: 'episodic', scope: 'project', project_id: 'recall-vault',
    session_id: 'sess-001', agent: 'trae', tags: ['api', 'pagination'], priority: 3,
  }});
  const rem1Json = JSON.parse(rem1.content[0].text);
  const memId1 = rem1Json.memory_id;
  check('remember episodic: 创建成功', rem1Json.created === true && rem1Json.memory_id?.startsWith('mem_'));
  check('remember episodic: 路径正确', rem1Json.path.includes('episodic'));

  // 3. remember semantic
  const rem2 = await send('tools/call', { name: 'remember', arguments: {
    content: '## Vite 5 legacy 插件兼容\nVite 5 默认是 ESM，某些旧插件需要 @vitejs/plugin-legacy。',
    memory_type: 'semantic', scope: 'project', project_id: 'recall-vault',
    agent: 'trae', tags: ['vite', 'build'], priority: 2,
  }});
  const rem2Json = JSON.parse(rem2.content[0].text);
  const memId2 = rem2Json.memory_id;
  check('remember semantic: 创建成功', rem2Json.created === true);

  // 4. remember shared semantic
  const rem3 = await send('tools/call', { name: 'remember', arguments: {
    content: '## pnpm workspace hoisting\npnpm 默认不 hoist 依赖，某些工具期望扁平化。',
    memory_type: 'semantic', scope: 'shared', project_id: 'shared',
    agent: 'trae', tags: ['pnpm'], priority: 2,
  }});
  const rem3Json = JSON.parse(rem3.content[0].text);
  check('remember shared: 创建成功', rem3Json.created === true && rem3Json.path.includes('shared'));

  // 5. recall 关键词
  const recall1 = await send('tools/call', { name: 'recall', arguments: {
    query: 'vite legacy', project_id: 'recall-vault', limit: 5,
  }});
  const t1 = recall1.content[0].text;
  check('recall 关键词 vite: 匹配成功', t1.includes('vite'), t1.slice(0, 150));

  // 6. recall memory_type 过滤器
  const recall2 = await send('tools/call', { name: 'recall', arguments: {
    query: 'api', project_id: 'recall-vault', memory_type: 'episodic', limit: 5,
  }});
  const t2 = recall2.content[0].text;
  check('recall memory_type=episodic: 过滤正确', t2.includes('cursor'));

  // 7. recall include_shared
  const recall3 = await send('tools/call', { name: 'recall', arguments: {
    query: 'pnpm', project_id: 'recall-vault', include_shared: true, limit: 5,
  }});
  const t3 = recall3.content[0].text;
  check('recall include_shared: 搜到 shared', t3.includes('pnpm'), t3.slice(0, 150));

  // 8. recall session_id
  const recall4 = await send('tools/call', { name: 'recall', arguments: {
    query: '分页', project_id: 'recall-vault', session_id: 'sess-001', limit: 5,
  }});
  const t4 = recall4.content[0].text;
  check('recall session_id 过滤器: 正确', t4.includes('cursor'), t4.slice(0, 150));

  // 9. list_memories
  const list1 = await send('tools/call', { name: 'list_memories', arguments: {
    project_id: 'recall-vault', limit: 10,
  }});
  const t5 = list1.content[0].text;
  check('list_memories: 列出条目', t5.includes('Listing'));

  // 10. archive
  const arc1 = await send('tools/call', { name: 'archive_memory', arguments: { memory_id: memId1, scope: 'project', project_id: 'recall-vault' }});
  const arc1Json = JSON.parse(arc1.content[0].text);
  check('archive_memory: 归档成功', arc1Json.archived === true);

  // 11. recall 排除归档
  const recall6 = await send('tools/call', { name: 'recall', arguments: {
    query: 'cursor', project_id: 'recall-vault', limit: 5,
  }});
  const t6 = recall6.content[0].text;
  check('recall: 归档内容被排除', !t6.includes(memId1), t6.slice(0, 150));

  // 12. unarchive
  await send('tools/call', { name: 'archive_memory', arguments: { memory_id: memId1, scope: 'project', project_id: 'recall-vault', unarchive: true }});
  const recall7 = await send('tools/call', { name: 'recall', arguments: {
    query: 'cursor', project_id: 'recall-vault', limit: 5,
  }});
  const t7 = recall7.content[0].text;
  check('recall: 解归档后恢复', t7.includes('cursor') || t7.includes(memId1));

  // 13. remember append
  const rem4 = await send('tools/call', { name: 'remember', arguments: {
    content: '\n补充：已确认在 SQLite 上性能更好。',
    memory_type: 'episodic', project_id: 'recall-vault',
    append_to: memId1, agent: 'trae',
  }});
  const rem4Json = JSON.parse(rem4.content[0].text);
  check('remember append: 创建=false 正确', rem4Json.created === false);

  const recall8 = await send('tools/call', { name: 'recall', arguments: {
    query: 'SQLite', project_id: 'recall-vault', session_id: 'sess-001', limit: 5,
  }});
  const t8 = recall8.content[0].text;
  check('recall: 追加内容可搜到 SQLite', t8.includes('SQLite'), t8.slice(0, 150));

  // 汇总
  console.log(`\n=== Results: ${passed}/${total} passed ===`);
  proc.stdin.end();
  proc.on('exit', () => process.exit(passed === total ? 0 : 1));
}

run().catch((err) => { console.error('FATAL:', err); process.exit(1); });
