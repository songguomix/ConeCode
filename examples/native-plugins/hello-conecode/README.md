# hello-conecode

The minimum runnable **ConeCode-native** plugin. It is intentionally small and
is labeled as a first-party sample in the market — it is not community
compatibility evidence.

## Manifest

`conecode.plugin.json` declares a plugin with `apiVersion: 1`. The `conecode`
object is a ConeCode field and is kept separate from the `dsh` field used by
DeepSeek Harness packages.

## Contributions

| Kind | Name | Verified behavior |
|---|---|---|
| Tool | `hello_conecode` | Returns a deterministic greeting object. |
| Command | `/hello [name]` | Returns a host command result. |
| Skill | `hello-conecode` | Registers a readable Markdown skill. |

## Lifecycle

`activate(api, config)` receives only the services declared in the manifest.
Every registration returns a disposer; the returned function is invoked on
disable/uninstall, and the host additionally removes every registration owned
by the plugin. There are no hidden stubs: asking for an undeclared host
capability fails the load with a named capability error.

## Install

Open **Plugin Market → Sources → Import local**, choose this directory, or use
the bundled sample entry in Discover. The source is copied into the active
profile; the original directory is never modified.

## Package as a local plugin

The folder can be zipped and shared as-is. A native plugin does not need npm;
if it ships dependencies, add a normal `package.json` and the installer will
run `npm install --ignore-scripts` inside the copied plugin directory.
