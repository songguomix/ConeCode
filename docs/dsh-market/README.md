# ConeCode DSH Plugin Market

ConeCode's plugin market unifies **ConeCode-native plugins** with **DSH (DeepSeek
Harness) community plugins**. It is a real installer and host-side runtime, not a
static catalog or a copied install command.

Open **Plugin Market** from the puzzle-piece button on the right side of the
sidebar toolbar (or from Settings → Plugins → Add → Plugin Market). Installed DSH plugins are also
listed and manageable directly in **Settings → Plugins**. The panel has three areas:

- **Discover** — search across names, authors, descriptions and capability labels;
  filter by category; sort by relevance/name/publish time/npm downloads/GitHub
  stars; compatible-only filter; paged results.
- **Installed** — enable/disable, per-row JSON configuration, logs, direct tool and
  command execution, update/rollback and uninstall with an explicit data-retention
  choice.
- **Sources & runtime** — bundled/remote/local catalog sources, last sync, stale
  cache and errors, local plugin import, pinned runtime facts and warnings.
- **Repository import** — `github:owner/repo` or a public https Git URL with an
  optional branch/tag/commit and package subdirectory. ConeCode resolves the ref
  to an exact commit, shallow-fetches that tree, reads the real package manifest and
  `dsh.bundle.patch`, shows a preview, then installs the pinned commit.

Every displayed download/star number is a point-in-time observation fetched from
the npm and GitHub APIs and stamped with provenance. There are no invented ratings,
certification badges, download counts or ratings.

## Run

```sh
npm install
npm run dev          # Vite + Electron; writes dist-electron/dsh-worker.js
# or
npm run build && npm start
```

The plugin market is behind the sidebar's puzzle-piece button. The first real
plugin install needs network access, `npm` 10+ on `PATH`, and enough disk space for
the pinned compatibility runtime (shared per profile). The native sample can be
installed without npm.

## Settings management

The puzzle-piece button sits in the right-hand group of the sidebar toolbar.
Installed DSH plugins are also embedded in **Settings → Plugins**: the same
enable/disable toggle, per-row configuration, logs, direct tool/command runner,
rollback and uninstall actions are available there, with a shortcut back to
Discover.

## Pinned DSH baseline

| Item | Value |
|---|---|
| DSH version | `0.2.2-rc.1` |
| Git tag | `dsh-v0.2.2-rc.1` |
| Commit | `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` |
| Compatibility adapter | `1.0.0` |
| Host runtime | Electron `42.11.3`, Node `24.19.0` (Electron embedded), macOS arm64 |

Source and docs used to derive the layer:

- `docs/architecture.md`
- `docs/user/develop/basic/publish.md`
- `packages/boot/app-boot/README.md`
- `packages/boot/plugin-manager/README.md`
- `packages/boot/app-boot/src/plugin-compatibility.ts`
- `packages/boot/app-boot/src/profile.ts`
- `packages/util/plugin-market-index/README.md`

The pinned version is stored in `src/core/dsh-market/types.ts` and in the bundled
catalog/verification files. Changing it invalidates verification records because
`verificationFresh` requires the exact baseline, commit and adapter version.

## Architecture

```text
React Plugin Market
  store + Discover / Installed / Detail / Sources
              │ typed preload bridge
              ▼
Electron main: DshMarketService
  ├─ catalog sources  ── bundled / remote format-1 / local catalog.json
  ├─ PackageInstaller ── npm exact version / pinned git / local dir/tarball
  ├─ MarketStateStore ── market-state.json, profiles, logs, backups
  └─ DshRuntimeManager ── worker_threads
                         │
                         ▼
              Cordis runtime host (isolated worker)
                ├─ tools service
                ├─ commands service
                ├─ skills service
                └─ credentials (environment-backed, optional)
```

The renderer never runs third-party plugin code. Install, probe, activation,
configuration validation, cleanup and tool/command execution happen in the
Electron main process and an isolated Node worker. The main process talks to the
worker with a request/response protocol; a crashed or hung worker is terminated
and surfaced as a runtime error rather than treated as a successful install.

### Why this layer (not a fake DSH)

The project already runs on Electron and bundles a Node 24 runtime. We implemented
an explicit compatibility adapter around the real `@deepseek-ai/cordis` 4.1.0
runtime and the pinned DSH peer packages instead of pretending DSH HTTP APIs or
the official Web client exist. The four required layers are:

1. **Directory and metadata recognition** — `package.json`, `dsh.bundle.patch`,
   ordered patch files, profile order, `insert`/id-targeted override semantics,
   `dsh.bundle.platforms`.
