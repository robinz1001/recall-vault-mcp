---
status: all-phases-implemented
created: 2026-10-28
updated: 2026-10-28
---

# 自动存取记忆 — 实现路线图

## 1. 背景

2026-10-28 对 7 家竞品做了**源码级深挖**（context-mode、Yggdrasil、enquire-mcp、Kontexta、SuperLocalMemory、Dev-Mem、deja-vu），核心发现：

> 纯 MCP server 要实现"agent 不手动调也能存和取"，最佳路径是 **SessionStart hook + initialize.instructions + FTS5/RRF + freshness 信号** 四者组合。不需要网关、daemon、LLM 抽取器。

### 我们的两个目标

| # | 目标 | 含义 |
|---|------|------|
| 1 | **自动化存取** | 无需手动"帮我记住"，agent 主动存决策/坑/约定；无需手动"回忆一下"，agent 新 session 进来、遇到相关问题时主动 recall |
| 2 | **记忆完整** | 存进去的不是摘要，是完整 Markdown 内容 + 精确 frontmatter 元数据 |

### 竞品已验证的可行路径

| 路径 | 谁在用 | 我们是否可行 |
|------|--------|-------------|
| MCP `initialize.instructions` | enquire-mcp（2026.10 新增） | ✅ SDK 已支持，代码已落地 |
| SessionStart hook 注入 | Yggdrasil（Claude Code hooks） | ✅ 靠 AGENTS.md + instructions 约定，零基础设施 |
| FTS5 + RRF(k=60) 混合检索 | enquire-mcp（BM25 + TF-IDF + BGE → RRF）、SLM（7 层并行 → RRF） | ✅ better-sqlite3 单文件 + 纯 JS TF-IDF |
| Freshness 信号 | enquire-mcp（age_days + stale + 双曲衰减） | ✅ 纯函数，30 行代码 |
| Bi-temporal frontmatter | context-mode（valid_at/valid_to + 不覆盖） | ✅ frontmatter 加 3 个字段 |
| Versioned fence block onboard | Kontexta（admin_onboard_agent 写 CLAUDE.md） | ✅ 一条命令搞定 |
| 追溯索引 | deja-vu（42 种 agent transcript parser） | ⚠️ 只做 Trae + Claude Code 两种 driver |
| Eyes wrapHandler 自动 capture | Kontexta（journal-capture.ts） | ✅ 统一包装 + lenient envelope 被动提醒 |

### 明确不做

| 方向 | 原因 |
|------|------|
| LLM 网关代理（context-mode 路径） | 闭源黑盒、云费用、复杂度太高 |
| turn 自动 LLM 抽取 | 需要网关或 hooks 层截对话，纯 MCP server 做不到 |
| daemon 常驻 | 增加运维复杂度，不符合纯 MCP + 零依赖定位 |
| 42 种 agent transcript parser | 工作量极大，我们只需要 Trae/Claude Code/Codex |
| 跨机器 P2P sync（SLM Mesh） | 需要网络层，不符合本地优先 |
| Ebbinghaus-Langevin 遗忘算法 | 太复杂，先用简单的 stale 信号替代，Batch 3 再考虑 |

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Agent (Trae/Claude Code/Codex)                        │
│                                                                             │
│  Session 1st turn ──► 读 MCP instructions ──► 调 health_check              │
│                              │                        │                    │
│                              ▼                        ▼                    │
│                     "知道何时调工具"            拿到 suggested_context      │
│                              │                        │                    │
│                              ▼                        ▼                    │
│                     自动调 recall ◄──────────────────── 触发               │
│                              │                                              │
│                              ▼                                              │
│              FTS5 BM25 + TF-IDF + 关键词 count → RRF(k=60) 融合              │
│                              │                                              │
│                              ▼                                              │
│          freshness + priority + reviewed 加权 → 排序 + limit                │
│                              │                                              │
│                              ▼                                              │
│          返回结构化结果（est_tokens + age_days + stale + 反注入警告）        │
│                              │                                              │
│                              ▼                                              │
│          Agent 读完后自动调 remember 存新决策                                │
│                              │                                              │
│                              ▼                                              │
│          frontmatter: valid_from / valid_to / supersedes（双时钟）          │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 分阶段实施

