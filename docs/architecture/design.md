---
status: draft
created: 2026-10-27
updated: 2026-10-27
---

# RecallVault 架构设计

## 0. 核心定位声明（优先级高于所有技术决策）

### 0.1 存储格式：纯 Markdown + YAML Frontmatter

所有记忆以 **标准 `.md` 文件 + 标准 YAML frontmatter** 存储在文件系统中，这是**唯一的权威数据源**。

**不依赖任何特定应用**——Obsidian 只是第一个被明确验证的人类编辑器。以下工具都能直接管理 RecallVault 的记忆：
- 任何文本编辑器（VS Code、Sublime Text、Vim、Notepad++）
- `cat` / `grep` / `rg` 等命令行工具
- 任何能读写 `.md` 文件的 Obsidian 替代（Typora、Logseq、Notion 导出）
- 直接用文件管理器双击打开

**不使用 Obsidian 特有语法**——不依赖 Dataview 插件、不依赖 Canvas、不依赖 Obsidian 专有 frontmatter 字段。唯一借鉴的是 Obsidian 兼容的通用约定（YAML frontmatter、`[[wikilink]]` 语法、`#tag` 格式）。

### 0.2 界面：零 GUI，零 Web

RecallVault 是**纯 MCP stdio 服务**，没有自己的前端。
- 人类用户编辑记忆 → 用你喜欢的编辑器（Obsidian、VS Code 等）
- AI Agent 读写记忆 → 通过 MCP 协议

如果将来需要管理界面，由外部工具（Obsidian 插件、VS Code 扩展等）来做，RecallVault 不承担这个职责。

### 0.3 数据库：可选缓存，不是必须

一期零数据库依赖（纯 Node.js `fs`）。Batch 3 可选 SQLite FTS5 加速。但**无论是否启用数据库，Markdown 文件始终是权威源**——数据库只是性能加速层，数据可以随时重建。

---

## 1. 技术栈选择

| 维度 | 选择 | 理由 |
|------|------|------|
| 语言 | **TypeScript / Node.js 20+** | MCP SDK 官方以 TS 为主；stdio 场景 Node 冷启动比 Python 快 2-3x；主流编码 Agent（Claude Code/Codex）内置 Node |
| MCP SDK | `@modelcontextprotocol/sdk` | 官方 npm 包，含 stdio Server 基类和 JSON-RPC 处理 |
| Frontmatter 解析 | `gray-matter` + `js-yaml` | 成熟的 Markdown frontmatter 读写库 |
| 文件遍历 | Node.js `fs/promises` + `fast-glob` | MVP 不需要额外数据库依赖 |
| 全文检索 | 一期：`fs` + 简单子串匹配（大小写不敏感）；二期可选 SQLite FTS5 | 单项目 <500 条记忆时 grep 级足够 |
| 语义检索 | 三期可选：`@xenova/transformers` + bge-small | 纯 JS 实现，不需要 Python runtime |

### 依赖策略

- MVP（Batch 0-1）**零 native 依赖**：TypeScript 编译、纯 Node.js fs 操作
- Batch 2+ 才引入可选加速库（SQLite、embeddings）
- 所有可选依赖通过环境变量开关（`COA_USE_FTS5`、`COA_USE_EMBEDDING`）

---

## 2. Vault 目录结构

> 注：下文的「知识库根目录」是你选的任意文件夹路径——可以是你的 Obsidian vault，也可以是任何空目录。RecallVault 直接在此目录读写，不触碰其他文件。

### 2.1 完整结构

```
.recall-vault/               ← COA_VAULT_PATH 或默认 ~/.recall-vault/
├── README.md                   # MCP 首次创建，目录说明（自动生成）
├── projects/
│   ├── {project_id}/
│   │   ├── episodic/           # 短期会话上下文
│   │   │   ├── mem_20261027_001.md
│   │   │   └── ...
│   │   └── semantic/           # 项目专属长期知识
│   │       ├── mem_20261027_005.md
│   │       └── ...
│   └── {another_project}/
├── shared/
│   └── semantic/               # 跨项目可复用知识
│       ├── mem_20261025_002.md
│       └── ...
└── _logs/                       # 运行时日志（.gitignore 建议）
    └── server_{date}.log
```

### 2.2 关键约束

| 规则 | 说明 |
|------|------|
| MCP 在 vaultPath 根目录读写 | vaultPath 就是 RecallVault 根目录 |
| 目录自动创建 | MCP 首次被使用时自动创建所有必要目录 |
| 文件名安全 | `{id}.md` —— id 纯 ASCII，不含空格和特殊字符 |
| 并发安全 | 文件级读写，Node.js 单线程事件循环天然避免写入冲突 |

---

## 3. Frontmatter Schema

### 3.1 完整字段

