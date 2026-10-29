# recall-vault-mcp

> 跨会话、跨项目的本地记忆 MCP server。flexsearch BM25 + TF-IDF 三路混合检索，双时钟事实管理，自动 Hook 链路。

[![npm version](https://img.shields.io/npm/v/recall-vault-mcp.svg)](https://www.npmjs.com/package/recall-vault-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP](https://img.shields.io/badge/MCP-model-context-protocol-blue.svg)](https://modelcontextprotocol.io/)

## 为什么需要 recall-vault-mcp？

| 痛点 | recall-vault 怎么解决 |
|------|---------------------|
| 开新对话 agent 忘了之前说过什么 | SessionStart Hook 自动 recall 上下文 |
| 技术决策、踩坑经验下次又踩 | remember 存成 Markdown 记忆，带 tags 和 priority |
| 旧记忆过时了不知道该信哪个 | 双时钟 frontmatter（valid_from/to）+ staleness 信号 |
| 跨项目知识无法共享 | 一个 vault（`~/.recall-vault/`），每个项目一个子目录 |

## 快速安装

### 方式 1：npx 零安装（推荐）

在你的 IDE MCP 配置里加：

```json
{
  "mcpServers": {
    "recall-vault": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "recall-vault-mcp"]
    }
  }
}
```

### 方式 2：全局安装

```bash
npm i -g recall-vault-mcp
```

```json
{
  "mcpServers": {
    "recall-vault": {
      "type": "stdio",
      "command": "recall-vault-mcp"
    }
  }
}
```

### 方式 3：Smithery 一行多 client

```bash
npx @smithery/cli install recall-vault-mcp --client codebuddy --scope user
npx @smithery/cli install recall-vault-mcp --client claude --scope user
npx @smithery/cli install recall-vault-mcp --client codex --scope user
npx @smithery/cli install recall-vault-mcp --client trae --scope user
```

### 安装全局 Skill

```bash
npx recall-vault-mcp install-skills
```

自动复制 SKILL.md 到 `~/.trae/skills/`、`~/.codebuddy/skills/`、`~/.claude/skills/` 等 7 个 IDE 全局目录。

## 支持的 IDE

| IDE | MCP 配置文件 | Hook 支持 |
|-----|-------------|----------|
| **Trae** | `.trae/mcp.json` | ✅ SessionStart / Stop / PostToolUse |
| **CodeBuddy / WorkBuddy** | `.mcp.json` 或 `.codebuddy/mcp.json` | ✅ SessionStart / Stop / PostToolUse |
| **Claude Code** | `~/.claude.json` | ❌ |
| **Codex** | `~/.codex/mcp.json` | ❌ |
| **Windsurf** | 全局 MCP 设置 | ❌ |
| **Cursor** | `.cursor/mcp.json` | ❌ |

## 核心功能

### 1. 三路混合检索 → RRF 融合

```
flexsearch BM25 + TF-IDF + legacy countOccurrences → RRF(k=60)
  → priority × reviewed × recencyScore(双曲衰减) → 最终排序
```

### 2. 双时钟事实管理

```markdown
---
valid_from: 2026-10-28T10:00:00Z
valid_to: null                      # null = 当前有效
supersedes: mem_phase1_fts_engine   # 我取代了谁
superseded_by: null                 # 谁取代了我（replaces 自动填）
priority: 3                         # 1=低 2=正常 3=踩坑经验
tags: [fts, flexsearch, windows]
---
```

`remember replaces=<old_id>` 自动关闭旧记忆（valid_to=now + superseded_by 填新 id）。

### 3. 自动 Hook 链路

| Hook | 触发时机 | 效果 |
|------|---------|------|
| **SessionStart** | 新建对话 | 注入 recall 指令 → agent 主动拉回上下文 |
| **Stop** | agent 准备结束 | 检测有产出但没 remember → 阻断，强制沉淀 |
| **PostToolUse** | npm test/build 成功 | 注入 remember 建议 |

### 4. WrapHandler Eyes 层

所有 MCP tool 自动 capture：

```json
{ "ts": "...", "tool": "remember", "args": {"content": "前100字符..."}, "status": "ok", "ms": 23 }
```

存到 `~/.recall-vault/journal/*.jsonl`，backlog ≥ 50 时 recall 返回提醒。

## 10 个 MCP 工具

| 工具 | 用途 |
|------|------|
| `health_check` | 健康检查 + vault 状态 |
| `remember` | 存一条记忆（content + tags + priority + replaces） |
| `recall` | 检索（query + limit + filters + include_superseded） |
| `list_memories` | 列出 vault 里所有记忆 |
| `update_memory` | 更新记忆内容 |
| `delete_memory` | 删除记忆 |
| `archive_memory` | 归档到 archived/ |
| `set_memory_priority` | 改 priority |
| `memory_setup` | 首次使用初始化（幂等 fence block） |
| `memory_import` | 从 docs/ 或 .trae/documents/ 批量导入 |

## Vault 结构

```
~/.recall-vault/
├── projects/                    # 每个项目一个目录
│   ├── recall-vault/            # 自动从 cwd basename 推断
│   │   ├── semantic/            # 项目级决策/约定
│   │   │   └── mem_phase1_fts_engine.md
│   │   └── episodic/            # 会话级摘要
│   └── some-other-project/
├── shared/                      # 跨项目通用记忆
│   └── semantic/
│       └── mem_npm_publish_flow.md
└── journal/                     # Eyes 自动 capture
    └── 2026-10-29.jsonl
```

## 本地开发

```bash
git clone https://github.com/robinz1001/recall-vault-mcp.git
cd recall-vault-mcp
npm install
npm run build

# 测试
node scripts/test-batch1.mjs   # 15 tests
node scripts/test-batch2.mjs   # 12 tests
node scripts/test-phase2.mjs   # 14 tests

# CLI
node bin/recall-vault-mcp.mjs doctor
node bin/recall-vault-mcp.mcp list
```

## 技术栈

| 组件 | 选择 | 原因 |
|------|------|------|
| FTS 引擎 | **flexsearch**（纯 JS） | better-sqlite3 在 Windows Node 22 下 Access Violation crash |
| 打包 | tsc → dist/ | npm publish 时已编译，用户不需要 build |
| 存储 | **Markdown + YAML frontmatter** | 可手动编辑、git 友好、零锁 |
| Hook 脚本 | Node ESM `.mjs` | 跨 IDE Shell 兼容（PowerShell + Git Bash） |
| 零 native 依赖 | ✅ | 不用 rebuild，Windows/Mac/Linux 开箱即用 |

## 路线图

| Phase | 功能 | 状态 |
|-------|------|------|
| 1 | 三路混合检索（flexsearch + TF-IDF + legacy → RRF） | ✅ 完成 |
| 2 | Staleness 信号 + 双时钟 frontmatter（valid_from/to + replaces） | ✅ 完成 |
| 3 | WrapHandler Eyes + est_tokens 中英文差异 + memory_setup | ✅ 完成 |
| 4 | memory_import 追溯索引（2 driver + 幂等） | ✅ 完成 |
| 5 | GitHub Actions publish workflow | 🔜 |
| 6 | Eyes 自动 distill（backlog → LLM 提炼摘要） | 🔜 |
| 7 | flexsearch 持久化（vault >5000 条时 export/import） | 🔜 |

## 许可

MIT © robinz1001
