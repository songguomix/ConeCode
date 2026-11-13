// Adapted from Aegis server/services/lookalike.ts (MIT; see LICENSE).
import { domainToUnicode } from 'node:url';
import { officialHostnames } from './registry.mjs';

const HOMOGLYPHS = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', ѕ: 's',
  і: 'i', ј: 'j', ԁ: 'd', ɡ: 'g', ո: 'n', հ: 'h',
};

function skeleton(label) {
  const mapped = Array.from(label, (character) => HOMOGLYPHS[character] ?? character).join('');
  return mapped.replace(/[^a-z0-9.]/gu, '').replace(/0/gu, 'o').replace(/1/gu, 'l').replace(/3/gu, 'e');
}

function secondLevel(hostname) {
  const labels = hostname.split('.');
  return labels[labels.length - 2] ?? '';
}

function levenshtein(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(above + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length];
}

const OFFICIAL_LABELS = officialHostnames.map((host) => {
  const label = secondLevel(host);
  return { host, label, key: skeleton(label) };
});

export function detectLookalike(hostname) {
  const label = secondLevel(hostname);
  if (!label) return null;
  const comparisonLabel = label.startsWith('xn--') ? domainToUnicode(label) || label : label;
  const key = skeleton(comparisonLabel);
  let best = null;

  for (const candidate of OFFICIAL_LABELS) {
    if (!candidate.label) continue;
    if (candidate.key === key && candidate.label !== label) {
      return { host: candidate.host, reason: 'homograph_or_skeleton_match' };
    }
    if (Math.abs(candidate.key.length - key.length) > 2) continue;
    const distance = levenshtein(key, candidate.key);
    const minLength = Math.min(comparisonLabel.length, candidate.label.length);
    if ((distance === 1 && minLength >= 5) || (distance === 2 && minLength >= 10)) {
      if (!best || distance < best.distance) best = { host: candidate.host, reason: `typosquat_distance_${distance}`, distance };
    }
  }
  if (best) return best;

  for (const candidate of OFFICIAL_LABELS) {
    if (candidate.label.length < 5 || label === candidate.label || !label.includes(candidate.label)) continue;
    const extra = label.replace(candidate.label, '');
    if (extra.length > 0 && extra.length <= 24) return { host: candidate.host, reason: 'brand_embedded_in_deceptive_label' };
  }
  return null;
}

const SUSPICIOUS_TLDS = new Set([
  'zip', 'mov', 'xyz', 'top', 'club', 'work', 'click', 'link',
  'gq', 'cf', 'tk', 'ml', 'ga', 'icu', 'rest', 'loan',
]);

export function hostnameSignals(hostname) {
  const labels = hostname.split('.');
  const punycode = labels.some((label) => label.startsWith('xn--'));
  // URL.hostname is ASCII. Decode IDN labels before applying the mixed script signal.
  const mixedScript = punycode && domainToUnicode(hostname).split('.').some((label) =>
    /\p{Script=Latin}/u.test(label) && Array.from(label).some((character) =>
      /\p{Letter}/u.test(character) && !/\p{Script=Latin}/u.test(character)));
  const tld = labels[labels.length - 1];
  return { punycode, mixedScript, suspiciousTld: SUSPICIOUS_TLDS.has(tld) ? tld : null };
}
