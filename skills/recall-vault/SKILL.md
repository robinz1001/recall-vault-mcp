---
name: recall-vault
version: 0.4.16
description: |
  跨会话、跨项目本地记忆管理系统。SessionStart hook 自动注入上下文摘要，remember 自动推断，recall 优先于 grep。
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

# RecallVault — Agent 行为剧本

你是 recall-vault 的运行时代理。**你是主角，MCP 是存储层，Hook 是安全员（不抢戏）。**

---

## Step 0: 检查 vault 状态（30 秒）

**SessionStart hook 会自动注入压缩摘要到你的上下文里**——那是 vault 最近的高价值记忆，直接用就行。

### 🔴 必须传 workspace_path（强制，v0.4.6 新增）

MCP server 是单例长驻进程，它的 cwd 固定在 IDE 启动目录，**无法自动感知你当前在哪个项目**。
如果不传 workspace_path，session_start 推断的 project_id 可能是你的用户名（比如 `robin`）——这会导致所有记忆存错位置。

**你知道自己在哪个项目里工作。** 所有 MCP tool 调用 **必须传 workspace_path**：

```
// 正确：从你当前的 workspace 路径推断
session_start({ workspace_path: "d:/Users/robin/source/wmetasoft/tournament-master" })
remember({ content: "...", workspace_path: "d:/Users/robin/source/wmetasoft/tournament-master" })
recall({ query: "...", workspace_path: "d:/Users/robin/source/wmetasoft/tournament-master", compact: true })

// 错误：不传 → 可能被推断成用户名
session_start()  // ❌ project_id 变成 "robin"
```

**怎么拿到 workspace_path？** 你（agent）从 Trae 的 prompt 上下文就能知道当前项目目录（cwd、当前打开文件路径、session environment）。

### session_start 拿到后做什么

如果你想更精确（比如要知道 project_status、previous_session、跨项目经验），手动调一次：

```
session_start({ workspace_path: "<你的项目绝对路径>" })
```

拿到返回值后：
- **记下来 `session_id`** — 后续所有 remember() 复用
- **记下来 `project_id`** — 后续所有 remember/recall 也可以直接传这个（省得每次传 workspace_path）
- 扫一眼 `compacted_summary` 和 hook 注入的对比，一致就不用深挖
- `suggested_actions` — 照做就行

---

## Step 1: 工作中 → 主动 recall + remember

### 🔴 Search BEFORE Grep（强制，最本质）

**任何 Grep/Glob 搜代码文件之前，先 recall 搜 vault。**

```
❌ 错误：Grep("架构决策") — vault 里有，但你可能搜不到
✅ 正确：recall({ query: "架构决策", compact: true })
```

vault 是项目知识的**语义索引**——比 grep 更快、更准、更省 token。Grep 只用来搜代码里的字符串字面量。

### 🔴 Recall BEFORE remember（强制）

**任何 remember 之前，先 recall 看看有没有近似的。** 避免存重复记忆。

```typescript
// 1. 先搜
const prev = recall({ query: "<你要存的内容关键词>", compact: true });

// 2. 有近似的 → 用 replaces 取代旧的（自动设 valid_to + superseded_by）
if (prev.results.length > 0 && prev.results[0].score > 0.5) {
  remember({ content: "...", replaces: prev.results[0].memory_id });
} else {
  // 3. 没有 → 新建
  remember({ content: "..." });
}
```

### 什么时候 recall（3 种场景）

| 场景 | 查询方式 |
|---|---|
| 开始新子任务 | `recall({ query: "<子任务关键词>", compact: true })` |
| 用户说"之前/上次/我们讨论过" | `recall({ query: "<话题>", include_shared: true, compact: true })` |
| debug 卡壳 | `recall({ query: "<关键报错> + bug", compact: true })` |

### 🔴 recall 空结果行为（强制）

`recall({ results: [] })` → **明确说** "我没有相关历史记忆"，**绝对不能** 把空结果当答案瞎编。

### 什么时候 remember（简化规则）

**花了 >1 分钟才搞定** 的决策/修复/发现 → 存。10 秒搞定的 → 跳过。

```typescript
// 最简 — 只传 content，MCP 自动推断 memory_type/scope/priority/tags
remember({ content: "..." })

// 手动覆盖（需要跨项目复用时）
remember({ content: "...", scope: "shared" })
```

**不要存：** 单纯的代码提交、一次性命令、临时路径、没被采纳的方案。

### token 预算决策

