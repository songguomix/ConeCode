# 恢复检查点

目标：在现有 ConeCode 工作区交付公开接口实现的 Computer Use Agent，覆盖阶段 0–12，并明确区分真实驱动、确定性模型替身和真实提供商测试。

- 工作分支：`main`；基线 HEAD：`f0bed6d3c474af4d6808c2595acffd4c3fd1c3a6`。
- 工作区原先有大量用户修改；实现沿用独立 `cua/` 包，不重置、不提交、不覆盖其他工作。
- 环境：macOS arm64，Node 22.23.2，已有 Playwright Chromium、Swift 工具链。
- 已完成：协议/状态机、SQLite 日志与恢复、浏览器/桌面驱动、受控代码运行时、调度器、React 控制台、CLI/SDK/MCP；本轮增加权限、生命周期、旧引用、UNKNOWN 和接口回归修复。
- 模型：无 `OPENAI_API_KEY`；真实模型 smoke 与浏览器闭环保留为显式待运行，HTTP 替身只验证接口。
- 桌面：用户已允许系统自动化授权。最新录屏/事件权限为 true；原生点击、Unicode、Meta+A、焦点切换、窗口移动检测以及 TextEdit 应用脚本保存/文件读回均通过。当前为宿主专属文稿，不是隔离 guest。
  本轮改为默认单 app 单窗口：观察只取目标窗口截图与其无障碍子树（其他 app/窗口不读），`desktop.press`/`desktop.set_value` 直接操作 AX 目标，窗口外坐标拒绝，输入前校验目标 app 在前台；`scope: "display"` 保留为排障用的全屏 opt-in。
- Docker：CLI 存在、daemon 不可连接；镜像启动配置尚未实测。
- 当前验收与准确状态：见 [交付报告](DELIVERY.zh-CN.md)、[阶段记录](PHASES.md)。最终代码版本使用 `artifacts/delivery/report.json` 中的源码 SHA-256 清单识别，不能只用基线 Git HEAD。

恢复步骤：

1. `cd cua && npm ci && npm run install:browsers`，macOS 可运行 `npm run build:native`。
2. `npm run verify:delivery` 生成当前版本证据；桌面交互通过 `--desktop` 显式启用。
3. `npm run serve` 读取 `.cua/runtime.db`，对未返回动作标记 UNKNOWN，并以新会话只读核实；不要重放历史写操作。
4. 配置模型/桌面权限/Docker 后分别运行对应验证，更新报告，不能把跳过项计为通过。

接下来的工程边界：原生键鼠完整隔离桌面验证、下载生命周期、真实模型多样本性能比较、多 worker 的执行端 fencing。具体哪些是环境阻塞、哪些尚未实现，参见限制矩阵。

最终验收：源码指纹 `f8354d1289ee32fc6a6a245bf915ba70b131be930b05f96b993ec76e5d90f782`；核心 26 文件、125 通过/7 跳过；随后独占桌面 6/6、桌面控制器保存和文件读回通过。独立安装目录构建及浏览器 Demo 同指纹通过。控制台最终构建运行于 http://127.0.0.1:4317；模型密钥、Docker daemon、隔离桌面 guest 与其他 OS 仍是后续边界。
