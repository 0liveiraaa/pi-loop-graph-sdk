# Build a loop

Model loops as explicit stages and routes. A stage owns one `codeNode`, `agentNode`, or `graphNode`; `connect` advances to another stage and `finish` returns the typed output. `firstMatch` selects the first valid transition. Keep loop termination in the graph route and enforce progress with invocation limits.
