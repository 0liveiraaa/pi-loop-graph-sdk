import { describe, expect, it } from "vitest";
import { phaseAuditCallGraph, phaseAuditComposeGraph, phaseAuditGraphs, phaseAuditRootGraph, PHASE_AUDIT_FAIL_TOOL } from "../../src/graphs/phase1-9-audit-graphs.js";
import { GraphCatalog } from "../../src/host/graph-catalog.js";
import { SkillCatalog } from "../../src/host/skill-catalog.js";
import { ToolCatalog } from "../../src/host/tool-catalog.js";
import { phaseAuditSkillRegistration } from "../../src/graphs/phase1-9-audit-graphs.js";
import { GraphRuntime } from "../../src/runtime/graph-runtime.js";
import type { JsonValue } from "../../src/core/json.js";

describe("Phase 1-9 real audit graph fixtures", () => {
  it("forms one root graph with compose and call children using Core GraphRefs", () => {
    expect(phaseAuditGraphs.map((graph) => graph.id)).toEqual(["phase_audit_compose", "phase_audit_call", "phase_audit_root"]);
    expect(phaseAuditRootGraph.stages.compose.node).toMatchObject({ kind: "graph", boundary: "compose", graph: { id: phaseAuditComposeGraph.id, version: "1" } });
    expect(phaseAuditRootGraph.stages.call.node).toMatchObject({ kind: "graph", boundary: "call", graph: { id: phaseAuditCallGraph.id, version: "1" } });
    expect(phaseAuditRootGraph.stages.final.node).toMatchObject({ kind: "agent", tools: [PHASE_AUDIT_FAIL_TOOL] });
  });

  it("passes catalog, tool and required Skill preflight", async () => {
    const catalog = new GraphCatalog(); for (const graph of phaseAuditGraphs) catalog.register(graph);
    const tools = new ToolCatalog(); tools.register({ name: PHASE_AUDIT_FAIL_TOOL, execute: async () => undefined });
    const skills = new SkillCatalog(); skills.register(phaseAuditSkillRegistration);
    const runtime = new GraphRuntime({
      catalog, toolCatalog: tools, skillCatalog: skills,
      runAgent: async (_node, input, context): Promise<JsonValue> => {
        const marker = (input as { marker: string }).marker;
        if (context.invocation.graph.id === phaseAuditComposeGraph.id) {
          return { boundary: "compose", marker, memoryMarkerVisible: true, secretVisible: false, sessionIsolationConfirmed: true };
        }
        if (context.invocation.graph.id === phaseAuditCallGraph.id) {
          return { boundary: "call", marker, memoryMarkerVisible: false, secretVisible: false, sessionIsolationConfirmed: true };
        }
        return { phaseAudit: "passed", marker, expectedToolFailureObserved: true, skillInstructionObserved: true };
      },
      createInvocationAgentHost: async () => ({
        runAgent: async (_node, input, context): Promise<JsonValue> => {
          const marker = (input as { marker: string }).marker;
          if (context.invocation.graph.id === phaseAuditComposeGraph.id) {
            return { boundary: "compose", marker, memoryMarkerVisible: true, secretVisible: false, sessionIsolationConfirmed: true };
          }
          return { boundary: "call", marker, memoryMarkerVisible: false, secretVisible: false, sessionIsolationConfirmed: true };
        },
        dispose() {},
      }),
    });
    await expect(runtime.execute(phaseAuditRootGraph, { publicTopic: "audit", secret: "hidden", marker: "M-1" })).resolves.toMatchObject({
      status: "completed", output: { phaseAudit: "passed", marker: "M-1" }, steps: 6,
    });
  });
});
