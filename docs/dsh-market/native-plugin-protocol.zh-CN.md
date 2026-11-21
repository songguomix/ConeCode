# ConeCode 原生插件协议 v1 开发文档

原生插件通过 `conecode.plugin.json` 声明入口，在 ConeCode 桌面端的 Node worker 中运行。开发者可以从两个文件开始，将目录导入当前市场配置（profile），再验证配置保存、版本升级和卸载。第三方 v1 接口覆盖工具、命令和 Skill。设置中的 GitHub 同步等内置插件由应用提供专用界面和 IPC。

## 运行第一个插件

1. 打开桌面版 ConeCode，进入「插件市场 → 来源与运行时 → 导入本地插件」，选择 [Hello ConeCode 示例目录](../../examples/native-plugins/hello-conecode)。也可以在「发现」中安装内置的同一个示例。
2. 打开「已安装 → 运行」，给 `hello_conecode` 工具传入 `{"name":"Ada"}`，应看到 `message` 为 `Hello, Ada!`。用 `Ada` 运行 `hello` 命令，再打开 `hello-conecode` Skill 的正文。
3. 打开「配置」，把 `native` 行的 JSON 改成 `{"greeting":"你好"}`。保存后再次调用工具，`message` 应为 `你好, Ada!`。
4. 禁用插件，确认它的贡献从可用列表中消失。重新启用并重启运行时，确认已保存的配置仍生效。

## 包清单和入口

一个只依赖 Node 内置能力的插件可由 `conecode.plugin.json` 和 `index.mjs` 组成。将以下内容分别保存到这两个文件，再导入所在目录。

```json
{
  "name": "example-greeter",
  "version": "1.0.0",
  "description": "向用户问好",
  "conecode": {
    "plugin": true,
    "apiVersion": 1,
    "entry": "./index.mjs",
    "capabilities": ["tools", "commands", "skills"],
    "config": { "greeting": { "type": "string", "default": "你好" } }
  }
}
```

| 字段 | v1 约定 |
| --- | --- |
| `name` | 必填。使用小写 npm 风格包名，可带 scope，例如 `@team/example-greeter`。升级和回滚以同一个包名关联安装记录。 |
| `version` | 必填。填写精确的 SemVer，例如 `1.0.0`、`1.1.0-beta.1`。每次分发新代码时递增版本。 |
| `conecode.plugin` | 必须是布尔值 `true`。 |
| `conecode.apiVersion` | 必须是数字 `1`。这是宿主协议版本，与插件自己的 `version` 独立。 |
| `conecode.entry` | 必填。填写指向包内现存文件的相对路径。构建输出与入口依赖的模块都要随目录交付。 |
| `conecode.capabilities` | 可选。字符串数组，用 `tools`、`commands`、`skills` 描述使用的宿主接口。为保持 v1 兼容，运行时始终提供这三个服务。 |
| `conecode.config` | 可选。可用对象记录配置字段及默认值。默认值与参数校验由插件的入口实现。 |
| `description`、`author`、`license`、`homepage`、`repository`、`readme` | 可选字符串。`repository` 可填写仓库 URL，`readme` 可填写包内说明文件路径。 |

```js
export function activate(api, config = {}) {
  const greeting = typeof config.greeting === 'string' && config.greeting.trim()
    ? config.greeting.trim()
    : '你好';
  const greet = (name) => `${greeting}，${String(name ?? '').trim() || '世界'}！`;

  const removeTool = api.tools.register({
    name: 'example_greet',
    description: '向指定名字问好',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
    },
    execute(args) {
      return { message: greet(args.name) };
    },
  });

  const removeCommand = api.commands.register({
    name: 'greet',
    description: '运行问候命令',
    input: { hint: '[名字]' },
    handler({ rawInput }) {
      return { kind: 'success', text: greet(rawInput) };
    },
  });

  const removeSkill = api.skills.register({
    name: 'example-greeter',
    description: '问候工具用法',
    content: '# 问候\n\n给 `example_greet` 传入可选的 `name`。',
  });

  return () => {
    removeSkill();
    removeCommand();
    removeTool();
  };
}
```

