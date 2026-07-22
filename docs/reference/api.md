# API reference

The stable root exports are the typed 0.2 authoring and execution surface:

- Builders: `defineGraph`, `defineSingleAgentGraph`, `defineLinearGraph`, `agentNode`, `codeNode`, `graphNode`, `graphRef`, `entry`, `connect`, `finish`, `firstMatch`, `skillRef`, `toolSet`.
- Execution: `createGraphHost`, `executeIsolatedGraph`, `createLoopGraphExtension`.
- Types: `Graph`, `GraphRef`, `Stage`, node definitions, `NodeCompletion`, `GraphRunResult`, `GraphFailure`, `InvocationLimits`.

The model completion protocol accepts only `{ result }`. Runtime status is exposed through `GraphRunResult`; failures use the structured `failure` field. Low-level validation, routing, projection, runtime, and legacy isolated-host APIs are available from `pi-loop-graph-sdk/advanced`. Replay stores and parsers are available from `pi-loop-graph-sdk/replay`.