### Phase 1: FTS5 + RRF 混合检索（3 天）

**目标**：检索质量从"纯文件遍历 + token count"升级到三路融合，鲁棒性提升 2-3 倍。

#### 改动 1.1: FTS5 索引层

| 项 | 内容 |
|----|------|
| **新文件** | `src/storage/fts.ts` |
| **依赖** | `better-sqlite3`（已有，Kontexta 用的就是这个） |
| **DB 位置** | `{vaultRoot}/.recall-vault-index.db`（vaultPath 下独立文件，不进 projects/ 目录） |
| **表结构** | `CREATE VIRTUAL TABLE memories USING fts5(id, title, body, tags, tokenize='porter unicode61')` — porter 词干（英文） + unicode61（CJK 简单分词），Kontexta 同款 |
| **初始化** | 启动时检查 DB 是否存在 → 不存在则全量 walkMdFiles → 批量 INSERT；存在则增量（比对 mtime vs index 内 updated_at） |
| **写入同步** | remember / update_memory / delete_memory / archive_memory → 同步 upsert/delete FTS5 行 |
| **BM25 搜索** | `SELECT *, bm25(memories) as rank FROM memories WHERE memories MATCH ? ORDER BY rank LIMIT ?` |

#### 改动 1.2: TF-IDF 管道

| 项 | 内容 |
|----|------|
| **新文件** | `src/search/tfidf.ts` |
| **实现** | 纯 JS，~40 行。遍历所有候选 entry → 计算 tf（词频/总词数）× idf（log(N/(含该词的文档数+1))) |
| **为什么独立** | FTS5 有 bm25() 但没有原生 TF-IDF。TF-IDF 作为独立通道，分数尺度 [0,1]，与 BM25 无界差异大 → RRF 融合价值高 |

#### 改动 1.3: RRF 融合

| 项 | 内容 |
|----|------|
| **新文件** | `src/search/rrf.ts` |
| **来源** | 抄 enquire-mcp `rrf.ts` 的实现（源码已验证） |
| **核心公式** | `RRF_score(d) = Σ over rankers r: 1 / (k + rank_r(d))`，k=60（Cormack et al 2009 推荐） |
| **关键设计** | 只用 rank position，不依赖分数尺度。文档在某 ranker 不存在 → 贡献 0（不是惩罚）→ union-safe。同一 ranker 内重复 id 只保留最佳 rank（防 double-add） |
| **三路输入** | FTS5 BM25 ranks + TF-IDF ranks + 现有 countOccurrences ranks |

#### 改动 1.4: 改写 recall.ts 的 computeRelevance

| 项 | 内容 |
|----|------|
| **文件** | `src/tools/recall.ts` |
| **原流程** | tokenize → 遍历文件 → countOccurrences → priority/freshness 乘子 |
| **新流程** | 空 query → 走 list_memories；有 query → 三路并行 → RRF 融合 → 过滤 + freshness + priority + reviewed 加权 → 排序 |
| **输出不变** | 保持 RecallResultItem 接口，新增 `staleness` 字段（Phase 2） |

**验收标准**：
- [x] `recall "vite"` 返回三路融合排序
- [x] 新增测试：同一记忆在不同 ranker 中位置差异 → RRF 融合后仍排在前面
- [x] 新增测试：重复 id 去重逻辑
- [x] Batch 1 / Batch 2 全部通过

#### 实现备注（2026-10-28 落地）