优先使用 `.mjs` 和命名导出 `activate`。v1 也接受 `default.activate` 和默认导出的函数。入口可以同步返回，也可以返回 Promise。宿主识别其返回的清理函数，并在卸载实例时调用它。

## 宿主 API

| 服务 | 调用与返回 |
| --- | --- |
| `api.tools` | `register({ name, execute, description?, parameters?, timeoutMs?, output? })` 返回注销函数。`list()` 返回当前实例注册的定义。`execute(args, { signal, callId })` 可返回 JSON 可表示的数据或字符串。 |
| `api.commands` | `register({ name, handler, description?, input?: { hint } })` 返回注销函数。`list()` 返回当前实例注册的定义。`handler({ rawInput })` 接收一段文本，可返回字符串或 `{ kind: 'success', text }` 等可序列化结果。 |
| `api.skills` | 静态 Skill 用 `register({ name, description?, content?, provider?, source?, locator? })` 注册。动态 Skill 用 `registerProvider(factory)`；两者都返回注销函数。`list(options?)` 列出候选项，`get(name, options?)` 读取内容。 |
| `api.logger` | Node `console`，适合写入不含凭据的诊断信息。激活和调用失败也可在插件市场的日志中排查。 |
| `api.plugin` | `{ id, name }` 描述当前实例。安装探测阶段的 `id` 是临时值，持久化标识应使用稳定包名。 |

工具的 `parameters` 用 JSON Schema 描述输入。插件应在 `execute` 内验证自己依赖的字段，因为市场直接调用也会向处理函数传入数据。`output.render(args, value)` 可选，可返回字符串或包含 `text` 的数组，便于在界面展示。调用结果通过 worker 传回，优先返回简洁的 JSON 数据。

工具默认限时 60 秒，可通过 `timeoutMs` 配置，执行上限为 120 秒。工具出错或超时会触发执行上下文的 `signal`，异步 I/O 可以据此停止。命令默认限时 60 秒。工具和命令的市场运行结果包含 `ok` 和 `durationMs`，成功时包含 `value`、`rendered`，失败时包含 `error`。

动态 Skill 的 `factory({ signal, invalidate })` 同步返回 `{ name, list(options), get(candidate, options) }`。`list` 可返回候选数组或 `{ candidates }`，条目至少包含 `name`。`get` 返回含 `content` 的对象即可。宿主每次查询都会读取候选项，注销 provider 或卸载实例时会中止它的 `signal`。静态 Skill 优先直接提供 Markdown `content`。同一个实例内应给同类贡献使用不同名称。

启用且已加载的插件会在市场「运行」页提供工具、命令和 Skill。工具和命令也会通过 MCP 风格的工具桥接提供给允许使用工具的对话，命令的桥接输入字段是 `input`。命令的直接入口是市场运行页；聊天框斜杠菜单管理另一套命令。市场注册的 Skill 从市场列出并读取，项目或用户的 `SKILL.md` 由旧版技能入口加载。

## 配置、升级与清理

- 原生插件的配置行 ID 固定为 `native`。用户在编辑器里填写该行的配置对象，宿主在每次激活时把它传给 `activate`。插件初次安装收到 `{}`。对新增配置使用默认值，旧字段改名时兼容已保存的数据。
- 安装时，宿主会在暂存目录探测激活，再在安装目录激活。保存已启用插件的配置会重新加载实例，激活拒绝时宿主恢复先前的配置并尝试重新加载。把会修改外部系统的操作放在用户明确触发的命令或工具里。
- 同名插件更新后可在「已安装」回滚。禁用、更新、切换 profile 和卸载都可能结束当前实例。清理函数负责释放插件自己创建的定时器、订阅和文件句柄，宿主撤回该实例的贡献。配置、安装和备份按市场 profile 管理。
- 原生插件按运行 ConeCode 的本地用户权限执行 Node 代码。`capabilities` 只记录宿主接口用途。普通配置会保存为可读 JSON，凭据应通过适合插件的凭据机制获取。

