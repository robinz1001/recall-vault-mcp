/**
 * MCP Server 定义 + 工具注册
 *
 * Batch 0: health_check
 * Batch 1: remember / recall / list_memories / archive_memory
 * Batch 2: update_memory / delete_memory / set_memory_priority
 */

import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { logger } from './logger.js';
import { config } from './config.js';
import { VaultManager } from './storage/vault.js';
import { remember } from './tools/remember.js';
import { recall } from './tools/recall.js';
import { listMemories } from './tools/list_memories.js';
import { archiveMemory } from './tools/archive_memory.js';
import { updateMemory } from './tools/update_memory.js';
import { deleteMemory } from './tools/delete_memory.js';
import { setPriority } from './tools/set_memory_priority.js';
import { wrapHandler, getJournalBacklog } from './tools/_wrap.js';
import { memorySetup } from './tools/memory_setup.js';
import { memoryImport } from './tools/memory_import.js';

const TOTAL_TOOLS = 10;

const SERVER_INSTRUCTIONS = `# RecallVault — Memory Usage Guide

You are connected to RecallVault, a local-first memory layer for this project. All memories are Markdown files in the vault root.

## When to SAVE (call remember) — proactive, do not wait for the user to ask

After any of these, call remember immediately:
- **Architecture decisions** — what you chose and why (memory_type: semantic, scope: project or shared)
- **Bugs you fixed** — what caused it, how you solved it (memory_type: semantic, scope: project, priority: 3)
- **Project conventions** — naming, file layout, API style (memory_type: semantic, scope: project)
- **Cross-project knowledge** — patterns reusable elsewhere (memory_type: semantic, scope: shared)
- **Session summary** — at the end of a task or when the conversation is ending (memory_type: episodic, scope: project)

## When to RECALL (call recall) — proactive, do not wait for the user to ask

Call recall with include_shared=true:
- **At the start of a new session** — refresh your context
- **Before starting a related task** — "have we done something like this before?"
- **When debugging** — "what caused similar issues last time?"
- **When the user says "before" or "previously"** — they expect context continuity

## Output rules

- recall results: cite the source path on every fact. Show score + snippet so the user can verify.
- Every returned path is absolute and clickable in the vault.
- Markdown files are the single source of truth — do not delete, only archive.

## Tool inventory

health_check | remember | recall | list_memories | archive_memory | update_memory | delete_memory | set_memory_priority

## Quick params

- default project_id: use the workspace folder basename
- default agent: trae (or claude-code / codex as appropriate)
- default scope: project for episodic, project or shared for semantic
- priority 1=low 2=normal 3=high — use 3 for critical decisions and hard-won fixes
- session_id: use sess_YYYYMMDD format, shared across one conversation
`;

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'recall-vault', version: '0.2.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // === health_check ===
  server.registerTool(
    'health_check',
    {
      description: 'Check RecallVault server health, configuration, and return a suggested context bundle for session start.',
      inputSchema: z.object({}),
    },
    wrapHandler('health_check', async () => {
      const vault = new VaultManager();
      const dirsOk = await directoryHealth(vault);

      // Yggdrasil-style: seed context on session start — last 5 semantic + newest episodic
      let suggested_context: any = null;
      try {
        const recent: any[] = [];
        // 复用 walkMdFiles + readMemory 直接读最新记忆（不用 listMemories，它不带 content）
        const { walkMdFiles } = await import('./tools/_walk.js');
        const { readMemory } = await import('./storage/frontmatter.js');
        const entries: any[] = [];
        for await (const fp of walkMdFiles(vault.root)) {
          const entry = await readMemory(fp);
          if (!entry) continue;
          if (entry.meta.archived) continue;
          entries.push(entry);
        }
        entries.sort((a, b) => new Date(b.meta.updated_at).getTime() - new Date(a.meta.updated_at).getTime());

        const semanticRecent = entries.filter((e) => e.meta.memory_type === 'semantic').slice(0, 5);
        const episodicLatest = entries.find((e) => e.meta.memory_type === 'episodic');

        const bundle: any[] = semanticRecent.map((e) => ({
          id: e.meta.id,
          type: e.meta.memory_type,
          priority: e.meta.priority,
          tags: e.meta.tags ?? [],
          updated_at: e.meta.updated_at,
          path: e.path,
          snippet: (e.body ?? '').slice(0, 200),
        }));
        if (episodicLatest) {
          bundle.push({
            id: episodicLatest.meta.id,
            type: 'episodic',
            session_id: episodicLatest.meta.session_id,
            updated_at: episodicLatest.meta.updated_at,
            path: episodicLatest.path,
            snippet: (episodicLatest.body ?? '').slice(0, 200),
            note: 'Previous session context — consider whether the current task relates.',
          });
        }
        suggested_context = {
          summary: `You have ${semanticRecent.length} recent semantic memories + ${episodicLatest ? 1 : 0} latest episodic. Read the files fully when relevant.`,
          count: bundle.length,
          items: bundle,
        };
      } catch {
        suggested_context = { summary: 'No memories yet — this is a fresh vault.', count: 0, items: [] };
      }

      const info = {
        name: 'recall-vault',
        version: '0.2.0',
        status: 'ok',
        vault_path: config.vaultPath,
        vault_root: vault.root,
        where_are_my_memories: `${vault.root}\\projects\\{project_id}\\episodic\\semantic\\*.md` + `\n${vault.root}\\shared\\semantic\\*.md`,
        log_level: config.logLevel,
        dirs_ok: dirsOk,
        tools_registered: TOTAL_TOOLS,
        tools: [
          'health_check', 'remember', 'recall', 'list_memories', 'archive_memory',
          'update_memory', 'delete_memory', 'set_memory_priority', 'memory_setup', 'memory_import',
        ],
        // Phase 3: Eyes journal backlog
        journal_backlog: getJournalBacklog(),
        suggested_context,
      };

      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
    }),
  );

  // === remember ===
  server.registerTool(
    'remember',
    {
      description:
        'Write memory (session context or permanent knowledge) to RecallVault. Creates new entry or appends to existing.',
      inputSchema: z.object({
        content: z.string().describe('Memory body in Markdown.'),
        memory_type: z.enum(['episodic', 'semantic']).describe('episodic = short-term session context; semantic = permanent knowledge.'),
        scope: z.enum(['project', 'shared']).optional().describe('Default project. episodic always project-only.'),
        project_id: z.string().optional().describe('Required for scope=project. Folder name under projects/.'),
        session_id: z.string().optional().describe('Session/task identifier for grouping episodic entries.'),
        agent: z.enum(['claude-code', 'codex', 'codebuddy', 'trae', 'manual']).optional().describe('Source agent.'),
        tags: z.array(z.string()).optional().describe('Obsidian-compatible tags (no # prefix).'),
        related_files: z.array(z.string()).optional().describe('Vault-root-relative paths to related files.'),
        priority: z.number().min(1).max(3).optional().describe('1=low 2=normal 3=high. Default 2.'),
        append_to: z.string().optional().describe('Existing memory_id to append content to (instead of creating new).'),
        replaces: z.string().optional().describe('Phase 2: Existing memory_id that this new memory supersedes. Old memory valid_to is set to now.'),
      }),
    },
    wrapHandler('remember', async (args) => {
      try {
        const result = await remember({
          ...args,
          priority: args.priority as 1 | 2 | 3 | undefined,
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `remember failed: ${err.message}` }] };
      }
    }),
  );

  // === recall ===
  server.registerTool(
    'recall',
    {
      description: 'Search and retrieve relevant memories. Keyword match + filters + sort + window-size adaptation.',
      inputSchema: z.object({
        query: z.string().describe('Natural language query or keywords.'),
        project_id: z.string().optional().describe('Project to search. If omitted, searches all.'),
        memory_type: z.enum(['episodic', 'semantic', 'all']).optional().describe('Default all.'),
        include_shared: z.boolean().optional().describe('Also search shared/semantic. Default false.'),
        tags: z.array(z.string()).optional().describe('Filter by tags (AND: all must match).'),
        agent: z.enum(['claude-code', 'codex', 'codebuddy', 'trae', 'manual']).optional(),
        session_id: z.string().optional().describe('Filter by session/task.'),
        include_archived: z.boolean().optional().describe('Default false.'),
        include_superseded: z.boolean().optional().describe('Phase 2: Default false. Include memories with valid_to set (superseded facts).'),
        reviewed_only: z.boolean().optional().describe('Only reviewed semantic memories. Default false.'),
        limit: z.number().min(1).max(50).optional().describe('Default 10.'),
        sort_by: z.enum(['relevance', 'priority', 'time_desc', 'time_asc']).optional().describe('Default relevance.'),
        context_window_size: z.number().optional().describe('Current agent context window size (tokens). Auto-adjusts recall granularity.'),
      }),
    },
    wrapHandler('recall', async (args) => {
      try {
        const result = await recall(args);
        return {
          content: [{
            type: 'text',
            text: formatRecallOutput(result),
          }],
        };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `recall failed: ${err.message}` }] };
      }
    }),
  );

  // === list_memories ===
  server.registerTool(
    'list_memories',
    {
      description: 'List memory entries with metadata overview. Useful for inventory and inspection.',
      inputSchema: z.object({
        project_id: z.string().optional(),
        include_shared: z.boolean().optional().describe('Default false.'),
        memory_type: z.enum(['episodic', 'semantic', 'all']).optional().describe('Default all.'),
        include_archived: z.boolean().optional().describe('Default false.'),
        limit: z.number().min(1).max(100).optional().describe('Default 50.'),
        offset: z.number().min(0).optional().describe('Pagination offset. Default 0.'),
        sort_by: z.enum(['time_desc', 'time_asc', 'priority']).optional().describe('Default time_desc.'),
      }),
    },
    wrapHandler('list_memories', async (args) => {
      try {
        const result = await listMemories(args);
        return {
          content: [{
            type: 'text',
            text: formatListOutput(result),
          }],
        };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `list_memories failed: ${err.message}` }] };
      }
    }),
  );

  // === archive_memory ===
  server.registerTool(
    'archive_memory',
    {
      description: 'Archive or unarchive a memory. Archived memories are excluded from recall by default.',
      inputSchema: z.object({
        memory_id: z.string().describe('Memory identifier (frontmatter id field).'),
        scope: z.enum(['project', 'shared']).optional().describe('Disambiguate when same id exists in both scopes.'),
        project_id: z.string().optional().describe('Further disambiguation for scope=project.'),
        unarchive: z.boolean().optional().describe('False=archive, true=unarchive. Default false.'),
      }),
    },
    wrapHandler('archive_memory', async (args) => {
      try {
        const result = await archiveMemory(args);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `archive_memory failed: ${err.message}` }] };
      }
    }),
  );

  // === update_memory ===
  server.registerTool(
    'update_memory',
    {
      description: 'Update memory content or frontmatter fields. Replaces body/tags/related_files or sets reviewed/priority/archived.',
      inputSchema: z.object({
        memory_id: z.string().describe('Memory identifier.'),
        scope: z.enum(['project', 'shared']).optional().describe('Disambiguate when same id exists in both scopes.'),
        project_id: z.string().optional().describe('Further disambiguation for scope=project.'),
        content: z.string().optional().describe('Replace entire body with this Markdown text.'),
        tags: z.array(z.string()).optional().describe('Replace all tags.'),
        related_files: z.array(z.string()).optional().describe('Replace related_files list.'),
        reviewed: z.boolean().optional().describe('Mark as reviewed/unreviewed (semantic memories only).'),
        priority: z.number().min(1).max(3).optional().describe('1=low 2=normal 3=high.'),
        archived: z.boolean().optional().describe('Archive or unarchive.'),
      }),
    },
    wrapHandler('update_memory', async (args) => {
      try {
        const result = await updateMemory({ ...args, priority: args.priority as 1 | 2 | 3 | undefined });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `update_memory failed: ${err.message}` }] };
      }
    }),
  );

  // === delete_memory ===
  server.registerTool(
    'delete_memory',
    {
      description: 'Permanently deletes a memory file. NO RECOVERY — be sure. Use archive_memory if you may need it back.',
      inputSchema: z.object({
        memory_id: z.string().describe('Memory identifier to DELETE.'),
        scope: z.enum(['project', 'shared']).optional().describe('Disambiguate when same id exists in both scopes.'),
        project_id: z.string().optional().describe('Further disambiguation for scope=project.'),
      }),
    },
    wrapHandler('delete_memory', async (args) => {
      try {
        const result = await deleteMemory(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `delete_memory failed: ${err.message}` }] };
      }
    }),
  );

  // === set_memory_priority ===
  server.registerTool(
    'set_memory_priority',
    {
      description: 'Quickly set memory priority (1=low, 2=normal, 3=high). Higher priority memories rank higher in recall.',
      inputSchema: z.object({
        memory_id: z.string().describe('Memory identifier.'),
        priority: z.number().min(1).max(3).describe('1=low 2=normal 3=high.'),
        scope: z.enum(['project', 'shared']).optional().describe('Disambiguate when same id exists in both scopes.'),
        project_id: z.string().optional().describe('Further disambiguation for scope=project.'),
      }),
    },
    wrapHandler('set_memory_priority', async (args) => {
      try {
        const result = await setPriority({ ...args, priority: args.priority as 1 | 2 | 3 });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `set_memory_priority failed: ${err.message}` }] };
      }
    }),
  );

  // === memory_setup ===
  server.registerTool(
    'memory_setup',
    {
      description: 'Phase 3: Initialize vault with fence block and optional starter memories. Safe to call multiple times (idempotent).',
      inputSchema: z.object({
        generate_starters: z.boolean().optional().describe('Generate starter semantic template. Default false.'),
        agent: z.string().optional().describe('Agent identifier for fence block. Default trae.'),
      }),
    },
    wrapHandler('memory_setup', async (args) => {
      try {
        const result = await memorySetup(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `memory_setup failed: ${err.message}` }] };
      }
    }),
  );

  // === memory_import ===
  server.registerTool(
    'memory_import',
    {
      description: 'Phase 4: Import existing project docs (.trae/documents/ and docs/) as semantic memories. Idempotent — skips already-imported files.',
      inputSchema: z.object({
        from_trae_documents: z.boolean().optional().describe('Scan .trae/documents/. Default true.'),
        from_docs: z.boolean().optional().describe('Scan docs/. Default true.'),
        scope: z.enum(['project', 'shared']).optional().describe('Default project.'),
        project_id: z.string().optional().describe('Default vault basename.'),
      }),
    },
    wrapHandler('memory_import', async (args) => {
      try {
        const results = await memoryImport(args);
        const total = results.reduce(
          (acc, r) => ({ scanned: acc.scanned + r.scanned, created: acc.created + r.created, skipped: acc.skipped + r.skipped, failed: acc.failed + r.failed }),
          { scanned: 0, created: 0, skipped: 0, failed: 0 },
        );
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              summary: `Imported ${results.length} driver(s). Total: ${total.scanned} scanned, ${total.created} created, ${total.skipped} skipped, ${total.failed} failed.`,
              drivers: results,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `memory_import failed: ${err.message}` }] };
      }
    }),
  );

  logger.info('MCP server created, vault:', config.vaultPath);
  return server;
}

