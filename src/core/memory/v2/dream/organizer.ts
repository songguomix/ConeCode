import type { DreamLlm, WikiIndexEntry } from './types';
import { buildOrganizerMessages } from './prompts';
import { extractJsonObject, sanitizeSlug } from './wiki';

export interface OrganizerPlan {
  merges: Array<{ from: string; to: string }>;
  retired: Array<{ slug: string; movedTo: string }>;
  warning?: string;
}

/** Asks the organizer model for merges; validation happens before any write. */
export async function planOrganization(
  llm: DreamLlm,
  input: { entries: WikiIndexEntry[]; scope: string; now: number }
): Promise<OrganizerPlan> {
  const { system, user } = buildOrganizerMessages(input);
  const raw = await llm({ system, user, maxTokens: 2000 });
  if (!raw || !raw.trim()) return { merges: [], retired: [], warning: 'organizer returned an empty response' };
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') {
    return { merges: [], retired: [], warning: 'organizer response was not valid JSON' };
  }
  const record = parsed as { merges?: unknown; retire?: unknown };
  if (!Array.isArray(record.merges) && !Array.isArray(record.retire)) {
    return { merges: [], retired: [], warning: 'organizer response had no merges or retire array' };
  }
  const known = new Set(input.entries.map((entry) => entry.slug));
  const merges: Array<{ from: string; to: string }> = [];
  const seen = new Set<string>();
  if (Array.isArray(record.merges)) {
    for (const item of record.merges.slice(0, 20)) {
      if (!item || typeof item !== 'object') continue;
      const from = sanitizeSlug((item as { from?: unknown }).from);
      const to = sanitizeSlug((item as { to?: unknown }).to);
      if (!from || !to || from === to) continue;
      if (!known.has(from) || !known.has(to) || seen.has(from)) continue;
      seen.add(from);
      merges.push({ from, to });
    }
  }
  const retired: Array<{ slug: string; movedTo: string }> = [];
  const retiredSeen = new Set<string>();
  if (Array.isArray(record.retire)) {
    for (const item of record.retire.slice(0, 20)) {
      if (!item || typeof item !== 'object') continue;
      const slug = sanitizeSlug((item as { slug?: unknown }).slug);
      const movedTo = sanitizeSlug((item as { movedTo?: unknown }).movedTo);
      if (!slug || !movedTo || slug === movedTo) continue;
      if (!known.has(slug) || !known.has(movedTo) || retiredSeen.has(slug) || seen.has(slug)) continue;
      retiredSeen.add(slug);
      retired.push({ slug, movedTo });
    }
  }
  return { merges, retired };
}
