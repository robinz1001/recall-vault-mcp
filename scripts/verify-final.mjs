import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const vault = path.join(os.homedir(), '.recall-vault');
console.log('vault:', vault);

const p = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: process.cwd(),
  env: { ...process.env, COA_VAULT_PATH: vault, COA_LOG_LEVEL: 'warn' },
});

let buf = '';
let nid = 0;
const pending = [];

p.stdout.on('data', (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf('\n')) > -1) {
    const l = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!l) continue;
    try {
      const m = JSON.parse(l);
      if (m.id != null) {
        const q = pending.find((x) => x.id === m.id);
        if (q) {
          q.resolve(m.error ? { err: m.error } : m.result);
          pending.splice(pending.indexOf(q), 1);
        }
      }
    } catch {}
  }
});

p.stderr.on('data', (c) => process.stderr.write(c));

function send(method, params) {
  const id = ++nid;
  return new Promise((resolve) => {
    pending.push({ id, resolve });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

(async () => {
  await send('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'q', version: '1' },
  });

  // ① health_check
  const hc = await send('tools/call', { name: 'health_check', arguments: {} });
  const hcJson = JSON.parse(hc.content[0].text);
  console.log('\n=== health_check ===');
  console.log('vault_path:', hcJson.vault_path);
  console.log('vault_root:', hcJson.vault_root);
  console.log('tools_registered:', hcJson.tools_registered);

  // ② remember × 2
  await send('tools/call', { name: 'remember', arguments: {
    content: '## TS strict\n开启 strict mode 避免很多坑。',
    memory_type: 'semantic', scope: 'project', project_id: 'demo',
    agent: 'manual', tags: ['ts', 'config'], priority: 2,
  }});
  await send('tools/call', { name: 'remember', arguments: {
    content: '## ESLint flat config\nflat config 是 eslint.config.js，没有 extends 字段。',
    memory_type: 'semantic', scope: 'project', project_id: 'demo',
    agent: 'manual', tags: ['eslint', 'ts'], priority: 1,
  }});

  // ③ recall
  const r = await send('tools/call', { name: 'recall', arguments: {
    query: 'ts eslint', project_id: 'demo', limit: 2, sort_by: 'relevance',
  }});
  const rJson = JSON.parse(r.content[0].text);
  console.log('\n=== recall JSON ===');
  console.log(JSON.stringify(rJson, null, 2));

  // ④ list_memories
  const list = await send('tools/call', { name: 'list_memories', arguments: {
    project_id: 'demo', limit: 10,
  }});
  const listJson = JSON.parse(list.content[0].text);
  console.log('\n=== list_memories JSON ===');
  console.log(JSON.stringify(listJson, null, 2));

  p.stdin.end();
  p.on('exit', () => console.log('\n=== 完成 ==='));
})();
