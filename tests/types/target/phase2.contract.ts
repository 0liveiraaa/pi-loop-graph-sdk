import type {
  GraphFailureCode,
  GraphRunResult,
  InvocationLimits,
} from "pi-loop-graph-sdk";

declare const result: GraphRunResult<{ answer: string }>;
declare const limits: InvocationLimits;
declare const code: GraphFailureCode;

switch (result.status) {
  case "completed":
    result.output.answer satisfies string;
    break;
  case "failed":
    result.failure.retryable satisfies boolean;
    break;
  case "cancelled":
    result.failure.code satisfies "cancelled";
    break;
  default: {
    const exhaustive: never = result;
    void exhaustive;
  }
}

limits.maxGraphDepth satisfies number;
limits.maxGraphInvocations satisfies number;
limits.maxTotalNodeVisits satisfies number;
code satisfies GraphFailureCode;