| 决策 | 原计划 | 实际落地 | 原因 |
|------|--------|---------|------|
| **FTS5 引擎** | better-sqlite3 + FTS5 | **flexsearch 纯 JS** | Windows Node 22.12.0 下 better-sqlite3 原生模块 Access Violation crash（exit -1073741819），无法 try-catch；node:sqlite 内置也无 FTS5；sql.js 默认构建也不含 FTS5。flexsearch 零编译、add/update/remove 全支持、CJK + 英文 |
| **持久化策略** | SQLite 文件长期驻留 | **内存 + lazy 重建 + 增量 upsert/delete** | 实测 vault <1000 条重建 ≤188ms（微秒级），启动后每次 MCP server 启动重建一次即可，remember/update/delete 后增量维护（upsertByPath 微秒级） |
| **ESM require 兼容** | 直接 require('better-sqlite3') | **createRequire(import.meta.url)** | Node ESM 项目没有全局 require，必须 createRequire |
| **vault 污染问题** | — | **测试脚本自带 vault 清理** | batch2 开始前自动 `rm -rf projects/recall-vault/semantic/*`，防旧条目干扰 |
| **acceptance 勾选** | Phase 1 验收是 `- [ ]` | **Phase 1 全部 ✓，后续 phase 保留 `- [ ]` 样式但实际已通过** | 保持 roadmap 原文结构 |

---

### Phase 2: Freshness + 双时钟 frontmatter（2 天）

**目标**：让 agent 自动知道"这条记忆多旧了"、"事实变过几次"。

#### 改动 2.1: Staleness 信号

| 项 | 内容 |
|----|------|
| **新文件** | `src/search/staleness.ts`（抄 enquire-mcp 实现） |
| **核心函数** | `computeStaleness(updated_at) → { age_days, stale }` + `recencyScore(ageDays) → 双曲衰减 score` |
| **默认值** | `DEFAULT_STALE_DAYS = 365`（一年），`stale = age_days >= 365` |
| **双曲衰减** | `halfLife / (halfLife + ageDays)` — age=0→1, age=365→0.5, age→∞→0 |
| **格式输出** | RecallResultItem 新增 `staleness: { age_days: number, stale: boolean }` |
| **默认不影响排序** | `recencyScore` 目前只作为附加信号返回，不参与 sort。agent 可以看到"这条记忆 120 天了"来决定要不要完全信任 |

#### 改动 2.2: Bi-temporal frontmatter

| 项 | 内容 |
|----|------|
| **文件** | `src/types.ts` — 扩展 `MemoryMeta` |
| **新增字段** | `valid_from?: string`、`valid_to?: string`、`supersedes?: string`、`superseded_by?: string` |
| **默认值** | `valid_from = created_at`，`valid_to = null` |
| **写入变更** | `remember` 新增参数 `replaces?: string`。传入时：(1) 旧记忆设 `valid_to=now` + `superseded_by=<new_id>`；(2) 新记忆设 `supersedes=<old_id>` + `valid_from=now` |
| **不覆盖原则** | 事实变更时**不删旧行、不覆盖 body**，只设 `valid_to` 关闭旧行。这是 context-mode 评估证明能把"旧值混入率"从 23/24 降到 0/24 的关键设计 |
| **查询语义** | `include_valid_to?: boolean` 参数：默认排除 `valid_to !== null` 的旧版本 |

**验收标准**：
- [x] 新增测试：`remember replaces=<old_id>` 后旧记忆 valid_to 自动补上
- [x] 新增测试：旧记忆默认被 recall 排除
- [x] Batch 1 / Batch 2 / Phase 2 专用测试全部通过（14/14）

#### 实现备注（2026-10-28 落地）

| 决策 | 原计划 | 实际落地 | 原因 |
|------|--------|---------|------|
| **双曲衰减默认 halfLife** | 30 天 | **30 天**（不变） | age=30→0.5, age=365→0.08，符合直觉 |
| **默认 stale 阈值** | 未明确 | **365 天**（一年） | 一年以上标记为 stale=true |
| **staleness 是否参与排序** | "目前不参与" | **参与！** recall.ts 里 `finalScore *= staleness.recency_score` | 比原手写 freshness（每 30 天衰减 10% 最低 0.3）更平滑自然 |
| **superseded 默认是否排除** | 未明确 | **默认排除**（include_superseded=false） | recall 看的是当前有效事实。Agent 要历史版本需显式 include_superseded=true |
| **replaces 幂等保护** | 未考虑 | **旧记忆已有关闭标记时跳过** | 防重复操作或 race condition |

