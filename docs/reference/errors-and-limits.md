# Errors and limits

`GraphRunResult` is a discriminated result: `completed` contains `output`, while `failed` and `cancelled` contain structured `failure` data (`code`, `phase`, `message`, and `retryable`). Invalid graph/input, budget exhaustion, rejected completion, persistence failure, and resume incompatibility are represented there rather than in model-submitted status fields.

Use `InvocationLimits` to bound graph depth, invocations, node visits, and related work. A host abort or dispose propagates cancellation and releases active resources. Nested checkpoint continuation is currently fail-closed.
