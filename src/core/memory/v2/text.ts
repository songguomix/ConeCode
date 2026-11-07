// Text normalisation shared by classification, full-text retrieval and dedupe.
//
// Chinese matters here: a whitespace tokenizer would index an entire sentence
// as one token and make full-text search useless for most of this app's users.
// CJK runs are split into overlapping bigrams (plus single characters for
// 1-character runs), Latin/number runs are lower-cased words.

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  // Walk character runs: consecutive CJK chars -> bigrams, everything else -> word chars.
  let i = 0;
  while (i < lower.length) {
    const ch = lower[i];
    if (CJK.test(ch)) {
      let j = i;
      while (j < lower.length && CJK.test(lower[j])) j++;
      const run = lower.slice(i, j);
      if (run.length === 1) tokens.push(run);
      for (let k = 0; k < run.length - 1; k++) tokens.push(run.slice(k, k + 2));
      i = j;
    } else if (/[a-z0-9]/.test(ch)) {
      let j = i;
      while (j < lower.length && /[a-z0-9_]/.test(lower[j])) j++;
      const word = lower.slice(i, j);
      if (word.length > 1) tokens.push(word);
      i = j;
    } else {
      i++;
    }
  }
  return tokens;
}

export function termSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Containment: one idea phrased as a subset of another. Used by legacy dedupe too. */
export function isContained(a: string, b: string): boolean {
  const ka = normalizeText(a);
  const kb = normalizeText(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  return short.length >= 8 && long.includes(short);
}
