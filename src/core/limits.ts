export interface InvocationLimits {
  readonly maxGraphDepth: number;
  readonly maxGraphInvocations: number;
  readonly maxTotalNodeVisits: number;
}

export const DEFAULT_INVOCATION_LIMITS: InvocationLimits = Object.freeze({
  maxGraphDepth: 8,
  maxGraphInvocations: 64,
  maxTotalNodeVisits: 500,
});

export function resolveInvocationLimits(
  limits: Partial<InvocationLimits> = {},
): InvocationLimits {
  const resolved = { ...DEFAULT_INVOCATION_LIMITS, ...limits };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  return Object.freeze(resolved);
}
