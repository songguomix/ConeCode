// Adapts Aegis server/services/{authority,gate}.ts to local-only review (MIT; see LICENSE).
import { isIP } from 'node:net';
import { lookupOfficial, normalizeHostname } from './registry.mjs';
import { detectLookalike, hostnameSignals } from './lookalike.mjs';

const MODES = new Set(['tri', 'strict', 'observe']);
const LOCAL_SUFFIXES = new Set(['localhost', 'localdomain', 'local', 'lan', 'internal', 'home.arpa']);

function domainList(value, option) {
  if (!Array.isArray(value)) throw new TypeError(`${option} must be an array of domain names.`);
  return new Set(Array.from(value, (entry) => {
    if (typeof entry !== 'string' || !/^[^:/?#@\s\\]+$/u.test(entry.trim())) {
      throw new TypeError(`${option} must contain only domain names.`);
    }
    const domain = normalizeHostname(new URL(`https://${entry.trim()}`).hostname);
    if (!domain.includes('.') || domain.split('.').some((label) => !label)) {
      throw new TypeError(`${option} must contain only fully qualified domain names.`);
    }
    return domain;
  }));
}

function matchesDomain(hostname, list) {
  let suffix = hostname;
  while (suffix) {
    if (list.has(suffix)) return true;
    if (!suffix.includes('.')) break;
    suffix = suffix.slice(suffix.indexOf('.') + 1);
  }
  return false;
}

function decide(authority, mode) {
  const { official, lookalike, allowed, denied } = authority;
  // Mirrors the upstream modes with unavailable VirusTotal and no online intel.
  if (denied) return 'block';
  if (mode === 'observe') return lookalike ? 'review' : 'allow';
  if (lookalike && !allowed) return 'block';
  if (allowed || official) return 'allow';
  return mode === 'strict' ? 'block' : 'review';
}

function scoreOf(decision, { official, lookalike, allowed, denied, punycode, mixedScript }, reasons) {
  // Upstream Aegis starts at 50 and subtracts 5 for unavailable VirusTotal.
  let score = 45;
  if (official) score += 30;
  if (allowed) score += 25;
  if (denied) score -= 50;
  if (lookalike) score -= 35;
  if (punycode) score -= 15;
  if (mixedScript) score -= 10;
  for (const { severity } of reasons) {
    if (severity === 'critical') score -= 10;
    if (severity === 'warn') score -= 3;
  }
  if (decision === 'allow') score = Math.max(score, 70);
  if (decision === 'block') score = Math.min(score, 25);
  return Math.max(0, Math.min(100, score));
}

function evaluateUrl(url, { allowlist, denylist, mode }) {
  const hostname = new URL(url).hostname.replace(/\.$/u, '');
  if (isIP(hostname.replace(/^\[|\]$/gu, '')) || matchesDomain(hostname, LOCAL_SUFFIXES)) {
    return {
      url, hostname, decision: 'block', score: 0,
      reasons: [{ code: 'local_or_literal', severity: 'critical', message: 'IP addresses and local network names are outside search URL review.' }],
    };
  }
  if (!hostname.includes('.') || hostname.split('.').some((label) => !label)) {
    return {
      url: null, hostname: '', decision: 'block', score: 0,
      reasons: [{ code: 'invalid_url', severity: 'critical', message: 'Expected a fully qualified hostname.' }],
    };
  }

  const official = lookupOfficial(hostname);
  const allowed = matchesDomain(hostname, allowlist);
  const denied = matchesDomain(hostname, denylist);
  const lookalike = official ? null : detectLookalike(hostname);
  const { punycode, mixedScript, suspiciousTld } = hostnameSignals(hostname);
  const reasons = [];
  const note = (code, severity, message) => reasons.push({ code, severity, message });

  if (denied) note('denylisted', 'critical', `Hostname ${hostname} is on the operator denylist.`);
  if (allowed) note('allowlisted', 'info', `Hostname ${hostname} is on the operator allowlist.`);
  if (official) note('official_domain', 'info', `Matched official registry: ${official.entry.brand} — ${official.entry.subject}`);
  if (lookalike) note('lookalike_domain', 'critical', `Possible lookalike of ${lookalike.host} (${lookalike.reason}).`);
  if (punycode) note('punycode', 'warn', 'Hostname uses punycode (possible homograph attack).');
  if (mixedScript) note('mixed_script', 'warn', 'A hostname label mixes Latin and non-Latin scripts.');
  if (suspiciousTld) note('suspicious_tld', 'warn', `TLD .${suspiciousTld} is frequently abused; treat with caution.`);
  note('rdap_skipped', 'info', 'RDAP lookup skipped in offline review.');
  note('vt_degraded', 'warn', 'VirusTotal and online threat intel are unavailable in offline review. Local authority checks still apply.');

  const authority = { official, allowed, denied, lookalike, punycode, mixedScript };
  const decision = decide(authority, mode);
  const score = scoreOf(decision, authority, reasons);
  if (decision === 'review') note('review_required', 'warn', 'Review this result before visiting the URL.');
  if (decision === 'block' && mode === 'strict' && !denied && !lookalike) {
    note('strict_unverified', 'warn', 'Strict policy only allows domains in the official registry or operator allowlist.');
  }
  return { url, hostname, decision, score, reasons };
}

/** Create a local Aegis reviewer. `review` expects prevalidated canonical HTTP(S) URLs. */
export function createAegisEngine({ allowlist = [], denylist = [], policyMode = 'tri' } = {}) {
  if (!MODES.has(policyMode)) throw new TypeError('policyMode must be tri, strict, or observe.');
  const policy = { mode: policyMode, allowlist: domainList(allowlist, 'allowlist'), denylist: domainList(denylist, 'denylist') };
  return { async review(urls) { return urls.map((url) => evaluateUrl(url, policy)); } };
}
