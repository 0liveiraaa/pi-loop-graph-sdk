import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedSkillView, SkillRef } from "../core/skill.js";

export interface SkillRegistration {
  readonly name: string;
  readonly version?: string;
  readonly source: string;
  readonly content: string;
}

export interface SkillResolver {
  resolve(ref: SkillRef): SkillRegistration | undefined;
}

export type SkillResolverFunction = (ref: SkillRef) => SkillRegistration | undefined;

export interface SkillCatalogOptions {
  readonly resolver?: SkillResolver | SkillResolverFunction;
}

export class SkillCatalog implements SkillResolver {
  private readonly skills = new Map<string, ResolvedSkillView>();
  private readonly misses = new Set<string>();

  constructor(private readonly options: SkillCatalogOptions = {}) {}

  register(skill: SkillRegistration): void {
    const key = skillKey(skill.name, skill.version);
    if (this.skills.has(key)) throw new Error(`Skill already registered: ${key}`);
    this.misses.delete(key);
    this.skills.set(key, resolveRegistration(skill));
  }

  resolve(ref: SkillRef): ResolvedSkillView | undefined {
    const key = skillKey(ref.name, ref.version);
    const registered = this.skills.get(key);
    if (registered) return registered;
    if (this.misses.has(key)) return undefined;
    const resolver = this.options.resolver;
    if (!resolver) return undefined;
    const candidate = typeof resolver === "function" ? resolver(ref) : resolver.resolve(ref);
    if (!candidate) {
      this.misses.add(key);
      return undefined;
    }
    if (candidate.name !== ref.name || candidate.version !== ref.version) {
      throw new Error(
        `Skill resolver returned ${skillKey(candidate.name, candidate.version)} for ${key}`,
      );
    }
    const resolved = resolveRegistration(candidate);
    this.skills.set(key, resolved);
    return resolved;
  }

  async loadPaths(paths: readonly string[]): Promise<void> {
    for (const basePath of paths) await this.loadPath(basePath);
  }

  private async loadPath(basePath: string): Promise<void> {
    for (const entry of await safeDirectories(basePath)) {
      const skillRoot = join(basePath, entry);
      const direct = await safeRead(join(skillRoot, "SKILL.md"));
      if (direct != null) {
        this.register({ name: entry, source: join(skillRoot, "SKILL.md"), content: direct });
      }
      for (const version of await safeDirectories(skillRoot)) {
        const versionPath = join(skillRoot, version, "SKILL.md");
        const content = await safeRead(versionPath);
        if (content != null) this.register({ name: entry, version, source: versionPath, content });
      }
    }
  }
}

async function safeDirectories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function skillKey(name: string, version?: string): string {
  return `${name}@${version ?? ""}`;
}

function resolveRegistration(skill: SkillRegistration): ResolvedSkillView {
  if (!skill.name || !skill.source) throw new Error("Skill registration requires name and source");
  return Object.freeze({
    ...skill,
    fingerprint: createHash("sha256").update(skill.content).digest("hex"),
  });
}
