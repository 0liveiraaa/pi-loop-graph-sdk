# 栈帧：图运行的心智模型

图模型描述了零件（Stage、Node、Route），上下文文档讲了每种数据的生命周期。把它们统一理解的最简单方式是：**把一次图运行看成调用栈**。

## 类比：函数调用

```
函数调用     ──────→     节点访问
──────────              ──────────
传入参数                Node Input
执行函数体              Node 的 execute / Agent Run
返回结果                Node Completion
调用者决定保留什么       Transition.frame
写入调用者的局部变量     Frame（后续节点可通过 Memory 看到）
```

每次节点访问就是一次"调用"：接收参数、做事、返回结果，然后由 Connection + Transition 决定保留什么状态并调用下一个节点。

## 栈帧长什么样

```
图调用开始
  │
  ├─ [Stage "analyze"]
  │    NodeInput: { question: "..." }
  │    执行：Agent 分析
  │    Completion: { analysis: "..." }
  │    Transition.frame → 追加到 Frames: { stage: "analyze", ... }
  │    Transition.map → 构造下一个 NodeInput
  │    [节点结束]
  │
  ├─ [Stage "answer"]
  │    NodeInput: { analysis: "..." }
  │    Memory 可见：[{ stage: "analyze", ... }]  ← Frame 中持久化的数据
  │    执行：Agent 回答
  │    Completion: { answer: "..." }
  │    finish().output → Graph Output
  │    [节点结束]
  │
  └─ 图返回
```

**注意**：Node Visit 本身不 push/pop Frame。Frame 是 Transition.frame() 向有序数组追加的持久工作记忆。后续节点通过 Memory 投影看到 Frame 中的数据。

## 关键推论

**Node Input ≠ Memory**。Node Input 是一次性的——上一条 Connection 为当前访问准备的数据，访问结束后消失。Memory 是持久化的——Transition.frame 写入的 Frame 对后续所有节点可见。两者不互相替代。

**Background ≠ Node Input**。即使第一个 Node Input 和 Background 内容相同，Background 仍是 Graph Invocation scope（图级稳定），Node Input 仍是 Node Visit scope（一次性传递）。

**compose 共享 Frame**。compose 子图的 Transition.frame 写入的 Frame 对父图的后续节点可见，就像子函数修改了调用者的局部变量。call 和 delegate 不共享。

**循环就是重新调用**。当 analyze → analyze 形成自环时，每个循环迭代都是新的 Node Visit：新的 NodeInput，上一轮通过 frame 保存的数据出现在 Memory 中，上一轮的 NodeInput 已消失。

## 相关文档

- [图模型](graph-model.md) — Stage、Node、Route
- [上下文与状态](context-and-state.md) — Background、Focus、Frame、Memory
- [构建条件路由与循环](../guides/build-a-loop.md) — 实操
