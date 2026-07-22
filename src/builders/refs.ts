import type { SkillRef } from "../core/skill.js";
export type { SkillRef } from "../core/skill.js";

export type ToolSet<TNames extends readonly string[] = readonly string[]> = TNames;

export function skillRef(name: string, version?: string, required = true): SkillRef {
  if (!name) throw new Error("SkillRef requires a name");
  return Object.freeze({ name, version, required });
}

export function toolSet<const TNames extends readonly string[]>(...names: TNames): ToolSet<TNames> {
  if (new Set(names).size !== names.length) throw new Error("ToolSet contains duplicate names");
  return Object.freeze([...names]) as unknown as TNames;
}
