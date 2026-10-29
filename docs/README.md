---
status: confirmed
created: 2026-10-27
updated: 2026-10-27
---

# RecallVault 文档索引

## 阅读顺序

按认知顺序排列，每一步都依赖前一步的结论：

1. **[竞品调研报告](research/competitive-analysis.md)** — GitHub 同类项目全景扫描，10+ 个竞品的能力矩阵和定位分析
2. **[痛点需求分析](requirements/pain-points-analysis.md)** — 4 个核心痛点的底层需求拆解 + 竞品覆盖度评估
3. **[隔离策略专题](architecture/isolation-strategy.md)** — 从"纯物理隔离"到"逻辑隔离+共享层"的决策过程
4. **[架构设计](architecture/design.md)** — 完整架构：目录结构、Frontmatter schema、MCP 工具签名、检索策略
5. **[自动存取路线图](architecture/roadmap.md)** — 基于 7 家竞品源码级深挖的实现方案：FTS5+RRF 融合检索、双时钟 frontmatter、onboard、Eyes 层、追溯索引（8 天实施）
6. **[工作方法](process/working-method.md)** — 开发哲学、MVP 分批、决策模型、验证策略

## 文档规范

### Frontmatter

每个文档顶部必须包含：

```yaml
---
status: draft | confirmed | archived
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

- `draft`：待审阅，内容可能调整
- `confirmed`：已确认锁死，后续变更需显式记录
- `archived`：已废弃，保留供参考

### 引用格式

- 调研数据：`[cite:N]` 内联标注，文档末尾附 `## Sources` 节，每条格式为 `[cite:N] 标题 — URL`
- 架构决策：采用「决策 → 理由 → 备选方案 → 影响」四段式，记录在每个决策点

### 变更记录

- 状态从 `draft` → `confirmed`：更新 frontmatter `updated` 日期，在文档末尾追加一行确认记录
- `confirmed` 文档的内容变更：追加 `## 变更记录` 节，每条记录 `日期 | 变更内容 | 原因`
