# DSH Compatibility Matrix and Verification Record

This page separates two facts that are often conflated:

1. **Author declaration** — the `engines.dsh` range, or DSH peer dependency ranges
   when `engines.dsh` is absent.
2. **ConeCode verification** — a recorded run bound to the exact plugin version,
   DSH baseline commit, adapter version and runtime environment.

A plugin can be compatible by declaration but **Unverified**, or incompatible by
declaration but manually exempted and **Partial**. The marketplace displays both.

## Baseline

| Item | Value |
|---|---|
| DSH | `0.2.2-rc.1` |
| Tag | `dsh-v0.2.2-rc.1` |
| Commit | `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` |
| Adapter | ConeCode DSH layer `1.0.0` |
| Runtime | Electron `42.11.3`, Node `24.19.0`, Chrome `148.0.7778.280` |
| Host | macOS 27.2, arm64 |
| Date | 2026-11-06 |

Records are stored in
[`resources/dsh-market/verifications.json`](../../resources/dsh-market/verifications.json).
The loader treats a record as stale when the baseline, commit, adapter version,
Node version, platform or architecture differs. Stale records become **Unverified**
instead of remaining green.

## Matrix

| Plugin (source) | Exact version | Author declaration | ConeCode result | Verified capabilities | Missing / notes |
|---|---|---|---|---|---|
| [`dsh-plugin-error-radar`](https://www.npmjs.com/package/dsh-plugin-error-radar) | `0.2.0` | No `engines.dsh`; peer `@deepseek-ai/cordis >=4.0.0` | **Verified** | `/radar`, `/health`, config save, disable/re-enable, failed-update rollback, restart restore, uninstall cleanup | None for the host half. Fixture trace data is input, not generated output. |
| [`dsh-plugin-guide`](https://www.npmjs.com/package/dsh-plugin-guide) | `0.4.5` | `engines.dsh >=0.2.2-0 <0.3.0`, `engines.node >=24.9.0` | **Verified** | skill registration, list, body read | Pure skill plugin. |
| [`dsh-plugin-health`](https://www.npmjs.com/package/dsh-plugin-health) | `3.0.5` | `engines.dsh >=0.2.0-rc.0 <0.3.0-0` | **Partial** | `plugin_health` tool returns a structured report; update to `3.0.4` and rollback to `3.0.5` | Ships `dsh.client`; the Web UI half is **not mounted** (`web-client`). Host half verified. |
| [`dsh-find-plugin`](https://www.npmjs.com/package/dsh-find-plugin) | `0.4.0` | Peer `@deepseek-ai/dsh-tools ^0.1.0-rc.6 \|\| ^0.1.7-alpha.1` | **Partial** | `find_dsh_plugin` tool, live GitHub search, curated fallback | The declared peer range excludes `0.2.2-rc.1`; installation is refused without an exact-version exemption. With the exemption, the tool works with the shared `0.2.2-rc.1` peer. |
| [`@dhicoc/dsh-chinese-traditional-wisdom-skill`](https://www.npmjs.com/package/@dhicoc/dsh-chinese-traditional-wisdom-skill) | `1.3.0` | No `engines.dsh`; peer `@deepseek-ai/dsh-skill ^0.2.0-rc.2` | **Verified (provider + body)** | `registerProvider`, list, get; body read | The skill body references downstream local engines; provider registration/body retrieval are verified, but every engine workflow is not claimed. |
| `dsh-plugin-debugging` | `0.7.1` | `engines.dsh ^0.1.7-rc.1 \|\| ^0.2.0-rc.1 \|\| ^0.2.1-rc.1` | **Unverified / expect partial** | — | Requires host services beyond this layer (agents/fs/web server routes); not in the verified set. |
| [`dsh-layerfs`](https://github.com/Ephemeral-AI-Lab/dsh-layerfs) | repo `b9bf3bc8` / package `0.1.0` | `engines.dsh >=0.2.1-alpha.4 <0.3.0` | **Incompatible / blocked** | — | Injects `shellEnv`, `sessions`; optionally `webServer`, `connection`, `systemPrompt`. Requires LayerFS checkout `fabefdf87a`, native daemon, Docker daemon/image, sealed bundle and DSH Web client. Docker daemon is not running here and the LayerFS build is absent. See [`layerfs.md`](layerfs.md). |
| `dsh-plugin-share` | `0.2.5` | Peer `@deepseek-ai/dsh-client-ui-settings-plugins` | **Incompatible host-only** | — | Its contribution is a client UI module; no host tool/command. ConeCode does not mount Web client halves. |
| `dsh-plugin-appshot` | `0.4.2` | No range; `dsh.client` present | **Incompatible host-only** | — | Context screenshot UI plugin; client half only. |
| `dsh-plugin-upgrader` | `1.8.0` | `engines.dsh >=0.2.1-rc.3 <0.3.0-0` | **Unverified / client half** | — | Version/rollback UI implemented against DSH client slots; not mounted. |
| `dsh-plugin-tool-management` | `0.22.2` | `engines.dsh >=0.2.2-rc.1 <0.2.3` | **Unverified / expect partial** | — | Requires many DSH host services and a client UI; not in the verified set. |
| `dsh-plugin-memory` | `0.17.9` | `engines.dsh ^0.2.1-rc.5` | **Unverified / expect partial** | — | Memory provider needs host prompt/session services beyond this layer. |
| `dsh-our-free-model` | `2.1.0` | No DSH range; client half | **Incompatible host-only** | — | Model/provider + client UI; not provided by this layer. |
| `dsh-theme` | `1.0.1` | No range; client half | **Incompatible host-only** | — | Theme/CSS client plugin. |
| `hello-conecode` (ConeCode native sample) | `1.0.0` | ConeCode `conecode.plugin.json`, apiVersion 1 | **Verified sample** | `hello_conecode` tool, `/hello` command, `hello-conecode` skill, unload cleanup | First-party sample; explicitly **not** community compatibility evidence. |

The first five rows are community-plugin evidence for this release. The sample
is supplementary and labeled in the UI.

## Full lifecycle evidence

The E2E test (`electron/dsh-market/compat.e2e.test.ts`) performed this sequence in
one isolated profile, using real npm packages and the built worker:

1. **Discover/search** — loaded the bundled catalog; the market contained 15 real
   pinned plugins (plus the native sample). A query for `radar` in the `tools`
   category and a `diagnostics` label filter both returned the expected real
   plugin.
2. **Install** `dsh-plugin-error-radar@0.2.0` from npm.
3. **Configure** the `error-radar` row with
   `{ "enabled": true, "dataDir": "<fixture>", "errorRateAlert": 20 }`.
4. **Execute** `/radar`. The real plugin parsed the trace fixture and returned:
   `web_fetch 4 calls · 100% errors · 4 consecutive failures · p95 5300ms`.
5. **Execute** `/health --days 7`. The real plugin returned a go/no-go verdict:
   `❌ 有系统性故障：web_fetch 连续失败 4 次`.
6. **Storage substrate** — a local fixture plugin opened a zod-validated domain through the official `@deepseek-ai/dsh-storage-domain`, wrote a record through the `json` backend, and read it again after a full worker restart.
7. **Disable** — the command contribution disappeared and invocation was refused.
8. **Re-enable** — `/radar` worked again.
9. **Failed update** — a local `0.2.1` package that throws during activation was
   probed and rejected; the installed `0.2.0` stayed loaded and `/radar` still
   worked.
10. **Repository import** — in an isolated profile, `github:`/https repository
   inspection resolved `v0.4.5` to commit
   `ccab614d6045625c359f4416e0760f93f7abe260`, installed that exact Git tree,
   listed its skill, then uninstalled it.
11. **Restart** — shut the worker down, created a new service instance from disk,
   and verified the installed versions, config, commands and skills were restored.
12. **Uninstall** — the plugin was unloaded, its contributions were confirmed empty,
    its package directory was removed, and plugin data was kept by default.

The test also installed and executed:

- `dsh-plugin-guide@0.4.5`: the registered `dsh-plugin-guide` skill was listed and
  its Markdown body (containing “ENTRY”) was read.
- `dsh-plugin-health@3.0.5`: `plugin_health` returned a structured report for the
  isolated DSH home. The result is **Partial** because the Web client half is not
  mounted.
- `dsh-find-plugin@0.4.0`: install without an exemption was refused with the exact
  peer requirement; install with an exact-version exemption succeeded and
  `find_dsh_plugin` returned real GitHub results. The result remains **Partial**.
- **Git transport**: `dsh-plugin-guide@0.4.5` was also prepared from
  `https://github.com/PerryLink/dsh-plugin-guide` at pinned commit
  `ccab614d6045625c359f4416e0760f93f7abe260`; the package tree and row resolved.
  This is a transport check, not a second compatibility verification.

## Storage substrate

The official DSH storage stack is a separate compatibility surface from LayerFS:

| Service | Package | Result |
|---|---|---|
| `ctx.storage` | `@deepseek-ai/dsh-storage@0.2.2-rc.1` | Mounted |
| `json` KV backend | `@deepseek-ai/dsh-storage-json@0.2.2-rc.1` | Mounted at `<profile>/storage` |
| `ctx.storageDomain` | `@deepseek-ai/dsh-storage-domain@0.2.2-rc.1` | Mounted; zod domain write/read |
| Restart persistence | local fixture `dsh-storage-probe@1.0.0` | Record survived a full worker/service restart |
| Backend registry | `ctx.storage.backend.register` | Official contract; JSON backend mounted; future backends can register without host changes |

See [`layerfs.md`](layerfs.md) for why `dsh-layerfs` itself is blocked rather
than falsely marked compatible.

## Negative and error-path checks covered by tests

| Scenario | Expected result | Test |
|---|---|---|
| Declared plugin range does not include the baseline | `Incompatible`, exact requirement retained; no install | `manifest.test.ts`, E2E `dsh-find-plugin` |
| Missing host service (e.g. `inject: ['agents']`) | Load fails with `missing-capability` and the service name; no empty stub | `runtime-host.test.ts` |
| Activation throws after half-registering a tool | `load-failed`, contributions removed | `runtime-host.test.ts` |
| Invalid Cordis config (`errorRateAlert=999`) | Save is rejected and the previous instance stays usable | E2E `saveConfig` rejection step |
| Unpinned git / option-shaped package / shell characters | Rejected before npm runs | `security.test.ts` |
| Patch path escapes package | Rejected | `manifest.test.ts` |
| Empty comments-only patch | Rejected as not a YAML array | `manifest.test.ts` |
| Update probe failure | Previous version remains | E2E failed-update step |
| Local plugin with an invalid dependency spec | npm fails; no installed record | E2E conflict step |
| Duplicate install of the same exact version | Rejected with “already installed” | E2E |
| Interrupted operation after app quit | Marked failed with `interrupted` on next start | `state.test.ts` |
| Plugin disabled | Contributions empty; invocation refuses | E2E |
| Uninstall | Contributions empty; directory removed; data policy visible | E2E |

## Reproduction commands

```sh
# Unit and integration checks that do not touch third-party packages
npm run typecheck
npm test

# Real community plugins (requires npm, network and the built worker)
npm run build
DSH_COMPAT_E2E=1 \
DSH_COMPAT_EVIDENCE=/tmp/dsh-evidence.json \
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron \
  ./node_modules/vitest/vitest.mjs run electron/dsh-market/compat.e2e.test.ts \
  --reporter=verbose --testTimeout=300000
```

The test is skipped by default in normal `npm test` runs. Evidence includes the
plugin version, baseline, adapter, environment, operation, observation and error
paths. The market never upgrades a stale record to “Verified”.
