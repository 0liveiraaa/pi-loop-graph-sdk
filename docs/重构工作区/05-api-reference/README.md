# 任务 05：公共 API 参考

## 目标

建立可查询但不承担教学任务的公共 API 参考。内容必须与 `src/index.ts` 和 `src/type.ts` 当前导出一致。

## 目标目录

创建 `docs/重构工作区/05-api-reference/reference/`：

- `api.md`：核心类型和工厂。
- `configuration.md`：`LoopGraphExtensionOptions`、limits、mechanismRuntime 等配置。
- `lifecycle.md`：Node、Agent run、turn、tool、completion、cleanup 顺序。
- `errors-and-limits.md`：failurePolicy、超时、最大步骤、工具校验和并发限制。

## 覆盖范围

- `createLoopGraphExtension`
- Graph/Entry/Node/Edge/Router/END
- NodeContext、AgentRunRequest、NodeCompletion、GraphRunResult
- Mechanism 全部 Hook、scope、events、exec、decisions、state、context append
- renderer、skill provider/renderer、model message formatter
- logger、traceSink、formatToolResult、toolResolver
- delegate host 和 isolated session factory

## 规则

- 只记录公共导出，不为内部类建立参考页面。
- 参数解释优先，源码签名只保留最小必要部分。
- 标注默认值、是否可选、失败行为和是否跨 delegate 传播。
- deprecated API 必须明确替代项。
- 不手写测试数量和实施 Phase。

## 验收

- `src/index.ts` 的每个重要导出都能在参考文档中查到。
- `LoopGraphExtensionOptions` 当前所有字段均有解释。
- lifecycle 顺序与实际代码一致。
- 不把 `ExtensionAPI` 上游能力重新复制成本站完整文档，只链接 pi 官方定义。
