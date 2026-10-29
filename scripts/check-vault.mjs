import { spawn } from 'node:child_process';

// 注意：不传 COA_VAULT_PATH → 用默认 ~/.recall-vault/
const p = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: process.cwd(),
  env: { ...process.env, COA_LOG_LEVEL: 'warn' },
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

p.stderr.on('data', () => {});

function send(m, p2) {
  const id = ++nid;
  return new Promise((resolve) => {
    pending.push({ id, resolve });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: m, params: p2 }) + '\n');
  });
}

(async () => {
  await send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'q', version: '1' } });
  const hc = await send('tools/call', { name: 'health_check', arguments: {} });
  const j = JSON.parse(hc.content[0].text);
  console.log('实际 vault_path:', j.vault_path);
  console.log('实际 vault_root:', j.vault_root);
  console.log('期望 vault_path:', process.env.USERPROFILE + '\\.recall-vault');
  console.log('✅ 匹配:', j.vault_path === process.env.USERPROFILE + '\\.recall-vault');
  p.stdin.end();
})();
