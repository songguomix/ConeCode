# 测试与评估

当前验收采用机器生成的 `artifacts/delivery/report.json` 和源码 SHA-256 清单。
[交付报告](DELIVERY.zh-CN.md) 给出本轮精确结果。

```bash
cd cua
npm ci
npm run install:browsers
npm run build:native       # macOS；其他系统明确跳过
npm run verify:delivery    # 默认不操作真实桌面、不请求付费模型
node scripts/verify-clean-install.mjs
```

独立安装验证在新的临时目录执行 `npm ci --offline`、构建、真实 Chromium Demo；复用 npm/Chromium 缓存，不等于新机器或其他系统验证。输出 `artifacts/clean-install/`。

桌面测试会真实截图、尝试切换 TextEdit 焦点和写专属临时文件，须显式启用：

```bash
CUA_RUN_DESKTOP=1 npx vitest run test/desktop.test.ts
npm run demo:desktop
# 或在完整证据链中执行：npm run verify:delivery -- --desktop
```

首次显式桌面测试因自动化授权等待超时，失败证据保留于 `artifacts/desktop-attempt/`。用户允许后，7 项桌面用例通过：单 app 单窗口观察（窗口截图 + 无障碍子树）、窗口内原生点击/Unicode/Meta+A、焦点切换与窗口移动、AX 写值与独立 AppleScript 重读、窗口外坐标拒绝、AX 点按。最后由完整验收重跑，核对同一源码指纹。
默认测试将桌面硬件用例标为跳过；显式 `CUA_RUN_DESKTOP=1`（或 `--desktop`）执行它们。纯逻辑（窗口选择、窗口局部坐标、AX 树裁剪与目标映射）在 `test/app-scope.test.ts` 中始终运行，不需要屏幕录制权限。

分层与证据：

- 协议/状态机：参数拒绝、非法转换、错误、预算、关联 ID。
- 真实 Chromium：表单/校验/保存/重读、列表重复按钮、弹窗、延迟、iframe/open shadow、重排旧引用、下载字节/hash、HTTP/WS origin 与过期授权。
- 控制器：输入、pause/resume/cancel/takeover/release、纠错、按语义重试预算、假成功拒绝、UNKNOWN。
- 故障：种子状态恢复及真正 fork + SIGKILL，覆盖意图记录后、提交后驱动响应返回前，恢复无重复点击。
- macOS 隔离：持续 globalThis、RPC 串行/遗漏 await、计时器跨轮、超时宿主动作；不借助 Node permission 的实际 OS 文件与网络拒绝。
- 接口：HTTP/token/Host/Origin、SSE 续读/协议错误、React 竞态、CLI、SDK、MCP、workflow 删除与存储权限。
- 确定性评估：4 个场景的预定断言，其中 2 个应成功、2 个应拒绝完成。4/4 是场景符合率；任务 succeeded 为 2/4，不能写成通用成功率 100%。
- 观察负载：form/list/iframe 各 3 次，同一观察配对序列化。字符数不是 token，费用/任务成功率 null。
- 真实模型：需要独立明确启用。HTTP 替身测试不代表真实提供商调用。

```bash
export OPENAI_API_KEY=...
export CUA_REAL_MODEL=your-model
npm run eval:real -- --json --max-model-calls 8
CUA_RUN_REAL_MODEL=1 npx vitest run test/model.test.ts test/evaluation.test.ts
```

`eval --real` 缺模型或密钥退出 2；模型/任务失败退出 1。成功只在重新读取持久化记录通过后产生。
原生 computer tool 未接入。模型名称、工具/图像/结构化能力分别配置。

指标约定：模型调用数基于 `model.request`，包含没有 response 的失败尝试；原生 adapter 默认不进行隐藏重试。
成功率有明确分母，UNKNOWN 不当成功。重复意图不是重复 GUI 副作用计数。
只有当前测试的实际记录能证明没有重复提交；不能外推任意业务 exactly-once。
真实模型未跑时，模型成本/恢复成功率/速度比较均不得编造。

控制器对照：`npx tsx scripts/compare-controller.ts --out docs/evidence/2026-11-07-controller-comparison.json`。两种观察模式、普通/延迟保存共四次真实控制器运行；相同验收/预算、确定性规划。费用 null，不声明速度或真实模型改善。
