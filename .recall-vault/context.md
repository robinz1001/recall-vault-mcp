# recall-vault — RecallVault 上下文
> 同步: 2026-11-09 12:18:28  |  Vault: `C:/Users/robin/.recall-vault/projects/recall-vault`
> **这是磁盘上的真实文件，任何 IDE 的 agent 都可以直接 ReadFile**

## 📋 项目画像
目标: 跨会话记忆持久化；多 IDE 共享 vault · 技术栈: TypeScript · Node.js · flexsearch · MCP stdio

## 🔥 关键记忆
- ⚠️ **recall-vault 的 MCP 工具不可用时（session_start/recall/remember/sess** (7天前)
  - recall-vault 的 MCP 工具不可用时（session_start/recall/remember/session_end/health_check 全都不在可用工具列表里，或调用报 isError），降级路径是**直接写 va…
  - 📎 `C:/Users/robin/.recall-vault/shared/semantic/mem_20261102_007.md`

- ⚠️ **recall-vault v0.4.6 工作流要点：** (7天前)
  - recall-vault v0.4.6 工作流要点： 1. session_start / remember / recall 必须传 workspace_path（v0.4.5 新增），否则 project_id 被错误推断为用户 hom…
  - 📎 `C:/Users/robin/.recall-vault/shared/semantic/mem_20261102_006.md`

- ⚠️ **## 关键教训：MCP SERVER_INSTRUCTIONS vs SKILL.md — 必须永远同步** (10天前)
  - ## 关键教训：MCP SERVER_INSTRUCTIONS vs SKILL.md — 必须永远同步 ### 问题 改了 SKILL.md v4（加了 Search-before-Grep、Recall-before-remember、…
  - 📎 `C:/Users/robin/.recall-vault/projects/recall-vault/semantic/mem_20261030_1702.md`

- ⚠️ **踩坑：better-sqlite3 在 Windows Node 22 上 Access Violation 崩溃。修复** (10天前)
  - 踩坑：better-sqlite3 在 Windows Node 22 上 Access Violation 崩溃。修复方案：替换为纯 JS flexsearch。这个 bug 花了我 2 小时才定位。
  - 📎 `C:/Users/robin/.recall-vault/projects/recall-vault/semantic/mem_20261030_016.md`

- ⚠️ **install-skills.mjs 和 install-codebuddy.mjs 全面重写为用户级全局配置模式：1)** (11天前)
  - install-skills.mjs 和 install-codebuddy.mjs 全面重写为用户级全局配置模式：1) hook 脚本统一部署到 ~/.recall-vault/scripts/（和 vault 同根，作为 vault 配…
  - 📎 `C:/Users/robin/.recall-vault/projects/recall-vault/semantic/mem_20261029_006.md`

## 🔗 关联项目
- **mfel-studio** → `../../mfel/mfel-studio/.recall-vault/context.md`
- **newtonrank.com** → `../../mfel/newtonrank.com/.recall-vault/context.md`
- **vscode-plugin** → `../../mfel/vscode-plugin/.recall-vault/context.md`
- **temp_20261109_02** → `../../../Documents/Trae-CN/temp_20261109_02/.recall-vault/context.md`

> 💡 跨项目读取: `ReadFile("../{neighbor}/.recall-vault/context.md")` 即可拿到邻居的完整上下文。

## 📖 记忆索引
1. **recall-vault 的 MCP 工具不可用时（session_start/recall/rem** — 7天前 — `mem_20261102_007`
2. **recall-vault v0.4.6 工作流要点：** — 7天前 — `mem_20261102_006`
3. **## 关键教训：MCP SERVER_INSTRUCTIONS vs SKILL.md — 必须永远** — 10天前 — `mem_20261030_1702`
4. **踩坑：better-sqlite3 在 Windows Node 22 上 Access Viola** — 10天前 — `mem_20261030_016`
5. **install-skills.mjs 和 install-codebuddy.mjs 全面重写为用户** — 11天前 — `mem_20261029_006`
6. **去掉项目级隔离硬编码：所有安装脚本（install-codebuddy.mjs、install-sk** — 11天前 — `mem_20261029_005`
7. **## 跨 IDE 适配完整方案（7 个 IDE）** — 11天前 — `mem_20261029_004`
8. **更新：ESM + TypeScript + esbuild 的架构栈确认通过全部测试** — 10天前 — `mem_20261030_018`
9. **架构决策：使用 ESM 模块系统，不用 CommonJS，因为 Node 22 原生支持且 tree** — 10天前 — `mem_20261030_015`
10. **架构决策：采用 MCP stdio 模式而非 HTTP，因为纯本地无网络依赖更安全，所有 IDE 原** — 10天前 — `mem_20261030_007`
11. **通用经验：npm 发布前要检查 2FA 设置，granular token 在 2027 年被弃用。** — 10天前 — `mem_20261030_006`
12. **决定采用 Node.js 22 + TypeScript + esbuild 的技术栈** — 10天前 — `mem_20261030_003`
13. **## English Test** — 11天前 — `mem_20261029_003`
14. **## 中文测试** — 11天前 — `mem_20261029_002`
15. **## Test entry** — 11天前 — `mem_20261029_001`

---

### Agent 使用指引

1. **开始工作前**: 已经在看这个文件了 ✅
2. **需要更精确搜索**: `recall({ query: "关键词", include_shared: true, limit: 5 })`
3. **完成重要决策**: `remember({ content: "决策内容", tags: ["architecture"] })`
4. **查看邻居项目**: `ReadFile("../{neighbor}/.recall-vault/context.md")`
5. **Session 结束前**: `session_end({ summary: "...", highlights: ["...", "..."] })`