- 默认 **compact: true**（省 ~80% token）→ 只有 id/score/wikilink
- 需要读完整内容 → **不要** 用 recall 的完整模式，而是 `ReadFile(wikilink 指向的文件路径)`
- **不确定就 compact:true**

### 什么时候调 organize_memories

当你觉得 vault 开始乱了：重复记忆多、tags 空、priority=3 长期没更新。

```typescript
organize_memories({ mode: "deep" })  // 执行 dedup + promote + tags 补齐
// 或先 dry-run
organize_memories({ mode: "light" })  // 只看建议，不动数据
```

---

## Step 2: session 结束 → 调 `session_end`

**结束前，最后一件事。** 不调也不会丢数据（文件已落盘），但调了能给下次 session 留个"上一次做了啥"的入口。

### 🔴 Episodic 正文强制（强制，v0.4.9 新增）

**Episodic 记忆的正文必须有实际内容**——不能只有一个空的 "## Highlights" 标题。空摘要等于白写，下次 session 读不到任何有用信息。

```typescript
// ✅ 正确：有实际内容
session_end({
  summary: "本次 session 完成了 recall-vault MCP 跨 IDE 安装调试",
  highlights: ["修复 bin/recall-vault-mcp.mjs 参数透传 bug", "CodeBuddy 需 type:stdio 字段才能连上 MCP", "hook-session-start 加了 project 过滤"],
})

// ❌ 错误：highlights 空或只有标题
session_end({
  summary: "本次 session",
  highlights: [],  // ← 空数组 = 废记忆
})
```

**最低标准**：`highlights` 至少 3 条，每条不少于 5 个字。实在没做任何事 → 干脆不调 session_end（跳过比空写好）。

---

## 🔴 降级策略（MCP 报错时）

```
MCP 工具报错 / 返回 isError: true
  → 调 health_check()
  → 看 degraded 字段：
    - vault_ready = false → 提示用户：vault 目录有问题，运行 memory_setup() 或检查 vault_path
    - vault_ready = true 但工具报错 → 提示用户 MCP server 可能没启动好
  → 不要阻塞工作流，继续用普通 Grep/Glob 搜代码
```

hook 注入的压缩摘要 **永远可用**——它直接读 vault 文件，不依赖 MCP server。

---

## 15 个 MCP 工具速查

| 工具 | 什么时候用 |
|---|---|
| session_start | ⭐ session 开始想精确知道 project_status / previous_session |
| session_end | ⭐ session 结束前存一个 episodic 摘要 |
| remember | recall before remember → 有近似就 replaces，没有就新建 |
| recall | **搜 vault 记忆（优先于 Grep）**。默认 compact:true |
| snapshot_list | **看项目画像快照**（_snapshot/ 下 4 个固定文件） |
| snapshot_update | **更新快照文件**（覆盖式，下次 session 自动注入） |
| organize_memories | vault 开始乱了。light=dry-run，deep=执行（含 raw→distill 归档） |
| list_memories | 盘点 vault（少用） |
| update_memory | 更新已有记忆（少用，优先 remember + replaces） |
| archive_memory | 软删除（不物理删） |
| delete_memory | ⚠️ 永久删除（慎重） |
| set_memory_priority | 快速调优先级（少用） |
| health_check | 诊断 vault 状态；MCP 报错时看 degraded |
| memory_setup | 初始化 vault（首次） |
| memory_import | 从 docs/ 导入文档。**默认蒸馏模式**（v0.4.9 起） |

### 🔴 memory_import 蒸馏模式（强制，v0.4.9 新增）

**默认 `mode: "distill"`**——不是复制原文到 vault，而是让你（agent）先总结文档要点再写入。对标 Supermemory 的 "Chunks + Memories" 分离：

```typescript
// ✅ 默认：蒸馏模式（推荐）
memory_import({ mode: "distill", from_docs: true })
// → MCP 只返回"哪些文档需要处理"，你逐个总结后用 remember 写入 distilled 版本

// 什么时候用 raw？文档很长、你需要 recall-vault 里也保留原文副本
memory_import({ mode: "raw", from_docs: true })
// → 直接复制原文（旧行为），会产生大量冗余
```

**蒸馏模式的工作流**：

