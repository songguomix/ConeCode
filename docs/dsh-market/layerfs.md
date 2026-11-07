# DSH LayerFS × ConeCode: Assessment and Storage Substrate

This note records the concrete inspection of
[`Ephemeral-AI-Lab/dsh-layerfs`](https://github.com/Ephemeral-AI-Lab/dsh-layerfs)
at commit `b9bf3bc819b42007354f08c9444156188c4fbadb` and the storage work that
was implemented in ConeCode as a result.

## What `dsh-layerfs` actually is

It is a **DSH Web bundle**, not a standalone storage library:

| Part | What it does |
|---|---|
| `packages/dsh-layerfs` | Bundle manifest. `dsh.bundle.patch` is an ordered list of three patch files. |
| `@dsh-layerfs/host` | Cordis host plugin. Injects `shellEnv`, `sessions`; optionally injects `webServer`, `connection`, `systemPrompt`. Registers `/layerfs` HTTP routes, shell environment variables, session records and system-prompt context. |
| `@dsh-layerfs/client` | DSH Web client plugin (Work/History UI). Requires DSH client conversation/layout/sidebar packages. |
| `@dsh-layerfs/mock` | Scripted model for the UI demo. |
| `@layerfs/runtime` | Opens the LayerFS home, worker, Init, volume and Sandbox management. |
| `@layerfs/agent` / `@layerfs/backend` | SDK used by agents' bash commands. |

The host expects a real LayerFS deployment:

- a LayerFS source checkout at the commit in `layerfs.json`
  (`fabefdf87a4fa4742897998c2ece883013939184`);
- Rust-built `layerfs-daemon` and `liblayerfs_node.so` (or a sealed macOS/Windows
  bundle);
- a runtime Docker image and Docker Engine socket;
- profile settings (`image`, `daemon`, `bundle`, optionally `docker`/`volumes`);
- DSH Web services `shellEnv`, `sessions`, and optionally `webServer`,
  `connection`, `systemPrompt`;
- the DSH Web client host for the Work/History tabs.

Its storage is **not** `ctx.storage`. It persists project bindings in its own
`bindings.json` (with a cross-process directory lock) and its real workspace
history in a LayerFS SQLite Store inside a Docker volume. The DSH `ctx.storage`
subsystem is a different seam.

## What ConeCode now implements: the official DSH storage substrate

ConeCode mounts the real official packages, pinned to the same DSH baseline:

| Package | Version | Service |
|---|---|---|
| `@deepseek-ai/dsh-storage` | `0.2.2-rc.1` | `ctx.storage` hub |
| `@deepseek-ai/dsh-storage-json` | `0.2.2-rc.1` | `json` backend (`kv`) |
| `@deepseek-ai/dsh-storage-domain` | `0.2.2-rc.1` | `ctx.storageDomain` typed KV domains |

Implementation:

- The worker mounts the hub, JSON backend and domain form once per profile,
  before plugin rows.
- The backend root is `<profile>/storage`.
- Plugins may inject `storage`, `storageDomain`, or `storage.backend.json`; the
  runtime only advertises those services when the stack actually activated.
- Storage failures are reported as `storage: { ready: false, error }`; they never
  become empty stubs.
- The profile runtime receives the packages in
  `SHARED_DSH_RUNTIME`, so an existing profile upgrades on the next launch/install
  without touching plugin code.
- A real fixture plugin (`dsh-storage-probe`) opens a zod domain, writes a record,
  reads it, and reads it again after a full worker/service restart. The record
  survives in `<profile>/storage/conecode_probe.json`.

Example plugin code:

```js
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

const spec = defineDomain({
  name: 'my_plugin',
  version: 1,
  tables: { records: domainTable(z.object({ value: z.string() })) },
})

export const inject = ['storageDomain']
export async function apply(ctx) {
  const domain = await ctx.storageDomain.open(spec)
  ctx.effect(() => () => domain.close())
  await domain.table('records').put('key', { value: 'durable' })
}
```

This is the plugin-form storage bottom: the market/runtime does not hardcode a
single database. Backends are named providers, domains are typed consumers, and a
future SQLite or remote backend follows the same `StorageBackend` contract.

## Why `dsh-layerfs` is not installed or marked compatible yet

The local environment has the Docker command-line client, but the Docker daemon is
not running (`/Users/pinecones/.docker/run/docker.sock` is absent). More
importantly, none of the LayerFS prerequisites are present in this repository:

- no LayerFS checkout / sealed bundle / runtime image;
- no LayerFS `layerfs-daemon` native binary built for the container;
- no DSH Web client host for `@dsh-layerfs/client`;
- ConeCode does not provide `shellEnv`, `sessions`, `webServer`, `connection`
  or `systemPrompt` host services, nor DSH's session event log;
- the package's workspace dependency graph uses `workspace:*`/`link:` entries that
  only resolve inside its monorepo.

Therefore `dsh-layerfs` is **not** in the verified catalog. The market must not
show it as compatible, and it must not fake `/layerfs` routes, session records or
a Work/History UI. Its current classification is **incompatible / blocked**.

## What was added for future repository integrations

- Remote repository import supports a pinned Git commit and an optional package
  subdirectory, including the `git+<url>#<commit>&path:/<subdir>` install form.
  That is required by monorepo bundles such as `dsh-layerfs`.
- The compatibility layer now has a real storage seam rather than a per-plugin
  JSON file convention; plugins can store typed, durable non-session state through
  the official DSH API.
- The root Cordis disposal bug found during this work was fixed: per-row unload
  now disposes the row's own fibers, not `root.fiber` (which would silently tear
  down the storage stack and all later services).

## What full LayerFS support would require

1. A DSH host-service bridge for `sessions`, `shellEnv`, `webServer`,
   `connection` and `systemPrompt`, or running the official DSH Web/Desktop host as
   a sidecar.
2. Provisioning and health checks for Docker, the LayerFS checkout, the native
   daemon, the sealed bundle and the runtime image.
3. A client-capable host for `@dsh-layerfs/client` (ConeCode's current market is
   host-side only).
4. A real compatibility entry bound to an exact `dsh-layerfs` commit and
   LayerFS commit, plus live tests of Init, Branch, Commit, merge, publish and
   uninstall.

Until those are present, the honest status is blocked—not “compatible.”
