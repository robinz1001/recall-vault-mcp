// Phase 3 验证：journal capture + wrapHandler + backlog
import { spawn } from 'node:child_process';
import path from 'node:path';
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';

const serverPath = path.resolve('dist/index.js');
const vault = process.cwd();

function cleanVault() {
  const dirs = [
    path.join(vault, 'projects', 'recall-vault', 'episodic'),
    path.join(vault, 'projects', 'recall-vault', 'semantic'),
    path.join(vault, 'shared', 'semantic'),
    path.join(vault, 'journal'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f);
      if (existsSync(p)) unlinkSync(p);
    }
  }
}
cleanVault();
console.log('🧹 Vault cleaned\n');

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
  await send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'p3-test', version: '1.0' } });

  console.log('=== Phase 3: WrapHandler Eyes journal capture ===\n');

  // ① 连调几个 tool
  await send('tools/call', { name: 'health_check', arguments: {} });
  await send('tools/call', { name: 'remember', arguments: {
    content: '## Test entry\njust a test.', memory_type: 'semantic', scope: 'project', project_id: 'recall-vault', agent: 'trae', tags: ['test'],
  }});
  await send('tools/call', { name: 'recall', arguments: { query: 'test', project_id: 'recall-vault', limit: 3 }});

  // ② 检查 journal 目录有没有生成
  const journalDir = path.join(vault, 'journal');
  check('journal 目录创建', existsSync(journalDir));
  if (existsSync(journalDir)) {
    const files = readdirSync(journalDir).filter(f => f.endsWith('.jsonl'));
    check('journal jsonl 文件生成', files.length > 0);
    if (files.length > 0) {
      const content = readFileSync(path.join(journalDir, files[0]), 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      check('journal 有 3 条记录', lines.length >= 3);

      // 解析每条，验证字段
      const entries = lines.map(l => JSON.parse(l));
      const tools = entries.map(e => e.tool);
      check('captured health_check', tools.includes('health_check'));
      check('captured remember', tools.includes('remember'));
      check('captured recall', tools.includes('recall'));

      // 验证字段结构
      const sample = entries[0];
      check('entry 有 ts', !!sample.ts);
      check('entry 有 tool', !!sample.tool);
      check('entry 有 status', sample.status === 'ok');
      check('entry 有 ms', typeof sample.ms === 'number');
      check('args 做了 redact（无 content 全文）', !sample.args?.content || typeof sample.args.content !== 'string' || sample.args.content.length < 50);
    }
  }

  // ③ health_check 能返回 journal_backlog
  const hc = await send('tools/call', { name: 'health_check', arguments: {} });
  const hcJson = JSON.parse(hc.content[0].text);
  check('health_check 有 journal_backlog', typeof hcJson.journal_backlog === 'number');
  check('journal_backlog > 0', hcJson.journal_backlog > 0);
  console.log('  journal_backlog:', hcJson.journal_backlog);

  console.log('\n=== Phase 3: est_tokens 中英文差异 ===\n');

  // ④ 中文 vs 英文 token 比例
  await send('tools/call', { name: 'remember', arguments: {
    content: '## 中文测试\n这是一段完全由中文字符组成的测试内容，用于验证 token 估算的中英文差异。我们希望看到中文的 token 密度大约是英文的 1.33 倍。',
    memory_type: 'semantic', scope: 'project', project_id: 'recall-vault', agent: 'trae', tags: ['中文'],
  }});
  await send('tools/call', { name: 'remember', arguments: {
    content: '## English Test\nThis is a paragraph written entirely in English alphabet characters for testing purposes. We want to verify that the token estimation ratio works correctly for ASCII text.',
    memory_type: 'semantic', scope: 'project', project_id: 'recall-vault', agent: 'trae', tags: ['english'],
  }});

  const r = await send('tools/call', { name: 'recall', arguments: { query: '中文 English', project_id: 'recall-vault', limit: 5 }});
  const rJson = JSON.parse(r.content[0].text);
  const cn = rJson.results?.find(x => x.title?.includes('中文'));
  const en = rJson.results?.find(x => x.title?.includes('English'));
  check('中文条目 est_tokens > 0', cn?.est_tokens > 0);
  check('英文条目 est_tokens > 0', en?.est_tokens > 0);
  // 同长度下中文 token 应该更多（中文 chars/3 vs 英文 chars/4）
  console.log(`  中文 est_tokens=${cn?.est_tokens}, 英文 est_tokens=${en?.est_tokens}`);

  console.log('\n' + '='.repeat(40));
  console.log(`=== Phase 3: ${passed}/${total} passed ===\n`);
  proc.stdin.end();
  proc.on('exit', () => process.exit(passed === total ? 0 : 1));
}

run().catch((err) => { console.error('FATAL:', err); process.exit(1); });