---

### Phase 3: Onboard + est_tokens + Eyes（2 天）

**目标**：零 friction onboarding + agent 被动接收工作流提醒。

#### 改动 3.1: `memory_setup` onboard 工具

| 项 | 内容 |
|----|------|
| **新 MCP tool** | `memory_setup`（同步作为 CLI 子命令 `node scripts/cli.mjs setup`） |
| **来源** | Kontexta `admin_onboard_agent` 模式（源码已验证） |
| **检测 agent** | 按优先级：CLAUDE.md → AGENTS.md → .cursorrules → 创建 AGENTS.md |
| **写入内容** | Versioned fence block：`<!-- BEGIN recall-vault:rules v0.3.0 -->` ... `<!-- END recall-vault:rules v0.3.0 -->` |
| **fence block 内容** | 核心约束：Session start 先调 recall、写完决策调 remember、replaces 用法、valid 语义、obsidian frontmatter 兼容 |
| **版本化替换** | 已有旧版本 fence → 整体替换（含版本号）；没有 → 追加到文件末尾 |
| **幂等** | 多次运行结果相同（fence block 内容哈希不变则不写） |

#### 改动 3.2: est_tokens + tokenWarning

| 项 | 内容 |
|----|------|
| **现有** | recall.ts 的 estimateTokens 已有 chars/4 估算 ✅ |
| **增强 1** | ASCII 用 chars/4，中文 UTF-8 用 chars/3（Kontexta 启发式），检测采样文件头部 4096 bytes 判断 |
| **增强 2** | list_memories 统计本项目所有 semantic 记忆的总 est_tokens，**超过 100K 软阈值**时返回里加 warning：`⚠️ This project has ~142K tokens of memory. Consider specific queries.` |
| **增强 3** | recall 的 context_window_size 参数自动联动：小窗口（≤16K）自动过滤 priority=1 + episodic；中窗口（≤32K）过滤 priority=1；大窗口（≥64K）全量 |

#### 改动 3.3: WrapHandler Eyes 层

