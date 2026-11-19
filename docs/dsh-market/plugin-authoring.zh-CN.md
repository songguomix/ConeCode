# ConeCode 开放插件开发指南

从一个能执行的命令开始。仓库中的 `conecode-hello-dsh` 是标准 DSH 包，包含清单、Cordis 补丁和一个 JavaScript 入口。把它导入市场后，输入名字「松果」，命令会返回「你好，松果！」。[完整示例](../../examples/dsh-plugins/hello-dsh)

## 运行第一个插件

1. 使用桌面版 ConeCode。开发仓库可在项目根目录执行 `npm ci`、`npm run dev`。DSH 内置宿主首次安装需要能访问 npm 仓库，或者已有对应包的 npm 缓存。
2. 点击侧边栏的拼图，进入「来源与运行时 → 导入本地插件」，选择 `examples/dsh-plugins/hello-dsh` 目录，在预览中确认包名和版本后安装。
3. 在「已安装 → 运行」找到 `hello_dsh`，在命令参数框中输入 `松果`。结果的 `kind` 为 `success`，`text` 为 `你好，松果！`。留空时返回 `你好，世界！`。
4. 在「配置」中找到 `hello-dsh` 这一行，把该行的 JSON 改成 `{"greeting":"早上好"}`，保存后再次运行。现在应返回 `早上好，松果！`。
5. 禁用后，命令从可用列表消失。重新启用可恢复调用。开发下一版时修改包版本再导入，测试升级与回滚。市场运行的是复制到当前配置中的包。

## 包清单、补丁与入口

`package.json` 提供 npm 包名、精确版本和可加载的入口。`dsh.bundle.patch` 指向随包发布的补丁，也可以是按顺序读取的路径数组。以下清单对应上面的示例。

```json
{
  "name": "conecode-hello-dsh",
  "version": "1.0.0",
  "type": "module",
  "exports": "./index.mjs",
  "files": ["index.mjs", "cordis.patch.yml"],
  "engines": { "dsh": ">=0.2.2-0 <0.3.0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml` 中的 `id` 标识实例，也用于关联用户保存的配置。在后续版本中保留这个 ID。`name` 指向包的模块或公开的导出子路径。多个实例可用不同 `id` 和不同配置。

```yaml
- insert:
    - id: hello-dsh
      name: conecode-hello-dsh
      config:
        greeting: 你好
```

`index.mjs` 声明依赖的宿主服务。`apply` 接收当前实例的 Cordis 上下文和配置。命令的 `rawInput` 是用户输入的文本，工具的 `execute` 接收按 JSON Schema 描述的参数。

```js
export const name = 'hello-dsh';
export const inject = ['commands'];

export function apply(ctx, config) {
  ctx.commands.register({
    name: 'hello_dsh',
    description: '向指定名字问好',
    input: { hint: '[名字]' },
    handler({ rawInput }) {
      const who = rawInput.trim() || '世界';
      return { kind: 'success', text: `${config.greeting || '你好'}，${who}！` };
    },
  });
}
```

如果模块只公开 `./host` 子路径，可将 `exports` 写成 `{"./host":"./lib/host.js"}`，补丁行的 `name` 写成 `包名/host`。纯配置包可以只发布清单和补丁。例如下面的补丁会覆盖已先安装的 `hello-dsh` 实例，卸载覆盖包后恢复原配置。

```yaml
- id: hello-dsh
  config:
    greeting: 晚上好
```

## 选择运行位置

| 插件功能 | 用户入口 | 在哪里验证 |
|---|---|---|
| 供 ConeCode 使用的命令、工具、Skill、按配置持久化的数据 | 插件详情中的「安装」或导入本地目录 | ConeCode 的「已安装 → 运行」显示工具返回值、命令结果和 Skill 正文 |
| DSH 主题、设置面板、浏览器插槽，或依赖官方 Web 配置提供的会话和宿主服务 | npm 版本详情中的「安装到 DSH Web」 | 浏览器中的官方 DSH Web。可在「来源与运行时 → 打开 DSH Web」返回 |
| ConeCode 专用的 Node 插件 | 导入含 `conecode.plugin.json` 的目录 | 查看 `activate(api, config)` 收到的配置，并分别调用清单声明的贡献 |

ConeCode 内置宿主的基线为 DSH `0.2.2-rc.1`。官方 Web 使用本机安装的 DeepSeek Harness Desktop 或 `dsh` CLI，按它自己的版本、平台与服务组合加载插件。Web 工具、模型和设置由该 Web 配置管理。两个入口分别保存插件、配置和数据。需要同时支持两种使用场景的包，应分别测试两个入口。[DSH 官方 profile 加载说明](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/boot/app-boot/README.md)

首次使用 Web 入口前，请安装带 `web` 配置的官方 DSH。单独安装的 CLI 还需它支持的 pnpm。ConeCode 可从系统 `PATH` 查找 `dsh`，也会查找 macOS 上标准位置的 DeepSeek Harness.app。自定义安装可通过 `CONECODE_DSH` 指定可执行文件的绝对路径。每个 ConeCode 配置有独立的 `official-web` 目录。Web 服务绑定 `127.0.0.1` 的随机端口，退出 ConeCode 时关闭。

