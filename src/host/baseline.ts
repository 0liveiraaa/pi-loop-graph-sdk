export type HostBaseline =
  | { readonly kind: "isolated" }
  | { readonly kind: "inherit"; readonly fingerprint?: string }
  | { readonly kind: "custom"; readonly id: string };

export const DEFAULT_HOST_BASELINE: HostBaseline = Object.freeze({ kind: "isolated" });

export function resolveHostBaseline(baseline?: HostBaseline): HostBaseline {
  return Object.freeze({ ...(baseline ?? DEFAULT_HOST_BASELINE) });
}
