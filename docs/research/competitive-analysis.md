---
status: confirmed
created: 2026-10-27
updated: 2026-10-27
---

# 竞品调研报告

## 1. 调研概况

**目的**：确认 RecallVault 要解决的问题是否已有成熟方案、市场上存在哪些差异化空位、竞品的定位和能力边界。

**范围**：GitHub 跨 Agent 共享记忆类 MCP 服务器 + Obsidian 集成记忆方案。

**方法**：6 轮并行 Web 搜索（2026-10-27）→ 10+ 候选项目筛选 → 5 个核心竞品完整 README 深读 + API 文档 + 二次验证。

**时效性标注**：所有信息基于 2026-10-27 可获取的公开仓库状态。

## 2. 竞品全景

按存储层和定位分为三类：

### A 类：跨 Agent 共享记忆 MCP（直接竞品）

| 项目 | 定位 | 存储层 | 跨 Agent | MCP stdio | Obsidian 兼容 | 写能力 | 许可证 | 成熟度 |
|------|------|--------|----------|-----------|--------------|--------|--------|--------|
| **enquire-mcp** | Obsidian 原生 AI 记忆层 | Obsidian vault 直接读写 + SQLite FTS5 + BGE embeddings | ✅ | ✅ | ✅ 就是为 Obsidian 设计 | ✅ opt-in `--enable-write` | MIT | v3.11.x 非常成熟 |
| **Kontexta** | Brain+Hands+Eyes 闭环 | SQLite FTS5 + git-backed markdown vault | ✅ | ✅ | 间接（md vault 可 Obsidian 打开） | ✅ 58 tools | Apache-2.0 | 从私有工具链抽出 |
| **SuperLocalMemory** | Governance-first 商业级记忆 | 本地 embedding + SQLite | ✅ 几乎所有 agent | ✅ + CLI + 插件 | ❌ 独立存储层 | ✅ | AGPL-3.0 | 极成熟（4 篇 arXiv） |
| **Yggdrasil** | 极简 local-first 记忆 | SQLite FTS5 + 每个记忆同时是 .md | ✅ | ✅ | ✅ 直接兼容 | ✅ | AGPL-3.0 | alpha，亮点明确 |
| **mnemoverse** | 云托管记忆（唯一 SaaS） | 云端 | ✅ hosted | ✅ | ❌ | ✅ | MIT | 有免费额度 |
| **Dev-Mem** | hooks 注入式自动提取 | SQLite knowledge graph | ✅ | ❌ hooks 注入 | ❌ | ❌ 自动提取 | MIT | npm 包可用 |
| **MCP server-memory** (官方) | 知识图谱参考实现 | 本地 JSON 文件 | ❌ 单 Agent | ✅ | ❌ | ✅ | MIT | 参考实现 |

### B 类：Obsidian 通用 MCP（不做记忆层）

- **obsidian-mnemo** — Python MCP server，直接读 vault 文件，零结构，零存储约束
- **obsidian-mcp (cyanheads)** — Obsidian MCP server，Bun + FastAPI
- **Companion MCP / Semantic Notes Vault MCP** — Obsidian 插件，vault 内建 MCP server

### C 类：其他记忆层

- **GitHub Copilot Memory** — 官方内建，repo-scoped，锁 GitHub 生态
- **Mem0 / Zep** — 成熟记忆框架，SDK 集成，self-hosted 但非 MCP 原生
- **ctxfile** — 单 repo context 文件版本化（非 MCP）

## 3. 核心竞品深度分析

### 3.1 enquire-mcp — 最大威胁（也是最大灵感）

**定位**：「Turns Obsidian vault into the memory database for your agents」——the #1 Obsidian MCP for freshness-aware, cited AI memory `[cite:1]`

**核心能力**：
- 47 个 MCP 工具（35 只读 + 7 写 opt-in + 1 feedback）
- 混合检索：BM25 + TF-IDF + BGE embeddings → RRF 融合 → BGE 跨编码器 reranker（+15.5 NDCG@10）
- PDF/OCR 混合检索、Canvas 解析、Dataview LIST/TABLE 查询、Base 文件过滤
- 每个搜索结果带 `age_days` 和 `stale`（freshness-aware）
- MIT 协议、v3.11.x 稳定、2367 测试用例、CI、SLSA L2 构建证明
- 零 outbound 调用、零 telemetry

**与 RecallVault 的关键差异**：

