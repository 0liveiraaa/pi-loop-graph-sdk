import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  GraphContextView,
  NodeContextView,
  NodeInputView,
  RenderedContextMessage,
} from "./projection.js";

export interface SkillLoadContext {
  readonly graph: GraphContextView;
  readonly node: NodeContextView;
  readonly input: NodeInputView;
  readonly basePath: string;
}

export type SkillContentProvider =
  (ref: string, context: SkillLoadContext) => Promise<string | null>;

export type SkillContentRenderer = (
  ref: string,
  content: string,
  context: SkillLoadContext,
) => RenderedContextMessage | null;

export type SkillFailurePolicy = "ignore" | "fail";

export interface SkillFailurePolicies {
  missing?: SkillFailurePolicy;
  error?: SkillFailurePolicy;
}

export const defaultSkillContentProvider: SkillContentProvider = async (ref, context) => {
  try {
    return await readFile(join(context.basePath, ref, "SKILL.md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
};

export const defaultSkillContentRenderer: SkillContentRenderer = (ref, content) => ({
  kind: "skill",
  content: `[skill: ${ref}]\n\n${content}`,
});
