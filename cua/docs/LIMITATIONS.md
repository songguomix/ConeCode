# 能力矩阵与实际限制

当前证据见 [DELIVERY.zh-CN.md](DELIVERY.zh-CN.md)，历史记录已被本轮核验覆盖。

| 能力/平台/接口 | 当前支持与证据 |
|---|---|
| Chromium / Playwright 1.65.0 | 真实本地驱动与控制器端到端已验证；跨调用保留浏览器 |
| 结构化目标 + 截图 | 每次观察唯一 ref、宿主 ElementHandle、重复按钮/iframe/open shadow/弹窗/标签页/滚动/坐标转换已测试 |
| 下载 | 真实下载保存 ArtifactStore，文件名、来源、SHA-256；重新读取字节和 hash 验收 |
| 页面范围 | closed shadow 不支持；任意虚拟列表/不可读 frame 是覆盖缺口；不能据此证明文本不存在 |
| 图像大小 | 可配置 viewport；无 screenshotMaxEdge 或图片重采样功能 |
| 浏览器请求守卫 | 约束 HTTP(S)/WS(S) origin 和授权有效期；重定向全部拒绝，包括合法重定向 |
| 恢复 | 实际 SIGKILL + SQLite 恢复，UNKNOWN 不重放；记录/文件/HTTP 不启动浏览器，DOM 恢复禁 JS/POST/WS |
| macOS 代码运行时 | Seatbelt + 单独进程，持久 globalThis、受控 RPC、串行 drain、超时/输出/堆限制已实际验证 |
| Linux 代码运行时 | bwrap 分支已实现，实际 Linux 隔离尚未验证；缺失隔离时拒绝执行，测试明确跳过 |
| Windows 代码运行时 | 不支持 |
| macOS 桌面 | 默认单 app 单窗口：窗口截图 + 该窗口无障碍子树，点按/写值走 AX，越界输入拒绝，TextEdit 保存与独立文件重读通过；受控宿主 fixture，不是隔离 VM |
| macOS 原生键鼠 | 窗口内真点击（截图坐标即窗口坐标）、中文/Unicode、Meta+A 以及焦点切换/窗口移动后的观察失效已测；输入前校验目标 app 在前台，否则不投递。保存通过应用脚本，不是原生 Save As 流程 |
| 中文/Unicode | 浏览器、Swift CGEvent 输入及 TextEdit 文件内容独立验证通过；主屏实际 2×缩放 |
| Linux/Windows 原生桌面 | 未实现、不支持，不提供假适配器 |
| ModelAdapter | OpenAI-compatible Chat Completions 函数工具、图片 opt-in、结构化输出 opt-in、错误/取消/用量解析已 HTTP 替身验证 |
| 真实模型 | 无密钥，smoke 与完整浏览器闭环未运行；入口已接通，缺少配置退出 2，不标为通过 |
| 原生 Responses computer tool | 未实现；能力明确 false；本项目用自身受控函数工具 |
| React / CLI / SDK / MCP | 实际本地服务、Chromium 控制台、CLI、SDK SSE、MCP stdio 验证通过 |
| 多 Agent | 单服务进程队列、资源锁、只读 Monitor、接管/归还已验证 |
| 多 worker | 不支持；SQLite lease API 没有 GUI 执行端 fencing，不可据此部署多个写 worker |
| Workflow | 验证过的语义步骤、版本/最近验证时间、过期配置、模式脱敏与指定名称删除已测试 |
| Docker/Compose | 配置提供，非 root 用户、本机端口映射；语法检查通过，daemon 不可用，镜像未构建 |
| CI | 无密钥的 Ubuntu 工作流提供，真实 Chromium；远端 runner 尚未执行 |

关键限制与处理办法：

1. 页面仍可在最终检查与点击间改变。ElementHandle 防 ref 克隆重定向，但同一 DOM 节点可以改变业务含义；敏感操作必须增加对象身份前置条件与业务验收。坐标点击尤其需要新截图。
2. Playwright 路由不是完整 OS 防火墙；WebRTC、浏览器自身系统服务等非 HTTP 通道未做目的地隔离。任意恶意站点需要额外容器/VM 与出站策略。当前默认用于本地 fixture。
3. GET/HEAD 只读是接口约定，不能保证一个不规范业务服务不会在 GET 时写入。使用明确的只读业务查询端点。
4. 文件路径解析阻止 `../` 和已有 symlink 逃逸，但 GUI 保存不能提供抵御另一宿主进程同时替换路径的原子 openat 边界。使用受控、专属目录。
5. 暂停/取消不是回滚。超时后宿主 GUI promise 可能仍运行；UNKNOWN 会阻止新写入和提前接管。无法证明时留待核实。
6. 代码 VM 与 Node permission 都不是独立安全边界。Seatbelt 是本机 OS 边界；256 MB V8 heap 不等于硬性整个进程 RSS 配额。处理任意敌意代码应采用更强 VM/容器资源限制。
7. 日志/长期记忆按模式脱敏；任意个人信息及截图并不能自动完全去敏。结构化任务/动作状态为恢复保留原文，不是加密存储；数据库、WAL/SHM、token 为 0600，目录新建为 0700。
8. workflow 删除是逻辑删除目标 memory，事件、SQLite 旧页及备份不会安全擦除。事件/截图自动保留期与删除尚未实现；停服务后可整体删除专属 dataDir，但这会丢失恢复证据。
9. 未提供价格时费用为 null，美元预算不可精确核算；提供价格也只是 token 费率估算，不能代替账单或处理所有服务端收费。调用/步骤/token/时间限制独立生效。
10. 负载裁剪对照不是任务速度或模型 token/费用改善。完整控制器的确定性 full/projected 对照 4/4 成功、每次 3 请求/2 动作；真实模型比较仍需凭证，不能据此宣称速度改善。

11. 桌面测试使用当前 macOS 上的专属测试文稿，键鼠和焦点仍是共享资源；全局执行锁不能阻止用户/其他进程干预。隔离 guest、额外显示器/实际缩放切换、原生 Save As、drag/double-click/scroll 全链路仍待额外环境验证。
12. 单 app 观察依赖目标应用暴露的无障碍树：自绘画布/自定义控件不暴露，AX 节点可能被应用截断（maxNodes/maxDepth 有上限）；窗口被最小化或位于其他 Space 时不可解析，会显式失败而不是退回全屏。`scope: 'display'` 仍会读取主屏其他 app 的像素，仅作排障 opt-in。
