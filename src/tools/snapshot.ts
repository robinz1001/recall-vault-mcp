/**
 * 结构化快照层（v0.4.11）
 *
 * 对标 Cline Memory Bank — 用固定格式文件存项目确定性快照。
 * 和 semantic/episodic 的区别：
 *   - semantic = 自由格式，靠 recall 搜索
 *   - snapshot = 固定结构，hook 默认注入，agent 不需要 recall 就能拿到
 *
 * 4 个固定文件：
 *   project.md      — 项目画像（是什么、目标、非目标）
 *   stack.md        — 技术栈（语言、框架、工具链）
 *   architecture.md — 架构分层、关键组件
 *   conventions.md  — 命名约定、红线、规则
 *
 * 目录位置：projects/{project_id}/_snapshot/
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { VaultManager } from '../storage/vault.js';
import { logger } from '../logger.js';

export const SNAPSHOT_FILES = ['project', 'stack', 'architecture', 'conventions'] as const;
export type SnapshotFile = (typeof SNAPSHOT_FILES)[number];

export interface SnapshotEntry {
  file: SnapshotFile;
  title: string;
  body: string;
  exists: boolean;
  updated_at?: string;
}

export interface SnapshotSummary {
  project_id: string;
  files: SnapshotEntry[];
  // hook 注入用的压缩摘要（~200 token）
  condensed: string;
  est_tokens: number;
}

/** 快照文件的自动生成模板（当 _snapshot 是空的时）*/
const AUTO_TEMPLATES: Record<SnapshotFile, string> = {
  project: `# 项目画像

## 这是什么
<!-- 一句话描述项目是什么（产品定位） -->

## 目标
<!-- 3-5 条核心目标，完成与否可度量 -->
- [ ] 目标 1
- [ ] 目标 2

## 非目标（Out of Scope）
<!-- 明确不做什么，避免 scope creep -->
- 不做 X
- 不做 Y
`,

  stack: `# 技术栈

| 层 | 技术 | 版本 |
|----|------|------|
| 语言 | | |
| 框架 | | |
| 构建 | | |
| 测试 | | |
| 部署 | | |

## 关键约束
<!-- 必须遵守的技术约束，比如"Electron 打包产物名必须是 XXX" -->
`,

  architecture: `# 架构

## 分层
<!-- 描述分层，比如 L0/L1/L2 + 依赖方向 -->

## 关键组件
| 组件 | 职责 | 位置 |
|------|------|------|
| | | |

## 依赖方向
<!-- 谁可以依赖谁，禁止的反向依赖 -->
`,

  conventions: `# 约定与红线

## 命名
<!-- 前缀规则、后缀规则、缩写表 -->

## 红线（禁止）
<!-- 破坏即停的约束，带代码位置 -->
- R1: XXX — 破坏后果 YYY（文件:行号）

## 验证
<!-- 怎么验证改动正确 -->
`,
};

/** 获取快照目录（自动创建）*/
export async function ensureSnapshotDir(vault: VaultManager, projectId: string): Promise<string> {
  const safeId = path.basename(projectId);
  const dir = path.join(vault.root, 'projects', safeId, '_snapshot');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 确保 4 个快照文件存在（不存在的写模板）*/
export async function ensureSnapshotFiles(vault: VaultManager, projectId: string): Promise<void> {
  const dir = await ensureSnapshotDir(vault, projectId);
  for (const name of SNAPSHOT_FILES) {
    const filePath = path.join(dir, `${name}.md`);
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, AUTO_TEMPLATES[name], 'utf-8');
      logger.info('Snapshot created:', filePath);
    }
  }
}

/**
 * 判断快照内容是否是"空模板"
 * 规则：<!-- 注释占位符超过 2 个 OR 包含 "<!-- 一句话描述" 这种明确模板标记
 */
function isTemplate(body: string): boolean {
  if (!body) return true;
  if (body.includes('<!-- 一句话描述') && body.includes('<!-- 3-5 条')) return true;
  const commentMatches = body.match(/<!--[\s\S]*?-->/g) || [];
  return commentMatches.length >= 3;
}

