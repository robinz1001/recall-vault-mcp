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
import { sessionStart } from './tools/session_start.js';
import { sessionEnd } from './tools/session_end.js';
import { organizeMemories } from './tools/organize_memories.js';

const TOTAL_TOOLS = 13;

const SERVER_INSTRUCTIONS = `# RecallVault — Memory Usage Guide

## ⭐ SESSION START/END (MUST USE THESE)

These are your PRIMARY entry points. Every session:

1. **Call \`session_start\` FIRST** — before any other tool call. It returns:
   - project_status: vault stats
   - recent_high_value: priority=3 top memories (compact)
   - previous_session: last episodic summary
   - suggested_actions: what to do next
   - session_id: reuse this for all remember() calls this session

2. **Call \`session_end\` LAST** — before ending the conversation. It saves:
   - A summary of what happened (episodic memory)
   - Your highlights (decisions, fixes, discoveries)
   - Auto-generated session_id

## When to SAVE (call remember) — proactive

After any of these, call remember immediately:
- **Architecture decisions** — what you chose and why (memory_type: semantic, scope: project or shared)
- **Bugs you fixed** — what caused it, how you solved it (memory_type: semantic, scope: project, priority: 3)
- **Project conventions** — naming, file layout, API style (memory_type: semantic, scope: project)
- **Cross-project knowledge** — patterns reusable elsewhere (memory_type: semantic, scope: shared)

## When to RECALL (call recall) — proactive

Call recall with include_shared=true:
- Before starting a related task — "have we done something like this before?"
- When debugging — "what caused similar issues last time?"
- When the user says "before" or "previously" — they expect context continuity

## ⚡ TOKEN-SAVING PATTERN

recall() has compact mode that saves ~80% tokens. Use it as default:
  recall({ query: "bug fix", compact: true })

## Tool inventory (13 tools)

session_start | session_end | health_check | remember | recall | list_memories | archive_memory | update_memory | delete_memory | set_memory_priority | memory_setup | memory_import | organize_memories

## Quick params

- default project_id: workspace folder basename
- default session_id: from session_start (reuse it!)
- priority 1=low 2=normal 3=high — use 3 for critical decisions and hard-won fixes
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

      // Phase B: Yggdrasil-style seed context + 300 token 压缩摘要
      let suggested_context: any = null;
      try {
        const { walkMdFiles } = await import('./tools/_walk.js');
        const { readMemory } = await import('./storage/frontmatter.js');
        const entries: any[] = [];
        for await (const fp of walkMdFiles(vault.root)) {
          const entry = await readMemory(fp);
          if (!entry) continue;
          if (entry.meta.archived) continue;
          if (entry.meta.valid_to) continue; // superseded 不进摘要
          entries.push(entry);
        }
        // priority DESC + updated_at DESC
        entries.sort((a, b) => {
          const pDiff = (b.meta.priority ?? 2) - (a.meta.priority ?? 2);
          if (pDiff !== 0) return pDiff;
          return new Date(b.meta.updated_at).getTime() - new Date(a.meta.updated_at).getTime();
        });

        const allSemantic = entries.filter((e) => e.meta.memory_type === 'semantic');
        const allEpisodic = entries.filter((e) => e.meta.memory_type === 'episodic');
        const highValueCount = allSemantic.filter((e) => e.meta.priority === 3).length;

        const topSemantic = allSemantic.slice(0, 3);
        const latestEpisodic = allEpisodic[0] ?? null;

        // Vault token 总预算估算（agent 用来判断要不要先过滤再 recall）
        const vaultTokenBudget = {
          total: entries.reduce((s, e) => s + estimateTokens(e.body), 0),
          semantic: allSemantic.reduce((s, e) => s + estimateTokens(e.body), 0),
          episodic: allEpisodic.reduce((s, e) => s + estimateTokens(e.body), 0),
          high_value: allSemantic.filter((e) => e.meta.priority === 3).reduce((s, e) => s + estimateTokens(e.body), 0),
        };

        // 压缩摘要文本（~300 token）
        const compactedLines: string[] = [];
        for (const e of topSemantic) {
          const title = extractTitle(e.body);
          const snippet = cleanBodySnippet(e.body, 120);
          const star = e.meta.priority === 3 ? ' ⚠️' : '';
          const age = ageLabel(e.meta.updated_at);
          const tags = (e.meta.tags ?? []).slice(0, 3).map((t: string) => `#${t}`).join(' ');
          compactedLines.push(`📌 ${title}${star} (${age})${tags ? ' ' + tags : ''}`);
          compactedLines.push(`   ${snippet}`);
        }
        if (latestEpisodic) {
          const snippet = cleanBodySnippet(latestEpisodic.body, 100);
          const age = ageLabel(latestEpisodic.meta.updated_at);
          compactedLines.push(`📝 上session ${age}: ${snippet}`);
        }
        const compacted_summary = compactedLines.join('\n');

        // 结构化 items（保留完整元数据供 agent 深挖）
        const bundle: any[] = topSemantic.map((e) => ({
          id: e.meta.id,
          type: e.meta.memory_type,
          priority: e.meta.priority,
          tags: e.meta.tags ?? [],
          updated_at: e.meta.updated_at,
          path: e.path,
          wikilink: formatWikilink(e),
        }));
        if (latestEpisodic) {
          bundle.push({
            id: latestEpisodic.meta.id,
            type: 'episodic',
            session_id: latestEpisodic.meta.session_id,
            updated_at: latestEpisodic.meta.updated_at,
            path: latestEpisodic.path,
            wikilink: formatWikilink(latestEpisodic),
            note: 'Previous session context — consider whether the current task relates.',
          });
        }

        suggested_context = {
          // 给 agent 直接用的压缩摘要（省一次 recall tool call）
          compacted_summary,
          est_tokens: estimateTokens(compacted_summary),
          // Vault token 总预算
          vault_token_budget: vaultTokenBudget,
          // 结构化元数据
          summary: `Vault: ${allSemantic.length} semantic + ${allEpisodic.length} episodic${highValueCount > 0 ? ` · ${highValueCount} high-value (priority=3)` : ''}`,
          total_semantic: allSemantic.length,
          total_episodic: allEpisodic.length,
          high_value_count: highValueCount,
          count: bundle.length,
          items: bundle,
        };
      } catch {
        suggested_context = {
          compacted_summary: null,
          est_tokens: 0,
          summary: 'No memories yet — this is a fresh vault.',
          total_semantic: 0,
          total_episodic: 0,
          high_value_count: 0,
          count: 0,
          items: [],
        };
      }

      const info = {
        name: 'recall-vault',
        version: '0.4.1',
        status: dirsOk ? 'ok' : 'degraded',
        vault_ready: dirsOk,
        vault_path: config.vaultPath,
        vault_root: vault.root,
        dirs_ok: dirsOk,
        tools_registered: TOTAL_TOOLS,
        tools: [
          'session_start', 'session_end', 'organize_memories',
          'health_check', 'remember', 'recall', 'list_memories', 'archive_memory',
          'update_memory', 'delete_memory', 'set_memory_priority', 'memory_setup', 'memory_import',
        ],
        // 降级提示：如果 vault 有问题，agent 应该怎么处理
        degraded: !dirsOk ? {
          reason: 'vault 目录结构不完整或不可写',
          action: '提示用户运行 memory_setup() 初始化，或检查 vault_path 环境变量',
        } : null,
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
        'Write memory to RecallVault. 参数极简：只传 content 即可，memory_type/scope/priority/tags 自动推断。手动覆盖时显式传参。',
      inputSchema: z.object({
        content: z.string().describe('记忆正文（唯一必填）。自动从中推断 type/scope/priority/tags。'),
        memory_type: z.enum(['episodic', 'semantic']).optional().describe('覆盖推断。默认 semantic（含"session/会话/本次"则 episodic）'),
        scope: z.enum(['project', 'shared']).optional().describe('覆盖推断。默认 project（含"通用/可复用/跨项目"则 shared）'),
        project_id: z.string().optional().describe('覆盖推断。默认从 cwd basename 推断'),
        session_id: z.string().optional().describe('session 分组 id（复用 session_start 返回的值）'),
        agent: z.enum(['claude-code', 'codex', 'codebuddy', 'trae', 'manual']).optional().describe('来源 agent'),
        tags: z.array(z.string()).optional().describe('覆盖/追加自动提取的 tags'),
        related_files: z.array(z.string()).optional().describe('vault-root-relative 相关文件'),
        priority: z.number().min(1).max(3).optional().describe('覆盖推断。默认 2（含"坑/错误/bug/debug"则自动 3）'),
        append_to: z.string().optional().describe('追加到已有 memory_id（而非新建）'),
        replaces: z.string().optional().describe('取代旧记忆：旧 memory_id 的 valid_to 自动设为 now'),
      }),
    },
    wrapHandler('remember', async (args) => {
      try {
        const result = await remember({
          ...args,
          priority: args.priority as 1 | 2 | 3 | undefined,
        });
        const compact: any = { ok: true, memory_id: result.memory_id, created: result.created, path: result.path };
        if (result.inferred) compact.inferred = result.inferred;
        if ((result as any).superseded) compact.superseded = (result as any).superseded;
        return { content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }] };
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
        compact: z.boolean().optional().describe('Phase MCP: Minimal output. Returns only id/score/wikilink, no snippets. Saves ~80% tokens. Agent reads full Markdown files directly.'),
      }),
    },
    wrapHandler('recall', async (args) => {
      try {
        const result = await recall(args);
        return {
          content: [{
            type: 'text',
            text: formatRecallOutput(result, args.compact ?? false),
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
        compact: z.boolean().optional().describe('Phase MCP: Minimal output. Only id + type + priority, no extra fields.'),
      }),
    },
    wrapHandler('list_memories', async (args) => {
      try {
        const result = await listMemories(args);
        return {
          content: [{
            type: 'text',
            text: formatListOutput(result, args.compact ?? false),
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
        const compact = { ok: true, memory_id: result.memory_id, archived: result.archived };
        return { content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }] };
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
        const compact: any = { ok: true, memory_id: result.memory_id };
        if ((result as any).updated) compact.updated = (result as any).updated;
        return { content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }] };
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
        const compact = { ok: true, memory_id: result.memory_id, deleted: true };
        return { content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }] };
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
        const compact = { ok: true, memory_id: result.memory_id, priority: result.priority };
        return { content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }] };
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

  // === session_start ===
  server.registerTool(
    'session_start',
    {
      description:
        'Session 启动入口（inhale）—— 新 session 的**第一件事**就调这个。一次返回 vault 状态、高价值记忆 Top 3、上一个 session 摘要、suggested_actions。返回的 session_id 后续 remember 复用。',
      inputSchema: z.object({
        project_id: z.string().optional().describe('不传则自动从 cwd 推断'),
      }),
    },
    wrapHandler('session_start', async (args) => {
      try {
        const result = await sessionStart(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `session_start failed: ${err.message}` }] };
      }
    }),
  );

  // === session_end ===
  server.registerTool(
    'session_end',
    {
      description:
        'Session 结束入口（exhale）—— 结束前调这个。自动生成 episodic 记忆，保存会话摘要和 highlights。',
      inputSchema: z.object({
        summary: z.string().optional().describe('本次 session 的总结：做了什么、有什么产出'),
        highlights: z.array(z.string()).optional().describe('重要产出：决策、修复、新发现等'),
        session_id: z.string().optional().describe('覆盖 session_id（默认自动生成）'),
        project_id: z.string().optional().describe('覆盖 project_id（默认自动推断）'),
      }),
    },
    wrapHandler('session_end', async (args) => {
      try {
        const result = await sessionEnd(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `session_end failed: ${err.message}` }] };
      }
    }),
  );

  // === organize_memories ===
  server.registerTool(
    'organize_memories',
    {
      description:
        '自动整理 vault：补 tags、promote stale priority=3 记忆、去重（同 project + 同 type + 内容高度相似）。mode=light 只做建议不动数据（默认），mode=deep 会设 valid_to 关闭旧记忆。',
      inputSchema: z.object({
        mode: z.enum(['light', 'deep']).optional().describe('light=只建议不改数据（默认），deep=执行 dedup/promote/tags 补齐'),
        project_id: z.string().optional().describe('限定某个项目，不传则全局'),
      }),
    },
    wrapHandler('organize_memories', async (args) => {
      try {
        const result = await organizeMemories(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `organize_memories failed: ${err.message}` }] };
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

function formatRecallOutput(result: Awaited<ReturnType<typeof recall>>, compact = false): string {
  const payload: any = {
    summary: `Found ${result.results.length} / ${result.total} memories${result.included_shared ? ' (includes shared layer)' : ''}`,
    total: result.total,
    result_count: result.results.length,
    included_shared: result.included_shared,
  };

  if (compact) {
    // 极简模式：agent 只需要定位到哪条记忆，内容自己读 Markdown 文件
    payload.compact = true;
    payload.results = result.results.map((r, i) => ({
      rank: i + 1,
      memory_id: r.memory_id,
      title: r.title.slice(0, 50),
      score: Number(r.relevance_score.toFixed(3)),
      wikilink: r.wikilink,
      priority: r.priority,
      type: r.memory_type,
      scope: r.scope,
      est_tokens: r.est_tokens,
    }));
  } else {
    payload.results = result.results.map((r, i) => ({
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
      staleness: r.staleness,
      valid_from: r.valid_from,
      valid_to: r.valid_to,
      supersedes: r.supersedes,
    }));
  }

  // Phase D: token 预算提示
  if (result.token_budget_hint) {
    payload.token_budget_hint = result.token_budget_hint;
    if (result.token_budget_hint.window_usage_pct && result.token_budget_hint.window_usage_pct > 20) {
      payload.summary += ` ⚠️ Recall results alone use ${result.token_budget_hint.window_usage_pct}% of your context window — consider more specific queries.`;
    }
  }
  return JSON.stringify(payload, null, 2);
}

function formatListOutput(result: Awaited<ReturnType<typeof listMemories>>, compact = false): string {
  const payload: any = {
    summary: `Listing ${result.items.length} / ${result.total} memories`,
  };
  if (compact) {
    payload.compact = true;
    payload.items = result.items.map((i) => ({
      memory_id: i.memory_id,
      type: i.memory_type,
      priority: i.priority,
    }));
  } else {
    payload.items = result.items.map((i) => ({
      memory_id: i.memory_id,
      title: i.title,
      memory_type: i.memory_type,
      scope: i.scope,
      priority: i.priority,
      archived: i.archived,
      tags: i.tags,
      updated_at: i.updated_at.slice(0, 10),
    }));
  }
  return JSON.stringify(payload, null, 2);
}

// ==================== health_check 辅助函数 ====================

function extractTitle(body: string): string {
  const firstLine = body.split('\n').find((l) => l.trim().length > 0) ?? '';
  const h1 = firstLine.match(/^#\s+(.+)/);
  if (h1) return h1[1].trim();
  return firstLine.slice(0, 60).trim();
}

/** 跳过 markdown 标题行的 body snippet */
function cleanBodySnippet(body: string, maxLen: number): string {
  const lines = body.split('\n').filter((l) => l.trim().length > 0);
  const contentStart = lines.find((l) => !/^#+\s+/.test(l)) ?? lines[0] ?? '';
  const cleaned = contentStart.replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '…' : cleaned;
}

function ageLabel(isoStr: string): string {
  const ageMs = Date.now() - new Date(isoStr).getTime();
  const ageMin = ageMs / 60000;
  if (ageMin < 1) return '刚刚';
  if (ageMin < 60) return `${Math.round(ageMin)}分钟前`;
  const ageH = ageMin / 60;
  if (ageH < 24) return `${Math.round(ageH)}小时前`;
  const ageD = ageH / 24;
  if (ageD < 30) return `${Math.round(ageD)}天前`;
  return `${Math.round(ageD / 30)}月前`;
}

function estimateTokens(text: string): number {
  let ascii = 0, cjk = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++; else cjk++;
  }
  return Math.ceil(ascii / 4 + cjk / 3);
}

function formatWikilink(e: any): string {
  const scope = e.meta.scope;
  if (scope === 'shared') {
    return `[[shared/semantic/${e.meta.id}]]`;
  }
  const pid = e.meta.project_id ?? '';
  return `[[projects/${pid}/${e.meta.memory_type}/${e.meta.id}]]`;
}
