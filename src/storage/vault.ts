/**
 * Vault 目录管理
 *
 * 首次启动时自动创建目录结构。
 * vaultPath 直接就是根目录（默认 ~/.recall-vault/），
 * MCP 只在此目录内读写，不触碰 vault 其他文件。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

const README_PATH = path.join(config.vaultPath, 'VAULT.md');

const AUTO_README = `# RecallVault Memory Directory

这个目录由 **RecallVault** (本地 MCP stdio 记忆服务) 自动管理。

## 目录结构

\`\`\`
{vaultPath}/
├── projects/{project_id}/
│   ├── episodic/       ← 短期会话上下文（项目绑定）
│   └── semantic/       ← 项目专属长期知识
├── shared/
│   └── semantic/       ← 跨项目可复用的长期知识
└── _logs/              ← MCP 运行时日志
\`\`\`

## 两种记忆类型

| 类型 | 说明 | 生命周期 | scope |
|------|------|---------|-------|
| **episodic** | 会话上下文、任务进展、决策记录 | 任务结束后可归档 | 只能 project |
| **semantic** | 项目规范、架构说明、踩坑总结 | 长期沉淀 | project 或 shared |

## 使用方式

- **AI Agent**：通过 MCP 协议调用 RecallVault 服务读写记忆
- **人类**：直接用你喜欢的编辑器（Obsidian / VS Code / Vim 等）编辑 .md 文件
- **唯一权威源**：Markdown 文件就是真相，MCP 只是薄读写层

## Frontmatter 约定

每个记忆文件顶部有 YAML frontmatter，包含系统字段和元数据。
详见 RecallVault 架构设计文档。

---
_此文件由 RecallVault 自动生成，请勿手动修改。_
`;

export class VaultManager {
  readonly root: string; // vaultPath 本身（默认 ~/.recall-vault/）
  readonly projectsDir: string;
  readonly sharedDir: string;
  readonly sharedSemanticDir: string;
  readonly logsDir: string;

  constructor(vaultPath?: string) {
    const root = vaultPath ?? config.vaultPath;
    this.root = root;
    this.projectsDir = path.join(root, 'projects');
    this.sharedDir = path.join(root, 'shared');
    this.sharedSemanticDir = path.join(this.sharedDir, 'semantic');
    this.logsDir = path.join(root, '_logs');
  }

  /** 确保所有必要目录存在，首次启动时调用 */
  async ensureStructure(): Promise<void> {
    const dirs = [
      this.root,
      this.projectsDir,
      this.sharedDir,
      this.sharedSemanticDir,
      this.logsDir,
    ];
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
      logger.debug('Vault dir ensured:', dir);
    }

    // 生成 README.md（如果不存在）
    try {
      await fs.access(README_PATH);
    } catch {
      await fs.writeFile(README_PATH, AUTO_README, 'utf-8');
      logger.info('Created VAULT.md');
    }
  }

  /** 获取项目专属目录，自动创建 */
  async ensureProjectDir(projectId: string): Promise<{ episodic: string; semantic: string }> {
    // 安全：project_id 不能包含路径遍历
    const safeId = path.basename(projectId);
    const episodic = path.join(this.projectsDir, safeId, 'episodic');
    const semantic = path.join(this.projectsDir, safeId, 'semantic');
    await fs.mkdir(episodic, { recursive: true });
    await fs.mkdir(semantic, { recursive: true });
    return { episodic, semantic };
  }

  /** shared/semantic 目录（已在 ensureStructure 中创建） */
  getSharedSemanticDir(): string {
    return this.sharedSemanticDir;
  }

  /**
   * 推断当前项目 ID。
   * 优先级：COA_PROJECT_ID → cwd 的 basename。
   * 去掉非法字符（保留字母数字 _ -），确保作为目录名安全。
   */
  inferProjectId(): string {
    const envOverride = process.env.COA_PROJECT_ID;
    const raw = envOverride ?? path.basename(process.cwd());
    // 安全化：去掉非法目录名字符
    return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default';
  }

  /** 返回项目 episodic 目录路径（不自动创建） */
  getEpisodicDir(projectId: string): string {
    return path.join(this.projectsDir, path.basename(projectId), 'episodic');
  }

  /** 返回项目 semantic 目录路径（不自动创建） */
  getSemanticDir(projectId: string): string {
    return path.join(this.projectsDir, path.basename(projectId), 'semantic');
  }
}