2. **Package and dependency installation** — real npm install of exact versions,
   pinned Git commits, local directories/tarballs; resolved version and lockfile
   integrity recorded; no shell interpolation.
3. **Runtime loading** — real Cordis `Context`, `inject`, `provide`, effects,
   events and disposal; named errors for missing host capabilities.
4. **Actual function** — real tools/commands/skills executed and asserted; see
   the compatibility matrix and evidence below.

## What works, what is partial, what is not claimed

| Capability | Status |
|---|---|
| DSH host-side tools (`ctx.tools.register`) | Implemented and verified |
| DSH host commands (`ctx.commands.register`) | Implemented and verified |
| DSH skills (`ctx.skills.register` / `registerProvider`) | Implemented and verified |
| Cordis config validation via exported `Config` | Implemented; invalid values keep the previous working instance |
| `engines.dsh`, DSH peer ranges, `engines.node`, bundle platforms | Implemented; prereleases included as DSH does |
| Exact-version compatibility exemptions | Implemented; persisted per profile; explicit risk acknowledgement |
| DSH Web client halves (`dsh.client`) | **Not mounted.** Detected and reported as `web-client` missing; host half may still be verified |
| `cordis:include`, Cordis groups, dynamic `!!js` patch rows | Explicitly rejected with a named error; not guessed |
| DSH host services other than tools/commands/skills/credentials/storage/domain | Missing capabilities are a hard load error, never empty stubs |
| HTTP routes, sessions, LLM adapters, model providers | Not provided by this layer; packages requiring them are shown as partial/incompatible |
| Native binaries / platform-specific prebuilt addons | Not claimed; platform mismatch is reported |

The plugin **detail page** shows two different facts side by side:

- the author-declared DSH range (`engines.dsh`, else DSH peer ranges);
- the ConeCode actual result, which only becomes **Verified** when a matching record
  exists for the exact plugin version, baseline commit, adapter version and runtime
  environment. Otherwise it is **Unverified** even when the range looks compatible.

## Plugin storage substrate

Every profile mounts the real official DSH storage stack before plugin rows:

- `@deepseek-ai/dsh-storage` → `ctx.storage` hub;
- `@deepseek-ai/dsh-storage-json` → named `json` KV backend under
  `<profile>/storage`;
- `@deepseek-ai/dsh-storage-domain` → `ctx.storageDomain` with schema-validated,
  change-emitting domains.

Plugins can inject `storage`, `storageDomain` or `storage.backend.json`; these
services are advertised only when the stack actually activated. A real fixture
plugin writes a zod domain record and reads it again after a full worker restart.
The market does not pretend a missing backend exists.

See [`layerfs.md`](layerfs.md) for the concrete `dsh-layerfs` inspection: it is a
DSH Web/LayerFS bundle that needs `shellEnv`, `sessions`, a web server, a LayerFS
checkout, Docker, native binaries and a client host. It is currently **blocked /
not marked compatible**; the official storage seam above is what plugins can use
today.

## Hot vs restart

| Change | Behavior |
|---|---|
| Install/update/disable a host-side tool, command or skill | Unload and reload the Cordis scope immediately |
| Edit a row config | Validate, restart that plugin instance, keep the old instance on rejection |
| DSH Web client half | Not mounted; changing or restarting ConeCode will not add the DSH Web UI |
| Worker crash or startup load failure | The plugin is reported as `restart-required`; use **Restart runtime** after fixing the cause |

Only the host-side types listed above are hot. The market never claims that a
client-only plugin became active just because the package installed.

## Installation and integrity

The default registry is the npm client's configured registry; no implicit
community API is treated as an official registry.

```text
npm package:  <name>@<exact version>
Git source:   git+https://<host>/<owner>/<repo>.git#<40-char commit>
Local source: file:/absolute/path  (directory or .tgz)
Native:       copied local directory with conecode.plugin.json
```

- The UI only accepts catalog versions or a user-picked local folder. It never
  concatenates a shell command.
- npm runs with `shell: false`; the spec is an argv token and is validated before
  use (`security.ts`).
- Dependency lifecycle scripts are **off by default** (`--ignore-scripts`).
  Allowing them is an explicit per-install checkbox and runs with user permissions
  outside the agent sandbox.
- The exact version is read back from the installed package. npm lockfile
  `integrity` is recorded when available; local/native packages get a SHA-256 of
  their manifest and entry.
- A probe activation runs in a temporary Cordis scope before the package replaces
  the current version. A failed probe leaves the previous version untouched.
