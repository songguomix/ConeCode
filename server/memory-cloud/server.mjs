#!/usr/bin/env node
// ConeCode Memory 2.0 — reference cloud service.
//
// A real, standalone HTTP service (NOT a file mirror of local memory): it has
// its own record store, server-side full-text query, change-log cursor,
// device/version tracking, tombstones, tenant isolation, token auth, object
// storage and backup/restore. Run with plain Node — zero dependencies:
//
//   MEMORY_CLOUD_TOKEN=your-secret node server/memory-cloud/server.mjs
//
// For production, put it behind TLS (or set TLS_CERT/TLS_KEY), point the app's
// Cloud Memory Settings at it, and back the store with PostgreSQL + S3/R2 by
// implementing the same contract (see docs/memory-2.0-cloud.md). This reference
// uses an atomic JSON file so it can be deployed and tested without a database.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 8791);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.MEMORY_CLOUD_TOKEN || '';
const DATA_DIR = process.env.MEMORY_CLOUD_DIR || path.resolve(process.cwd(), '.memory-cloud-data');
const ALLOWED_TENANTS = (process.env.MEMORY_CLOUD_TENANTS || '').split(',').map((s) => s.trim()).filter(Boolean);
const TLS_CERT = process.env.TLS_CERT || '';
const TLS_KEY = process.env.TLS_KEY || '';

if (!TOKEN) {
  console.error('[memory-cloud] MEMORY_CLOUD_TOKEN is required. Refusing to start without authentication.');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- storage --------------------------------------------------------------

const tenants = new Map();

function tenantFile(tenant) {
  return path.join(DATA_DIR, `${tenant.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

function loadTenant(tenant) {
  if (tenants.has(tenant)) return tenants.get(tenant);
  let data = { records: [], changes: [], seq: 0, applied: [], objects: {}, devices: [], revoked: [] };
  try {
    const file = tenantFile(tenant);
    if (fs.existsSync(file)) data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf-8')) };
  } catch (e) {
    console.error('[memory-cloud] failed to read tenant store:', e.message);
  }
  tenants.set(tenant, data);
  return data;
}

function persist(tenant) {
  const data = loadTenant(tenant);
  const file = tenantFile(tenant);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

function backupTenant(tenant) {
  const file = tenantFile(tenant);
  const key = `backup-${tenant}-${Date.now()}.json`;
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(DATA_DIR, key));
  return key;
}

// ---- full-text (server side, independent of the client) -------------------

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (CJK.test(ch)) {
      let j = i;
      while (j < s.length && CJK.test(s[j])) j++;
      const run = s.slice(i, j);
      if (run.length === 1) out.push(run);
      for (let k = 0; k < run.length - 1; k++) out.push(run.slice(k, k + 2));
      i = j;
    } else if (/[a-z0-9]/.test(ch)) {
      let j = i;
      while (j < s.length && /[a-z0-9_]/.test(s[j])) j++;
      if (j - i > 1) out.push(s.slice(i, j));
      i = j;
    } else i++;
  }
  return out;
}

// ---- http helpers ---------------------------------------------------------

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Tenant-Id, X-Device-Id');
}

function json(res, status, body) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 8 * 1024 * 1024) reject(new Error('body too large')); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function authenticate(req) {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${TOKEN}`) return { ok: false, status: 401, error: 'unauthorised: invalid bearer token' };
  const tenant = String(req.headers['x-tenant-id'] || 'default');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tenant)) return { ok: false, status: 400, error: 'invalid tenant id' };
  if (ALLOWED_TENANTS.length && !ALLOWED_TENANTS.includes(tenant)) {
    return { ok: false, status: 403, error: 'tenant is not authorised for this token' };
  }
  const deviceId = String(req.headers['x-device-id'] || 'unknown');
  if (loadTenant(tenant).revoked.includes(deviceId)) {
    return { ok: false, status: 403, error: 'device authorisation has been revoked' };
  }
  return { ok: true, tenant, deviceId };
}

