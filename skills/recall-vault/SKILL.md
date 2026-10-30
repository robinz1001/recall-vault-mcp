---
name: recall-vault
description: |
  跨会话、跨项目本地记忆管理系统。自动 recall 上下文、remember 决策和踩坑。
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

# RecallVault — 跨会话跨项目记忆系统

## 你是这个系统的什么

你是 recall-vault 的**运行时代理**。agent 是用户的双手和大脑，你是它的**长期记忆器官**。
MCP server 是你的**存储层**，这个 skill 是你的**行为手册**。

---

## Part 0: 前置检查 — MCP 装了吗？

**每次新 session 的第一件事**，在做任何任务之前：

```
1. 调 health_check tool
   ├─ 成功 → MCP 就绪，继续下面的 Part 1
   └─ 失败 → 自动安装（不用问用户！）：
      a) npm install -g recall-vault-mcp（如果没装）
      b) 检查 IDE 的 mcp.json 是否有 recall-vault 条目
      c) 没有 → 写一条进去：
         {
           "mcpServers": {
             "recall-vault": {
               "type": "stdio",
               "command": "npx",
               "args": ["-y", "recall-vault-mcp"]
             }
           }
         }
      d) 告诉用户重启 IDE 或 reload MCP
```

**用户永远不需要手动装** — 你帮他装。

---

## Part 1: 什么时候 recall？

| 时机 | 为什么 | recall query 怎么写 |
|------|--------|-------------------|
| **新 session 开始** | 恢复项目上下文，避免从零开始 | `"当前项目 技术决策 踩坑"` |
| **跨项目问题** | 搜共享记忆里有没有相关经验 | `"include_shared=true 架构决策"` |
| **debug 卡壳时** | 可能之前遇到过同样问题 | `"error 报错信息里的关键词"` |
| **写新功能前** | 看看有没有类似实现可以参考 | `"功能名 implementation approach"` |
| **用户问"之前怎么处理的"** | 直接搜 | `"用户问的那个具体话题"` |

### recall 结果怎么用

| 情况 | 处理 |
|------|------|
| recall 有结果 | **把 rank 前 3 条和当前上下文合成**后再回答，不要只贴记忆 |
| recall 没结果 | 正常用当前上下文回答，不要说"记忆里没有" |
| recall 有 stale 标记 | 告诉用户"这条记忆超过一年了，参考但注意可能已过时" |
| recall 有 superseded_by | **默认用新条目**，旧条目只是历史参考 |
| recall 有多个矛盾结果 | 列出来，说"记忆 A 说 X，记忆 B 说 Y，我倾向 X 因为..." |

---

## Part 2: 什么时候 remember？

**黄金法则**：**值得在未来 3 个月内再用一次的东西**，就 remember。

### ✅ 一定要 remember 的

| 场景 | content 结构 | tags | priority |
|------|-------------|------|----------|
| **做了架构决策** | "决策 → 根因 → 替代方案 → 影响" | `决策,架构` | 2 |
| **踩了非显而易见的坑** | "现象 → 根因 → 修复" | `踩坑,bug` | **3** |
| **debug 成功** | "问题 → 定位过程 → 修复点 → 为什么之前没发现" | `debug,bug` | 3 |
| **和用户约定了东西** | 原话或要点，标注是谁说的 | `约定,需求` | 2 |
| **重要的实现细节** | "怎么做的 → 为什么这么做 → 有什么局限" | `实现,技术` | 2 |

### ❌ 不要 remember 的

| 场景 | 为什么 |
|------|--------|
| 一次性的命令（比如 `ls -la`） | 没长期价值 |
| 临时文件路径 | 机器相关，换环境就失效 |
| AI 建议但没被采纳的方案 | 未来会混淆 |
| 短会话里的碎碎念 | vault 会被垃圾淹没 |

### remember 的 content 写法

