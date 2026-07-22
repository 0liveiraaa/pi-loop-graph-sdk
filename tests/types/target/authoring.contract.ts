import {
  Type,
  agentNode,
  codeNode,
  connect,
  defineGraph,
  defineLinearGraph,
  defineSingleAgentGraph,
  entry,
  finish,
  firstMatch,
  graphNode,
  graphRef,
  skillRef,
  toolSet,
} from "pi-loop-graph-sdk";

const StudyInput = Type.Object({
  topic: Type.String(),
  requirements: Type.Array(Type.String()),
  sourceFiles: Type.Array(Type.String()),
  internalJobId: Type.String(),
});

const PreparedInput = Type.Object({
  topic: Type.String(),
  excerpts: Type.Array(Type.String()),
});

const Draft = Type.Object({
  answer: Type.String(),
  sources: Type.Array(Type.String()),
});

const prepare = codeNode({
  subGoal: "Prepare source excerpts",
  input: StudyInput,
  output: PreparedInput,
  context: { focus: { select: "none" } },
  async execute({ input, complete }) {
    return complete({ topic: input.topic, excerpts: input.sourceFiles });
  },
});

const write = agentNode({
  subGoal: "Write a sourced answer",
  input: PreparedInput,
  output: Draft,
  tools: toolSet("read"),
  skills: [skillRef("answer-writing", "2")],
  context: {
    focus: {
      select: (input) => ({ topic: input.topic, excerpts: input.excerpts }),
      render: ({ selected, meta }) => {
        if (selected) {
          selected.topic;
          selected.excerpts;
          // @ts-expect-error The renderer only receives fields returned by select.
          selected.internalJobId;
        }
        return `${meta.node.subGoal}\n${JSON.stringify(selected)}`;
      },
    },
  },
  prompt: "Complete the current node and submit its structured result.",
});

const reviewer = graphNode({
  subGoal: "Review the draft in a reusable child graph",
  input: Draft,
  output: Draft,
  graph: graphRef("review-answer", "1"),
  boundary: "call",
});

export const completeGraph = defineGraph({
  id: "study-answer",
  version: "1",
  goal: "Produce a sourced study answer",
  input: StudyInput,
  output: Draft,
  tools: toolSet("read"),
  context: {
    background: {
      select: (input) => ({
        topic: input.topic,
        requirements: input.requirements,
      }),
    },
    memory: {
      select: (frames) => frames,
    },
  },
  entries: [entry("main", { to: "prepare" })],
  stages: {
    prepare: {
      node: prepare,
      route: firstMatch({
        next: connect("write", {
          map: ({ completion }) => completion.result,
          frame: ({ completion }) => ({ prepared: completion.result }),
        }),
      }),
    },
    write: {
      node: write,
      route: firstMatch({
        review: connect("review", {
          map: ({ completion }) => completion.result,
          frame: ({ completion }) => ({ draft: completion.result }),
        }),
      }),
    },
    review: {
      node: reviewer,
      route: firstMatch({
        done: finish({
          output: ({ completion }) => completion.result,
          frame: ({ completion }) => ({ reviewed: completion.result }),
        }),
      }),
    },
  },
});

export const singleAgentGraph = defineSingleAgentGraph({
  id: "single-answer",
  version: "1",
  goal: "Write one answer",
  input: PreparedInput,
  output: Draft,
  context: { background: { select: "all" } },
  node: write,
});

export const linearGraph = defineLinearGraph({
  id: "linear-answer",
  version: "1",
  goal: "Prepare and write an answer",
  input: StudyInput,
  output: Draft,
  context: { background: { select: "all" } },
  nodes: [prepare, write],
});