function passes(record, q) {
  if (!q.includeDeleted && record.deletedAt != null) return false;
  if (!q.statuses?.length && (record.status === 'archived' || record.status === 'superseded')) return false;
  if (q.layers?.length && !q.layers.includes(record.layer)) return false;
  if (q.types?.length && !q.types.includes(record.type)) return false;
  if (q.statuses?.length && !q.statuses.includes(record.status)) return false;
  if (q.tags?.length && !q.tags.some((t) => (record.tags || []).includes(t))) return false;
  if (q.importanceMin != null && record.importance < q.importanceMin) return false;
  if (q.confidenceMin != null && record.confidence < q.confidenceMin) return false;
  if (q.from != null && record.updatedAt < q.from) return false;
  if (q.to != null && record.updatedAt > q.to) return false;
  if (q.sourceSessionId && record.sourceSessionId !== q.sourceSessionId) return false;
  return true;
}

/** Project boundary enforced on the SERVER too — never rely on the client alone. */
function inScope(record, q) {
  if (q.scope === 'global') return record.layer === 'global';
  if (q.scope === 'project') return !!q.projectId && record.projectId === q.projectId;
  return record.layer === 'global' || (!!q.projectId && record.projectId === q.projectId);
}

function serverSearch(data, q) {
  const text = String(q.text || '');
  const terms = tokenize(text);
  // Browse only for an actually empty query. Punctuation-only text must not
  // return the whole tenant.
  if (text.trim() && !terms.length) return [];
  const pool = data.records.filter((r) => inScope(r, q) && passes(r, q));
  const hits = pool.map((record) => {
    const haystack = `${record.title} ${record.title} ${(record.tags || []).join(' ')} ${record.content} ${record.why || ''}`.toLowerCase();
    const matchedTerms = [];
    let score = 0;
    for (const term of new Set(terms)) {
      const count = haystack.split(term).length - 1;
      if (count > 0) { score += 1 + Math.log(count); matchedTerms.push(term); }
    }
    if (terms.length && !matchedTerms.length) return null;
    score += (record.importance || 0) * 0.4 + (record.confidence || 0) * 0.2;
    return {
      record, score, matchedTerms,
      reasons: [`server full-text: ${matchedTerms.slice(0, 4).join(', ') || 'browse'}`, `tenant store v${record.version}`],
    };
  }).filter(Boolean);
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, q.limit || 30);
}

