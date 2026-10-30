---
name: recall-vault
description: |
  跨会话、跨项目本地记忆管理系统。session_start 强制前置载入上下文，remember 自动推断，recall 优先于 grep。
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

## Step 1: session 开始 → 立即调 `session_start`（硬性前置）

**不调这个，后面的都别做。** 如果你在 session 中还没调过它，**现在就调**。

```
session_start()
```

拿到返回值后：
- **记下来 `session_id`** — 后续所有 remember() 复用
- 扫一眼 `compacted_summary`（约 200 token，省一次 recall）
- 如果 `recent_high_value` 或 `previous_session` 和当前任务相关 → 继续用 recall 深挖
- 照做 `suggested_actions`

---

## Step 2: 工作中 → 主动 recall + remember

### 🔴 Recall BEFORE remember（强制）

**任何 remember 之前，先 recall 看看有没有近似的。** 避免存重复记忆。

```typescript
// 1. 先搜
const prev = recall({ query: "<你要存的内容关键词>", compact: true });

// 2. 有近似的 → 用 replaces 取代旧的
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

## Step 3: session 结束 → 调 `session_end`

**结束前，最后一件事。** 不调也不会丢数据（文件已落盘），但调了能给下次 session 留个"上一次做了啥"的入口。

```typescript
session_end({
  summary: "本次 session 做了什么",
  highlights: ["完成了 X", "修复了 Y", "决定了 Z"],
})
```

---

## 13 个 MCP 工具速查

| 工具 | 什么时候用 |
|---|---|
| **session_start** | ⭐ **每次 session 第一件事（硬性前置）** |
| **session_end** | ⭐ **每次 session 结束前** |
| remember | recall before remember → 有近似就 replaces，没有就新建 |
| recall | 新任务前、用户提"之前"、debug 卡壳。默认 compact:true |
| organize_memories | vault 开始乱了。light=dry-run，deep=执行 |
| list_memories | 盘点 vault（少用） |
| update_memory | 更新已有记忆（少用，优先 remember + replaces） |
| archive_memory | 软删除（不物理删） |
| delete_memory | ⚠️ 永久删除（慎重） |
| set_memory_priority | 快速调优先级（少用） |
| health_check | 诊断 vault 状态 |
| memory_setup | 初始化 vault（首次） |
| memory_import | 从 docs/ 导入文档 |

---

## Hook 兜底（安全员，不抢戏）

Hook 是最后防线。如果你（agent）主动 remember/recall 了，hook 不会打扰你。

| Hook | 打扰级别 | 说明 |
|---|---|---|
| SessionStart | 轻 | 自动注入 vault 摘要（给你上下文，不是阻断） |
| PostToolUse | 极轻 | 只有 test_pass 才推 hint，其他静默写 marker |
| Stop | 极少 | 只拦 priority≥3 + 冷却期外 |

---

## 决策优先级

```
1. session_start 强制前置 → 跳过 = 你没按剧本走
2. Recall before remember → 避免重复
3. recall 空结果 → 明确说没有，别瞎编
4. 不确定该不该 remember？→ 花 >1min 才搞定的 → 存
```
