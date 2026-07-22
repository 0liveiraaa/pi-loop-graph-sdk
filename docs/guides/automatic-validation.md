# Automatic validation

Graph and node schemas are validated before execution. Agent nodes submit completion through the protected `graph_complete` tool using exactly `{ result }`; `status` and extra fields are rejected. Output Contract, run, node, mechanism, and agent-choice validators run inside the Runtime. Rejected submissions may be retried up to the configured limit; the fourth rejection produces a stable failed completion.