```yaml
---
# === 系统字段（MCP 自动管理，人不应手动修改）===
id: mem_20261027_001                    # 全局唯一：mem_YYYYMMDD_序号
scope: project                          # project | shared
project_id: my-project                  # scope=project 时必填；scope=shared 时为 "shared"
memory_type: episodic                   # episodic | semantic
created_at: 2026-10-27T10:30:00Z        # ISO 8601
updated_at: 2026-10-27T10:45:00Z        # ISO 8601
archived: false                         # 默认 false
priority: 2                             # 1=低 2=正常 3=高；默认 2

# === 来源元数据 ===
agent: claude-code                      # claude-code | codex | codebuddy | trae | manual
session_id: sess_abc123                 # episodic 专属：跨请求追踪会话
reviewed: false                         # semantic 专属：人工审核标记

# === 检索辅助 ===
tags: [bug, build, vite]                # YAML 数组格式（Obsidian 自动识别为 tag）
related_files:                          # 关联代码文件（相对路径，以 vault 为根）
  - src/scripts/build.ts
  - package.json
---

# 记忆标题（可选，不写则自动用前 30 字符生成）

正文内容...（支持 Markdown，Obsidian 双链 [[xxx]] 有效）
```

### 3.2 字段分级

| 分级 | 字段 | 谁管理 | 说明 |
|------|------|--------|------|
| **系统** | id, scope, project_id, memory_type, created_at, updated_at, archived | MCP 自动 | 人不应该手动改 |
| **来源** | agent, session_id, reviewed | Agent 写入时提交，人可改 | reviewed 字段需要人工确认 |
| **检索** | priority, tags, related_files | Agent 或人都可以 | tags 格式必须是 YAML 数组 |

### 3.3 memory_type 语义差异

| 维度 | episodic | semantic |
|------|----------|----------|
| 用途 | 会话上下文、任务进展、决策记录 | 项目规范、架构说明、踩坑总结 |
| scope 限制 | 只能 project | project 或 shared |
| 生命周期 | 任务结束后可归档/作废 | 长期沉淀 |
| 是否需要 reviewed | 否 | 可选标记 |
| 典型内容 | "今天改了 user-api 的分页逻辑" | "Vite 5 的 legacy 插件兼容方案" |

---

## 4. MCP 工具签名

### 4.1 MVP 工具（Batch 1）

#### remember — 写入记忆

```typescript
{
  name: "remember",
  description: "Write context or knowledge to the RecallVault memory vault. Creates a new memory entry or appends to an existing one.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description: "Project identifier (folder name under projects/). Required for scope=project.",
      },
      content: {
        type: "string",
        description: "Memory body in Markdown. Supports Obsidian wikilinks.",
      },
      memory_type: {
        type: "string",
        enum: ["episodic", "semantic"],
        description: "episodic = short-term session context; semantic = permanent knowledge.",
      },
      scope: {
        type: "string",
        enum: ["project", "shared"],
        description: "project = project-specific; shared = reusable across projects. Default: project. episodic always uses project.",
      },
      session_id: {
        type: "string",
        description: "Session/task identifier for episodic memories. Used to group entries from one task.",
      },
      agent: {
        type: "string",
        enum: ["claude-code", "codex", "codebuddy", "trae", "manual"],
        description: "Source agent. Default: determined by MCP client name.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Obsidian-compatible tags (without # prefix).",
      },
      related_files: {
        type: "array",
        items: { type: "string" },
        description: "Relative paths to related code files (vault-root-relative).",
      },
      priority: {
        type: "number",
        enum: [1, 2, 3],
        description: "Recall priority: 1=low 2=normal 3=high. Default: 2.",
      },
      append_to: {
        type: "string",
        description: "Existing memory_id to append content to (instead of creating new).",
      },
    },
    required: ["content", "memory_type"],
  },
}
```

**返回**：
```json
{
  "memory_id": "mem_20261027_001",
  "path": "projects/my-project/episodic/mem_20261027_001.md",
  "created": true
}
```

#### recall — 检索记忆

```typescript
{
  name: "recall",
  description: "Search and retrieve relevant memories from RecallVault. Returns memory fragments with source paths and Obsidian wikilinks.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description: "Project to search. If omitted, searches shared + all semantic memories.",
      },
      query: {
        type: "string",
        description: "Natural language query or keywords.",
      },
      memory_type: {
        type: "string",
        enum: ["episodic", "semantic", "all"],
        description: "Filter by memory type. Default: all.",
      },
      include_shared: {
        type: "boolean",
        description: "Also search shared/semantic/. Default: false.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Filter by tags (AND logic — all must match).",
      },
      agent: {
        type: "string",
        description: "Filter by source agent.",
      },
      session_id: {
        type: "string",
        description: "Filter by session/task (task-level recall).",
      },
      include_archived: {
        type: "boolean",
        description: "Include archived memories. Default: false.",
      },
      reviewed_only: {
        type: "boolean",
        description: "Only return reviewed semantic memories. Default: false.",
      },
      limit: {
        type: "number",
        description: "Max results. Default: 10, max: 50.",
      },
      sort_by: {
        type: "string",
        enum: ["relevance", "priority", "time_desc", "time_asc"],
        description: "Sort strategy. Default: relevance.",
      },
      // === 窗口适配（独有特性）===
      context_window_size: {
        type: "number",
        description: "Current agent context window size (tokens). Used to auto-adjust recall granularity.",
      },
    },
    required: ["query"],
  },
}
```

