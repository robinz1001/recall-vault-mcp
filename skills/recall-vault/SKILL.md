---
name: recall-vault
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

如果你想更精确（比如要知道 project_status、previous_session、跨项目经验），手动调一次：

```
session_start()
```

拿到返回值后：
- **记下来 `session_id`** — 后续所有 remember() 复用
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

```typescript
session_end({
  summary: "本次 session 做了什么",
  highlights: ["完成了 X", "修复了 Y", "决定了 Z"],
})
```

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

## 13 个 MCP 工具速查

| 工具 | 什么时候用 |
|---|---|
| session_start | ⭐ session 开始想精确知道 project_status / previous_session |
| session_end | ⭐ session 结束前存一个 episodic 摘要 |
| remember | recall before remember → 有近似就 replaces，没有就新建 |
| recall | **搜 vault 记忆（优先于 Grep）**。默认 compact:true |
| organize_memories | vault 开始乱了。light=dry-run，deep=执行 |
| list_memories | 盘点 vault（少用） |
| update_memory | 更新已有记忆（少用，优先 remember + replaces） |
| archive_memory | 软删除（不物理删） |
| delete_memory | ⚠️ 永久删除（慎重） |
| set_memory_priority | 快速调优先级（少用） |
| health_check | 诊断 vault 状态；MCP 报错时看 degraded |
| memory_setup | 初始化 vault（首次） |
| memory_import | 从 docs/ 导入文档 |

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
