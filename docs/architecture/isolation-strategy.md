---
status: confirmed
created: 2026-10-27
updated: 2026-10-27
---

# 隔离策略专题

## 1. 问题的由来

RecallVault 初始设计提出"项目级物理隔离"（每个项目一个独立子文件夹，MCP 工具必须传 `project_id`），这个设计在被质疑之前被认为是核心差异化点。但经过竞品调研和真实需求推演，发现它**可能反而是个坑**。

本文档完整记录：
- 竞品为什么都不做项目隔离
- 纯物理隔离的问题在哪里
- 最终决策：逻辑隔离 + 可选共享层

---

## 2. 竞品为什么都不做项目隔离

竞品不是忽略了——**跨项目知识复用是它们明确的产品卖点**：

### Yggdrasil

> "Cross-project recall — 'this looks like project B — reuse it?'"
> — 直接写在产品首页卖点里 `[cite:2]`

### Kontexta

> "Global reach: An agent working in Project A can instantly search and read the documentation, context, and states of Project B.
> Shared standards: Solve a problem once, document it, and let your agent apply that solution across all your other projects automatically."
> — 也是核心卖点 `[cite:3]`

这说明**跨项目知识复用是真实的高频需求**，不是边缘 case。一个开发者的多个项目必然共享：
- 编码规范（ESLint 配置、git 提交风格）
- 技术栈惯例（都用 React + Vite）
- 工具使用经验（"Cursor 的 .cursorrules 怎么写才不会被覆盖"）
- 踩坑总结（"Vite 5 legacy 插件兼容问题"、"pnpm hoisting 陷阱"）

这些天然是跨项目的，锁死在某个项目目录里是反直觉的。

---

## 3. 纯物理隔离的问题推演

我重新推演了纯物理隔离会导致的三个实际痛点：

### 3.1 好知识被锁死

你花精力总结的坑点——比如 "GitHub Actions cache key 的最佳实践"——应该跨项目可复用。纯物理隔离把它锁死在某个项目目录里后：
- 新项目遇到同样的坑，Agent 搜不到 → 重新踩一遍
- 你要么手动复制（复制粘贴违反单一数据源原则，两份副本迟早不一致）
- 要么每个项目都重新踩一遍（浪费时间 + 浪费 token）

### 3.2 用户会本能地 hack 一个共享层

你的多个项目必然有共享的东西。如果架构**强制隔离**（每个记忆必须属一个项目），你会自然想要 workaround：
- 在 vault 里手动建一个 `shared-notes/` 目录
- 期望 MCP 能搜到它（但 MCP 只搜 `projects/` 里的东西）
- 结果：要么放弃隔离、要么手动 hack 目录结构

这说明纯隔离**违反了真实使用场景**——用户有共享需求，架构不支持就要自己 hack。

### 3.3 隔离的"价值"其实没有那么大

我之前以为"防 A 项目记忆混入 B 项目"是刚需，但实际场景里：
- **episodic 记忆**（"今天在项目 A 改了哪个接口"）——这些天然是项目绑定的，混到别的项目里大概率是噪声。但加个 `project_id` frontmatter 字段，recall 默认过滤就够了，不需要物理隔离。
- **semantic 记忆**（"Vite 5 的坑"）——就算 Agent 在项目 B 看到项目 A 总结的 Vite 坑，大概率是有用的，不是干扰。

---

## 4. 竞品不做隔离的另一个可能原因

除了跨项目是 feature 之外，还有一个**实现层面的考虑**：

Yggdrasil 和 Kontexta 的存储层是 SQLite，FTS5 索引对跨项目搜索是天然友好的——加个 WHERE 条件就隔离了。但如果强制物理隔离（每个项目一个 SQLite 数据库或一个独立目录），反而增加了复杂度：
- 多数据库管理
- 跨项目搜索要同时查多个库
- 并发安全问题更复杂

这可能也是它们选择"全局 vault + 逻辑过滤"而不是物理隔离的原因之一。

---

## 5. 决策：逻辑隔离 + 可选共享层

**隔离降级为默认行为（逻辑隔离），而不是强制物理隔离。**

### 5.1 目录结构

```
recall-vault/
├── projects/
│   ├── my-project/
│   │   ├── episodic/          ← 短期会话上下文（项目专属）
│   │   └── semantic/          ← 项目专属长期知识
│   └── another-project/
│       └── ...
├── shared/
│   └── semantic/              ← 跨项目可复用的长期知识
└── _logs/
```

**关键约束**：
- episodic 记忆只能放在 projects/{id}/episodic/ —— 会话上下文天然项目绑定
- semantic 记忆可放在 projects/{id}/semantic/ **或** shared/semantic/ —— 由写入时的 scope 参数决定
- vault 的其他普通笔记始终不触碰

### 5.2 工具签名调整

```typescript
// remember — 加 scope 参数
remember({
  project_id: string,
  scope?: "project" | "shared",    // 默认 "project"
  content: string,
  memory_type: "episodic" | "semantic",
  // 规则：episodic 自动 scope="project"，semantic 可手动选择
})

// recall — 加 include_shared 参数
recall({
  project_id: string,
  query: string,
  include_shared?: boolean,        // 默认 false（只搜当前项目）
  // 不传 project_id 时，自动搜 shared + 所有项目的 semantic
})
```

### 5.3 检索行为矩阵

| 场景 | 行为 | 为什么 |
|------|------|--------|
| 默认 recall（不传 include_shared） | 只搜 `projects/{pid}/` | 隔离防污染 |
| recall + include_shared: true | 当前项目 + shared/semantic | 跨项目复用 |
| remember semantic + scope=shared | 写入 shared 层 | 通用知识 |
| remember episodic | 强制写入项目层 | 会话绑定 |
| 不传 project_id 的 recall | 搜 shared + 所有项目的 semantic（不搜 episodic） | 通用知识查询 |

### 5.4 Frontmatter 字段调整

```yaml
---
id: mem_20261027_001
project_id: my-project          # shared 层的记忆为 null 或 "shared"
scope: project                  # project | shared
memory_type: episodic           # episodic | semantic
created_at: 2026-10-27T10:30:00Z
agent: claude-code
session_id: sess_abc123         # episodic 专属
reviewed: false                 # semantic 专属
priority: 2                     # 1|2|3
archived: false
tags: [bug, vite]
related_files:
  - src/config/vite.config.ts
---
```

---

## 6. 决策记录

| 项目 | 内容 |
|------|------|
| **决策** | 从纯物理隔离改为逻辑隔离 + 可选共享层 |
| **理由** | 1) 跨项目知识复用是真实高频需求（所有竞品都做）；2) 纯隔离会锁死好知识；3) 用户会本能 hack 共享层 |
| **备选方案** | A) 保持纯物理隔离 → 不可行；B) 完全不做隔离 → 会导致项目间会话上下文泄漏 |
| **最终方案** | 逻辑隔离（recall 默认只搜当前项目）+ 共享层（shared/semantic/） |
| **影响** | 目录结构、Frontmatter schema、remember/recall 工具签名都需要调整 |

---

## Sources

[cite:2] Yggdrasil GitHub — https://github.com/VonderVuflya/yggdrasil
[cite:3] Kontexta GitHub — https://github.com/safiyu/kontexta