**返回**：
```json
{
  "results": [
    {
      "memory_id": "mem_20261027_001",
      "path": "projects/my-project/semantic/mem_20261027_001.md",
      "wikilink": "[[projects/my-project/semantic/mem_20261027_001]]",
      "title": "Vite 5 legacy 插件兼容方案",
      "snippet": "前 200 字符摘要...",
      "est_tokens": 156,
      "priority": 3,
      "memory_type": "semantic",
      "scope": "project",
      "tags": ["vite", "build"],
      "created_at": "2026-10-27T10:30:00Z",
      "relevance_score": 0.87
    }
  ],
  "total": 23,
  "included_shared": false
}
```

#### list_memories — 列出记忆概览

```typescript
{
  name: "list_memories",
  description: "List memory entries with metadata overview. Useful for inventory and inspection.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      include_shared: { type: "boolean", default: false },
      memory_type: { type: "string", enum: ["episodic", "semantic", "all"] },
      include_archived: { type: "boolean", default: false },
      limit: { type: "number", default: 50 },
      offset: { type: "number", default: 0 },
      sort_by: {
        type: "string",
        enum: ["time_desc", "time_asc", "priority"],
        default: "time_desc",
      },
    },
  },
}
```

#### archive_memory — 归档记忆

```typescript
{
  name: "archive_memory",
  description: "Archive a memory entry. Archived memories are excluded from recall by default.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: { type: "string", description: "Memory identifier (frontmatter id field)." },
      unarchive: { type: "boolean", default: false },
    },
    required: ["memory_id"],
  },
}
```

### 4.2 Batch 2 工具

#### update_memory — 更新记忆

```typescript
{
  name: "update_memory",
  description: "Update content or metadata of an existing memory.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: { type: "string", required: true },
      content: { type: "string", description: "Replace full body with new content." },
      append_content: { type: "string", description: "Append block to end (use OR not AND with content)." },
      tags: { type: "array", items: { type: "string" }, description: "Replace tags array." },
      priority: { type: "number", enum: [1, 2, 3] },
      reviewed: { type: "boolean", description: "Mark semantic memory as human-reviewed." },
    },
    required: ["memory_id"],
  },
}
```

#### delete_memory — 删除记忆

```typescript
{
  name: "delete_memory",
  description: "Permanently delete a memory file. Moves to _trash/ first for recovery.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: { type: "string", required: true },
      force: { type: "boolean", default: false, description: "Skip trash, delete immediately." },
    },
    required: ["memory_id"],
  },
}
```

#### set_memory_priority — 调整优先级

```typescript
{
  name: "set_memory_priority",
  description: "Adjust recall priority for a memory entry.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: { type: "string", required: true },
      priority: { type: "number", enum: [1, 2, 3], required: true },
    },
    required: ["memory_id", "priority"],
  },
}
```

---

## 5. 检索策略分层

### 5.1 L1: 关键词匹配（一期实现）

```
recall(query) → 多线程并行扫描当前项目目录 + 可选 shared 目录
│
├─ 正文子串匹配（大小写不敏感）
├─ frontmatter tags 字段匹配
├─ frontmatter title（如果有）匹配
│
└─ 每条匹配记录：匹配命中位置 + 匹配长度 → 初步 relevance_score
```

### 5.2 L2: 过滤器叠加（一期实现）

```
L1 结果 → 应用过滤器：
├─ memory_type / scope / agent / session_id
├─ tags AND 逻辑（所有标签必须匹配）
├─ archived=true 排除（除非 include_archived=true）
├─ reviewed_only=true 排除未审核的 semantic
│
└─ 过滤后的候选集
```

### 5.3 L3: 排序 + 窗口适配（一期实现）

```
L2 结果 → 排序（按 sort_by）：
├─ relevance: L1 匹配分 × priority 权重 × freshness 权重
├─ priority: priority desc → updated_at desc
├─ time_desc / time_asc: updated_at
│
└─ context_window_size 适配：
   ├─ 窗口大（>64k）→ 拉 priority 1/2/3 + episodic + semantic 完整 snippet
   ├─ 窗口中（32k-64k）→ 排除 priority 1，snippet 缩短到 150 字符
   └─ 窗口小（<32k）→ 只拉 priority 2/3 的 semantic，snippet 缩到 80 字符
```