「安装到 DSH Web」会下载所选 npm 版本、校验目录提供的摘要，随后调用官方插件管理器安装。更新、配置、禁用和删除可在 DSH Web 的插件管理界面完成。Git 或本地包也可在该界面导入。依赖 Docker、原生二进制或帐号的插件需要相应的运行条件。

## 宿主接口与数据

| 能力 | DSH 入口 | 开发时应检查 |
|---|---|---|
| 工具 | `ctx.tools.register({ name, description, parameters, execute })` | 描述必填参数和结果，使用实际参数调用一次 |
| 命令 | `ctx.commands.register({ name, input, handler })` | 验证空输入，以及不同实例收到的配置 |
| Skill | `ctx.skills.register(...)` 或 `ctx.skills.registerProvider(...)` | 在「运行」中列出 Skill 并打开正文，验证动态 provider 的 `list()` 和 `get(candidate)` |
| DSH 模型适配器 | 插件注入 `llm`，在官方 DSH LLM 服务上注册 provider | 由另一个插件调用 `ctx.llm.listProviders()` 查看注册名，卸载后再检查一次。DSH Web 提供官方模型设置界面 |
| 持久化 | `ctx.storageDomain.open(spec)` | 在 profile 内保存数据，重启运行时后读取；在 Cordis 作用域释放时关闭 domain |
| 原生插件 | `conecode.plugin.json` 的 `conecode.apiVersion: 1`、`entry`、`capabilities` 和入口导出的 `activate(api, config)` | 仅请求用到的服务。返回的清理函数应释放插件创建的资源 |

配置编辑器每个框对应一个行 ID，填写该行的配置对象。插件拥有定时器、订阅或文件句柄时，用 Cordis `ctx.effect` 或原生插件的清理函数释放资源。保存配置、禁用和更新都可能重新创建实例。卸载时可以清理插件的私有数据目录。通过 `storageDomain` 写入共享后端的数据，应由插件按自己的数据模型管理。普通配置会保存为可读 JSON，凭据请使用对应宿主的凭据机制。[存储示例和接口说明](plugin-authoring.md) · [原生插件完整示例](../../examples/native-plugins/hello-conecode)

## 分发与收录

- **本地开发**。直接导入插件目录。通过 `npm pack --dry-run` 检查清单、全部补丁、编译后的入口和客户端资源是否随包发布。用户默认禁用依赖生命周期脚本，建议在发布前编译产物。
- **Git**。在「导入仓库」填写公开 HTTPS 仓库或 `github:owner/repo`，可填写标签、分支或提交。monorepo 填写包含插件清单的子目录。市场预览解析后的提交，确认后安装该提交。
- **npm**。选择自己有发布权限的包名，更新版本并审核 `npm pack` 得到的包，在开发者自己的 npm 账户中发布。每次发布使用新版本；在目录中写入精确版本。示例包名用于本地练习。
- **市场索引**。可自行托管 HTTPS JSON 索引，或先在「来源与运行时 → 添加本地目录」选择含 `catalog.json` 的文件夹。下面的 DSH format 1 片段演示已发布包的条目，将包名和版本替换为自己的。发布到 npm 后还需添加目录源或向内置目录提交变更。[目录格式、摘要与同步规则](catalog-format.md)

```json
{
  "format": 1,
  "title": "我的插件",
  "plugins": [{
    "name": "your-published-package",
    "versions": [{
      "version": "1.0.0",
      "source": { "type": "npm" },
      "engines": { "dsh": ">=0.2.2-0 <0.3.0" }
    }]
  }]
}
```

## 验收与排错

| 现象 | 从这里查 |
|---|---|
| 找不到 npm 或首装下载失败 | 在「来源与运行时」查看 npm 路径，检查仓库连通性。自定义 npm 可执行文件可用 `CONECODE_NPM` 指定 |
| 能预览却激活失败 | 查看插件日志中第一个缺失服务、模块路径或配置校验错误。需要官方服务时使用 DSH Web。缺少构建产物时，检查 `npm pack --dry-run` 的文件列表 |
| 作者版本范围不匹配 | 对照详情中的 DSH 基线、Node 版本、平台与 `engines`/`peerDependencies`。修正并测试声明后重新发布 |
| 修改代码或配置后行为仍旧 | 确认当前 profile、安装版本和实例 ID。代码变更后安装新版本，配置变更后重新运行该行的贡献 |
| Web 主题安装成功 | 打开 DSH Web 设置并切换主题，确认页面实际变化。`dsh-theme@1.0.1` 实测可列出 30 款主题，切换 `forest` 后样式立即应用 |

在本仓库根目录可以复现示例和真实插件回归。先构建 worker，然后用 Electron 内置的 Node 执行。以下为 macOS/Linux 的 shell 命令，Windows 可在 PowerShell 中用 `$env:变量名 = '1'` 设置同名环境变量。

```sh
npm run build
DSH_MARKET_INSTALL_E2E=1 ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron \
  ./node_modules/vitest/vitest.mjs run electron/dsh-market/authoring.e2e.test.ts \
  electron/dsh-market/market-install.e2e.test.ts
DSH_WEB_E2E=1 ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron \
  ./node_modules/vitest/vitest.mjs run electron/dsh-market/official-web.test.ts
```

第一组会安装示例和固定版本社区包，并实际调用贡献。第二组需要本机官方 DSH，它会安装主题、验证认证后的主页以及主题客户端脚本。各测试使用临时配置。[更多社区包、重启和回滚验证](compatibility.md)