async function directoryHealth(vault: VaultManager): Promise<boolean> {
  try {
    await vault.ensureStructure();
    return true;
  } catch (err) {
    logger.error('Vault directory health check failed', err);
    return false;
  }
}

function formatRecallOutput(result: Awaited<ReturnType<typeof recall>>): string {
  const payload = {
    summary: `Found ${result.results.length} / ${result.total} memories${result.included_shared ? ' (includes shared layer)' : ''}`,
    results: result.results.map((r, i) => ({
      rank: i + 1,
      title: r.title,
      memory_id: r.memory_id,
      score: r.relevance_score,
      priority: r.priority,
      memory_type: r.memory_type,
      scope: r.scope,
      tags: r.tags,
      reviewed: r.reviewed,
      snippet: r.snippet,
      wikilink: r.wikilink,
      est_tokens: r.est_tokens,
      // Phase 2: 新鲜度信号
      staleness: r.staleness,
      // Phase 2: 双时钟字段
      valid_from: r.valid_from,
      valid_to: r.valid_to,
      supersedes: r.supersedes,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

function formatListOutput(result: Awaited<ReturnType<typeof listMemories>>): string {
  const payload = {
    summary: `Listing ${result.items.length} / ${result.total} memories`,
    items: result.items.map((i) => ({
      memory_id: i.memory_id,
      title: i.title,
      memory_type: i.memory_type,
      scope: i.scope,
      priority: i.priority,
      archived: i.archived,
      tags: i.tags,
      updated_at: i.updated_at.slice(0, 10),
    })),
  };
  return JSON.stringify(payload, null, 2);
}
