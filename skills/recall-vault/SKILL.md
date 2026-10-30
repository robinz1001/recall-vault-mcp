---
name: recall-vault
description: |
  跨会话、跨项目本地记忆管理系统。session_start 主动载入上下文，session_end 自动保存。
  当你需要记住技术决策、搜索历史记忆、或在新 session 里恢复项目上下文时使用。
  触发词：remember、recall、记忆、回忆、vault、/recall-vault。
scope: global
install_hooks: true
hooks:
  SessionStart:
    - matcher: "startup"
      hooks:
        - type: command
          command: 'node ~/.recall-vault/scripts/hook-session-start.mjs'
          timeout: 30
  Stop:
    - hooks:
        - type: command
          command: 'node ~/.recall-vault/scripts/hook-stop.mjs'
          timeout: 15
  PostToolUse:
    - matcher: "RunCommand|Bash|WriteFile|Write|Edit|Glob|Grep|ReadFile|Read"
      hooks:
        - type: command
          command: 'node ~/.recall-vault/scripts/hook-post-tool.mjs'
          timeout: 15
---

# RecallVault — 流程剧本

你是 recall-vault 的运行时代理。MCP server 是你的存储层，这个 skill 是你的行为剧本。

---

## ⭐ 核心流程（每次 session 必走）

### Step 1: session 开始 → 调 `session_start`

**第一件事，任何其他 tool call 之前。**

```
session_start()
```

返回结构（直接用，不要自己拼装）：

| 字段 | 怎么用 |
|---|---|
| `session_id` | **记下来**，后续所有 remember() 复用这个值 |
| `project_status` | 快速扫一眼有多少 semantic/episodic、多少 priority=3 |
| `recent_high_value` | Top 3 priority=3 的记忆 — 如果当前任务相关，用 recall 深挖 |
| `previous_session` | 上一个 session 的 episodic — 判断和当前任务是否相关 |
| `cross_project_hints` | 提醒你 shared 层有什么通用经验 |
| `suggested_actions` | 照做就行（已经帮你想好了） |
| `compacted_summary` | 直接读这个，约 200-300 token，省一次 recall |

### Step 2: 工作中 → 主动 remember + recall

**不需要 Hook 提醒，自己判断。**

**什么时候 recall：**
- 开始一个新子任务前 → `recall({ query: "<子任务关键词>", compact: true })`
- 用户说"之前"、"上次"、"我们讨论过" → `recall({ query: "<话题>", include_shared: true, compact: true })`
- debug 卡壳 → `recall({ query: "error + 关键报错", compact: true })`

**什么时候 remember（4 个 checklist，任一 YES 就存）：**

```
□ 刚做了一个架构/技术选型决策？
  → remember({ content: "决策是什么 → 为什么 → 替代方案 → 影响", priority: 2 })

□ 刚踩了一个非显而易见的坑并修复了？
  → remember({ content: "现象 → 根因 → 修复", priority: 3, tags: ["踩坑","bug"] })

□ 刚和用户约定了某个需求/方案？
  → remember({ content: "约定原话 + 是谁说的", priority: 2 })

□ 这次 debug/修复花了 10 分钟以上才定位？
  → remember({ content: "问题 → 定位过程 → 修复点 → 为什么之前没发现", priority: 3 })
```

**参数简化**：只传 content 就行。MCP 会自动推断 memory_type、scope、priority、tags。需要覆盖时手动指定：

```typescript
// 最简（推荐）
remember({ content: "决策正文" })

// 需要跨项目复用时
remember({ content: "决策正文", scope: "shared" })

// session_id 复用 session_start 返回的值
remember({ content: "正文", session_id: "sess_20261030" })
```

**不要 remember 的：**
- 单纯的代码提交（没有决策/踩坑）
- 一次性命令、临时路径、碎碎念
- AI 建议但没被采纳的方案

### Step 3: session 结束 → 调 `session_end`

**结束前，最后一件事。**

```typescript
session_end({
  summary: "本次 session 做了什么",
  highlights: [
    "完成了 X 功能",
    "修复了 Y bug（根因是 Z）",
    "决定了用 A 方案而非 B",
  ],
})
```

不传 summary 就只记录最小元数据（但建议传）。

---

## 12 个 MCP 工具速查

| 工具 | 什么时候用 | 常用参数 |
|---|---|---|
| **session_start** | ⭐ **session 开始第一件事** | （无，或 project_id） |
| **session_end** | ⭐ **session 结束前** | summary, highlights |
| remember | 有决策/踩坑/约定要存 | content, session_id, priority? |
| recall | 搜历史记忆 | query, compact: true, include_shared? |
| list_memories | 盘点 vault | project_id, compact: true |
| archive_memory | 软删除（不物理删） | memory_id |
| update_memory | 更新已有记忆 | memory_id, content? |
| delete_memory | **永久删除**（慎重） | memory_id |
| set_memory_priority | 快速调优先级 | memory_id, priority |
| health_check | 诊断 vault 状态 | （无） |
| memory_setup | 初始化 vault（首次） | generate_starters? |
| memory_import | 从 docs/ 导入文档 | from_docs: true |

---

## Hook 兜底（Layer 2）

Hook 是最后防线——如果 Layer 1（你主动 remember）搞定了，hook 不会打扰你。

| Hook | 触发条件 | 打扰级别 |
|---|---|---|
| SessionStart | IDE 自动注入 vault 摘要 | 轻（给你上下文，不是阻断） |
| PostToolUse | 只有 test_pass 才推 hint | 极轻 |
| Stop | **只拦 priority≥3 + 冷却期外** | 极少触发 |

---

## 存储结构

```
~/.recall-vault/                      ← vault 根（全局唯一）
├── projects/
│   ├── <project-id>/
│   │   ├── semantic/*.md           ← 项目长期知识（决策、架构、踩坑）
│   │   └── episodic/*.md           ← 会话摘要（session_end 写入）
└── shared/
    └── semantic/*.md               ← 跨项目通用知识
```

记忆文件 frontmatter：

```yaml
---
memory_id: mem_20261030_001
memory_type: semantic               # semantic | episodic
priority: 3                         # 1=low 2=normal 3=high
tags: [决策, MCP]
agent: trae
session_id: sess_20261030
valid_from: 2026-10-30T10:00:00Z
valid_to: null                      # 被 supersedes 时设
supersedes: null
superseded_by: null
reviewed: false
---
```

---

## 跨 IDE 路径映射

| IDE | Skill | MCP | Hooks |
|---|---|---|---|
| Trae CN | `~/.trae-cn/skills/recall-vault/` | `%APPDATA%\Trae CN\User\mcp.json` | `~/.trae-cn/hooks.json` |
| CodeBuddy | `~/.codebuddy/skills/recall-vault/` | `~/.codebuddy/.mcp.json` | `~/.codebuddy/settings.json` |
| Claude Code | `~/.claude/skills/recall-vault/` | `~/.claude/settings.json` | 同上 |

**一键安装**（所有 IDE）：
```bash
npx -y recall-vault-mcp install-skills
```
