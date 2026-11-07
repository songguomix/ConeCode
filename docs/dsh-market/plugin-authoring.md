# Plugin Authoring and Compatibility Extension

ConeCode loads two formats through the same lifecycle:

- **DSH bundle** — a real `package.json` with `dsh.bundle.patch` (the DSH format).
- **ConeCode-native** — `conecode.plugin.json` with `conecode.plugin === true`
  and an `activate(api, config)` entry.

ConeCode-specific fields always live under `conecode`; DSH fields stay under
`dsh` and are preserved unchanged in `InstalledPlugin.manifestRaw`.

## Native plugin: minimum runnable example

See [`examples/native-plugins/hello-conecode`](../../examples/native-plugins/hello-conecode).

`conecode.plugin.json`:

```json
{
  "name": "hello-conecode",
  "version": "1.0.0",
  "description": "One tool, one command, one skill.",
  "author": "ConeCode",
  "license": "MIT",
  "conecode": {
    "plugin": true,
    "apiVersion": 1,
    "entry": "./index.mjs",
    "capabilities": ["tools", "commands", "skills"],
    "config": {
      "greeting": { "type": "string", "default": "Hello" }
    }
  }
}
```

`index.mjs`:

```js
export async function activate(api, config = {}) {
  const offTool = api.tools.register({
    name: 'hello_conecode',
    description: 'Return a deterministic greeting.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    async execute(args) {
      return { message: `${config.greeting || 'Hello'}, ${args.name}!` };
    },
  });

  const offCommand = api.commands.register({
    name: 'hello',
    description: '/hello [name]',
    handler({ rawInput }) {
      return { kind: 'success', text: `Hello, ${rawInput || 'world'}` };
    },
  });

  const offSkill = api.skills.register({
    name: 'hello-conecode',
    description: 'How this plugin works.',
    content: '# Hello\n\nRegistered by a ConeCode-native plugin.',
  });

  return () => { offTool(); offCommand(); offSkill(); };
}
```

Rules:

- Only declared host capabilities are provided. An undeclared service access fails;
  the host does not inject empty stubs.
- Every `register` returns a disposer. The returned `activate` disposer is optional
  but recommended; the host also removes all contributions owned by the plugin on
  disable/uninstall.
- `apiVersion` is currently `1`. An unknown version is rejected at install time.
- There is no renderer UI API yet; native plugins contribute host-side tools,
  commands and skills. Browser UI extension is listed as a separate, unsupported
  capability rather than faked.

## Durable plugin storage

ConeCode mounts the official DSH storage stack for every profile. A DSH host
plugin can inject `storageDomain` and use the official typed KV API:

```js
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export const inject = ['storageDomain']
const spec = defineDomain({
  name: 'my_plugin',
  version: 1,
  tables: { records: domainTable(z.object({ value: z.string() })) },
})

export async function apply(ctx) {
  const domain = await ctx.storageDomain.open(spec)
  ctx.effect(() => () => domain.close())
  await domain.table('records').put('key', { value: 'durable' })
}
```

The media owner is the `json` backend under `<profile>/storage`; the backend,
domain form and hub are real `@deepseek-ai/dsh-storage*@0.2.2-rc.1` packages.
`ctx.storage`, `ctx.storageDomain` and `storage.backend.json` are advertised only
when the stack activates; a failed backend is reported, never replaced by an empty
stub. LayerFS is a separate external runtime and is not simulated here.

## DSH bundle package

Minimum:

```text
my-plugin/
  package.json
  cordis.patch.yml
  index.js
```

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "type": "module",
  "main": "index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": { "dsh": ">=0.2.2-0 <0.3.0" }
}
```

```js
export const name = 'my-plugin'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register({
    name: 'my_tool',
    description: 'Do one thing.',
    parameters: { type: 'object', properties: {} },
    async execute() { return 'done' },
  })
}
```

Supported DSH semantics in this release:

- `dsh.bundle.patch` as one path or an ordered list; paths are resolved relative to
  the package and must remain inside it.
- Patch lists are concatenated; `insert` appends root rows, an `{id, config, ...}`
  patch replaces the named row's keys. Inserted rows get stable ids.
- `dsh.bundle.platforms` checked against the Node host platform.
- `engines.dsh` alone decides when present; otherwise every `@deepseek-ai/dsh*`
  peer range must match. Ranges use `includePrerelease: true`, matching DSH.
- `engines.node` is checked against the worker Node runtime.
- Cordis `inject`, `provide`, `effect`, event listeners and disposal are provided by
  the real `@deepseek-ai/cordis` 4.1.0 runtime.
- Exported `Config` (Schemastery/standard-schema) is validated by Cordis before
  activation. A rejected config keeps the previous running instance.

Explicitly unsupported in this release:

- `cordis:include`, native Cordis groups, `!!js` dynamic rows.
- Any injected service other than `tools`, `commands`, `skills`, `credentials` and
  the built-in Cordis services.
- DSH Web client halves (`dsh.client`): detected and reported, never mounted.
- HTTP routes, model provider adapters, sessions, agents, LLM adapters, filesystem
  services and native binaries.

A plugin that needs those capabilities should be listed as **Partial** or
**Incompatible** in its verification record, with the missing item named.

## Adding a host capability (developer checklist)

1. Define the service shape and its cleanup semantics, not just a method name.
2. Provide it from a host plugin in `electron/dsh-market/runtime-host.ts`; never use
   an empty object to silence an `inject`.
3. Add the service name to `SUPPORTED_HOST_SERVICES` in
   `electron/dsh-market/constants.ts` only when it is actually implemented.
4. Wire contributions into the internal model (`PluginContributions`) and, where
   appropriate, into ConeCode's existing tool bridge.
5. Add a unit test for missing/cleanup behavior and an E2E test with a real plugin.
6. Update the matrix and a verification record only after the exact version and
   environment pass. A stale record must remain Unverified.

## Packaging and install expectations

- npm: build `lib/`/`dist/` before publishing. Installation uses exact versions.
- Git: pin a 40-character commit. `prepare` scripts are off unless the user
  explicitly allows dependency scripts.
- Local: the folder is copied into the profile; modifications to the original
  directory do not affect the installed copy.
- Keep `dsh.bundle.patch` rows referencing the package name, not a relative path,
  so Node resolves the installed package.
- Do not put credentials in a patch config; configure them in the market UI and
  use the plugin's secret mechanism. The local market stores ordinary config as
  visible JSON.