/** 读所有快照文件 */
export async function readAllSnapshots(vault: VaultManager, projectId: string): Promise<SnapshotEntry[]> {
  const dir = path.join(vault.root, 'projects', path.basename(projectId), '_snapshot');
  const results: SnapshotEntry[] = [];

  for (const name of SNAPSHOT_FILES) {
    const filePath = path.join(dir, `${name}.md`);
    let body = '';
    let exists = false;
    let updatedAt: string | undefined;

    try {
      const stat = await fs.stat(filePath);
      exists = true;
      updatedAt = stat.mtime.toISOString();
      body = await fs.readFile(filePath, 'utf-8');
    } catch {
      // 不存在 → 模板内容
      body = AUTO_TEMPLATES[name];
    }

    // 提取标题（第一行 # title）
    const firstLine = body.split('\n').find((l) => l.trim().length > 0) || '';
    const title = firstLine.replace(/^#+\s*/, '').trim() || name;

    results.push({ file: name, title, body, exists, updated_at: updatedAt });
  }

  return results;
}

/** 读单个快照文件 */
export async function readSnapshot(vault: VaultManager, projectId: string, file: SnapshotFile): Promise<SnapshotEntry> {
  const dir = path.join(vault.root, 'projects', path.basename(projectId), '_snapshot');
  const filePath = path.join(dir, `${file}.md`);
  let body = '';
  let exists = false;
  let updatedAt: string | undefined;

  try {
    const stat = await fs.stat(filePath);
    exists = true;
    updatedAt = stat.mtime.toISOString();
    body = await fs.readFile(filePath, 'utf-8');
  } catch {
    body = AUTO_TEMPLATES[file];
  }

  const firstLine = body.split('\n').find((l) => l.trim().length > 0) || '';
  const title = firstLine.replace(/^#+\s*/, '').trim() || file;

  return { file, title, body, exists, updated_at: updatedAt };
}

/** 写单个快照文件（agent 更新用）*/
export async function writeSnapshot(
  vault: VaultManager,
  projectId: string,
  file: SnapshotFile,
  body: string,
): Promise<{ ok: boolean; path: string }> {
  const dir = await ensureSnapshotDir(vault, projectId);
  const filePath = path.join(dir, `${file}.md`);
  await fs.writeFile(filePath, body, 'utf-8');
  logger.info('Snapshot updated:', file, '→', projectId);
  return { ok: true, path: filePath };
}

/**
 * 生成 hook 注入用的压缩摘要
 *
 * 格式：
 *   📋 项目画像：[技术栈标签] [架构一句话] [红线核心]
 *
 * 规则：优先取非模板内容（跳过模板占位符如 "<!-- 一句话描述"）
 */
export function condenseSnapshots(entries: SnapshotEntry[]): string {
  const parts: string[] = [];

  // stack → 技术栈标签（只取第一列非空值）
  const stackEntry = entries.find((e) => e.file === 'stack');
  if (stackEntry && stackEntry.exists) {
    // 提取表格里的技术名（跳过标题行）
    const tableLines = stackEntry.body.split('\n').filter((l) => l.startsWith('|'));
    const techs: string[] = [];
    for (const line of tableLines) {
      const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
      // 跳过表头（含 "层"、"技术"、"--"）
      if (cells.some((c) => c.includes('---') || c === '层' || c === '技术')) continue;
      if (cells[1] && !cells[1].includes('<!--')) techs.push(cells[1]);
      if (techs.length >= 4) break;
    }
    if (techs.length > 0) parts.push(`技术栈: ${techs.join(' · ')}`);
  }

  // project → 目标/非目标前两条
  const projEntry = entries.find((e) => e.file === 'project');
  if (projEntry && projEntry.exists) {
    const goals = projEntry.body.match(/-\s*\[[ x]\]\s*([^\n{]+)/g)?.slice(0, 2) || [];
    const goalText = goals.map((g) => g.replace(/-\s*\[[ x]\]\s*/, '').slice(0, 40)).filter((t) => !t.includes('<!--'));
    if (goalText.length > 0) parts.push(`目标: ${goalText.join('；')}`);
  }

  // conventions → 红线 R1-R3 摘要
  const convEntry = entries.find((e) => e.file === 'conventions');
  if (convEntry && convEntry.exists) {
    const redlines = convEntry.body.match(/R\d+[：:][^\n]*/g)?.slice(0, 2) || [];
    if (redlines.length > 0) parts.push(`红线: ${redlines.join('；').slice(0, 100)}`);
  }

  // architecture → 分层一句话
  const archEntry = entries.find((e) => e.file === 'architecture');
  if (archEntry && archEntry.exists && !isTemplate(archEntry.body)) {
    // 找第一个非模板段落的第一句话（跳过表格标题和分隔线）
    const lines = archEntry.body
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        if (!t) return false;
        if (t.startsWith('#')) return false;
        if (t.includes('<!--')) return false;
        if (/^\|[\s\-|:]+\|$/.test(t)) return false; // 表格分隔线 |||---|||
        if (t.includes('组件') && t.includes('职责')) return false; // 表格标题
        return true;
      });
    if (lines.length > 0) parts.push(`架构: ${lines[0].trim().slice(0, 60)}`);
  }

  return parts.join(' · ');
}

/** 估算 token（ASCII 4 chars/token, CJK 3 chars/token）*/
function estimateTokens(text: string): number {
  let ascii = 0, cjk = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++; else cjk++;
  }
  return Math.ceil(ascii / 4 + cjk / 3);
}

/** 汇总 — 供 session_start MCP 工具和 hook 使用 */
export async function snapshotSummary(
  projectId: string,
  vault?: VaultManager,
): Promise<SnapshotSummary | null> {
  const v = vault ?? new VaultManager();
  await ensureSnapshotDir(v, projectId);
  await ensureSnapshotFiles(v, projectId);

  const entries = await readAllSnapshots(v, projectId);
  // 只保留非模板的快照
  const realEntries = entries.filter((e) => e.exists && !isTemplate(e.body));
  if (realEntries.length === 0) return null;

  const condensed = condenseSnapshots(realEntries);
  if (!condensed) return null;

  return {
    project_id: path.basename(projectId),
    files: realEntries,
    condensed,
    est_tokens: estimateTokens(condensed),
  };
}