```typescript
// 1. 触发 import（只扫描，不写内容）
const targets = memory_import({ mode: "distill", from_docs: true })
// targets = [{ file: "docs/nforge/standards/xxx.md", priority: "high" }, ...]

// 2. 你逐个 ReadFile → 总结要点（200 字内）→ remember 写入 distilled 版本
for (const t of targets.files) {
  const content = ReadFile(t.file);
  const summary = summarize(content); // 你自己做
  remember({
    content: `# ${basename(t.file)}\n\n${summary}`,
    scope: "project",
    workspace_path: "<你的项目路径>",
  });
}
```

**为什么蒸馏？** 原文镜像会导致：38 份冗余记忆稀释高价值事实、hook 摘要被 import 污染、token 占用膨胀。蒸馏后 vault 里只有精炼的知识要点——和你手写的记忆同质量。

---

## 📋 结构化快照（v0.4.11 新增）

对标 Cline Memory Bank —— **确定性内容用固定格式存，不靠 recall 搜**。

### 为什么需要快照？

semantic 记忆是**自由格式**，agent 靠 recall 搜。但有些内容**每次 session 都需要**：项目是什么、用什么技术栈、核心架构、红线规则——这些不该每次都 recall，应该**默认注入**。

### 4 个固定文件

快照存在 `projects/{project_id}/_snapshot/`，目录首次访问自动创建（模板占位）：

| 文件 | 内容 | 模板状态判断 |
|------|------|-------------|
| `project.md` | 项目画像、目标（3-5 条 checkbox）、非目标 | 含 `<!-- 一句话描述` + `<!-- 3-5 条` → 空模板 |
| `stack.md` | 技术栈表格（层/技术/版本） | 含 `| 层 | 技术 |` + <!-- 注释 → 空模板 |
| `architecture.md` | 分层、关键组件表、依赖方向 | 含 `| 组件 | 职责 | 位置 |` → 空模板 |
| `conventions.md` | 命名规则、红线 R1-R10（带代码位置）、验证方式 | 含 `R1: XXX` 占位符 → 空模板 |

### 🔴 快照写入规则（强制）

**首次接触项目 → 先建快照再开干。** 模板占位等于没有快照——hook 不会注入空模板。

```typescript
// Step 0 之后，session_start 之前：
const snap = snapshot_list({ workspace_path: "<项目路径>" });

// 如果返回 note 说"空模板" → 填！
if (snap.note?.includes('空模板')) {
  snapshot_update({
    file: "stack",
    body: `# 技术栈\n\n| 层 | 技术 | 版本 |\n|---|---|---|\n| 语言 | TypeScript | 5.x |\n| 运行时 | Node.js | 22+ |\n| ... | ... | ... |`,
    workspace_path: "<项目路径>",
  });
  // 依次填 project / architecture / conventions
}
```

**什么时候更新快照？**

| 事件 | 更新哪个 |
|------|---------|
| 项目从 TS 切到 JS | `stack.md` |
| 新增/删除关键组件 | `architecture.md` |
| 新加红线 R11 | `conventions.md` |
| 目标变了（比如加了 iOS） | `project.md` |

**更新方式**：`snapshot_update({ file, body, workspace_path })` — 覆盖式，全量替换。

### 快照 vs semantic 的分工

```
┌─ 快照（_snapshot/）────────────┐  ┌─ semantic（semantic/）──────────┐
│ 固定 4 文件，hook 默认注入       │  │ 自由格式，靠 recall 搜索         │
│ 确定性：是什么、用什么、红线     │  │ 变化的：决策记录、踩坑经验、方案 │
│ 低 token（< 50）               │  │ 数量大（可能 50+）               │
│ 对标 Cline Memory Bank          │  │ 对标 Supermemory Memories       │
└────────────────────────────────┘  └────────────────────────────────┘
   不需要 recall 就能用                  需要 recall 按需检索
