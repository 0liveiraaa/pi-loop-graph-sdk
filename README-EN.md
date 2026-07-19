# Loop Graph SDK

A serial, loopable graph orchestration SDK for [pi](https://pi.dev).

> **Status: alpha.** This is the first test release; the API may still change.

Loop Graph SDK lets developers break complex tasks into explicit stages using a graph model, turning skills into callable workflows. Each stage can run code, call an LLM agent, or invoke a subgraph. After a stage completes, explicit routing decides the next step, what working memory to retain, and whether to form a loop.

## Use Cases

- Multi-stage generation, review, modification, and re-checking
- Serial workflows mixing code execution with LLM agent reasoning
- Conditional routing and retry based on completion results
- Per-node tool declarations with gating, automatic validation, and auditing
- Subgraph reuse with controlled context sharing boundaries

## Core Capabilities

- **Two node types**: `code` nodes execute code or agents; `graph` nodes invoke subgraphs.
- **Conditional routing and loops**: Choose edges based on completion results, or return to a previous node.
- **Code + Agent hybrid**: A single code node can prepare data, call an agent, then process the result.
- **Automatic validation**: Output schema checks and custom validators can reject malformed results.
- **Tool control**: Nodes declare available tools; cross-cutting extensions can block, modify, or redact tool calls.
- **Context customization**: Control how task instructions and completed working memory are presented to agents.
- **Three subgraph boundaries**: `call`, `compose`, and `delegate` provide different levels of sharing and isolation.

The entire SDK is built around a **stack frame** mental model: each node visit is a function call — accept arguments, execute, return results — and each Edge decides what to retain in the caller's persistent memory. See [Stack Frame](docs/concepts/stack-frame.md) for details.
## The reference project
[pi-study-helper](https://github.com/0liveiraaa/pi-study-helper) uses this SDK to accomplish internal workflow orchestration.
## Installation

As a library dependency:

```bash
npm install git:github.com/0liveiraaa/pi-loop-graph-sdk#v0.1
```

Or as a pi extension (includes demo graphs for exploration):

```bash
pi install git:github.com/0liveiraaa/pi-loop-graph-sdk
```

## Minimal Example

A single-node graph that receives arguments via `/hello`, asks an agent to greet the user, and returns the result via `END`.

### Step 1: Define the graph

Create `hello-graph.ts`:

```typescript
import { END, createAgentExecute } from "pi-loop-graph-sdk";
import type { Edge, Entry, Graph, Node } from "pi-loop-graph-sdk";

const greetNode: Node = {
  kind: "code",
  id: "greet",
  subGoal: "Greet the user by the provided name",
  execute: createAgentExecute({
    prompt: (input) =>
      `Please greet ${String(input.data.name ?? "world")} in one short sentence.`,
  }),
};

const done: Edge = {
  id: "done",
  from: "greet",
  to: END,
  priority: 10,
  guard: () => true,
  migrate(_instance, completion) {
    return {
      frame: { greetingOutcome: completion.result },
      output: { status: completion.status, result: completion.result },
    };
  },
};

const entry: Entry = {
  id: "main",
  guard: () => true,
  startNodeId: "greet",
  mapInput: (background) => ({ name: String(background.name ?? "world") }),
};

export const helloGraph: Graph = {
  id: "hello_world",
  goal: "Greet a specified person",
  invocation: {
    name: "hello",
    description: "Generate a greeting",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    parseArgs: (args) => ({ name: args.trim() || "world" }),
  },
  entries: [entry],
  nodes: { greet: greetNode },
  routing: {
    greet: {
      nodeId: "greet",
      edges: [done],
      router: { kind: "first-match" },
    },
  },
};
```

`frame` holds business working memory for subsequent stages, defined by the graph author. `output` explicitly declares the return value and status of the entire graph.

### Step 2: Register with a pi extension

Create `my-extension.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLoopGraphExtension } from "pi-loop-graph-sdk";
import { helloGraph } from "./hello-graph.js";

export default function myExtension(pi: ExtensionAPI): void {
  const loop = createLoopGraphExtension(pi);
  loop.registerGraph(helloGraph);
}
```

Add this entry to your pi extension config, then start pi and run:

```text
/hello world
```

For a complete project setup and walkthrough, see [Getting Started](docs/getting-started.md).

## Subgraph Boundaries

| Boundary     | When to Use                                                                        |
| ------------ | ---------------------------------------------------------------------------------- |
| `call`     | Default. Reuses the current execution session with a fresh logical work instance.  |
| `compose`  | Subgraph must read parent working memory, or is an internal implementation detail. |
| `delegate` | Sub-task requires its own execution session and independent context lifecycle.     |

All three boundaries currently wait for the subgraph to complete along a single path; `delegate` does not imply parallel execution.

## Current Limitations

- A single graph run always advances one node path at a time; no fork/join parallelism.
- No inter-agent communication or coordination protocol.
- No graph run recovery after process or session termination.
- A single `LoopGraphExtension` instance does not support concurrent top-level execution.
- This is alpha software. Before production use, perform your own security assessment, fault handling, and stability verification.

## Documentation

> **Note:** The detailed developer documentation is currently written in Chinese, as the project is primarily developed by a Chinese-speaking developer. If you are not familiar with Chinese, you can use AI assistants (such as the pi agent itself, ChatGPT, or Claude) to help translate or interpret the documentation. The code examples and API signatures are in TypeScript and are language-agnostic.

| Goal                            | Entry                                      |
| ------------------------------- | ------------------------------------------ |
| First runnable extension        | [Getting Started](docs/getting-started.md)  |
| Stack frame mental model        | [Stack Frame](docs/concepts/stack-frame.md) |
| Graph model, state, boundaries  | [Concepts](docs/concepts/)                  |
| Task-oriented guides            | [Guides](docs/guides/)                      |
| API reference, config, errors   | [Reference](docs/reference/)                |
| Internal design and maintenance | [Design](docs/design/core-design.md)        |

## Development Checks

```bash
npm run build
npm test
npm run typecheck
```

By default, no debug log files are written. JSONL lifecycle logging is only enabled when `debug: true` is explicitly set.

## License

MIT — see [LICENSE](LICENSE).
