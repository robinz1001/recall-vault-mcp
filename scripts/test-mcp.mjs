import { spawn } from 'node:child_process';
import path from 'node:path';

const serverPath = path.resolve('dist/index.js');

const proc = spawn('node', [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, COA_VAULT_PATH: process.cwd() },
});

const messages = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0' },
  }},
  { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'health_check', arguments: {} } },
];

let sentIdx = 0;
let buffer = '';

proc.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  // MCP 用换行分隔消息
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (line) {
      const msg = JSON.parse(line);
      console.log('[stdout]', JSON.stringify(msg, null, 2));
    }
  }
});

proc.stderr.on('data', (chunk) => {
  console.error('[stderr]', chunk.toString().trim());
});

proc.on('error', (err) => {
  console.error('[error]', err.message);
});

proc.on('exit', (code) => {
  console.log('[exit]', code);
});

// 串行发送：等上一个 response 再发下一个
function sendNext() {
  if (sentIdx >= messages.length) {
    setTimeout(() => proc.stdin.end(), 500);
    return;
  }
  const msg = messages[sentIdx++];
  console.log('[send]', msg.method, msg.id ?? '');
  proc.stdin.write(JSON.stringify(msg) + '\n');
  setTimeout(sendNext, 300);
}

sendNext();