| 维度 | enquire-mcp | RecallVault 提案 |
|------|------------|-----------------|
| Vault 访问范围 | 整个 vault 全读（可触碰普通笔记） | 在 vaultPath 根目录读写 |
| 记忆类型分层 | 无——通用 notes | episodic（会话短期）vs semantic（长期知识）明确区分 |
| Frontmatter schema | 通用索引所有 frontmatter 字段 | 明确定义 schema |
| 多项目隔离 | 单 vault 全部可访问 | project_id → 子文件夹 |
| 人工审核标记 | 无 | semantic 记忆 reviewed 字段 |
| 检索深度 | 极强（hybrid + rerank + HyDE + multi-query） | 一期只关键词 + 过滤器 |

**结论**：enquire-mcp 是更强的 Obsidian + 记忆组合，但它是通用 vault 访问层 + 搜索引擎，不是专项记忆系统。它不会破坏 vault 其他笔记（只读默认），但也不会帮用户自动管理结构化记忆条目。

### 3.2 Kontexta — Brain+Hands+Eyes 闭环

**定位**：One memory. One toolbox. One feedback loop. Any agent. `[cite:3]`

**核心能力**：
- Brain：git-backed markdown vault + SQLite FTS5 + 58 MCP tools
- Hands：sandboxed command engine（`kontexta.json` 声明式权限）
- Eyes：自动 journaling（Layer 1 event log → Layer 2 总结）
- est_tokens / size_bytes 每个返回带 token 预算
- 跨项目 awareness 是显式卖点

**关键特征**：
- 不是 Obsidian 兼容的——它自己有一个 markdown vault，人可以用 Obsidian 打开但目录结构是 Kontexta 定义的
- 有 Hands（命令沙箱）和 Eyes（自动 journaling）——这两个是 RecallVault 不做的
- 跨项目知识共享是设计目标，不做隔离

### 3.3 SuperLocalMemory — 商业级治理

**定位**：The governed memory brain for every AI agent. It lives on your machine. It never bluffs. `[cite:4]`

**核心能力**：
- 四层 recall：supported answer / closest memories / "That isn't in SuperLocalMemory"
- 7 路混合检索：语义 + BM25 + 图 + 时间 + Hopfield + spreading-activation + picture
- Layered recall（depth 0 一行 / 1 事实 / 2 完整）+ 硬 max_tokens cap
- 时间旅行（valid-at / known-as-of / window）+ 生物启发式遗忘
- 12 个超能力（详见 GitHub README）
- 4 篇 arXiv 论文，AGPL-3.0

**关键特征**：
- 存储层是黑盒（本地 embedding + SQLite），不是纯文件
- 治理层极强（admission check / audit trail / role-based access / 内存中毒防护）
- 支持图片和 PDF 嵌入检索
- 几乎和所有 Agent 生态都有原生插件

### 3.4 Yggdrasil — 极简挑战者

**定位**：One local memory for Claude Code, Codex, and every MCP agent — Zero dependencies. Nothing leaves your machine. `[cite:2]`

**核心能力**：
- SQLite + FTS5（一期）+ 可选 Ollama embeddings（recall@1 从 0.77 → 0.93）
- 每个记忆同时是纯 Markdown 文件（Obsidian 直接可读！）
- Daemon 常驻（~21MB RAM）
- 自动 session start 注入项目状态摘要（~300 tokens）
- AGPL-3.0、alpha 状态但亮点明确

**关键特征**：
- Markdown 是副产物（SQLite 是权威源）——人改 md 会不会同步回 SQLite，文档没说
- 没有明确的 episodic/semantic 分层
- 没有 project_id 目录隔离
- 跨项目 recall 是卖点（"this looks like project B — reuse it?"）

### 3.5 Dev-Mem — hooks 注入式

**定位**：Persistent local knowledge store for AI coding agents — Preserves development context and catches repeated mistakes `[cite:5]`

**核心能力**：
- 通过 Claude Code / Codex / Cursor 的 hooks 自动注入
- SessionStart / PostToolUse / SessionEnd 全链路捕捉
- LLM 自动从对话提取决策、失败方案、约束、发现
- SQLite knowledge graph 存储

**关键特征**：
- 不是 MCP 标准协议——用 hooks 注入（不兼容没有 hooks 的 Agent）
- 黑盒存储，人不参与内容管理
- 自动提取可能引入噪声（LLM 幻觉式"发现"）