```markdown
---
memory_id: mem_<topic>_<date>
memory_type: semantic          # semantic = 知识/决策 | episodic = 会话摘要
priority: 3                   # 1=低 2=正常 3=重要/踩坑
tags: [决策, 架构, MCP]
agent: <你是谁>                # trae / codebuddy / codex / claude
session_id: sess_<日期>
---

# 标题（动词+名词，不用"关于XXX"）

## 决策/做法
一句话说做了什么。

## 根因/为什么
解释背后的原因。这是未来 recall 时最有价值的部分。

## 替代方案
你考虑过但没选的。

## 影响/后续
这次决策会导致什么后果。
```

### priority 怎么定

| priority | 标准 | 例子 |
|----------|------|------|
| **1** | 事实性笔记，丢了也不影响 | "这个函数签名是 foo(x: number)" |
| **2** | 有长期参考价值的知识 | "项目用 flexsearch 做索引" |
| **3** | **踩坑/决策**，丢了下次还会踩 | "Windows 下 better-sqlite3 Access Violation crash" |

---

## Part 3: 自动 Hook 链路

### SessionStart → recall 注入

Trae/CodeBuddy 在新 session 创建时触发：
```
→ hook-session-start.mjs
→ 输出 additionalContext:
   "这是一个新 session。请先调 recall-vault 的 health_check，
    然后用 query='当前项目 技术决策 踩坑' 调 recall，
    把结果纳入你的工作上下文。"
→ agent 看到 → 自动 recall ✅
```

### PostToolUse → npm test/build 成功后 remember

```
→ npm test 通过
→ hook-post-tool.mjs 匹配到 RunCommand + "test passed"
→ 输出 additionalContext:
   "刚才的 npm test 成功了。你做了什么修改？
    如果涉及决策或踩坑，请调 remember 保存。"
→ agent 看到 → 自动 remember ✅
```

### Stop → 有产出但没 remember 时阻断

```
→ agent 准备结束 turn
→ hook-stop.mjs 检测最近 5 分钟有 RunCommand 成功
→ 但 session 里没调过 remember
→ 输出 decision: block, reason: "你刚完成了任务，要不要 remember 一下？"
→ agent 被阻断 → 被迫 remember ✅
```

---

## Part 4: 跨 IDE 路径映射

| IDE | Skill 安装位置 | MCP 配置位置 |
|-----|---------------|-------------|
| **Trae** | `~/.trae/skills/recall-vault/SKILL.md` | `~/.trae/mcp.json` 或 `<项目>/.trae/mcp.json` |
| **CodeBuddy** | `~/.codebuddy/skills/recall-vault/SKILL.md` | `<项目>/.mcp.json` 或 `~/.codebuddy/.mcp.json` |
| **Claude Code** | `~/.claude/skills/recall-vault/SKILL.md` | `~/.claude.json` |
| **Codex** | `~/.codex/skills/recall-vault/SKILL.md` | `~/.codex/mcp.json` |
| **Windsurf** | 全局或 `<项目>/.windsurfrules` | IDE 设置里 MCP 面板 |

**安装后这个 skill 文件应该在上面所有 IDE 的 skills 目录里都有一份**，这样换项目时自动生效。

### npm install -g 后的自动安装

```bash
recall-vault-mcp install-skills
# 或 npm postinstall 自动触发
```

这个命令会：
1. 检测当前系统里哪些 IDE 存在（看 skill 目录）
2. 把 SKILL.md 复制到每个 IDE 的全局 skill 目录
3. 告诉用户已安装到哪些位置

---

## Part 5: 子命令路由

用户说 `/recall-vault <subcommand>` 时：

### doctor — 诊断全链路
```
检查: dist/ 编译产物、mcp.json 配置、MCP 能否启动、vault_path 正确、目录健康、工具数量 10
输出: 问题清单 + 修复命令
MCP: 调 health_check
CLI: node scripts/cli.mjs doctor
```

### recall <query> — 搜索记忆
```
参数: query(必填)、memory_type、project_id、include_shared(默认 true)、limit(默认 5)
MCP: recall tool
CLI: node scripts/cli.mjs recall "query"
输出: rank + summary + 前几条结果，给用户选要不要看更多
```

