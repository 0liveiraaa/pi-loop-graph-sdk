# 任务 07：导航、质量与最终收口

## 目标

在其他任务完成后统一导航、删除重复入口并建立防漂移检查。这是最后执行的集成任务。

## 修改范围

- 根 `README.md` 中的文档链接。
- `docs/README.md`。
- `docs/设计/README.md`、`docs/形态/README.md`，必要时删除或改为短跳转页。
- `src/docs-consistency.test.ts` 及必要的文档测试辅助代码。
- 旧 `developer-guide.md`、`implementation-status.md` 的归档或短跳转处理。

## 推荐默认阅读顺序

```text
README
→ Getting Started
→ Concepts（按需要）
→ Task Guides
→ API Reference
```

Internals、ADR、Research 和 Archive 不出现在新用户的线性必读路径中。

## 旧文档处理

- `developer-guide.md`：内容拆分完成后移入归档，或缩为目录跳转页；不得与新 guides 重复维护。
- `implementation-status.md`：压缩为“能力矩阵 + 已知限制”，实施阶段历史移入归档/changelog。
- 旧计划链接必须指向真实归档位置。
- 删除 README 索引中的重复表头、重复链接和过期日期。

## 自动检查建议

- 验证 Markdown 相对链接存在。
- 将 README/getting-started 的 TypeScript 示例提取后执行 typecheck。
- 检查默认阅读路径中不得出现未解释的 `scopeId`、`visit`、GraphCallScope。
- 检查公开能力列表不得包含 communication research 中的未实现能力。
- 避免在多个文件硬编码测试总数；如必须展示，由单一脚本生成。

## 最终验收场景

请让一个没有项目上下文的 agent 只阅读 README 和 getting-started，然后回答：

1. 项目当前支持什么、不支持什么？
2. 如何创建并注册第一张图？
3. Node、Completion、Edge 和 Frame 分别负责什么？
4. 什么时候使用 call、compose、delegate？
5. 去哪里查询 Mechanism 和配置项？

若无法准确回答，说明导航或概念解释仍未完成。