## 4. 竞品定位矩阵

```
记忆管理深度 ↑
              │
  高治理层    │  SuperLocalMemory (qualixar)  ← 已商用 / 4 篇论文
              │  Kontexta (safiyu)            ← Brain+Hands+Eyes
              │  Yggdrasil (VonderVuflya)     ← SQLite+md 双重存储
              │  Dev-Mem (HarsH-1877)         ← hooks 自动提取
              │
              │  ── enquire-mcp (oomkapwn) ── ← 最强 Obsidian 访问层
              │     ↑ 但没有结构化记忆类型
              │
  纯访问层    │  obsidian-mnemo 等             ← 只读写 vault
              │
              └──────────────────────────────→ 存储介质
              纯文件          SQLite/FTS5          云端
              ↑ RecallVault 目标位置
```

**RecallVault 的定位缺口**：
- 纯 Markdown 文件作为唯一权威源（SQLite 只是可选加速索引）
- 明确的 MCP 专属目录隔离（不碰 vault 其他笔记）
- 结构化记忆分层（episodic / semantic + reviewed 审核标记）
- 逻辑隔离 + 可选共享层（平衡隔离需求和跨项目复用）

目前没有任何竞品同时做到这四点。

## 5. 竞品为什么不做项目隔离

不是忽略——是**明确把跨项目复用当成核心卖点**：

- Yggdrasil：cross-project recall 直接写在卖点里
- Kontexta：Shared standards — Solve a problem once, document it, and let your agent apply that solution across all your other projects automatically

这说明跨项目知识复用是真实需求，不是边缘 case。详见 [隔离策略专题](architecture/isolation-strategy.md)。

## 6. 启示

| 竞品 | RecallVault 可借鉴 | 应避免 |
|------|-------------------|--------|
| enquire-mcp | Obsidian 原生兼容、freshness-aware、context_pack token 预算 | 不要做通用 vault 访问层——聚焦结构化记忆 |
| Kontexta | est_tokens 每个返回带 token 估算、surgical section fetch | 不要加 Hands 命令沙箱——超出范围；不要全局 vault |
| SLM | 显式 priority 字段、分层召回 | 不要黑盒存储；不要过度治理（MVP 阶段） |
| Yggdrasil | 纯 Markdown 输出让 Obsidian 可读 | Markdown 必须是权威源，不是 SQLite 的副产物 |
| Dev-Mem | hooks 注入是好主意但不是 MCP | 一期只做 MCP，hooks 注入作为二期可选 |

## 7. 竞品怎么做"自动存取记忆"（新增 2026-10-28）

上一轮调研聚焦功能广度，这一轮聚焦核心痛点：**agent 不手动调也能存和取，怎么做到？**

### 7.1 自动存取的 6 种实现路径

| 路径 | 原理 | 代表 | 黑盒？ | 跨 Agent？ | 维护成本 |
|------|------|------|--------|-----------|---------|
| **A. 云网关代理** | Agent 请求先过网关 → 网关透明提取/注入 → 转发 | context-mode.com | ✅ 完全黑盒 | ✅ 所有 agent | 高（云费用） |
| **B. AGENTS.md 强约定** | 告诉 agent "什么时候调记忆工具" | enquire-mcp、我们的 recall-vault | ❌ 透明可读 | ✅ 所有支持 AGENTS.md 的 | 低（一个文件） |
| **C. MCP initialize.instructions** | MCP 协议新能力——server 在连接时返回"推荐的使用规则" | enquire-mcp（2026.10 新增） | 半黑盒 | ✅ MCP 客户端支持 | 零 |
| **D. 自动生成 AGENTS.md** | 一条 tool 调用 → server 直接写 CLAUDE.md / AGENTS.md | Kontexta `admin_onboard_agent`、Mnemoverse `setup_memory` | 半黑盒 | ✅ | 低（一次命令） |
| **E. daemon + session 启动注入** | 常驻进程监控 agent 活动 → session start 时自动 inject 摘要 | Yggdrasil | ✅ 黑盒 | ✅ 所有 MCP | 中（daemon 常驻） |
| **F. hooks 事件注入** | 注册到 agent 的 hooks 系统（SessionStart / PostToolUse / SessionEnd） | Dev-Mem、deja-vu、agentmemory | 半黑盒 | ⚠️ 仅支持 hooks 的 | 中（需要 agent hooks 支持） |
| **G. 追溯索引（retroactive）** | 扫描 agent 已产生的日志/transcript → 反向建索引 | deja-vu、agentmemory | ❌ 透明 | ✅ 42 种 agent | 零（无侵入） |

