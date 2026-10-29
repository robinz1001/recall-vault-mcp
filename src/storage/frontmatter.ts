/**
 * Markdown + YAML frontmatter 读写
 *
 * gray-matter 处理边界情况：
 * - 有 frontmatter → 正常解析 data + content
 * - 无 frontmatter → data={}, content=全文
 * - frontmatter 空 → data={}
 */

import matter from 'gray-matter';
import fs from 'node:fs/promises';
import { logger } from '../logger.js';
import type { MemoryEntry, MemoryMeta } from '../types.js';

/** 从文件读取一个记忆 */
export async function readMemory(filePath: string): Promise<MemoryEntry | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = matter(raw);

    const meta = parsed.data as Partial<MemoryMeta>;
    if (!meta.id) {
      logger.warn('File missing frontmatter id:', filePath);
      return null;
    }

    return {
      path: filePath,
      meta: meta as MemoryMeta,
      body: parsed.content.trim(),
    };
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    logger.error('Failed to read memory: ' + filePath, err);
    return null;
  }
}

/** 写入一个新记忆（新建文件） */
export async function writeMemory(filePath: string, meta: MemoryMeta, body: string): Promise<void> {
  const content = matter.stringify(body.trim(), meta);
  await fs.writeFile(filePath, content, 'utf-8');
  logger.debug('Wrote memory:', filePath);
}

/** 更新已有记忆的 frontmatter，保留 body */
export async function updateMemoryMeta(
  filePath: string,
  patch: Partial<MemoryMeta>,
): Promise<MemoryEntry | null> {
  const entry = await readMemory(filePath);
  if (!entry) return null;

  const updatedMeta: MemoryMeta = { ...entry.meta, ...patch, updated_at: new Date().toISOString() };
  const content = matter.stringify(entry.body, updatedMeta);
  await fs.writeFile(filePath, content, 'utf-8');
  logger.debug('Updated memory meta:', filePath, 'patch:', patch);
  return { ...entry, meta: updatedMeta };
}

/** 追加内容到已有记忆正文 */
export async function appendToMemory(
  filePath: string,
  extraContent: string,
): Promise<MemoryEntry | null> {
  const entry = await readMemory(filePath);
  if (!entry) return null;

  const newBody = entry.body
    ? `${entry.body}\n\n${extraContent.trim()}`
    : extraContent.trim();

  const updatedMeta: MemoryMeta = { ...entry.meta, updated_at: new Date().toISOString() };
  const content = matter.stringify(newBody, updatedMeta);
  await fs.writeFile(filePath, content, 'utf-8');
  logger.debug('Appended to memory:', filePath);
  return { ...entry, meta: updatedMeta, body: newBody };
}