// ---- routes ---------------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname;
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  if (route === '/health') {
    // Health is public only in the sense that it reports the service identity;
    // it still requires a valid token so a stray URL cannot be probed.
    const auth = authenticate(req);
    if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.error });
    return json(res, 200, { ok: true, service: 'conecode-memory-cloud', version: 1, tenant: auth.tenant });
  }

  const auth = authenticate(req);
  if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.error });
  const { tenant, deviceId } = auth;
  const data = loadTenant(tenant);

  if (route === '/search' && req.method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, { hits: serverSearch(data, body.query || {}) });
  }

  if (route === '/changes' && req.method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    const limit = Math.min(500, Number(url.searchParams.get('limit') || 200));
    const changes = data.changes.filter((c) => c.seq > since).slice(0, limit);
    return json(res, 200, { changes, cursor: data.seq });
  }

  if (route === '/changes' && req.method === 'POST') {
    const body = await readBody(req);
    const changes = Array.isArray(body.changes) ? body.changes : [];
    const acceptedChangeIds = [];
    const conflicts = [];
    for (const change of changes) {
      if (!change || typeof change.memoryId !== 'string') continue;
      if (data.applied.includes(change.changeId)) { acceptedChangeIds.push(change.changeId); continue; }
      data.applied.push(change.changeId);
      if (data.applied.length > 5000) data.applied = data.applied.slice(-3000);

      const index = data.records.findIndex((r) => r.id === change.memoryId);
      const current = index >= 0 ? data.records[index] : null;
      const incoming = change.record;
      // Idempotent replay of an already-current record: accept without a new
      // change-log row, so other devices never see a duplicate.
      if (current && incoming
        && current.version === incoming.version
        && current.contentHash === incoming.contentHash) {
        acceptedChangeIds.push(change.changeId);
        continue;
      }
      // Version conflict: another device wrote at least as new a version with
      // different content. Never overwrite it; return both sides to the client.
      if (current && incoming
        && current.version >= incoming.version
        && current.deviceId !== incoming.deviceId
        && current.contentHash !== incoming.contentHash) {
        conflicts.push({
          id: `cf-${randomUUID()}`, memoryId: change.memoryId,
          local: incoming, remote: current, detectedAt: Date.now(), resolved: false,
        });
        acceptedChangeIds.push(change.changeId);
        continue;
      }
      if (incoming) {
        if (index >= 0) data.records[index] = incoming;
        else data.records.push(incoming);
      } else if (change.op === 'delete' && current) {
        data.records[index] = { ...current, deletedAt: change.at || Date.now(), status: 'archived' };
      }
      data.seq += 1;
      data.changes.push({ ...change, seq: data.seq, deviceId: body.deviceId || deviceId });
      acceptedChangeIds.push(change.changeId);
    }
    if (!data.devices.some((d) => d.deviceId === deviceId)) data.devices.push({ deviceId, lastSeenAt: Date.now() });
    else data.devices = data.devices.map((d) => d.deviceId === deviceId ? { ...d, lastSeenAt: Date.now() } : d);
    persist(tenant);
    return json(res, 200, { ok: true, acceptedChangeIds, cursor: data.seq, conflicts });
  }

  if (route.startsWith('/objects/')) {
    const key = decodeURIComponent(route.slice('/objects/'.length));
    if (req.method === 'PUT') {
      const body = await readBody(req);
      data.objects[key] = String(body.content ?? '');
      persist(tenant);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET') return json(res, 200, { content: data.objects[key] ?? null });
  }

  if (route === '/usage' && req.method === 'GET') {
    return json(res, 200, {
      records: data.records.length,
      changes: data.changes.length,
      objects: Object.keys(data.objects).length,
      bytes: fs.existsSync(tenantFile(tenant)) ? fs.statSync(tenantFile(tenant)).size : 0,
      devices: data.devices,
    });
  }

  if (route === '/devices' && req.method === 'GET') return json(res, 200, { devices: data.devices, revoked: data.revoked });
  if (route === '/devices/revoke' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.deviceId && !data.revoked.includes(body.deviceId)) data.revoked.push(body.deviceId);
    persist(tenant);
    return json(res, 200, { ok: true });
  }
  if (route === '/tenant/delete' && req.method === 'POST') {
    const body = await readBody(req);
    // Destructive tenant deletion requires an explicit confirmation value; a
    // stale client cannot wipe a namespace by accident.
    if (body.confirm !== tenant) return json(res, 400, { ok: false, error: 'confirmation must equal the tenant id' });
    const file = tenantFile(tenant);
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    for (const name of fs.readdirSync(DATA_DIR)) {
      if (name.startsWith(`backup-${tenant}-`) && name.endsWith('.json')) {
        try { fs.rmSync(path.join(DATA_DIR, name), { force: true }); } catch { /* ignore */ }
      }
    }
    tenants.delete(tenant);
    return json(res, 200, { ok: true });
  }
  if (route === '/backup' && req.method === 'POST') return json(res, 200, { ok: true, key: backupTenant(tenant) });
  if (route === '/restore' && req.method === 'POST') {
    const files = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith(`backup-${tenant}-`) && f.endsWith('.json')).sort();
    if (!files.length) return json(res, 404, { ok: false, error: 'no backup found' });
    fs.copyFileSync(path.join(DATA_DIR, files[files.length - 1]), tenantFile(tenant));
    tenants.delete(tenant);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { ok: false, error: `unknown route ${req.method} ${route}` });
}

const listener = async (req, res) => {
  try { await handle(req, res); }
  catch (e) { json(res, 500, { ok: false, error: e?.message || String(e) }); }
};

let server;
if (TLS_CERT && TLS_KEY) {
  server = https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, listener);
} else {
  server = http.createServer(listener);
}

server.listen(PORT, HOST, () => {
  const proto = TLS_CERT && TLS_KEY ? 'https' : 'http';
  console.log(`[memory-cloud] listening on ${proto}://${HOST}:${PORT} (tenant data: ${DATA_DIR})`);
  if (!TLS_CERT) console.log('[memory-cloud] plain HTTP — deploy behind TLS or set TLS_CERT/TLS_KEY for production.');
});

export { server };