### 7.2 每家竞品的自动机制

#### enquire-mcp — MCP instructions + AGENTS.md 片段（路径 B+C）

- **不做自动提取**——enquire-mcp 定位是 Obsidian 访问层，不是记忆管理器
- **但解决了"agent 什么时候想起调它"这个问题**：
  1. MCP `initialize` 握手时返回 `instructions`（MCP 协议新能力）——内容是"推荐的 recall workflow + citation 语义 + freshness 检查规则"
  2. README 提供现成的 **AGENTS.md 片段**，用户复制粘贴即可：
     ```markdown
     You have my Obsidian vault wired up as searchable memory.
     Always check obsidian_search first when I ask about anything in my notes.
     ```
- `age_days` + `stale` freshness 标记 → agent 自动倾向新鲜来源

**启示**：MCP `initialize.instructions` 是 2026 年的新东西，值得跟进。AGENTS.md 片段是零成本方式。

#### Kontexta — onboard 工具 + Eyes 自动 journaling（路径 D+F）

- `admin_onboard_agent` 工具 → **直接往 CLAUDE.md / AGENTS.md / `.cursorrules` 里写规则块**，一次调用完成配置
- `projects_register` → 注册项目，让 kontexta 知道哪些项目要监控
- **Eyes 层**：PostToolUse 自动 journaling → 每次 tool use 后把结果摘要写回 memory（Layer 1 event log → Layer 2 总结）
- est_tokens 每个返回 → agent 自动感知 token 预算

**启示**：`onboard` 工具是很好的 UX——用户一条命令搞定配置，比手动改文件好。我们可以加一个 `setup` 子命令自动生成 AGENTS.md 片段。

#### Yggdrasil — daemon 自动 session 注入（路径 E）

- Daemon 常驻（~21MB RAM）→ 监控 agent 活动
- **每个 session start 自动注入项目状态摘要（~300 tokens）** → agent 一进来就知道之前发生了什么
- SQLite + FTS5 作为权威源，Markdown 是副产物（这一点我们相反——Markdown 是权威源）
- 跨项目 recall 是设计目标

**启示**：session start 自动注入摘要这个 300 tokens 技巧非常高效——我们 Batch 3 可以考虑做类似的东西，但不用 daemon，用 AGENTS.md 里写"session 开头先调 recall limit=3"也行。

#### SuperLocalMemory — hooks 自动提取 + 分层 recall（路径 F）

- 四层 recall：supported answer → closest memories → "That isn't in SLM" → picture
- **时间旅行**：valid-at / known-as-of 双时钟 + 生物启发式遗忘
- hooks 自动提取 → 不需要手动存
- 治理层极强：admission check / audit trail / 内存中毒防护
- 几乎所有 agent 都有原生插件（不是只靠 MCP）

**启示**：双时钟我们可以借鉴，但 hooks 依赖 agent 生态支持，我们作为纯 MCP server 不好直接做。

#### Dev-Mem — hooks 注入式自动提取（路径 F）

- 不是 MCP——直接 hook Claude Code / Codex / Cursor
- SessionStart / PostToolUse / SessionEnd 全链路捕捉
- LLM 自动从对话提取：决策、失败方案、约束、发现
- SQLite knowledge graph 存储（黑盒）

**启示**：hooks 注入比 MCP 更深入 agent 生命周期，但兼容性差（只支持有 hooks 的 agent）。我们可以二期做一个可选 hooks adapter。

#### deja-vu — 追溯索引 + session start hook（路径 G + F）

- **零侵入**——不 capture，只索引 agent 已经写到磁盘的 transcript
- 42 种 agent 原生解析器（Claude Code、Codex、Cursor、opencode、Goose、OpenClaw…）
- hook 在 session start + before edit + after failure → 主动 recall 相关历史
- R@5 95.2%（LongMemEval-S）
- 不写任何 memory 文件，只读 transcript

**启示**：追溯索引是零成本获得初始记忆的好办法——我们可以加一个 `memory_import` 工具，扫描 `.trae/documents/` 和 agent 的 JSONL 日志，自动转成 semantic 记忆。

#### Mnemoverse — setup_memory 自动生成 AGENTS.md（路径 D）

