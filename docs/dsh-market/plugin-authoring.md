# Plugin Authoring and Compatibility Extension

For an installable DSH command and a walkthrough covering development, packaging and catalog distribution, see the [Chinese developer guide](plugin-authoring.zh-CN.md) and the [sample package](../../examples/dsh-plugins/hello-dsh).

For the ConeCode-native manifest, host API, and compatibility tests, see the [native plugin protocol reference (Chinese)](native-plugin-protocol.zh-CN.md).

ConeCode loads two formats through the embedded worker:

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

- The v1 host provides `tools`, `commands`, `skills`, `logger`, and the `plugin`
  identity. Use `conecode.capabilities` to describe the services your plugin
  uses. The field is manifest metadata and the Node worker runs plugin code with
  the application's OS permissions.
- Every `register` returns a disposer. The returned `activate` disposer is optional
  but recommended; the host also removes all contributions owned by the plugin on
  disable/uninstall.
- `apiVersion` is currently `1`. An unknown version is rejected at install time.
- Native plugins apply defaults and validate the saved `native` row's configuration
  in `activate`. `conecode.config` describes the plugin's settings.
- Use **Plugin Market → Installed → Run** to execute `hello_conecode` and the
  `hello` command. The market displays the command as `/hello` and exposes it to
  the model through the chat tool bridge. The chat composer's slash menu has its
  own command registry. Native v1 integrations run on the host and contribute
  tools, commands, and skills.

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

Use the official DSH Web profile for capabilities outside the embedded worker:

- `cordis:include`, native Cordis groups, `!!js` dynamic rows.
- Additional services required by a plugin beyond those active in **Sources & runtime**.
- DSH Web client halves (`dsh.client`), including themes and settings panels.
- HTTP routes, sessions, browser model selection, and plugins that depend on the full Web composition.

For published npm packages, **Install in DSH Web** installs the selected version in the official host. Use **Sources & runtime → Open DSH Web** to manage it. Record verification for the runtime you actually tested.

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

- DSH npm: build `lib/`/`dist/` before publishing. Installation uses exact versions.
- DSH Git: pin a 40-character commit. `prepare` scripts are off unless the user
  explicitly allows dependency scripts.
- DSH local folder: the installer copies the folder into the active profile.
- Native: use **Sources → Import local folder** or install the bundled example
  from Discover. To distribute a native plugin, share the directory or an archive
  that users can unpack before importing. ConeCode copies the folder into the
  profile. Import a new plugin version to update the installed copy.
- Keep `dsh.bundle.patch` rows referencing the package name, not a relative path,
  so Node resolves the installed package.
- DSH plugins can request the host's `credentials` service. The local market stores ordinary config as visible JSON.
