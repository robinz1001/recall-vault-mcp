// Phase 2 手动验证脚本
import { spawn } from 'node:child_process';
import path from 'node:path';
import { readdirSync, existsSync, unlinkSync } from 'node:fs';

const serverPath = path.resolve('dist/index.js');
const vault = process.cwd();

// 清理 vault
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
  const db = path.join(vault, '.recall-vault-index.db');
  if (existsSync(db)) {
    unlinkSync(db);
    for (const ext of ['-wal', '-shm']) {
      const f = db + ext;
      if (existsSync(f)) unlinkSync(f);
    }
  }
  console.log('🧹 Vault cleaned\n');
}
cleanVault();

const proc = spawn('node', [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, COA_VAULT_PATH: vault, COA_LOG_LEVEL: 'warn' },
});

let buffer = '';
let nextId = 0;
const requests = [];
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

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    requests.push({ id, resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const PASS = '✅';
const FAIL = '❌';
let total = 0, passed = 0;
function check(name, cond) {
  total++;
  if (cond) { passed++; console.log(PASS, name); }
  else { console.log(FAIL, name); }
}

async function run() {
  await send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'p2-test', version: '1.0' } });

  console.log('=== Phase 2: Staleness 信号 ===\n');

  // ① 新建一条记忆
  const rem1 = await send('tools/call', { name: 'remember', arguments: {
    content: '## Jest mock 陷阱\njest.mock() 会提升到文件顶部，jest.fn() 不会。',
    memory_type: 'semantic', scope: 'project', project_id: 'recall-vault',
    agent: 'trae', tags: ['jest', 'testing'], priority: 2,
  }});
  const rem1Json = JSON.parse(rem1.content[0].text);
  const memIdV1 = rem1Json.memory_id;
  check('remember v1 成功', rem1Json.created === true);

  // ② recall 应该返回 staleness 字段
  const r1 = await send('tools/call', { name: 'recall', arguments: {
    query: 'jest mock', project_id: 'recall-vault', limit: 3,
  }});
  const r1Json = JSON.parse(r1.content[0].text);
  const item1 = r1Json.results?.[0];
  check('recall 返回 staleness', item1?.staleness !== undefined);
  check('staleness.age_days 是数字', typeof item1?.staleness?.age_days === 'number');
  check('staleness.recency_score 是数字', typeof item1?.staleness?.recency_score === 'number');
  check('新建记忆 recency_score ≈ 1', item1?.staleness?.recency_score > 0.9);
  check('新建记忆 stale=false', item1?.staleness?.stale === false);
  console.log('  staleness:', JSON.stringify(item1?.staleness));

  console.log('\n=== Phase 2: 双时钟 replaces ===\n');

  // ③ 用 replaces 写 v2
  const rem2 = await send('tools/call', { name: 'remember', arguments: {
    content: '## Jest mock 陷阱（已修正）\njest.mock() 会提升到文件顶部，jest.fn() 不会。解决：用工厂函数 jest.fn(() => {...})。',
    memory_type: 'semantic', scope: 'project', project_id: 'recall-vault',
    agent: 'trae', tags: ['jest', 'testing'], priority: 2,
    replaces: memIdV1,
  }});
  const rem2Json = JSON.parse(rem2.content[0].text);
  check('remember v2 replaces 返回 superseded', rem2Json.superseded === memIdV1);
  const memIdV2 = rem2Json.memory_id;

  // ④ recall 默认排除 v1（valid_to 已设）
  const r2 = await send('tools/call', { name: 'recall', arguments: {
    query: 'jest mock', project_id: 'recall-vault', limit: 5,
  }});
  const r2Json = JSON.parse(r2.content[0].text);
  const ids = r2Json.results?.map(r => r.memory_id) ?? [];
  check('默认 recall 排除 v1（superseded）', !ids.includes(memIdV1));
  check('默认 recall 包含 v2（当前有效）', ids.includes(memIdV2));

  // ⑤ recall include_superseded=true 能看到 v1
  const r3 = await send('tools/call', { name: 'recall', arguments: {
    query: 'jest mock', project_id: 'recall-vault', limit: 5, include_superseded: true,
  }});
  const r3Json = JSON.parse(r3.content[0].text);
  const ids2 = r3Json.results?.map(r => r.memory_id) ?? [];
  check('include_superseded=true 包含 v1', ids2.includes(memIdV1));
  check('include_superseded=true 包含 v2', ids2.includes(memIdV2));

  // ⑥ 验证 v1 的 valid_to
  const v1Item = r3Json.results?.find(r => r.memory_id === memIdV1);
  check('v1 有 valid_to 字段', v1Item?.valid_to !== undefined);

  // ⑦ 验证 v2 的 supersedes
  const v2Item = r3Json.results?.find(r => r.memory_id === memIdV2);
  check('v2 有 supersedes 字段', v2Item?.supersedes === memIdV1);
  check('v2 有 valid_from 字段', v2Item?.valid_from !== undefined);

  console.log('\n' + '='.repeat(40));
  console.log(`=== Phase 2: ${passed}/${total} passed ===\n`);
  proc.stdin.end();
  proc.on('exit', () => process.exit(passed === total ? 0 : 1));
}

run().catch((err) => { console.error('FATAL:', err); process.exit(1); });
