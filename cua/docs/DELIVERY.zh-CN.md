# 当前交付与验收报告

2026-11-07，Asia/Shanghai。本轮沿用既有独立 `cua/`，完成工程修复、扩展与实际验收；未覆盖或重置 ConeCode 原工作区的其他修改。分支 `main`，基线 Git HEAD `f0bed6d3c474af4d6808c2595acffd4c3fd1c3a6`，未代用户提交。

最终源码 SHA-256：`f8354d1289ee32fc6a6a245bf915ba70b131be930b05f96b993ec76e5d90f782`。完整验收首尾指纹一致；独立安装验证使用相同指纹。

## 启动和体验

当前控制台已运行：[打开本地控制台](http://127.0.0.1:4317/)，显示真实浏览器任务历史、截图、动作、验收和事件。
重新安装/启动时执行：

```bash
cd '/Users/pinecones/Desktop/CODE/更新版本的项目/conecode/cua'
npm ci
npm run install:browsers
npm run build:native       # macOS，需要 Swift 工具链
npm run build
npm run demo:browser
npm run demo:desktop       # 已显式 --yes；真实 TextEdit 写专用临时文件
npm run serve -- --data-dir .cua/demo-browser --no-recover --open
```

已有服务占用 4317 时直接打开链接，勿重复启动。服务以 Ctrl+C 停止；token 位于专属 dataDir 的 `server-token`（0600），不要分享其值。

```bash
npm run verify:delivery -- --desktop      # 完整本机验收，桌面串行执行
node scripts/verify-clean-install.mjs     # 新临时安装目录验证
npm run eval -- --json                    # 无付费模型的四个场景
npm run mcp                              # 配置 CUA_API_URL/CUA_TOKEN，接同一服务
```

真实模型入口已实现，但本轮未运行：

```bash
export OPENAI_API_KEY=...
export CUA_REAL_MODEL=your-model
npm run eval:real -- --json --max-model-calls 8 --max-cost-usd 0.5
CUA_RUN_REAL_MODEL=1 npx vitest run test/model.test.ts test/evaluation.test.ts
```

模型/端点/能力/价格由配置决定，未硬编码型号；缺模型或密钥退出 2、`not_run`，失败退出 1。无价格费用 null，美元核算不完整，调用/token/时间限制仍生效。HTTP 替身测试不能作为真实提供商证据。公开格式核对见 [OFFICIAL-SOURCES.md](OFFICIAL-SOURCES.md)。

## 阶段与架构

阶段 0–12 的逐项状态见 [PHASES.md](PHASES.md)，支持矩阵见 [LIMITATIONS.md](LIMITATIONS.md)。
TypeScript/Node、Zod、Playwright Chromium、React、SQLite WAL；Controller、Planner/ModelAdapter、Observer、Executor、Verifier、代码 Runtime、Store、Coordinator/Monitor 分责。模型、MCP、代码 UI RPC 经过同一执行器。工具返回与固定用户验收分开，UNKNOWN 不盲目重试。

本轮修复了验证器授权绕过、文件路径逃逸、暂停会话/双循环、旧引用克隆、跨轮 RPC/计时器、UNKNOWN 降级、超时接管、模型预算、浏览器请求范围、恢复脚本再提交、控制台游标/响应竞态、SQLite 权限和敏感 workflow。新增真实下载验收、SIGKILL 恢复、模型闭环入口、工作流过期/删除、性能对照、CI 与指纹证据。

原生输入测试发现并修复 Command 修饰键继承。已批准的固定 TextEdit/内容/路径操作可跨前台变化；坐标、输入、按键仍严格拒绝过期观察。CLI Demo 失败时会正确返回非零退出码。

## 最终实际结果

| 检查 | 结果 | 证据 |
|---|---|---|
| `npm run verify:delivery -- --desktop` | 全部通过，源码未漂移 | `artifacts/delivery/report.json` |
| 核心默认测试 | 26 文件，125 通过 / 0 失败 / 7 跳过，共 132 项 | `tests.json`、`tests.log` |
| 独占桌面测试 | 6/6 通过，0 失败 | `desktop-tests.json`、`desktop-tests.log` |
| TypeScript / Swift / React build | 通过 | `typecheck.log`、`native.log`、`build.log` |
| 独立目录 npm ci + build + browser Demo | 通过，同源码指纹 | `artifacts/clean-install/report.json` |
| 浏览器 Demo | succeeded；持久化 name=Demo | `artifacts/delivery/browser-demo.log` |
| 桌面完整控制器 Demo | succeeded；中文/Unicode 文件匹配 true | `artifacts/delivery/desktop-demo.log` |
| React 控制台真实渲染 | 通过，已目视检查截图 | `artifacts/console.png`、`artifacts/delivery/console.log` |
| 故障/成功评估 | 4/4 符合预期，2 succeeded / 2 failed | `artifacts/delivery/evaluation.log` |
| 同观察负载对照 | 9 对，32,571 → 23,739 字符，减少 27.12% | `docs/evidence/2026-11-07-context-comparison.json` |
| full/projected 控制器对照 | 2 场景 × 2 模式，4/4 成功；每次 3 请求/2 动作 | `docs/evidence/2026-11-07-controller-comparison.json` |
| 真实模型 | 无凭证，未运行 | `artifacts/delivery/real-model-not-run.json` |
| Docker | Compose 语法通过，daemon 不可用，未构建 | `artifacts/delivery/docker-info.txt` |

核心默认 7 个跳过包括 4 个桌面交互用例（随后独占执行并通过）、2 个真实模型用例、1 个“缺沙箱拒绝”条件用例（本机有沙箱，不适用）。桌面单独运行避免与浏览器工作进程竞争焦点；两次测试包含重复的只读能力检查，不能相加冒充不同样本。

首次 TextEdit 授权超时、并发焦点中断与旧 CLI 退出码误报记录保留于 `artifacts/desktop-attempt/`、`desktop-concurrency-attempt/`、`desktop-approval-freshness-attempt/`。错误通过记录已明确撤销；上述最终成功来自修复后的统一指纹。

桌面真实输入使用 CGEvent，保存为明确的 TextEdit 应用脚本通道；主屏实际 2×缩放、Finder/TextEdit 焦点切换与窗口移动后的观察失效均验证。测试是当前宿主桌面上的专属文稿，不能称为隔离 VM。

新安装目录复用 npm/Chromium 缓存；不声称新机器或其他 OS 已验证。所有完整日志默认 gitignore，可在当前工作区阅读或用脚本重建。

| 故障/成功场景 | 实际状态 | 适配器请求尝试 | 时延 |
|---|---|---:|---:|
| `baseline_form_save` | succeeded | 3 | 526 ms |
| `save_failure_then_recover` | succeeded | 6 | 717 ms |
| `fake_success_rejected` | failed | 5 | 8501 ms |
| `budget_exhaustion_is_terminal` | failed | 2 | 205 ms |

4/4 是预先定义的场景符合率，不是任务通用成功率 100%；任务 succeeded 为 2/4，错误宣告完成 0/4。2 个真实 SIGKILL 样本均恢复核实，无重复点击、持久化记录未再修改；不外推任意 GUI exactly-once。

| 控制器对照 | 模式 | 状态 | 请求数 | 时延 |
|---|---|---|---:|---:|
| ordinary_save | full | succeeded | 3 | 522.9 ms |
| ordinary_save | projected | succeeded | 3 | 507.2 ms |
| delayed_save | projected | succeeded | 3 | 608.6 ms |
| delayed_save | full | succeeded | 3 | 612.1 ms |

两模式原始验收、预算、脚本相同；规划为 ScriptedAdapter，真实模型调用 0、费用 null。时延只是单次描述，不宣称速度或模型成本改善。观察字符数也不是模型 token 数。

## 支持矩阵、未验证项与处理

| 范围 | 当前结论 |
|---|---|
| 浏览器 | Chromium/Playwright 1.65.0 的真实结构观察、动作、下载、HTTP/WS 范围、恢复已验证 |
| 模型 | OpenAI-compatible Chat Completions 函数工具已 HTTP 替身验证；真实 key + 可用 model 后再跑真实层；原生 computer tool 未实现 |
| 桌面 | macOS 主屏、原生点击/Unicode/快捷键、焦点/窗口变化、应用脚本保存及独立读回通过；隔离 guest 和额外显示器待环境 |
| 代码隔离 | macOS Seatbelt OS 文件/网络实际拒绝已测；Linux bwrap 分支未实测；Windows 不支持 |
| 接口 | React、CLI、类型化 SDK、MCP stdio、SSE 已实测同一服务 |
| 调度 | 单进程锁/队列与隔离会话并发已测；多 worker 执行端 fencing 未实现，不支持多写 worker |
| 工程环境 | 本机独立安装目录通过；Docker daemon 启动后仍须 build/smoke；Ubuntu CI 配置已提供但远端未运行 |

尚未实现/验证：事件与截图自动保留期删除、图像重采样、原生 provider computer tool、多 worker 执行端 fencing、其他 OS 桌面、隔离桌面 guest、完整原生 Save As/全部手势链路，以及真实模型多样本性能/费用对照。

主要限制与处理：HTTP/WS 路由不是 OS 防火墙，任意敌意站点/代码应使用隔离 VM/容器与出站规则；GUI 仍有页面/焦点竞态，固定业务身份与原始验收必须保留；未知结果只读核实，取消不回滚。宿主文件并发替换不能由 GUI 保存提供原子 openat 保证。
脱敏基于模式，恢复原文/截图仍可能含私密内容；数据库、WAL/SHM/token 为 0600，新目录 0700。workflow 逻辑删除不保证擦除 SQLite 历史页或备份。详情见 [THREAT-MODEL.md](THREAT-MODEL.md)、[RECOVERY.md](RECOVERY.md)。

## 恢复入口

[CHECKPOINT.md](CHECKPOINT.md) 保存版本、结果、边界和下一步。
机器摘要：[2026-11-07-delivery-summary.json](evidence/2026-11-07-delivery-summary.json)。
源码架构、协议/状态机、扩展 driver、故障排查与运行方法分别见 ARCHITECTURE.md、PROTOCOL.md、DRIVERS.md、LIMITATIONS.md 和 README.md。