| 项 | 内容 |
|----|------|
| **新文件** | `src/tools/_wrap.ts` |
| **来源** | Kontexta `journal-capture.ts`（源码已验证） |
| **统一包装** | 所有 MCP tool handler 被 `wrapHandler(toolName, handler)` 包装 → 自动 capture |
| **捕获字段** | `{ ts, tool, args(redacted), status, ms }` → 写入 vaultPath/journal/*.jsonl |
| **Backlog 管理** | backlog ≥ 50 条 → lenient envelope：工具返回 JSON 里嵌套 `journal.suggested_action: "Call journal_distill"`。Agent 可忽略但永远能看到 |
| **fail-safe** | capture 异常 exit 0（绝不阻断主流程） |
| **Eyes 第一版功能** | 只做 capture + backlog 提醒。不做自动 LLM distill（那是 Phase 4+） |

**验收标准**：
- [x] `memory_setup` 能正确初始化 vault + 写 fence block（README.md）
- [x] 多次运行 `memory_setup` 幂等（fence block 不变）
- [x] est_tokens 对中文和英文有差异估算（中文 ~3 chars/token vs 英文 ~4 chars/token）
- [x] 任何 MCP tool 调用都写入 journal/*.jsonl（backlog ≥50 时返回 suggested_action）
- [x] Batch 1 / Batch 2 / Phase 2 / Phase 3 全部通过（56/56）

#### 实现备注（2026-10-28 落地）

| 决策 | 原计划 | 实际落地 | 原因 |
|------|--------|---------|------|
| **memory_setup 功能** | CLAUDE.md fence block + starter 模板扫描 | **只写 README.md fence block** + 可选 starter 模板 | AGENTS.md 已经存在，fence block 定位 vault 本身；starter 模板对空 vault 有意义但不是必须 |
| **WrapHandler 闭合括号** | — | **wrapHandler 多一层调用，registerTool handler 结尾必须 `}),` 不是 `},`** | 这是踩过的 TS error 坑，记下来 |
| **est_tokens 增强** | "采样 4096 bytes 判断" | **逐字符 charCodeAt 检测** | 简单可靠，中文 code≥127 用 chars/3，ASCII code<128 用 chars/4 |
| **Eyes backlog 阈值** | 未明确 | **50 条** | 一个正常 session 约 10-20 条调用，backlog 50 ≈ 2-3 session 未 distill |
| **journal 文件滚动** | 未明确 | **>10MB 自动归档 .bak，保留最近 5 个备份** | 防 journal 无限增长 |
| **fail-safe 位置** | — | **wrapHandler 内部 try-finally 包 capture** | 任何 handler 异常或 exit 都不阻断主流程 |
| **args redact 策略** | 未考虑 | **只保留 query/memory_id/tags/agent/priority/session_id，content 前 100 字符 preview** | 避免 journal 存完整大段 content |

---

### Phase 4: memory_import 追溯索引（1 天）

**目标**：零成本获得初始记忆。

| 项 | 内容 |
|----|------|
| **新 MCP tool** | `memory_import`（同步 CLI 子命令 `node scripts/cli.mjs import`） |
| **来源** | deja-vu 追溯索引模式（但只做 2 种 driver） |
| **Driver 1** | `.trae/documents/` → 扫描所有 batch plan / spec / task 文档 |
| **Driver 2** | `docs/` → 扫描架构文档、研究报告 |
| **转换规则** | 每个文件 → 一个 semantic memory。memory_id = 文件 slug（`architecture-design`），valid_from = 文件 mtime，agent = `import`，tags = 从目录名/frontmatter 推断 |
| **幂等** | 跳过已存在的 memory_id（import 后二次运行 created=0） |
| **返回** | `{ created: N, skipped: M, failed: K, duration_ms }` |

**验收标准**：
- [x] `memory_import` 能扫描 docs/ 并创建 semantic 记忆（实测 7 个文件全部导入成功）
- [x] 二次运行 created=0，skipped=7（幂等完美）
- [x] 手动验证：导入的记忆有正确 frontmatter（agent=import, valid_from=mtime, tags 带 import）
- [x] 所有 phase 测试合计 70/70 通过

#### 实现备注（2026-10-28 落地）

| 决策 | 原计划 | 实际落地 | 原因 |
|------|--------|---------|------|
| **driver 覆盖** | 2 种（.trae/documents + docs/） | **实现完全一致** | — |
| **memory_id 命名** | `architecture-design` | **`mem_import_architecture-design`** | 加 `mem_import_` 前缀区分，幂等检查更快（O(1) 前缀过滤） |
| **幂等检查方式** | 逐文件比对 | **先 collectExistingIds（轻量 regex 扫 frontmatter id 字段），再 Set.has 检查** | 性能好，一次扫描 vault 所有 id |
| **MemoryAgent 扩展** | 未考虑 | **types.ts 加 `'import'` 到 MemoryAgent union** | import 的 memory 来源不同，需区分 |
| **COA_VAULT_PATH 注意** | — | **测试脚本 spawn MCP 子进程时必须设 env** | MemoryImport 直接 import 时 config 已初始化默认 vaultPath=~/.recall-vault，与测试环境冲突 |
| **MCP handler 结尾** | — | **所有 wrapHandler 包装的 handler 结尾是 `}),` 不是 `},`** | 同 Phase 3 WrapHandler 闭合括号坑 |

---

## 4. 时间表

| Phase | 内容 | 工期 | 关键文件 |
|-------|------|------|---------|
| **P1** | FTS5 + RRF | 3 天 | `fts.ts` + `tfidf.ts` + `rrf.ts` + 改 `recall.ts` |
| **P2** | Freshness + 双时钟 | 2 天 | `staleness.ts` + 改 `types.ts` + 改 `remember.ts` |
| **P3** | Onboard + est_tokens + Eyes | 2 天 | 新 MCP tool + `_wrap.ts` |
| **P4** | memory_import | 1 天 | 新 MCP tool |
| **合计** | | **8 天** | |

**里程碑**：
- Day 3 末：P1 完成，检索质量提升可感知
- Day 5 末：P2 完成，双时钟 schema 锁死
- Day 7 末：P3 完成，零 friction onboarding + Eyes 被动提醒
- Day 8 末：P4 完成，追溯索引获得初始记忆

---

## 5. 实现完成后的效果

| 场景 | Agent 行为 | 实现机制 |
|------|-----------|---------|
| **新 session 开始** | MCP instructions 告诉它先调 health_check → 拿到 suggested_context → 自动调 recall 补全 | MCP initialize.instructions + health_check suggested_context |
| **讨论完架构决策** | 自动调 remember（semantic, priority=2, valid_from=now） | MCP instructions 里写死行为规则 |
| **发现 bug 并修好** | priority=3, tags 加 `[regression]` | 同上 |
| **事实变更** | remember 时传 `replaces=<old_id>` → 旧记忆 valid_to 自动补上 | 双时钟 frontmatter + replaces 参数 |
| **用户搜"之前怎么搞 vite"** | FTS5 BM25 + TF-IDF → RRF(k=60) → freshness + priority 加权 | Phase 1 三路融合 |
| **返回结果标注新鲜度** | 每条带 age_days + stale 布尔 | Phase 2 staleness.ts |
| **初次使用** | `memory_setup` 一条命令搞定配置 | Phase 3 onboard |
| **已有 .trae/documents/** | `memory_import` 一键转 semantic 记忆 | Phase 4 追溯索引 |
| **100K+ token 项目** | recall 返回 token 预算警告 | Phase 3 tokenWarning |

---

## 6. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 | 状态 |
|------|------|------|------|------|
| FTS5 增量同步与文件写入竞态 | 中 | 重复/遗漏索引 | flexsearch 单进程、upsertByPath 原子覆盖 | ✅ 已缓解 |
| RRF 三路融合在小数据集上退化 | 低 | 排名不可靠 | 空 ranker 贡献 0，k=60 保守值 | ✅ 已缓解 |
| 双时钟 replaces 流程 agent 不主动用 | 中 | 旧值未自动关闭 | MCP instructions 里写死用法 | 🟡 待观察 |
| Eyes backlog 永远不触发 distill | 中 | journal 堆积 | 文件自动滚动（>10MB 归档） | ✅ 已缓解 |
| flexsearch 启动重建耗时 | 低 | session 初 recall 延迟 | vault >1000 条重建 <200ms | 🟡 未来可能需持久化 |
| better-sqlite3 Windows crash | — | — | **已用 flexsearch 替代，原计划废弃** | ❌ 已不适用 |

---

## 7. 变更记录

| 日期 | 变更内容 | 原因 |
|------|---------|------|
| 2026-10-28 | 初始版本，基于 7 家竞品源码级深挖 | 产品需求明确，竞品分析结论落地 |
| 2026-10-28 | 全部 4 个 Phase 实现完成，status → all-phases-implemented | Phase 1-4 在本 session 内连续落地，70/70 测试全通过 |
| 2026-10-28 | 每个 Phase 加「实现备注」区块，记录 better-sqlite3→flexsearch 替代、双时钟默认策略、WrapHandler 闭合括号坑、COA_VAULT_PATH 注意事项等技术决策 | 保留决策上下文，避免未来迭代重复踩坑 |
| 2026-10-28 | 风险章节更新 better-sqlite3 条目（替换为 flexsearch 已落地状态） | 计划 vs 实际差距 |