```

---

## Hook 兜底（安全员，不抢戏）

Hook 是最后防线。如果你（agent）主动 remember/recall 了，hook 不会打扰你。

| Hook | 打扰级别 | 说明 |
|---|---|---|
| **SessionStart** | 轻 | ✅ 自动注入 vault 压缩摘要（直接用，不是阻断） |
| PostToolUse | 极轻 | 只有 test_pass 才推 hint，其他静默写 marker |
| Stop | 极少 | 只拦 priority≥3 + 冷却期外 |

---

## 决策优先级

```
1. Search before Grep — vault 是唯一知识入口
2. Recall before remember — 避免重复
3. recall 空结果 → 明确说没有，别瞎编
4. MCP 报错 → health_check → 降级 → 继续工作
5. 不确定该不该 remember？→ 花 >1min 才搞定的 → 存
```

---

## 🤝 跨项目本地 context.md（v0.4.16 新增）

### 为什么需要这个？

MCP server 是单例，跨项目读取靠 `recall({ project_id: "xxx" })` 传参——但 agent 不知道要传。**本地 `.recall-vault/context.md` 是磁盘文件，任何 IDE 的 agent 都能直接 `ReadFile`，不需要 MCP。**

### 项目本地 `.recall-vault/` 目录

每个项目目录下自动生成：

```
{project}/.recall-vault/
├── context.md              ← 📌 主文件：session 开始前先读这个
├── cross-refs.json         ← 邻居项目清单（含 rel_path）
└── .gitignore              ← 建议：提交 context.md，忽略 cache
```

### 1. 开始新 session → 先 `ReadFile(".recall-vault/context.md")`

这是 **磁盘上的真实文件**，SessionStart hook 自动生成，Stop hook 自动刷新：

```typescript
// 你（agent）的 Step 0 改成：
const ctx = ReadFile(".recall-vault/context.md");
// ctx 包含：
//   - 📋 项目画像（从 vault _snapshot/ 提炼）
//   - 🔥 Top 5 关键记忆（priority=3 的先）
//   - 🔗 邻居项目列表（可跨项目读取）
//   - 📖 完整记忆索引（最多 20 条）
//   - 上 session 摘要
```

### 2. 跨项目读取（零依赖）

context.md 的 🔗 关联项目章节已经给了邻居的相对路径：

```markdown
## 🔗 关联项目
- **recall-vault** → `../../wmetasoft/recall-vault/.recall-vault/context.md`
- **vscode-plugin** → `../vscode-plugin/.recall-vault/context.md`
```

**直接 ReadFile 跨项目读取：**

```typescript
// 你在 mfel-studio，想查 recall-vault 的 MCP 工具实现
const recallVaultCtx = ReadFile("../../wmetasoft/recall-vault/.recall-vault/context.md");
// 或者从 cross-refs.json 拿路径（更可靠）
const refs = JSON.parse(ReadFile(".recall-vault/cross-refs.json"));
const neighborPath = refs.neighbors.find(n => n.project_id === "recall-vault")?.rel_path;
if (neighborPath) {
  const neighborCtx = ReadFile(neighborPath);
}
```

**MCP 方式（稳定 API，可选）：**

```typescript
// 不指定 project_id → 返回所有有 context.md 的项目
resolve_context_path({ workspace_path: "<你的项目路径>" })
// 或指定
resolve_context_path({ project_id: "recall-vault", workspace_path: "..." })
```

### 3. 什么时候跨项目读取？

| 场景 | 怎么做 |
|------|--------|
| 要查另一个项目的技术栈/架构 | `ReadFile("../neighbor/.recall-vault/context.md")` |
| 另一个项目可能有相关决策 | `recall({ query: "...", project_id: "neighbor" })` |
| 不确定邻居项目名 | 先看当前 context.md 的 🔗 关联项目章节 |

### content.md 自动刷新时机

| 触发点 | 机制 |
|--------|------|
| SessionStart hook | ✅ 每次 session 开始自动生成 |
| PostToolUse hook | ✅ 有产出事件（test_pass/build_pass/git_commit）后 throttle 5 分钟刷新 |
| Stop hook | ✅ session 结束强制刷新（跳过 throttle） |

### 三层污染防御（避免你的记忆被别的项目内容污染）

| 层级 | 检查什么 | 为什么 |
|------|----------|--------|
| 1 | frontmatter 精确匹配当前 project_id | 基础隔离 |
| 2 | frontmatter 标记了其他项目 → 排除 | 物理隔离不充分时的第二防线 |
| 3 | **内容交叉检查**（长项目名 + 单词边界） | 防止 agent 错误推断 project_id 时污染（短名字如 "robin" 跳过防误伤） |

### cross-refs.json 格式

```json
{
  "self": {
    "project_id": "mfel-studio",
    "context_path": ".recall-vault/context.md",
    "vault_project_dir": "C:/Users/robin/.recall-vault/projects/mfel-studio",
    "last_sync": "2026-11-09T10:42:00.000Z"
  },
  "neighbors": [
    {
      "project_id": "recall-vault",
      "name": "recall-vault",
      "rel_path": "../../wmetasoft/recall-vault/.recall-vault/context.md",
      "abs_path": "d:/Users/robin/source/wmetasoft/recall-vault/.recall-vault/context.md",
      "distance": 3
    }
  ]
}
```
