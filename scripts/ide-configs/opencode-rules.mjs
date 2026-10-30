/**
 * OpenCode AGENTS.md 规则内容（全局级 ~/.config/opencode/AGENTS.md）
 *
 * OpenCode 没有 hook 机制，用 AGENTS.md 作为每次 prompt 的系统级规则注入。
 * Sentinel 包装确保幂等：多次 install 不会重复追加。
 */

const SENTINEL_START = '<!-- recall-vault:start -->';
const SENTINEL_END = '<!-- recall-vault:end -->';

const RULES_CONTENT = `${SENTINEL_START}
# RecallVault Memory Rules

You have access to RecallVault memory via MCP tools: health_check, remember, recall, list_memories, archive_memory, update_memory, delete_memory, set_memory_priority, memory_setup, memory_import.

## SAVE (PROACTIVE — do not wait for me to ask)
Call remember immediately after:
- Architecture decisions (memory_type: semantic, scope: project or shared)
- Bugs fixed (priority: 3, tags: ['regression'])
- Project conventions (scope: project)
- Cross-project patterns (scope: shared)
- Session summary (memory_type: episodic, before conversation ends)

## RECALL (PROACTIVE)
Call recall with include_shared=true:
- At session start — refresh prior context
- Before starting related tasks — "have we done this before?"
- When debugging — "what caused this last time?"
- When I reference prior work — "before", "previously", "we discussed"

## ⚡ Token-saving
Use compact mode by default: recall({ query: "setup", compact: true }) — saves ~58% tokens.

## Params
- project_id: workspace folder basename
- agent: 'opencode'
- scope: 'project' (project-only) or 'shared' (cross-project reusable)
${SENTINEL_END}`;

export function generateOpenCodeRules() {
  return RULES_CONTENT;
}

export const opencodeSentinel = { start: SENTINEL_START, end: SENTINEL_END };
