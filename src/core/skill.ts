export interface SkillRef {
  readonly name: string;
  readonly version?: string;
  readonly required: boolean;
}

export interface ResolvedSkillView {
  readonly name: string;
  readonly version?: string;
  readonly source: string;
  readonly fingerprint: string;
  readonly content: string;
}
