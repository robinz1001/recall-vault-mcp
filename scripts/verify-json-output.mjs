/**
 * 快速验证：新的 JSON 输出格式 + 默认 vault 路径
 *
 * 不传 COA_VAULT_PATH → 应该使用 ~/.recall-vault/ 默认路径
 */
import { spawn } from 'node:child_process';
import os from 'node:os';

const proc = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: process.cwd(),
  // 注意：不传 COA_VAULT_PATH，用默认值 ~/.recall-vault/
  env: { ...process.env, PATH: process.env.PATH },
});

let buf = '';
let nextId = 0;
const pending = [];

proc.stdout.on('data', (c) => {
  buf += c.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) {
        const p = pending.find((x) => x.id === msg.id);
        if (p) {
          p.resolve(msg.error ? { error: msg.error } : msg.result);
          pending.splice(pending.indexOf(p), 1);
        }
      }
    } catch {}
  }
});

proc.stderr.on('data', () => {});

function send(method, params) {
  const id = ++nextId;
  pending.push(new Promise((resolve) => send._resolve = resolve));
  return new Promise((resolve) => {
    pending[pending.length - 1].resolve = resolve;
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const PASS = '✅';
const FAIL = '❌';
let t = 0, p = 0;
function check(name, cond, detail) {
  t++;
  if (cond) { p++; console.log(PASS, name); }
  else { console.log(FAIL, name, detail ? '— ' + detail : ''); }
}

(async () => {
  await send('initialize', {
    protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'quick-check', version: '1' },
  });

  console.log('\n=== 输出格式 + 默认 Vault 路径验证 ===\n');

  // ① health_check JSON 格式
  const hc = await send('tools/call', { name: 'health_check', arguments: {} });
  const hcJson = JSON.parse(hc.content[0].text);
  check('health_check: JSON 可解析', true);
  check('health_check: status=ok', hcJson.status === 'ok');
  check('health_check: tools_registered=9', hcJson.tools_registered === 9);

  const expectedDefault = `${os.homedir()}/.recall-vault`.replace(/\\/g, '/');
  const actual = hcJson.vault_path.replace(/\\/g, '/');
  check(`默认 vault_path → ~/.recall-vault/`, actual.includes('.recall-vault'), actual);
  console.log(`   vault_path: ${hcJson.vault_path}`);
  console.log(`   vault_root: ${hcJson.vault_root}`);

  // ② remember → 写入默认 vault
  const rem = await send('tools/call', { name: 'remember', arguments: {
    content: '## 默认 vault 测试\n验证默认路径下记忆能正常写入和读取。',
    memory_type: 'semantic', scope: 'project', project_id: 'quick-test',
    agent: 'quick-check', tags: ['test', 'default-vault'], priority: 2,
  }});
  const remJson = JSON.parse(rem.content[0].text);
  check('remember → 默认 vault 创建成功', remJson.created === true, rem.content[0].text);
  const memId = remJson.memory_id;
  console.log(`   memory_id: ${memId}`);

  // ③ recall → JSON 格式 + reviewed 字段
  const recall = await send('tools/call', { name: 'recall', arguments: {
    query: '默认 vault 测试', project_id: 'quick-test', limit: 3,
  }});
  const recallJson = JSON.parse(recall.content[0].text);
  check('recall: JSON 可解析', true);
  check('recall: summary 字段', !!recallJson.summary);
  check('recall: results[] 数组', Array.isArray(recallJson.results));
  if (recallJson.results.length > 0) {
    const r0 = recallJson.results[0];
    check('recall: result 有 score', typeof r0.score === 'number');
    check('recall: result 有 wikilink', !!r0.wikilink && r0.wikilink.startsWith('[['));
    check('recall: result 有 reviewed 字段', 'reviewed' in r0);
    check('recall: result 有 rank', r0.rank === 1);
    console.log(`   第一条: "${r0.title}" score=${r0.score} rank=${r0.rank}`);
    console.log(`   wikilink: ${r0.wikilink}`);
  }

  // ④ list_memories → JSON 格式
  const list = await send('tools/call', { name: 'list_memories', arguments: {
    project_id: 'quick-test', limit: 10,
  }});
  const listJson = JSON.parse(list.content[0].text);
  check('list_memories: JSON 可解析', true);
  check('list_memories: items[] 数组', Array.isArray(listJson.items));

  // ⑤ update_memory + reviewed 验证
  const upd = await send('tools/call', { name: 'update_memory', arguments: {
    memory_id: memId, scope: 'project', project_id: 'quick-test', reviewed: true,
  }});
  const updJson = JSON.parse(upd.content[0].text);
  check('update_memory: reviewed 改为 true', updJson.updated.includes('reviewed'));

  // recall 再查一次，应该 reviewed=true
  const recall2 = await send('tools/call', { name: 'recall', arguments: {
    query: '默认 vault', project_id: 'quick-test', limit: 3, memory_type: 'semantic', sort_by: 'priority',
  }});
  const recall2Json = JSON.parse(recall2.content[0].text);
  if (recall2Json.results.length > 0) {
    const reviewedMem = recall2Json.results.find((r) => r.memory_id === memId);
    check('recall: reviewed 字段正确传递', reviewedMem?.reviewed === true);
  }

  // 汇总
  console.log(`\n=== 结果: ${p}/${t} passed ===\n`);
  console.log(`💾 默认 vault 位置: ${hcJson.vault_root}`);
  console.log(`   你可以直接用 VS Code / Obsidian 打开这个目录，看到 .md 文件。\n`);

  // 清理测试数据
  await send('tools/call', { name: 'delete_memory', arguments: {
    memory_id: memId, scope: 'project', project_id: 'quick-test',
  }});

  proc.stdin.end();
  proc.on('exit', () => process.exit(p === t ? 0 : 1));
})();