- Updates keep the previous package directory as a rollback backup. A post-swap
  activation failure restores it; a failed rollback is reported, not hidden.
- Uninstall unloads the plugin, confirms that its tools/commands/skills are gone,
  removes the package and profile links, and keeps plugin data unless the user
  checks “also delete plugin data”. Logs remain available for audit.
- Operations are serialized per plugin; a second install/update for the same
  plugin is rejected with a busy error. Cancellation aborts npm and the staging
  tree. Profile switching and runtime restart are blocked while an operation is
  active, so a half-swapped package can never be attributed to the wrong profile.

Profile data lives under:

```text
<userData>/dsh-market/
  market-state.json
  profiles/<profile>/
    package.json                 # DSH-compatible projection
    cordis.patch.yml             # generated projection of installed rows
    compatibility.json           # exact-version exemptions
    node_modules/                # shared pinned runtime + plugin links
    plugins/<plugin-dir>/        # installed package tree
    backups/<plugin-dir>/        # rollback packages
    logs/<plugin>.log
    data/                        # preserved plugin data by default
  cache/sources/                 # remote/local catalog cache
  cache/readme/                  # README cache for offline detail
```

`market-state.json` is the source of truth for the market; the DSH-looking profile
files are a projection so tools such as `dsh-plugin-health` can inspect the same
profile. They are not a claim that the profile can boot a complete official DSH
Web application.

## Chat and agent use

Host tools and commands are exposed to ConeCode's existing MCP-shaped tool bridge:
tools appear as `mcp__dsh_<plugin>__<tool>`, commands as
`mcp__dshcmd_<plugin>__<command>`. Calls are routed back to the DSH worker, so the
model can use a plugin without a separate copy of the plugin code. Skills are
listed and readable from the market; they are not injected into every prompt.

## Verification

See [`compatibility.md`](compatibility.md) and
[`../../resources/dsh-market/verifications.json`](../../resources/dsh-market/verifications.json).
The real-plugin E2E is skipped by default because it downloads packages and needs
the built worker:

```sh
npm run build
DSH_COMPAT_E2E=1 \
DSH_COMPAT_EVIDENCE=/tmp/dsh-evidence.json \
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron \
  ./node_modules/vitest/vitest.mjs run electron/dsh-market/compat.e2e.test.ts \
  --reporter=verbose --testTimeout=300000
```

It uses real community packages, not mocks (and also exercises a pinned Git
transport):

- `dsh-plugin-error-radar@0.2.0` — install, config, `/radar`, `/health`,
  disable/cleanup, re-enable, failed update rollback, restart restore, uninstall.
- `dsh-plugin-guide@0.4.5` — skill registration, listing and body read.
- `@dhicoc/dsh-chinese-traditional-wisdom-skill@1.3.0` — skill provider registration, listing and body read.
- `dsh-plugin-health@3.0.5` — `plugin_health` tool; host verified, Web client
  partial.
- `dsh-find-plugin@0.4.0` — author range excludes the baseline; install refused
  without exemption, then verified as partial and the real tool returned GitHub
  results.

## Developer docs

- [`plugin-authoring.md`](plugin-authoring.md) — native manifest, DSH package
  shape, compatibility extension points.
- [`catalog-format.md`](catalog-format.md) — source format, DSH format-1 adapter,
  provenance and sync behavior.
- `examples/native-plugins/hello-conecode/` — minimum runnable native plugin.
- `scripts/sync-dsh-catalog.mjs` — regenerate the pinned real catalog from npm and
  GitHub; never invents counts.

## Deliberate limits

- This is a **host-side compatibility layer**, not the official DSH Web runtime.
  Browser/UI plugin code is not executed.
- Git packages that require a build `prepare` script cannot be installed unless
  scripts are explicitly allowed; prebuilt npm packages are the recommended path.
- The shared runtime resolves one pinned set of DSH peer packages
  (`@deepseek-ai/dsh-tools@0.2.2-rc.1` and its peers). A plugin that requires a
  different peer implementation is partial, not silently mixed.
- Catalog statistics are point-in-time observations. They are never used to claim
  certification, security or compatibility.
- Remote catalog indexes are user-configured. The official DSH format-1 index is
  supported, but the project does not assume an official default market endpoint.
- The verification record in this repository was produced on macOS arm64. The
  Windows npm shim path and junction links are implemented but were not exercised
  in this verification run, so no Windows compatibility claim is made.
- The `credentials` service resolves named environment variables only. Secrets do
  not enter `market-state.json`, logs or the renderer. Plugins that require an
  interactive DSH credential UI are partial rather than silently handed a fake
  credential.
