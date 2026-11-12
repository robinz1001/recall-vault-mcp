# recall-vault — RecallVault 上下文
> 同步: 2026-11-12 01:53:32  |  Vault: `C:/Users/robin/.recall-vault/projects/recall-vault`
> **这是磁盘上的真实文件，任何 IDE 的 agent 都可以直接 ReadFile**

## 📋 项目画像
目标: 跨会话记忆持久化；多 IDE 共享 vault · 技术栈: TypeScript · Node.js · flexsearch · MCP stdio

## 🔥 关键记忆
- ⚠️ **【Theia 1.76 在 ViewContainer part 内嵌 TreeWidget「永久空白」的三个叠加根因与** (1天前)
  - 【Theia 1.76 在 ViewContainer part 内嵌 TreeWidget「永久空白」的三个叠加根因与修复（2026-11-11 实证）】 场景：把自定义 TreeWidget 通过 `explorer.addWidget…
  - 📎 `C:/Users/robin/.recall-vault/shared/semantic/mem_20261111_001.md`

- ⚠️ **recall-vault 的 MCP 工具不可用时（session_start/recall/remember/sess** (10天前)
  - recall-vault 的 MCP 工具不可用时（session_start/recall/remember/session_end/health_check 全都不在可用工具列表里，或调用报 isError），降级路径是**直接写 va…
  - 📎 `C:/Users/robin/.recall-vault/shared/semantic/mem_20261102_007.md`

- ⚠️ **recall-vault v0.4.6 工作流要点：** (10天前)
  - recall-vault v0.4.6 工作流要点： 1. session_start / remember / recall 必须传 workspace_path（v0.4.5 新增），否则 project_id 被错误推断为用户 hom…
  - 📎 `C:/Users/robin/.recall-vault/shared/semantic/mem_20261102_006.md`

- ⚠️ **## 关键教训：MCP SERVER_INSTRUCTIONS vs SKILL.md — 必须永远同步** (13天前)
  - ## 关键教训：MCP SERVER_INSTRUCTIONS vs SKILL.md — 必须永远同步 ### 问题 改了 SKILL.md v4（加了 Search-before-Grep、Recall-before-remember、…
  - 📎 `C:/Users/robin/.recall-vault/projects/recall-vault/semantic/mem_20261030_1702.md`

- ⚠️ **踩坑：better-sqlite3 在 Windows Node 22 上 Access Violation 崩溃。修复** (13天前)
  - 踩坑：better-sqlite3 在 Windows Node 22 上 Access Violation 崩溃。修复方案：替换为纯 JS flexsearch。这个 bug 花了我 2 小时才定位。
  - 📎 `C:/Users/robin/.recall-vault/projects/recall-vault/semantic/mem_20261030_016.md`

## 🔗 关联项目
- **mfel-studio** → `../../mfel/mfel-studio/.recall-vault/context.md` — NForge 是一个产品（专业物理计算软件生成平台）；NForge Core / Studio / Cloud 是三个发
- **newtonrank.com** → `../../mfel/newtonrank.com/.recall-vault/context.md`
- **vscode-plugin** → `../../mfel/vscode-plugin/.recall-vault/context.md` — MFEL VS Code 扩展（L2 适配层）：为 FEPG/MFEL 有限元工作流提供 `.mac` 项目编辑、生成、
- **temp_20261109_02** → `../../../Documents/Trae-CN/temp_20261109_02/.recall-vault/context.md`

> 💡 跨项目读取: `ReadFile("../{neighbor}/.recall-vault/context.md")` 即可拿到邻居的完整上下文。

## 📖 记忆索引
1. **【Theia 1.76 在 ViewContainer part 内嵌 TreeWidget「永久空** — 1天前 — `mem_20261111_001`
2. **recall-vault 的 MCP 工具不可用时（session_start/recall/rem** — 10天前 — `mem_20261102_007`
3. **recall-vault v0.4.6 工作流要点：** — 10天前 — `mem_20261102_006`
4. **## 关键教训：MCP SERVER_INSTRUCTIONS vs SKILL.md — 必须永远** — 13天前 — `mem_20261030_1702`
5. **踩坑：better-sqlite3 在 Windows Node 22 上 Access Viola** — 13天前 — `mem_20261030_016`
6. **install-skills.mjs 和 install-codebuddy.mjs 全面重写为用户** — 13天前 — `mem_20261029_006`
7. **去掉项目级隔离硬编码：所有安装脚本（install-codebuddy.mjs、install-sk** — 13天前 — `mem_20261029_005`
8. **## 跨 IDE 适配完整方案（7 个 IDE）** — 14天前 — `mem_20261029_004`
9. **更新：ESM + TypeScript + esbuild 的架构栈确认通过全部测试** — 13天前 — `mem_20261030_018`
10. **架构决策：使用 ESM 模块系统，不用 CommonJS，因为 Node 22 原生支持且 tree** — 13天前 — `mem_20261030_015`
11. **架构决策：采用 MCP stdio 模式而非 HTTP，因为纯本地无网络依赖更安全，所有 IDE 原** — 13天前 — `mem_20261030_007`
12. **通用经验：npm 发布前要检查 2FA 设置，granular token 在 2027 年被弃用。** — 13天前 — `mem_20261030_006`
13. **决定采用 Node.js 22 + TypeScript + esbuild 的技术栈** — 13天前 — `mem_20261030_003`
14. **## English Test** — 14天前 — `mem_20261029_003`
15. **## 中文测试** — 14天前 — `mem_20261029_002`
16. **## Test entry** — 14天前 — `mem_20261029_001`

---

### Agent 使用指引

1. **开始工作前**: 已经在看这个文件了 ✅
2. **需要更精确搜索**: `recall({ query: "关键词", include_shared: true, limit: 5 })`
3. **完成重要决策**: `remember({ content: "决策内容", tags: ["architecture"] })`
4. **查看邻居项目**: `ReadFile("../{neighbor}/.recall-vault/context.md")`
5. **Session 结束前**: `session_end({ summary: "...", highlights: ["...", "..."] })`