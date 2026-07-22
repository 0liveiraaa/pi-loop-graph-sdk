# 控制节点可用工具

## 适用场景

你需要精确控制每个节点中模型能调用哪些工具。

## 三层权限模型

```text
Host Tool Catalog（真实工具实现，构成最终能力边界）
  → Graph Tool Policy（图声明允许的工具全集）
    → Node Tool Set（节点从图权限中选择实际启用的集合）
      → Runtime Protocol Tool（强制注入 __graph_complete__）
```

## 声明工具权限

### Graph：toolSet

```typescript
import { toolSet, defineGraph } from "pi-loop-graph-sdk";

const graph = defineGraph({
  // ...
  tools: toolSet("read", "review_chapter", "review_answer"),
});
```

### Node：tools 字段

```typescript
// 选择图声明的部分工具
const reviewNode = agentNode({
  subGoal: "出题并批改",
  tools: ["review_chapter", "review_answer"],
});

// 选择全部：tools: "all"
const 全功能节点 = agentNode({
  tools: "all",
});

// 不声明：无业务工具（只有 __graph_complete__）
const 只提交节点 = agentNode({
  // tools 省略
});
```

## 工具解析规则

- Node 不能启用 Graph 未声明的业务工具
- Host 有实现但 Graph 未声明 → 模型拿不到
- Graph 声明但 Node 未选择 → 模型拿不到
- `__graph_complete__` 由 Runtime 强制注入，不计入 Graph Policy
- `read` 是普通业务工具，需 Graph 声明 + Node 选择才能使用

## 子图的工具权限

子图使用**自己的 Graph Tool Policy**，不继承父图权限。父图不需要重复声明子图的内部工具。Host 缺失子图需要的工具时在预运行阶段失败。

## 高级：unsafe resolver

`advanced` 子路径提供 unsafe tool resolver，可越过 Graph Policy 但记录 warning。协议工具和 Host 实际能力边界仍不可绕过。普通业务不应使用。

## 运行过程

`registerGraph` 或 `execute` 时自动执行 capability preflight：
1. 检查 Graph Policy 中的工具是否都在 Host Catalog 中存在
2. 检查 Node Tool Set 是否都在 Graph Policy 中
3. 检查子图依赖的工具在 Host Catalog 中是否存在

任一失败 → 注册/执行前报错，不进入执行。

## 相关文档

- [API 参考](../reference/api.md) — toolSet 签名
- [子图调用边界](../concepts/subgraph-boundaries.md) — 子图权限隔离
- [配置项](../reference/configuration.md) — Host Tool Catalog
