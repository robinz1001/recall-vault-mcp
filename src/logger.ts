/**
 * 日志系统
 *
 * 所有应用日志必须通过此模块输出。
 *
 * 规则：
 * 1. 所有日志 → stderr（不影响 MCP stdio 协议）
 * 2. DEBUG 级别默认关闭，通过 COA_LOG_LEVEL=debug 开启
 * 3. 绝对禁止 console.log / process.stdout.write（非 SDK 发送的）
 */

import { config, type LogLevel } from './config.js';

const LEVEL_NUM: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  return LEVEL_NUM[level] >= LEVEL_NUM[config.logLevel];
}

function fmt(level: LogLevel, msg: string): string {
  const ts = new Date().toISOString();
  return `[${ts}] [${level.toUpperCase()}] ${msg}`;
}

export const logger = {
  debug(msg: string, ...rest: unknown[]) {
    if (!shouldLog('debug')) return;
    process.stderr.write(fmt('debug', rest.length ? `${msg} ${JSON.stringify(rest)}` : msg) + '\n');
  },

  info(msg: string, ...rest: unknown[]) {
    if (!shouldLog('info')) return;
    process.stderr.write(fmt('info', rest.length ? `${msg} ${JSON.stringify(rest)}` : msg) + '\n');
  },

  warn(msg: string, ...rest: unknown[]) {
    if (!shouldLog('warn')) return;
    process.stderr.write(fmt('warn', rest.length ? `${msg} ${JSON.stringify(rest)}` : msg) + '\n');
  },

  error(msg: string, err?: unknown) {
    if (!shouldLog('error')) return;
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : err ? String(err) : '';
    process.stderr.write(fmt('error', detail ? `${msg} ${detail}` : msg) + '\n');
  },
};