## 分发与兼容范围

分发原生插件时，交付含清单、构建产物及资源的目录。用户下载压缩包后先解压，再导入目录。市场会复制目录并跳过 `.git` 和 `node_modules`。如需 npm 依赖，把运行依赖放进同目录 `package.json` 的 `dependencies`；宿主在暂存目录安装依赖，默认跳过生命周期脚本。只依赖 Node 内置模块的包无需安装第三方依赖。

| 目标 | 包格式和入口 | 兼容范围 |
| --- | --- | --- |
| ConeCode 原生插件 | `conecode.plugin.json` + `activate(api, config)`，通过本地目录或内置示例安装 | v1 的工具、命令和 Skill。发布前按目标操作系统及 CPU 架构验证插件依赖。 |
| ConeCode 内置 DSH 宿主 | `package.json` 的 `dsh.bundle.patch` + Cordis `apply(ctx, config)`，支持 npm、固定提交的 Git 和本地包 | 基线为 DSH `0.2.2-rc.1`，按宿主已提供的服务和精确插件版本验收。 [DSH 开发指南](plugin-authoring.zh-CN.md) · [实测兼容矩阵](compatibility.md) |
| 官方 DSH Web | 「安装到 DSH Web」或通过官方 DSH 的插件管理器安装 | 用官方 `web` profile 验证依赖客户端主题、设置面板或 Web 服务的 DSH 插件。它管理独立的安装与配置。 [官方 DSH profile 文档](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/boot/app-boot/README.md) |
| 旧版 ConeCode 技能 | `SKILL.md`，由「技能」或关联技能的插件入口加载 | 保留 Markdown 指令和原有执行路径。以原生插件交付 Node 代码时使用 `activate`。 |

同时面向两个宿主的插件可以复用业务逻辑，分别提供原生 `activate` 入口和 DSH `apply` 入口并独立测试。Git 仓库里的原生包可以通过下载目录分发。市场的 Git 导入和 npm 安装入口使用 DSH 包格式。

维护 v1 时保留已有入口形式、参数和返回约定，新增配置使用可选字段。需要改变既有调用方式时使用新的协议版本，并在目标宿主提供支持后再分发。遇到目标宿主差异时，记录实际通过的插件版本、宿主、系统和架构。

## 验收与排错

| 检查项 | 通过条件 |
| --- | --- |
| 导入与版本 | 在干净的 profile 导入，预览显示正确包名和版本。无效入口或未知协议版本会在安装前提示错误。 |
| 贡献与配置 | 调用每项工具和命令并读出 Skill。测试空参数、合法参数和错误参数。保存配置后重启运行时，验证配置仍生效。 |
| 升级与回滚 | 从上一版安装新版本，核对已保存配置和注册名。验证回滚后的实际输出，并确认激活失败时原版本仍可用。 |
| 清理与隔离 | 禁用后贡献不可调用，重新启用后恢复。切换 profile 后验证各自的安装和配置。卸载后确认贡献消失，插件创建的资源已释放。 |

在 ConeCode 仓库根目录运行以下测试。源码开发环境的 Node 要求见 [package.json](../../package.json)。先构建 worker 以启用 native 市场用例。测试覆盖清单安装、真实 worker 调用、配置、profile 恢复和回滚。开关及社区插件案例见 [DSH 兼容矩阵](compatibility.md)。

```sh
npm ci
npm run build
npm run typecheck
npm test -- electron/dsh-market/installer.test.ts \
  electron/dsh-market/runtime-host.test.ts \
  electron/dsh-market/market-service.native.test.ts
```

入口加载失败时，先检查安装目录中的实际入口、模块格式和运行依赖。修改源文件后需重新导入目录，市场运行的是已安装的副本。工具或命令缺失时，检查 `activate` 是否成功完成、插件是否启用以及当前 profile 是否正确。
