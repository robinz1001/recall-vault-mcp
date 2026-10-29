# recall-vault — 用户级安装指南

跨项目通用的本地记忆 MCP server。一个用户一个 vault（`~/.recall-vault`），每个项目是 vault 下的子目录。

## 快速安装（一行命令）

### 方式 A：npm 全局 + IDE 配置

```bash
# 1. 全局安装 MCP server
npm install -g recall-vault

# 2. 验证
recall-vault-mcp doctor
```

然后把下面对应 IDE 的配置加到 IDE 里。

### 方式 B：npx 零安装

```json
// 直接在 IDE MCP 配置里用 npx
{
  "mcpServers": {
    "recall-vault": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "recall-vault"],
      "env": {
        "COA_LOG_LEVEL": "info"
      }
    }
  }
}
```

## IDE 配置模板

### CodeBuddy（推荐）

**用户级** `~/.codebuddy/.mcp.json`：
```json
{
  "mcpServers": {
    "recall-vault": {
      "type": "stdio",
      "command": "recall-vault-mcp",
      "env": {
        "COA_LOG_LEVEL": "info"
      }
    }
  }
}
```

或者用 CLI：
```bash
codebuddy mcp add-json --scope user recall-vault '{
  "type": "stdio",
  "command": "recall-vault-mcp",
  "env": { "COA_LOG_LEVEL": "info" }
}'
```

### Trae

**用户级** `~/.trae/mcp.json` 或项目级 `.trae/mcp.json`：
```json
{
  "mcpServers": {
    "recall-vault": {
      "command": "recall-vault-mcp",
      "env": {
        "COA_LOG_LEVEL": "info"
      }
    }
  }
}
```

### Claude Code

**用户级** `~/.claude.json`：
```json
{
  "mcpServers": {
    "recall-vault": {
      "command": "recall-vault-mcp"
    }
  }
}
```

### Codex

**用户级** `~/.codex/mcp.json`：
```json
{
  "mcpServers": {
    "recall-vault": {
      "command": "recall-vault-mcp"
    }
  }
}
```

### Windsurf

```json
{
  "mcpServers": {
    "recall-vault": {
      "command": "recall-vault-mcp"
    }
  }
}
```

### VS Code（extension）

在 VS Code 设置里：
```json
"codebuddy.mcpServers": {
  "recall-vault": {
    "command": "recall-vault-mcp"
  }
}
```

## Smithery 一行安装（注册后可用）

```bash
# 自动配置到指定 IDE
npx @smithery/cli install recall-vault --client codebuddy --scope user
npx @smithery/cli install recall-vault --client trae --scope user
npx @smithery/cli install recall-vault --client claude --scope user
npx @smithery/cli install recall-vault --client codex --scope user
```

## 可选：Hook 自动化（每个项目）

recall-vault 自带三个 Hook 实现自动化存取：

| Hook | 事件 | 作用 |
|------|------|------|
| SessionStart | 新会话 | 自动 recall 项目记忆 |
| Stop | 会话结束 | 有产出没 remember 时阻断 |
| PostToolUse | npm test/build 后 | 建议 remember 这次修复 |

**安装 Hook（每个项目一次）**：
```bash
# 全局安装 recall-vault 后
node $(npm root -g)/recall-vault/scripts/install-hooks.mjs
# 或者在项目里：
node /path/to/recall-vault/scripts/install-hooks.mjs
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `COA_VAULT_PATH` | `~/.recall-vault` | vault 根目录（覆盖后变项目级） |
| `COA_PROJECT_ID` | cwd basename | 项目 ID（vault 内的目录名） |
| `COA_LOG_LEVEL` | `info` | debug / info / warn / error |

## 验证安装

```bash
recall-vault-mcp doctor
recall-vault-mcp list
recall-vault-mcp recall "test"
```
