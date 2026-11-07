-- ConeCode Memory 2.0 — production PostgreSQL schema (reference).
--
-- The client only speaks the REST contract in docs/memory-2.0-cloud.md.
-- A gateway can use these tables for structured records, relations, change
-- cursors and device state; object storage (S3/R2/GCS) should hold Markdown,
-- attachments and backups. Do not put the change log in object storage.

create table if not exists memory_tenants (
  tenant_id text primary key,
  created_at timestamptz not null default now()
);

create table if not exists memory_records (
  tenant_id text not null references memory_tenants(tenant_id) on delete cascade,
  id uuid not null,
  project_id text,
  layer text not null,
  version integer not null,
  content_hash text not null,
  record jsonb not null,
  deleted_at timestamptz,
  updated_at timestamptz not null,
  primary key (tenant_id, id)
);
create index if not exists memory_records_project_idx on memory_records (tenant_id, project_id, layer);
create index if not exists memory_records_updated_idx on memory_records (tenant_id, updated_at desc);

-- Full-text index for server-side search. The gateway should use the same
-- CJK-aware tokenisation as the client for Chinese content.
create index if not exists memory_records_fts_idx
  on memory_records using gin (to_tsvector('simple', coalesce(record->>'title','') || ' ' || coalesce(record->>'content','')));

create table if not exists memory_changes (
  tenant_id text not null references memory_tenants(tenant_id) on delete cascade,
  seq bigserial,
  change_id text not null,
  memory_id uuid not null,
  op text not null,
  record jsonb,
  device_id text not null,
  project_id text,
  at timestamptz not null,
  primary key (tenant_id, seq),
  unique (tenant_id, change_id)
);
create index if not exists memory_changes_cursor_idx on memory_changes (tenant_id, seq);

create table if not exists memory_devices (
  tenant_id text not null references memory_tenants(tenant_id) on delete cascade,
  device_id text not null,
  last_seen_at timestamptz not null default now(),
  revoked boolean not null default false,
  primary key (tenant_id, device_id)
);

-- Object metadata only. The bytes live in S3/R2/GCS; the key is the stable
-- object id used by /objects/<key>.
create table if not exists memory_objects (
  tenant_id text not null references memory_tenants(tenant_id) on delete cascade,
  object_key text not null,
  bytes bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, object_key)
);

-- Optional immutable snapshots for cloud restore. A real deployment should
-- also copy objects to versioned object storage.
create table if not exists memory_backups (
  tenant_id text not null references memory_tenants(tenant_id) on delete cascade,
  backup_key text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, backup_key)
);

-- Idempotent write example (the gateway must perform this inside one
-- transaction, and return a conflict instead of overwriting a newer version):
--
-- insert into memory_changes (tenant_id, change_id, memory_id, op, record, device_id, project_id, at)
-- values ($1, $2, $3, $4, $5, $6, $7, now())
-- on conflict (tenant_id, change_id) do nothing;
