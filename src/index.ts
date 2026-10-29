/**
 * RecallVault 入口
 *
 * 职责：
 * 1. 确保 vault 目录结构存在
 * 2. 通过 factory 函数创建 MCP Server 实例并注册 stdio
 * 3. 等待 stdin EOF 时自动退出
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { VaultManager } from './storage/vault.js';
import { logger } from './logger.js';
import { config } from './config.js';
import { createServer } from './server.js';

// 在 factory 之前执行（这些是一次性初始化，不依赖请求上下文）
const vault = new VaultManager();
await vault.ensureStructure();
logger.info('Vault directory structure ready at:', vault.root);

// serveStdio 接受 factory：() => McpServer
// factory 被每个新连接调用一次，返回该连接的 server 实例
const handle = serveStdio(() => {
  const server = createServer();

  // 当连接关闭时，让进程自然退出（没有其他 keep-alive handle）
  server.server.onclose = () => {
    logger.info('MCP connection closed, shutting down');
  };

  return server;
});

logger.info('RecallVault listening on stdio (vault:', config.vaultPath + ')');
