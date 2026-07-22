# Calling subgraphs

Create a reusable graph and reference it with `graphNode({ graph: graphRef("id", "version"), boundary: "call" | "compose" | "delegate" })`. Register GraphRefs in the same extension/catalog. `call` and `compose` use invocation-scoped child Pi Sessions while sharing the Core Runtime, budget, frames, mechanisms, and replay scope; `delegate` requires an isolated host. Nested checkpoint continuation recovery is not yet supported and fails closed.
