/**
 * list_memories — 列出记忆概览
 *
 * 和 recall 的区别：不做关键词匹配，返回全部（受 filter/limit/offset 限制）。
 * 不需要 relevance_score。
 */

import { VaultManager } from '../storage/vault.js';
import { readMemory } from '../storage/frontmatter.js';
import { walkMdFiles } from './_walk.js';
import { recall } from './recall.js';
import type { MemoryType, MemoryAgent } from '../types.js';

export interface ListArgs {
  project_id?: string;
  include_shared?: boolean;
  memory_type?: MemoryType | 'all';
  include_archived?: boolean;
  limit?: number;
  offset?: number;
  sort_by?: 'time_desc' | 'time_asc' | 'priority';
}

export interface ListItem {
  memory_id: string;
  path: string;
  title: string;
  memory_type: MemoryType;
  scope: string;
  priority: number;
  archived: boolean;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export async function listMemories(args: ListArgs): Promise<{ items: ListItem[]; total: number }> {
  // 复用 recall 的搜索 + 过滤逻辑，空 query = 全部匹配
  const recallSort = args.sort_by ?? 'time_desc';

  // 用 recall 空 query 收集全部候选，然后自己排序（recall 默认 relevance 排序）
  const vault = new VaultManager();
  const all: ListItem[] = [];

  for await (const fp of walkMdFiles(vault.root)) {
    const entry = await readMemory(fp);
    if (!entry) continue;

    // scope 过滤
    if (args.project_id) {
      if (entry.meta.scope !== 'project' || entry.meta.project_id !== args.project_id.replace(/[\\/]/g, '_')) {
        continue;
      }
    } else {
      // 无 project_id → 搜全部，但如果 include_shared=false 则排除 shared
      if (!args.include_shared && entry.meta.scope === 'shared') continue;
    }
    // memory_type 过滤
    if (args.memory_type && args.memory_type !== 'all' && entry.meta.memory_type !== args.memory_type) continue;
    // archived 过滤
    if (!(args.include_archived ?? false) && entry.meta.archived) continue;

    all.push(toListItem(entry));
  }

  // 排序
  const reversed = recallSort === 'time_asc';
  all.sort((a, b) => {
    if (recallSort === 'priority') {
      return b.priority - a.priority;
    }
    const ta = new Date(a.updated_at).getTime();
    const tb = new Date(b.updated_at).getTime();
    return reversed ? ta - tb : tb - ta;
  });

  const total = all.length;
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 50;
  const items = all.slice(offset, offset + limit);

  return { items, total };
}

function toListItem(entry: ReturnType<typeof readMemory> & {} | any): ListItem {
  const m = entry.meta;
  const title =
    (entry.body.split('\n').find((l: string) => l.trim().length > 0) ?? '').replace(/^#\s+/, '').slice(0, 60) ||
    '(no title)';

  return {
    memory_id: m.id,
    path: entry.path,
    title,
    memory_type: m.memory_type,
    scope: m.scope,
    priority: m.priority,
    archived: m.archived,
    tags: m.tags ?? [],
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}
