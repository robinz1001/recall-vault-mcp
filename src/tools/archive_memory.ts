/**
 * archive_memory — 归档 / 解归档记忆
 */

import { VaultManager } from '../storage/vault.js';
import { readMemory, updateMemoryMeta } from '../storage/frontmatter.js';
import { logger } from '../logger.js';
import { walkMdFiles } from './_walk.js';

export interface ArchiveArgs {
  memory_id: string;
  scope?: 'project' | 'shared';
  project_id?: string;
  unarchive?: boolean;
}

export interface ArchiveResult {
  memory_id: string;
  path: string;
  archived: boolean;
}

export async function archiveMemory(args: ArchiveArgs): Promise<ArchiveResult> {
  const vault = new VaultManager();

  const candidates: string[] = [];
  for await (const fp of walkMdFiles(vault.root)) {
    const entry = await readMemory(fp);
    if (!entry || entry.meta.id !== args.memory_id) continue;

    // scope / project_id 精确定位
    if (args.scope && entry.meta.scope !== args.scope) continue;
    if (args.project_id && entry.meta.project_id !== args.project_id) continue;

    candidates.push(fp);
  }

  if (candidates.length === 0) {
    throw new Error(`Memory not found: ${args.memory_id}${args.scope ? ` scope=${args.scope}` : ''}`);
  }
  if (candidates.length > 1) {
    throw new Error(
      `Ambiguous memory_id: ${args.memory_id} matches ${candidates.length} files. Provide scope/project_id to disambiguate.`,
    );
  }

  const archived = !(args.unarchive ?? false);
  await updateMemoryMeta(candidates[0], { archived });

  logger.info(archived ? 'Archived' : 'Unarchived', args.memory_id, '→', candidates[0]);
  return { memory_id: args.memory_id, path: candidates[0], archived };
}
