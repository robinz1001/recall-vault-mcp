/**
 * 环境变量配置
 *
 * 唯一权威的配置来源。所有模块通过 import { config } from './config' 获取。
 */

import path from 'node:path';
import os from 'node:os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  /** 知识库根目录（默认 ~/.recall-vault/） */
  vaultPath: string;
  /** 日志级别 */
  logLevel: LogLevel;
  /** 是否启用 SQLite FTS5 索引（Batch 3+） */
  useFts5: boolean;
  /** 是否启用本地 embedding 语义检索（Batch 3+） */
  useEmbedding: boolean;
}

function parseLogLevel(v: string | undefined): LogLevel {
  const valid: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  return (valid.includes(v as LogLevel) ? v : 'info') as LogLevel;
}

function parseBool(v: string | undefined, def: boolean): boolean {
  if (v === undefined) return def;
  return ['true', '1', 'yes', 'on'].includes(v.toLowerCase());
}

function resolveVaultPath(): string {
  const raw = process.env.COA_VAULT_PATH;
  if (raw) {
    return path.resolve(raw);
  }
  // 默认：用户家目录下的 .recall-vault/ —— 跨项目统一，用户一眼知道在哪
  return path.join(os.homedir(), '.recall-vault');
}

export const config: Config = {
  vaultPath: resolveVaultPath(),
  logLevel: parseLogLevel(process.env.COA_LOG_LEVEL),
  useFts5: parseBool(process.env.COA_USE_FTS5, false),
  useEmbedding: parseBool(process.env.COA_USE_EMBEDDING, false),
};
