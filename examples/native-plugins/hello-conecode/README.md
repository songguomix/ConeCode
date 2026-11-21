# hello-conecode

The minimum runnable **ConeCode-native** plugin. It is intentionally small and
is labeled as a first-party sample in the market. See the [native plugin protocol
reference (Chinese)](../../../docs/dsh-market/native-plugin-protocol.zh-CN.md)
for the manifest and host API.

## Manifest

`conecode.plugin.json` declares a plugin with `apiVersion: 1`. The `conecode`
object is a ConeCode field and is kept separate from the `dsh` field used by
DeepSeek Harness packages.

## Contributions

| Kind | Name | Verified behavior |
|---|---|---|
| Tool | `hello_conecode` | Returns a greeting object with plugin version and timestamp. |
| Command | `hello` | Accepts a name and returns a host command result in the market's Run panel. |
| Skill | `hello-conecode` | Registers a readable Markdown skill. |

The market displays the command as `/hello`. The chat tool bridge also exposes
the command to the model with an `input` argument.

## Lifecycle

`activate(api, config)` receives `tools`, `commands`, `skills`, `logger`, and the
plugin identity. The manifest describes the services the sample uses, and the
sample supplies the `Hello` default when the saved configuration lacks a valid
greeting. Every registration returns a disposer. ConeCode calls the cleanup
function and withdraws the plugin's contributions when the plugin unloads.

## Install

Open **Plugin Market → Sources → Import local**, choose this directory, or use
the bundled sample entry in Discover. The source is copied into the active
profile; the original directory is never modified.

## Package as a local plugin

Share the folder or zip it for distribution. Recipients extract the archive and
import the directory containing `conecode.plugin.json`. This sample runs with its
manifest and entry file. If your plugin uses npm dependencies, declare them in
the `dependencies` field of `package.json`. ConeCode installs those dependencies
in the copied directory with lifecycle scripts disabled by default.
