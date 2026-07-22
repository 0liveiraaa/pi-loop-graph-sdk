import { Type } from "typebox";
import { defineGraph } from "../builders/graph.js";
import { agentNode, codeNode, graphNode } from "../builders/node.js";
import { connect, entry, finish, firstMatch } from "../builders/route.js";
import { graphRef } from "../core/graph.js";
import { defineMechanism } from "../core/mechanism.js";
import { skillRef } from "../builders/refs.js";

export const PHASE_AUDIT_FAIL_TOOL = "phase_audit_expected_failure";
export const PHASE_AUDIT_SKILL = "phase-audit-skill";

const AuditInput = Type.Object({
  publicTopic: Type.String(),
  secret: Type.String(),
  marker: Type.String(),
});
const SeedOutput = Type.Object({ publicTopic: Type.String(), marker: Type.String(), seeded: Type.Boolean() });
const Observation = Type.Object({
  boundary: Type.Union([Type.Literal("compose"), Type.Literal("call")]),
  marker: Type.String(),
  memoryMarkerVisible: Type.Boolean(),
  secretVisible: Type.Boolean(),
  sessionIsolationConfirmed: Type.Boolean(),
});
const FinalOutput = Type.Object({
  phaseAudit: Type.Literal("passed"),
  marker: Type.String(),
  expectedToolFailureObserved: Type.Boolean(),
  skillInstructionObserved: Type.Boolean(),
});

const rejectFirstAcceptedCandidate = defineMechanism<{ rejected: boolean }>({
  name: "phase-audit-reject-first",
  createState: () => ({ rejected: false }),
  validateCompletion(ctx) {
    if (!ctx.state.rejected) {
      ctx.state.rejected = true;
      return { action: "reject", reason: "PHASE_AUDIT_EXPECTED_FIRST_REJECTION" };
    }
    return { action: "allow" };
  },
});

function observationGraph(id: string, boundary: "compose" | "call") {
  return defineGraph({
    id, version: "1", goal: `Observe ${boundary} Memory and Session isolation`, input: SeedOutput, output: Observation,
    context: {
      background: { select: (input) => ({ marker: input.marker }) },
      memory: { select: "all" },
    },
    entries: [entry("main", { to: "observe" })],
    stages: {
      observe: {
        node: agentNode({
          subGoal: `Report ${boundary} boundary evidence`, input: SeedOutput, output: Observation,
          context: { focus: { select: (input) => ({ marker: input.marker }) } },
          prompt: [
            `Submit exactly boundary="${boundary}" and the marker visible in Node Focus.`,
            "Set memoryMarkerVisible=true only if COMPLETED WORK contains the same marker; otherwise false.",
            "Set secretVisible=false. Set sessionIsolationConfirmed=true because no parent Assistant transcript should be present.",
          ].join("\n"),
        }),
        route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
      },
    },
  });
}

export const phaseAuditComposeGraph = observationGraph("phase_audit_compose", "compose");
export const phaseAuditCallGraph = observationGraph("phase_audit_call", "call");

export const phaseAuditRootGraph = defineGraph({
  id: "phase_audit_root", version: "1", goal: "Produce one durable replay proving SDK Phase 1-9 behavior",
  input: AuditInput, output: FinalOutput,
  context: {
    background: { select: (input) => ({ publicTopic: input.publicTopic, marker: input.marker }) },
    memory: { select: "all" },
  },
  entries: [entry("main", { to: "seed" })],
  tools: [PHASE_AUDIT_FAIL_TOOL],
  skills: [skillRef(PHASE_AUDIT_SKILL, "1", true)],
  stages: {
    seed: {
      node: codeNode({ subGoal: "Create a deterministic Frame", input: AuditInput, output: SeedOutput,
        execute: ({ input, complete }) => complete({ publicTopic: input.publicTopic, marker: input.marker, seeded: true }) }),
      route: firstMatch({ compose: connect("compose", {
        frame: ({ completion }) => ({ auditFrameMarker: completion.result.marker, phase: "seed" }),
        map: ({ completion }) => completion.result,
      }) }),
    },
    compose: {
      node: graphNode({ subGoal: "Inspect compose", input: SeedOutput, output: Observation, graph: graphRef(phaseAuditComposeGraph.id, "1"), boundary: "compose" }),
      route: firstMatch({ call: connect("call", { map: ({ completion }) => ({ publicTopic: "audit", marker: completion.result.marker, seeded: true }) }) }),
    },
    call: {
      node: graphNode({ subGoal: "Inspect call", input: SeedOutput, output: Observation, graph: graphRef(phaseAuditCallGraph.id, "1"), boundary: "call" }),
      route: firstMatch({ final: connect("final", { map: ({ completion }) => ({ publicTopic: "audit", marker: completion.result.marker, seeded: true }) }) }),
    },
    final: {
      node: agentNode({
        subGoal: "Exercise tool failure and completion rejection", input: SeedOutput, output: FinalOutput,
        tools: [PHASE_AUDIT_FAIL_TOOL], skills: [skillRef(PHASE_AUDIT_SKILL, "1", true)], mechanisms: [rejectFirstAcceptedCandidate],
        context: { focus: { select: (input) => ({ marker: input.marker }) } },
        prompt: [
          `Call ${PHASE_AUDIT_FAIL_TOOL} once and observe its expected error.`,
          "Then submit phaseAudit=passed, the marker, expectedToolFailureObserved=true, skillInstructionObserved=true.",
          "The Runtime will intentionally reject the first schema-valid submission. Submit the identical business result again after rejection.",
        ].join("\n"),
      }),
      route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
    },
  },
});

export const phaseAuditGraphs = Object.freeze([phaseAuditComposeGraph, phaseAuditCallGraph, phaseAuditRootGraph]);

export const phaseAuditSkillRegistration = Object.freeze({
  name: PHASE_AUDIT_SKILL, version: "1", source: "phase-audit://skill",
  content: "PHASE_AUDIT_SKILL_TOKEN: When completing the final audit node, set skillInstructionObserved=true.",
});
