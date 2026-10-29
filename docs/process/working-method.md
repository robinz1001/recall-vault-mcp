---
status: confirmed
created: 2026-10-27
updated: 2026-10-27
---

# RecallVault 工作方法

## 1. 开发哲学

### 先跑通，再做好

核心链路的最小可运行版本必须在第一批就验证，每一批交付都必须是一个可以实际跑起来、可以被编码 Agent 调用的 MCP 服务。不做「写完一堆代码再集成测试」。

### 文件是一切的源

整个系统围绕「Markdown 文件 + Frontmatter」这个单一数据源设计，不搞数据库同步、不搞复杂缓存。MCP 服务是文件的薄读写层，Obsidian 是人用的前端。任何一层的变更（人改 md、Agent 调用 MCP），另一层立即可见，不需要同步脚本。

### stdio 是红线

所有应用日志走 stderr 或文件，stdout 严格只出 JSON-RPC。这条从第一天就卡死，任何调试输出都不能直接 `console.log()`。

---

## 2. 决策模型

| 类型 | 决策权 | 例子 |
|------|--------|------|
| **技术选型 / 架构** | 自主定，实现前告知 | MCP SDK 用官方包、不引入 SQLite、一期不用 embedding |
| **数据契约**（frontmatter schema、目录结构、文件名） | 先出草案，确认后锁死 | 字段名、必填/可选、哪些系统管理哪些人改 |
| **MCP 工具签名**（参数名、类型、返回结构） | 先出草案，确认后锁死 | 工具名、参数 schema、返回给 Agent 的格式 |
| **功能优先级** | 定边界，排顺序 | 「第一批只做 remember/recall」→ 拆成可交付子任务 |
| **Obsidian 体验** | 说需求我实现 | 比如「双链要正常、tag 要被 Obsidian 图谱识别」 |

**简单说**：怎么实现我来定，长什么样、有什么能力你来定。

---

## 3. MVP 分批

### Batch 0：脚手架 + 空 MCP Server

**范围**：项目骨架、日志系统、MCP 空壳

```
├── package.json + tsconfig + 构建脚本
├── MCP stdio Server 骨架，能被 Claude Code / Codex 启动
├── 日志系统（stderr + 文件，验证不污染 stdout）
├── 工具注册：先注册一个 health_check 工具测通
└── 交付物：能被 Agent 成功 start、调用 health_check 返回 ok
```

### Batch 1：核心读写链路（最小可用）

**范围**：remember + recall + list + archive + 存储层 + 目录创建

```
├── Vault 目录自动创建（.recall-vault/ 根目录 + projects/ + shared/）
├── Frontmatter 解析 / 生成（gray-matter + js-yaml）
├── memory_id 生成（mem_YYYYMMDD_序号）
├── remember 工具（两类记忆写入 + append_to 追加）
├── recall 工具（L1 关键词匹配 + L2 过滤器 + L3 排序 + 窗口适配）
├── list_memories 工具
├── archive_memory 工具
└── 交付物：Agent 能写记忆、能搜到记忆、Obsidian 打开 md 渲染正常
```

### Batch 2：完整管理能力

**范围**：update + delete + set_priority + recall 增强

```
├── update_memory（替换 / 追加内容、改 tags、设置 reviewed）
├── delete_memory（移 _trash 目录或硬删）
├── set_memory_priority
├── recall 增强：时间范围过滤、多 query fan-out
└── 交付物：完整 CRUD + 归档 + 优先级 + 审核标记
```

### Batch 3：可选增强层

**范围**：检索深度升级 + 可选依赖

```
├── SQLite FTS5 索引加速（COA_USE_FTS5=true 开关）
├── 本地 embedding 语义检索（@xenova/transformers + bge-small，开关）
├── MCP resources 暴露（让 Agent 浏览 vault 文件）
└── 交付物：根据需要选做，不影响已有功能
```

---

## 4. 验证策略

每批交付过三道检查：

### 4.1 单元 / 集成测试

- 关键函数写测试：frontmatter 解析、memory_id 生成、recall 匹配逻辑、过滤逻辑
- 用 Jest 或 Vitest，测试文件放 `test/` 目录

### 4.2 Obsidian 渲染验证

- 写一份测试 md 文件在 `test-fixtures/` 目录
- 实际在 Obsidian 里打开，确认：
  - YAML frontmatter 属性面板正常显示
  - tags 被 Obsidian 识别（Tag Pane、图谱）
  - Obsidian 双链 `[[xxx]]` 正常渲染和跳转
  - 目录结构符合预期

### 4.3 真实 Agent 调用验证

- 用 Claude Code（或 Codex CLI）实际启动 MCP 服务
- 检查：
  - 工具被正常识别和列出（`mcp__recall-vault__*`）
  - 参数传递无丢失
  - 返回内容长度合理，超长分片可用
  - **全程 stdout 输出全是 JSON-RPC，stderr 有日志**（关键红线）

**结果留存**：测试用的 vault 文件和测试脚本放在 `test-fixtures/`，每批跑一次回归。

---

## 5. 变更确认节奏

| 阶段 | 节奏 | 动作 |
|------|------|------|
| 新契约 | 出草案 → 审阅 → 锁死 | Frontmatter schema、工具签名、目录结构 |
| Batch 0 交付 | 测通 MCP Server 能启动 | 最基础的 sanity check |
| Batch 1 交付 | 真实 Agent 写 + Obsidian 打开 | 核心链路验证 |
| Batch 2/3 交付 | 增量验证 | 新功能不破坏已有功能 |

---

## 6. 不做什么（明确排除项）

这些在规划范围内，但**明确不做**：

| 项目 | 为什么不做 | 谁来做 |
|------|----------|--------|
| GUI / Web 界面 | 纯 MCP stdio 服务；人类编辑靠 Obsidian/VS Code 等编辑器 | 外部工具可扩展 |
| 云端存储 | 100% 本地是硬约束 | — |
| 依赖 Obsidian 专有功能 | 纯 Markdown 权威源，不依赖 Dataview/Canvas/插件 | — |
| Hands 命令沙箱 | 超出记忆层范围 | Kontexta 做了 |
| 自动 journaling / hooks 注入 | 一期只做 MCP；hooks 作为可选 Batch | Dev-Mem 做了 |
| 语义 embedding | 一期不做，可选 Batch 3 | SLM / enquire-mcp 做了 |
| 图片 / PDF 检索 | 专注文本记忆 | SLM / enquire-mcp 做了 |
| 治理层 / 审计 | MVP 不加 admission check / 权限 | SLM 做了 |
