# 任务 07：迁移、导航、质量检查与最终收口

## 当前前提

00、02、03、04、05 已在重构工作区完成审查和校正；06 已产出内部设计草稿。01 仍需重写，当前的 `README copy.md` 不符合根 README 验收要求，不能直接迁移。

本任务不再负责创作大篇新内容。它负责把已经通过审查的工作区成果迁移到正式目录，建立唯一导航，并验证迁移后没有断链、重复真相源或明显代码漂移。

## 执行顺序

1. 先完成并复核 01 根 README。
2. 再复核 06 的内部设计草稿与源码是否一致。
3. 确定正式目录映射并迁移 00–06 的成品。
4. 建立根 README 与 `docs/README.md` 两级导航。
5. 归档或缩短旧文档，避免新旧内容并行维护。
6. 运行链接、代码示例、术语和公开能力一致性检查。
7. 让无上下文读者完成最终验收。

在第 1、2 步完成前，不应把工作区整体覆盖到正式文档目录。

## 正式目录映射

迁移时采用下面的目标结构；若实际仓库约定不同，应先统一修改本表和所有导航，不能同时保留两套路径。

| 工作区来源 | 正式目标 |
| --- | --- |
| `00-glossary-and-truth/CONTEXT.md` | `docs/设计/CONTEXT.md` |
| `01-root-readme/` 中最终通过验收的成品 | 根 `README.md` |
| `02-getting-started/GETTING_STARTED.md` | `docs/getting-started.md` |
| `03-concepts/concepts/*.md` | `docs/concepts/*.md` |
| `04-task-guides/guides/*.md` | `docs/guides/*.md` |
| `05-api-reference/reference/*.md` | `docs/reference/*.md` |
| `06-design-and-internals/draft/core-design.md` | `docs/design/core-design.md` |
| `06-design-and-internals/draft/internals/*.md` | `docs/internals/*.md` |
| `06-design-and-internals/draft/research/*.md` | `docs/research/*.md` |
| `06-design-and-internals/draft/adr-review.md` | 作为 ADR 整理清单使用，不直接当成用户文档发布 |

迁移后删除或归档工作区中的临时命名，例如 `README copy.md`、`draft/` 和任务说明 README；它们不能出现在正式用户导航中。

## 导航结构

### 根 README

根 README 只承担产品入口职责：

```text
项目定位与 alpha 提示
→ 适用和不适用场景
→ library 安装
→ 最小示例
→ 当前限制
→ 文档导航
```

不得放置完整 API 表、源码文件树、硬编码测试数量或旧文档目录。

### docs/README.md

建立一个新的文档首页，按读者任务分组：

```text
第一次使用
  → Getting Started

理解系统
  → Graph Model
  → Context and State
  → Subgraph Boundaries
  → Mechanisms

完成具体任务
  → Guides

查询精确签名和行为
  → API Reference

维护 SDK
  → Design / Internals / ADR

非当前能力
  → Research
```

默认阅读路径是：

```text
README → Getting Started → Concepts（按需）→ Guides → API Reference
```

Design、Internals、ADR、Research 和 Archive 不进入新用户线性必读路径。

## 旧文档处理

- `docs/形态/developer-guide.md`：新教程、概念、指南和参考文档完成迁移后，移入 `docs/archive/`，或缩成只包含新入口链接的跳转页。
- `docs/形态/implementation-status.md`：若仍有发布价值，只保留当前能力矩阵和已知限制；Phase 历史移入 archive 或 changelog。
- 旧设计总文档：与新的 `core-design.md` 对照去重。仍有价值但不适合当前正文的历史推演移入 archive。
- `docs/设计/README.md`、`docs/形态/README.md`：改为短导航或删除，不能继续维护另一套完整目录。
- ADR：保留真实决策记录；按 `adr-review.md` 检查状态、重复项和失效链接，不因文档重构改写历史结论。
- Archive 内容必须标明“历史资料，不代表当前公共行为”，并从默认阅读路径移除。

归档前先搜索外部链接和仓库内引用；移动后为高频旧入口保留短跳转页，避免无提示断链。

## 必须建立的自动检查