- 云托管（唯一 SaaS）
- `setup_memory` 工具 → 自动为 claude-code / claude-ai / cursor / codex 生成对应的 AGENTS.md / CLAUDE.md 记忆规则
- `memory_write` / `memory_read` / `memory_feedback` 三个核心 MCP 工具
- 跨机器同步（云端优势）

**启示**：`setup_memory` 这个工具名和功能非常值得借鉴——我们可以加一个 `memory_setup` 工具，检测当前 agent（CLAUDE.md vs AGENTS.md vs .cursorrules），生成对应的规则片段。

### 7.3 自动存取能力总表

| 产品 | 自动存 | 自动取 | 机制 | 黑盒程度 | 需要手动配置？ |
|------|--------|--------|------|---------|--------------|
| **context-mode** | ✅ 网关透明提取 | ✅ 每条会话首请求注入 | 云网关代理 | ⬛ 完全黑盒 | 登录账号即可 |
| **SuperLocalMemory** | ✅ hooks 自动提取 | ✅ 分层 recall + 时间旅行 | hooks + 原生插件 | ⬛ 黑盒存储 | 装插件 |
| **Yggdrasil** | 🔧 agent 主动（无自动提取） | ✅ session start 自动注入摘要 | daemon 常驻 | ⬛ daemon 黑盒 | 启动 daemon |
| **Kontexta** | ✅ Eyes 自动 journaling | 🔧 agent 主动（需规则） | onboard 生成 AGENTS.md | ⬜ 透明 | `onboard` 一次 |
| **Dev-Mem** | ✅ hooks 全链路提取 | ✅ hooks 自动注入 | agent hooks | ⬛ 黑盒存储 | 安装 hooks |
| **enquire-mcp** | ❌ 不做提取 | 🔧 AGENTS.md 规则 + instructions | MCP instructions + AGENTS.md | ⬜ 完全透明 | 粘贴 AGENTS.md 片段 |
| **Mnemoverse** | 🔧 agent 主动 | 🔧 setup_memory 生成规则 | MCP tool 生成 AGENTS.md | 🔶 云端存储 | `setup_memory` 一次 |
| **deja-vu** | — 追溯已有 transcript | ✅ session start hook | 只读 transcript 索引 | ⬜ 完全透明 | 装 hook（可选） |
| **RecallVault（当前）** | 🔧 AGENTS.md 规则引导 | 🔧 AGENTS.md 规则引导 | AGENTS.md 强约定 | ⬜ 完全透明 | 无（项目自带 AGENTS.md） |

### 7.4 RecallVault 下一步增强方向

对比竞品，我们的差距主要在**自动性**上。三个低成本增强：

| 增强 | 路径 | 工作量 | 效果 |
|------|------|--------|------|
| `memory_setup` 工具 → 自动生成 AGENTS.md 片段 | 学 Kontexta/Mnemoverse 的 onboard | 小 | 新用户 1 条命令搞定配置 |
| MCP `initialize.instructions` → server 主动告诉 agent 怎么用 | 学 enquire-mcp 2026.10 新增 | 小（改 server.ts） | 所有 MCP 客户端自动获得规则 |
| `memory_import` → 扫描 `.trae/documents/` + agent 日志，自动转 semantic | 学 deja-vu 追溯索引 | 中 | 零成本获得初始记忆 |
| session start 自动注入 ~300 token 摘要 | 学 Yggdrasil | 中 | 减少上下文重建 |

**暂时不做的**：hooks 注入（Dev-Mem 路径）、云网关（context-mode 路径）、daemon（Yggdrasil 路径）——依赖 agent 生态或增加运维复杂度，不符合我们纯 MCP + 零依赖的定位。

## Sources

[cite:1] enquire-mcp GitHub — https://github.com/oomkapwn/enquire-mcp
[cite:2] Yggdrasil GitHub — https://github.com/VonderVuflya/yggdrasil
[cite:3] Kontexta GitHub — https://github.com/safiyu/kontexta
[cite:4] SuperLocalMemory GitHub — https://github.com/qualixar/superlocalmemory
[cite:5] Dev-Mem GitHub — https://github.com/HarsH-1877/Dev-Mem
[cite:6] mnemoverse GitHub — https://github.com/mnemoverse/mcp-memory-server
[cite:7] MCP 官方 memory server — https://github.com/modelcontextprotocol/servers/tree/main/src/memory
[cite:8] GitHub Copilot Memory 博客 — https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/
