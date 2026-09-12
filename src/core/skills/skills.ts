// Skills: reusable expertise the agent can load on demand.
//
// A skill is a folder holding SKILL.md — frontmatter (name + description) plus a
// markdown body of instructions. Only the name and description go into the
// system prompt; the body is fetched with the `use_skill` tool when a task
// actually calls for it, so twenty installed skills cost ~twenty lines of
// context instead of twenty documents.
//
// Pure module: parsing, validation and prompt rendering. Disk access lives in
// the main process.

export interface SkillMeta {
  /** Folder name and tool argument — lowercase, hyphenated. */
  id: string;
  name: string;
  /** One line telling the model WHEN to reach for this. */
  description: string;
  tags: string[];
  version?: string;
  /** Where it is installed: this workspace, or every project. */
  scope: 'project' | 'global';
  /**
   * Where it came from. 'custom' means a human wrote or imported it — ConeCode
   * does not review those, so the UI labels them and the user owns the risk.
   */
  source: 'builtin' | 'custom';
  /** Disabled skills stay installed and editable but are not advertised or loaded. */
  enabled?: boolean;
  /** Absolute path of the skill folder. */
  path?: string;
}

export interface Skill extends SkillMeta {
  /** The full instructions, loaded only when used. */
  body: string;
}

export const SKILL_FILE = 'SKILL.md';
export const MAX_DESCRIPTION = 200;

function shortHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 6);
}

/** Folder/tool-safe id. Mirrors the tool-name charset the providers accept. */
export function skillId(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  // Keep provider/tool-safe ASCII ids while preventing every non-Latin name
  // from collapsing to the same "skill" folder. Mixed names also get a suffix
  // so "React 规范" and "React 测试" cannot collide as "react".
  if (/[^\x00-\x7f]/.test(name)) {
    const suffix = shortHash(name);
    const stem = (id || 'skill').slice(0, 47 - suffix.length);
    return `${stem}-${suffix}`;
  }
  return id || 'skill';
}

/**
 * Parse a SKILL.md. Frontmatter is a small fixed key set, so this avoids a YAML
 * dependency — but it must be forgiving, because these files are hand-written.
 * Returns null when there is no usable name, since an unnamed skill can neither
 * be listed nor invoked.
 */
export function parseSkill(raw: string, fallback: Partial<SkillMeta> = {}): Skill | null {
  if (!raw) return null;

  let body = raw;
  const meta: Record<string, string> = {};

  const fm = raw.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (fm) {
    body = fm[2];
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (!m) continue;
      // Strip surrounding quotes; values here are always simple scalars.
      meta[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }

  // A missing frontmatter name falls back to the first heading, then the folder.
  const heading = body.match(/^\s*#\s+(.+)$/m)?.[1]?.trim();
  const name = (meta.name || heading || fallback.name || '').trim();
  if (!name) return null;

  const description = (meta.description || firstParagraph(body) || '').slice(0, MAX_DESCRIPTION);

  return {
    id: skillId(meta.id || fallback.id || name),
    name: name.slice(0, 60),
    description,
    tags: meta.tags ? meta.tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 5) : (fallback.tags || []),
    version: meta.version || fallback.version,
    scope: fallback.scope || 'project',
    // Anything not explicitly stamped as built-in is treated as user-authored,
    // so a hand-written or imported SKILL.md is never mislabelled as reviewed.
    source: meta.source === 'builtin' ? 'builtin' : (fallback.source || 'custom'),
    enabled: meta.enabled ? meta.enabled.toLowerCase() !== 'false' : (fallback.enabled ?? true),
    path: fallback.path,
    body: body.trim(),
  };
}

function firstParagraph(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    return text;
  }
  return '';
}

/** Serialize back to SKILL.md, so installs and edits round-trip. */
export function serializeSkill(skill: Pick<Skill, 'name' | 'description' | 'body'> & Partial<Skill>): string {
  const lines = ['---', `name: ${skill.name}`, `description: ${skill.description}`];
  if (skill.tags?.length) lines.push(`tags: ${skill.tags.join(', ')}`);
  if (skill.version) lines.push(`version: ${skill.version}`);
  if (skill.source) lines.push(`source: ${skill.source}`);
  if (skill.enabled === false) lines.push('enabled: false');
  lines.push('---', '', skill.body.trim(), '');
  return lines.join('\n');
}

/**
 * The system-prompt block. Names and descriptions only — the whole point is that
 * bodies stay out of context until `use_skill` asks for one.
 */
export function formatSkillsPrompt(skills: SkillMeta[]): string {
  const active = skills.filter((s) => s.enabled !== false);
  if (!active.length) return '';
  const lines = active.map((s) => `- ${s.id}: ${(s.description || s.name).slice(0, MAX_DESCRIPTION)}`);
  return `Installed skills — reusable expertise for specific kinds of work. When a task matches one, call use_skill with its id FIRST and follow what it says; the instructions you get back take precedence over your defaults for that task. Do not guess at a skill's contents without loading it.

${lines.join('\n')}`;
}

/** Project skills shadow global ones of the same id, like local config wins. */
export function mergeSkills(global: SkillMeta[], project: SkillMeta[]): SkillMeta[] {
  const byId = new Map<string, SkillMeta>();
  for (const s of global) byId.set(s.id, { ...s, scope: 'global' });
  for (const s of project) byId.set(s.id, { ...s, scope: 'project' });
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Reject anything that would escape the skills directory. */
export function isSafeSkillId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,47}$/.test(id) && !id.includes('..');
}


// ---------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
  tags?: string[];
}

export interface DraftErrors {
  name?: string;
  description?: string;
  body?: string;
}

/**
 * Validate a hand-written skill. The description is not optional polish: it is
 * the ONLY thing the model sees until it decides to load the skill, so a skill
 * without one can never be chosen.
 */
export function validateDraft(draft: SkillDraft): DraftErrors {
  const errors: DraftErrors = {};
  const name = draft.name?.trim() || '';
  const description = draft.description?.trim() || '';
  const body = draft.body?.trim() || '';

  if (!name) errors.name = 'required';
  else if (!isSafeSkillId(skillId(name))) errors.name = 'invalid';

  if (!description) errors.description = 'required';
  else if (description.length > MAX_DESCRIPTION) errors.description = 'tooLong';

  if (!body) errors.body = 'required';
  else if (body.length < 20) errors.body = 'tooShort';

  return errors;
}

export function draftHasErrors(errors: DraftErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Turn a pasted or imported SKILL.md into a draft for the editor. */
export function draftFromMarkdown(raw: string): SkillDraft | null {
  const parsed = parseSkill(raw);
  if (!parsed) return null;
  return { name: parsed.name, description: parsed.description, body: parsed.body, tags: parsed.tags };
}