### remember — 保存记忆
```
参数: content(必填)、memory_type(默认 semantic)、tags、priority(默认 2)、replaces(可选)
MCP: remember tool
CLI: node scripts/cli.mjs remember --content "..." --tags "xxx"
```

### list — 列出所有记忆
```
MCP: list_memories tool
CLI: node scripts/cli.mjs list
```

### archive <memory_id> — 归档
```
MCP: archive_memory tool
CLI: node scripts/cli.mjs archive <id>
```

---

## Part 6: MCP vs CLI fallback

| 场景 | 用什么 |
|------|--------|
| IDE 里 MCP 可用 | **优先用 MCP tool**（实时、有错误处理、有 status） |
| MCP 连不上 | CLI fallback：`npx recall-vault-mcp <subcommand>` 或 `node scripts/cli.mjs <subcommand>` |
| CLI 也跑不了 | 告诉用户"recall-vault 需要 node ≥ 18 + npm install" |

---

## Part 7: 存储结构

### Vault 目录（默认 `~/.recall-vault/`）

```
~/.recall-vault/
├── projects/
│   ├── <project-id>/              # 从 cwd basename 自动推断
│   │   ├── semantic/*.md          # 技术决策、架构、踩坑
│   │   └── episodic/*.md          # 会话摘要
│   └── ...
└── shared/
    └── semantic/*.md              # 跨项目通用知识（语言特性、库用法）
```

### 记忆文件格式

```yaml
---
memory_id: mem_phase1_fts_engine
memory_type: semantic              # semantic | episodic
priority: 3                        # 1 | 2 | 3
tags: [phase1, fts, 踩坑]
agent: trae
session_id: sess_2026-10-28
valid_from: 2026-10-28T10:00:00Z   # 双时钟：何时生效
valid_to: null                     # 双时钟：何时失效（被 replaces 时设）
supersedes: null                   # 被替换的旧记忆 id
superseded_by: null                # 替换它的新记忆 id
reviewed: true                     # 已确认正确
---
```

### 检索架构

```
查询 → 三路并行:
  Channel A: flexsearch BM25（全文）
  Channel B: TF-IDF（纯 JS 加权，tags×1.5）
  Channel C: legacy countOccurrences（tags×3）
    → RRF(k=60) 融合
    → × priority(1~3) × reviewed × recencyScore(双曲衰减)
    → 最终排序
```

---

## Part 8: 常见问题

**Q: recall 和 remember 的区别？**
A: recall 从 vault 搜索，remember 往 vault 写入。两个不同 MCP tool。

**Q: 为什么要双时钟 valid_from / valid_to？**
A: 有了 supersedes 后，旧记忆不是被删掉而是被关闭（valid_to=now）。recall 默认排除已关闭的，但可以 `include_superseded=true` 看历史。

**Q: stale 标记是什么？**
A: recencyScore 用双曲衰减：`halfLife/(halfLife + ageDays)`，halfLife=30 天。超过 365 天 → `stale=true`，提醒参考但注意可能已过时。

**Q: MCP 和 CLI 有什么区别？**
A: MCP 是 IDE 集成的常驻进程，CLI 是直接命令行工具。底层共享同一个 VaultManager，vault 是同一个。

**Q: 我在 Trae 里装了，CodeBuddy 里也要装吗？**
A: npm install -g 后全局生效（全局 skill 目录 + `recall-vault-mcp` bin 命令），但每个 IDE 仍需配置 MCP server（指向同一个全局命令）。

---

## 文件位置

| 项目 | 路径 |
|------|------|
| npm 包 | `recall-vault-mcp` |
| bin 命令 | `recall-vault-mcp` |
| MCP server 源码 | `dist/index.js`（编译后） |
| Skill（这个文件） | 各 IDE 的 `~/.xxx/skills/recall-vault/SKILL.md` |
| Vault | `~/.recall-vault/` |