建议新增 `src/docs-consistency.test.ts`，或使用等价的独立脚本，并接入现有测试命令。

### 1. Markdown 链接

- 验证正式文档中的相对文件链接和锚点存在。
- 忽略明确允许的外部 URL，但报告空链接和仍指向 `docs/重构工作区` 的链接。
- 检查根 README 与 `docs/README.md` 中的所有入口。

### 2. TypeScript 示例

- 至少提取根 README 和 `docs/getting-started.md` 的完整示例执行 typecheck。
- 示例必须只使用 `src/index.ts` 的公开导出。
- END 边必须显式使用 `MigrationResult.output`。
- 禁止在新示例中使用 deprecated `runAgent.tools` 或把兼容 frame 字段当固定结构。

### 3. 公开 API 与配置覆盖

- 对照 `src/index.ts` 检查重要公共导出在 `docs/reference/` 中可查询。
- 对照 `LoopGraphExtensionOptions` 检查配置字段无遗漏。
- 对照 `LoopGraphLifecycleEvent` 检查文档没有虚构事件。
- 对照 `PiNodeContext` 检查验证顺序保持为：

```text
outputSchema
→ runAgent.validateCompletion
→ Node.validateCompletion
→ Mechanism.validateCompletion
→ agent-choice 校验
```

### 4. 术语和能力边界

- 默认阅读路径中不得无解释出现 `scopeId`、`visit`、`GraphCallScope`、broker、WeakMap。
- `scope` 首次面向用户出现时解释为当前节点执行周期。
- `ctx.pi` 必须描述为完整但非托管，并且只能出现在 Mechanism 上下文中。
- 不得宣称支持 fork/join、并行 Agent、多 Agent 通讯或会话恢复。
- call、compose、delegate 的 Session、AgentInstance 和工作记忆关系必须与 `docs/设计/CONTEXT.md` 一致。

### 5. 易漂移内容

- 不在文档中硬编码测试总数、测试文件数或未经验证的“真实 LLM 测试”声明。
- 默认 debug 不写文件；只有 `debug: true` 才启用 JSONL。
- 不使用“生产稳定”“适用于所有场景”等无法验证的宣传语。
- 不保留日期已经失效的实施状态或 Phase 完成表。

## 人工一致性检查

自动检查不能代替以下人工核对：

- 04 的任务指南是否围绕用户任务，而不是重新变成 API 手册。
- 05 的参考文档是否只陈述精确行为，不承担入门教学。
- 06 是否明确区分公共契约、内部实现和研究设想。
- 同一事实是否只有一个权威定义；其他文件应链接而不是复制长表。
- 旧文档归档后，新导航是否仍能覆盖其有效内容。

## 最终验收

### 工程检查

- `npm run typecheck`
- `npm test`
- Markdown 相对链接和锚点检查通过
- README 与 Getting Started 示例 typecheck 通过
- 正式文档中不存在指向重构工作区或待归档正文的链接
- `git diff --check` 通过

### 无上下文读者检查

让一个没有项目上下文的 Agent 只阅读根 README 和 Getting Started，然后回答：

1. 项目当前支持什么、不支持什么？
2. 如何安装 SDK、创建 extension 并注册第一张图？
3. Node、Completion、Edge 和 Frame 分别负责什么？
4. END 边如何明确返回图结果？
5. 去哪里学习循环、自动验证、Mechanism 和子图？

再允许它阅读 Concepts 和文档首页，继续回答：

6. 什么时候选择 call、compose 或 delegate？
7. 什么时候使用 Frame，什么时候使用 Mechanism state？
8. 去哪里查询配置项、生命周期和错误行为？

回答错误时，应定位到缺失或互相矛盾的文档并修复，不能通过向验收 Agent 补充口头上下文来放行。

## 完成定义

只有同时满足以下条件，任务 07 才算完成：

- 01 和 06 已通过最终复核；
- 00–06 成品已迁移到唯一正式路径；
- 根 README 和 `docs/README.md` 导航生效；
- 旧正文已归档或变成短跳转，不再形成第二真相源；
- 自动与人工检查全部通过；
- 无上下文读者能够完成上述验收问题。
