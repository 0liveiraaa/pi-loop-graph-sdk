# Migrating from 0.1 to 0.2

| 0.1 | 0.2 |
| --- | --- |
| `Graph.nodes`, `Graph.routing`, `Edge`, `END` | `defineGraph`, `stages`, `connect`, `finish` |
| `Node.id` | stage keys and builder definitions |
| global `registerGraph` | `createLoopGraphExtension(pi).registerGraph(graph)` |
| completion `{ status, result }` | completion `{ result }`; Runtime owns status |
| ad-hoc failed result | `GraphRunResult.status === "failed"` and `failure` |
| extension-wide business tools | node `tools` / Tool Catalog |

The root package is the stable authoring surface. `./advanced` contains runtime, projection, validation, and legacy isolated-host details for opt-in integrations; `./replay` contains recording and replay APIs. `createGraphHost` and `executeIsolatedGraph` are the supported execution helpers.

Checkpoint/resume is intentionally bounded: Phase 10 reliably restores a single Root invocation at a Node boundary. Nested call/compose/delegate continuation restoration is not available and fails closed. Live LLM tests require `PI_LIVE_TESTS=1`; Study Helper six-graph business regression is separate and was not run.