### 5.4 L4: 可选增强（三期）

- SQLite FTS5 索引加速关键词匹配
- `@xenova/transformers` + bge-small 本地 embedding
- 语义相似度融合到 relevance 排序

---

## 6. 日志方案（stdio 红线）

### 6.1 分层设计

```typescript
// 四个日志级别
enum LogLevel { DEBUG = 0, INFO = 1, WARN = 2, ERROR = 3 }

// 输出目标
enum LogTarget { STDERR, FILE }
```

**规则**：
1. MCP JSON-RPC 消息 → 严格走 `process.stdout`（官方 SDK 处理）
2. 应用日志 → `process.stderr.write()`（不影响协议）
3. 详细日志 → `{vault}/_logs/server_{date}.log`
4. **绝对禁止 `console.log()`** —— 会炸 MCP
5. DEBUG 级别默认关闭，通过 `COA_LOG_LEVEL=debug` 开启

### 6.2 日志内容

```
# stderr（实时，适合终端调试）
[2026-10-27T10:30:00Z] [INFO]  Loading vault: ~/Documents/Obsidian Vault
[2026-10-27T10:30:00Z] [INFO]  Remember: project=my-project, type=semantic, id=mem_20261027_005
[2026-10-27T10:30:01Z] [WARN]  Recall: 0 results for query="vite plugin" — consider include_shared

# 文件日志（完整，含 stack trace）
[2026-10-27T10:30:00Z] [DEBUG] File scanned: shared/semantic/mem_20261025_002.md (frontmatter parsed: 15 fields)
[2026-10-27T10:30:00Z] [DEBUG] Match: score=0.87, positions=[120, 340, 580]
```

---

## 7. 项目配置与启动

### 7.1 环境变量

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `COA_VAULT_PATH` | ✅ | — | Obsidian vault 绝对路径 |
| `COA_LOG_LEVEL` | ❌ | `info` | debug / info / warn / error |
| `COA_USE_FTS5` | ❌ | `false` | 二期：启用 SQLite FTS5 索引 |
| `COA_USE_EMBEDDING` | ❌ | `false` | 三期：启用本地 embedding |

### 7.2 MCP 客户端配置

```jsonc
// Claude Code / Codex / CodeBuddy / TRAE 通用
{
  "mcpServers": {
    "recall-vault": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "COA_VAULT_PATH": "/path/to/your/Obsidian/vault",
        "COA_LOG_LEVEL": "info"
      }
    }
  }
}
```

### 7.3 目录自动创建

MCP 首次启动时，自动执行：

```typescript
// 确保这些目录存在
await fs.mkdir(vault, { recursive: true })          // vaultPath 本身
await fs.mkdir(`${vault}/projects/`, { recursive: true })
await fs.mkdir(`${vault}/shared/semantic/`, { recursive: true })
await fs.mkdir(`${vault}/_logs/`, { recursive: true })

// 生成 README.md（如果不存在）
const readmePath = `${vault}/README.md`
if (!(await fs.pathExists(readmePath))) {
  await fs.writeFile(readmePath, AUTO_GENERATED_README)
}
```

---

## 8. 仓库结构

```
recall-vault/
├── docs/
│   ├── README.md
│   ├── research/
│   │   └── competitive-analysis.md
│   ├── requirements/
│   │   └── pain-points-analysis.md
│   ├── architecture/
│   │   ├── design.md                   ← 本文件
│   │   └── isolation-strategy.md
│   └── process/
│       └── working-method.md
├── src/
│   ├── index.ts                  # 入口：启动 MCP Server
│   ├── server.ts                 # MCP Server 定义 + 工具注册
│   ├── tools/                    # MCP 工具实现
│   │   ├── remember.ts
│   │   ├── recall.ts
│   │   ├── list_memories.ts
│   │   ├── archive_memory.ts
│   │   ├── update_memory.ts
│   │   ├── delete_memory.ts
│   │   └── set_memory_priority.ts
│   ├── storage/                  # 文件存储层
│   │   ├── vault.ts              # Vault 目录管理
│   │   ├── frontmatter.ts        # frontmatter 读写
│   │   ├── filename.ts           # memory_id 生成
│   │   └── index.ts              # 二期可选索引层
│   ├── search/                   # 检索逻辑
│   │   ├── keyword.ts            # L1 关键词匹配
│   │   ├── filter.ts             # L2 过滤器
│   │   ├── sort.ts               # L3 排序 + 窗口适配
│   │   └── semantic.ts           # 三期可选
│   ├── types.ts                  # 共享类型定义
│   ├── logger.ts                 # 日志系统
│   └── config.ts                 # 环境变量配置
├── test-fixtures/                # 测试用 vault 文件
├── package.json
├── tsconfig.json
└── README.md                     # 实现后写
```
