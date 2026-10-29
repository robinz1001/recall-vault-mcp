// Phase 4 验证：memory_import 幂等 + driver
// 注意：COA_VAULT_PATH 必须在 node 启动前设置，否则 config 已初始化
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';

const vault = process.cwd();

// 清理 vault semantic 目录
function clean() {
  const semDir = path.join(vault, 'projects', 'recall-vault', 'semantic');
  if (existsSync(semDir)) {
    for (const f of readdirSync(semDir)) {
      if (f.startsWith('mem_import_')) unlinkSync(path.join(semDir, f));
    }
  }
  const journal = path.join(vault, 'journal');
  if (existsSync(journal)) {
    for (const f of readdirSync(journal)) unlinkSync(path.join(journal, f));
  }
}
clean();
console.log('🧹 Vault cleaned\n');

const PASS = '✅';
const FAIL = '❌';
let total = 0, passed = 0;
function check(name, cond, detail = '') {
  total++;
  if (cond) { passed++; console.log(PASS, name); }
  else { console.log(FAIL, name, detail); }
}

// === 核心：用 spawn 启动 MCP server，所有测试都通过它 ===
const serverPath = path.resolve('dist/index.js');
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

async function run() {
  await send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'p4-test', version: '1.0' } });

  console.log('=== Phase 4: memory_import driver + 幂等 ===\n');

  // ① health_check 确认 tools_registered=10
  const hc = await send('tools/call', { name: 'health_check', arguments: {} });
  const hcJson = JSON.parse(hc.content[0].text);
  check('tools_registered=10', hcJson.tools_registered === 10, `got=${hcJson.tools_registered}`);
  check('tools 含 memory_import', hcJson.tools.includes('memory_import'));

  // ② 第一次导入
  const r1 = await send('tools/call', { name: 'memory_import', arguments: { from_trae_documents: false, from_docs: true } });
  const r1Json = JSON.parse(r1.content[0].text);
  const d1 = r1Json.drivers?.find((d) => d.driver === 'docs');
  check('第一次导入 docs driver 存在', !!d1);
  check('docs scanned=7', d1?.scanned === 7, `scanned=${d1?.scanned}`);
  check('docs created > 0', (d1?.created ?? 0) > 0, `created=${d1?.created}`);
  check('docs failed = 0', (d1?.failed ?? 0) === 0);
  console.log(`  第一次: scanned=${d1?.scanned}, created=${d1?.created}, skipped=${d1?.skipped}, failed=${d1?.failed}`);

  // ③ 幂等 — 第二次 created=0
  const r2 = await send('tools/call', { name: 'memory_import', arguments: { from_trae_documents: false, from_docs: true } });
  const r2Json = JSON.parse(r2.content[0].text);
  const d2 = r2Json.drivers?.find((d) => d.driver === 'docs');
  check('幂等: 第二次 created=0', (d2?.created ?? -1) === 0, `created=${d2?.created}`);
  check('幂等: skipped > 0', (d2?.skipped ?? 0) > 0, `skipped=${d2?.skipped}`);
  console.log(`  二次: created=${d2?.created}, skipped=${d2?.skipped}`);

  // ④ 验证 vault 里实际文件
  const semDir = path.join(vault, 'projects', 'recall-vault', 'semantic');
  const impFiles = readdirSync(semDir).filter((f) => f.startsWith('mem_import_'));
  check('生成 mem_import_* 命名', impFiles.length > 0, `found=${impFiles.length}`);
  if (impFiles.length > 0) {
    const content = await send('tools/call', { name: 'recall', arguments: { query: 'architecture design roadmap', project_id: 'recall-vault', limit: 5 }});
    const cJson = JSON.parse(content.content[0].text);
    check('recall 能搜到导入的内容', cJson.results?.length > 0);
    const item = cJson.results?.find((r) => r.tags?.includes('import'));
    check('导入的记忆有 import tag', !!item);
  }

  // ⑤ summary 聚合
  check('summary 有 Total', r1Json.summary.includes('Total:'));
  check('duration_ms 合理', typeof d1?.duration_ms === 'number');

  // ⑥ journal 也 capture 了 memory_import 调用
  const hc2 = await send('tools/call', { name: 'health_check', arguments: {} });
  const hc2Json = JSON.parse(hc2.content[0].text);
  check('journal_backlog >= 3（hc + import + hc2）', (hc2Json.journal_backlog ?? 0) >= 3);

  console.log('\n' + '='.repeat(40));
  console.log(`=== Phase 4: ${passed}/${total} passed ===\n`);
  proc.stdin.end();
  proc.on('exit', () => process.exit(passed === total ? 0 : 1));
}

run().catch((err) => { console.error('FATAL:', err); process.exit(1); });
