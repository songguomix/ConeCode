// Adapted from Aegis server/services/registry.ts (MIT; see LICENSE).
import officialDomains from './official-domains.json' with { type: 'json' };

export const officialHostnames = Object.keys(officialDomains).sort();

export function normalizeHostname(host) {
  return host.trim().toLowerCase().replace(/^\./u, '').replace(/\.$/u, '');
}

export function lookupOfficial(hostname) {
  const labels = normalizeHostname(hostname).split('.');
  // Match a listed host and its subdomains, but never an unrelated suffix.
  for (let i = 0; i < labels.length - 1; i++) {
    const host = labels.slice(i).join('.');
    if (Object.hasOwn(officialDomains, host)) return { host, entry: officialDomains[host] };
  }
  return null;
}
