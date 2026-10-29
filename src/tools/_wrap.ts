/**
 * WrapHandler Eyes 层 — 统一包装 MCP tool handler，自动 capture 调用记录
 *
 * 来源：Kontexta journal-capture.ts（源码已验证）
 * 设计原则：
 *   - fail-safe：capture 异常 exit 0，绝不阻断主流程
 *   - lenient envelope：backlog ≥ 50 条时工具返回 JSON 里嵌套 journal.suggested_action
 *   - 自动滚动：journal 文件 > 10MB 自动归档（重命名 .jsonl → .jsonl.bak）
 *   - 零影响：包装后的 handler 签名不变，server.registerTool 不用改
 *
 * 捕获字段：{ ts, tool, args(redacted), status, ms }
 * 存储位置：{vaultRoot}/journal/*.jsonl
 *
 * 当前是第一版（Eyes only）：只做 capture + backlog 提醒。
 * 自动 distill（LLM 抽取）留 Phase 4+。
 */

import fs from 'node:fs';
import path from 'node:path';
import { VaultManager } from '../storage/vault.js';

const BACKLOG_THRESHOLD = 50;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_RECENT_FILES = 5;

interface JournalEntry {
  ts: string;
  tool: string;
  args: Record<string, unknown>;
  status: 'ok' | 'error';
  ms: number;
  error?: string;
}

let _journalDir: string | null = null;

function getJournalDir(): string {
  if (!_journalDir) {
    const vault = new VaultManager();
    _journalDir = path.join(vault.root, 'journal');
    if (!fs.existsSync(_journalDir)) {
      try { fs.mkdirSync(_journalDir, { recursive: true }); } catch { /* ignore */ }
    }
  }
  return _journalDir;
}

function getJournalFile(): string {
  const dir = getJournalDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.endsWith('.bak'));
  if (files.length === 0) {
    const now = new Date();
    const fn = `journal_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}.jsonl`;
    return path.join(dir, fn);
  }
  // 取最新的
  const latest = files.sort().slice(-1)[0];
  const full = path.join(dir, latest);

  // 超过 10MB → 归档
  try {
    const stat = fs.statSync(full);
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      fs.renameSync(full, full + '.bak');
      cleanupOldBackups(dir);
      // 新开一个
      const now = new Date();
      const fn = `journal_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}.jsonl`;
      return path.join(dir, fn);
    }
  } catch { /* ignore */ }

  return full;
}

function cleanupOldBackups(dir: string): void {
  const backups = fs.readdirSync(dir).filter((f) => f.endsWith('.bak')).sort();
  while (backups.length > MAX_RECENT_FILES) {
    const old = backups.shift();
    if (old) {
      try { fs.unlinkSync(path.join(dir, old)); } catch { /* ignore */ }
    }
  }
}

function countBacklog(): number {
  try {
    const dir = getJournalDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.endsWith('.bak'));
    let count = 0;
    for (const f of files) {
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      count += content.split('\n').filter((l) => l.trim()).length;
    }
    return count;
  } catch { return 0; }
}

function capture(entry: JournalEntry): void {
  try {
    const file = getJournalFile();
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(file, line);
  } catch {
    // fail-safe：绝不阻断主流程
  }
}

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  // 只保留关键字段，避免 journal 存完整大段 content
  const result: Record<string, unknown> = {};
  const keepKeys = ['query', 'memory_id', 'scope', 'project_id', 'memory_type', 'tags', 'agent', 'priority', 'session_id'];
  for (const key of keepKeys) {
    if (args[key] !== undefined) result[key] = args[key];
  }
  // content 只存前 100 字符
  if (args.content) {
    const str = String(args.content);
    result.content_preview = str.slice(0, 100) + (str.length > 100 ? '...' : '');
  }
  return result;
}

/**
 * 统一包装 MCP tool handler
 *   1. capture 调用记录（fail-safe）
 *   2. backlog ≥ 50 条时返回里加 journal.suggested_action
 */
export function wrapHandler<TArgs extends Record<string, unknown>, TResult>(
  toolName: string,
  handler: (args: TArgs) => Promise<TResult>,
): (args: TArgs) => Promise<TResult> {
  return async (args: TArgs): Promise<TResult> => {
    const t0 = performance.now();
    let status: 'ok' | 'error' = 'ok';
    let errorMsg: string | undefined;
    let result: TResult;

    try {
      result = await handler(args);
    } catch (err: any) {
      status = 'error';
      errorMsg = err?.message ?? String(err);
      throw err;
    } finally {
      const ms = Math.round(performance.now() - t0);
      capture({
        ts: new Date().toISOString(),
        tool: toolName,
        args: redactArgs(args),
        status,
        ms,
        error: errorMsg,
      });
    }

    // backlog 提醒（只在 ok 时注入）
    if (result && typeof result === 'object' && 'content' in (result as any)) {
      const backlog = countBacklog();
      if (backlog >= BACKLOG_THRESHOLD) {
        const res = result as any;
        const originalText = res.content?.[0]?.text;
        if (typeof originalText === 'string') {
          try {
            const parsed = JSON.parse(originalText);
            parsed.journal = {
              backlog_count: backlog,
              suggested_action: `Call journal_distill to process ${backlog} pending entries. Or call memory_import with source=journal.`,
            };
            res.content[0].text = JSON.stringify(parsed, null, 2);
          } catch { /* 非 JSON 输出跳过 */ }
        }
      }
    }

    return result;
  };
}

/** 查询当前 backlog 数量（health_check 用） */
export function getJournalBacklog(): number {
  return countBacklog();
}

/** 重置 journal 目录（测试用） */
export function resetJournalDir(): void {
  try {
    if (_journalDir && fs.existsSync(_journalDir)) {
      fs.rmSync(_journalDir, { recursive: true });
    }
  } catch { /* ignore */ }
  _journalDir = null;
}
