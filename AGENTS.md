# Project Instructions — recall-vault

本项目使用 RecallVault 本地 MCP 服务进行跨会话记忆管理。MCP server 通过 `.trae/mcp.json` 配置，提供 8 个工具。

## 何时自动保存记忆（remember）

在以下场景**主动调用** `remember` tool，不要等用户说"帮我记住"：

| 场景 | 推荐 memory_type | 推荐 scope |
|------|-----------------|------------|
| 讨论/确认了架构决策、技术选型 | semantic | shared（通用知识）或 project |
| 实现了复杂功能并踩了坑 | semantic | project |
| 会话结束前，把本次任务摘要存一份 | episodic | project |
| 发现项目特有的约定（命名、文件布局、API 风格） | semantic | project |
| 写了一段"以后肯定会再用"的代码/命令 | semantic | shared |

**写入规范**：
- `project_id` 用当前目录 basename（本项目是 `recall-vault`）
- `agent` 字段写 `trae`
- `tags` 加 2-4 个描述性标签
- `priority`: 踩坑经验=3（高），架构决策=2（正常），临时上下文=1（低）
- `session_id`: 每次会话开始时生成一个 `sess_日期` 格式的 id

## 何时自动检索记忆（recall）

在以下场景**主动调用** `recall` tool：

1. 接手一个新任务前，搜一下有没有相关的历史记忆：`query=<task 关键词>`，`include_shared=true`
2. 遇到一个好像之前解决过的问题：`query=<错误信息或关键词>`
3. 用户问"之前我们讨论过什么"、"上次是怎么处理 X 的"
4. 准备写类似之前写过的代码：搜一下之前的实现

**检索规范**：
- 默认 `include_shared=true`（跨项目的知识也有价值）
- `limit` 给 5-10 条，给用户最相关的
- 把结果的 **snippet + score + wikilink** 一起展示，不要只贴 id

## 项目特定信息

- **vault_path**: `${workspaceFolder}`（就是项目根，没有嵌套层）
- **目录结构**: projects/recall-vault/episodic/、projects/recall-vault/semantic/、shared/semantic/
- **CLI 脚本**: `node scripts/cli.mjs <subcommand>` 可手动操作，也可作为 MCP 不可用时的 fallback
- **MCP 健康检查**: `health_check` tool 能确认服务状态，`doctor` 子命令能诊断配置问题
