---
feature: remote-fingerprint-pairing
status: delivered
updated: 2026-09-26
branch: fix/remote-fingerprint-pairing (conecode) + fix/remote-connect-ui (Cone AI New2)
commits: 2303ea9..3a8ca7b (conecode) · 3487776..922e628 (Cone AI New2)
---

# Remote Fingerprint Pairing + Mobile Mirror UI

## Report

**What was built** — 桌面配对 URL/QR 携带本机远程 TLS 证书的 SHA-256 指纹（`fp=`），Android 解析该指纹并按「系统 CA → 配对 fp → TOFU」信任对端；未知自签证书一律拒绝（已删除捆绑证书旁路）。远程镜像页增加连接状态胶囊、失败重试卡、会话行 ≥48dp 触控、独立「被踢」态，以及 ≤360dp 紧凑边距。

**Verification** — conecode `npm test` PASS (646)、`npm run typecheck` PASS、`certFingerprint` 单测 PASS。Android `RemoteTrustTest` / `RemoteEndpointParseTest` 已写入；本机无 Java Runtime，`gradlew test` 为 **PRE-EXISTING** 环境限制未在本机执行。独立 review 初判 REQUEST_CHANGES（捆绑证书旁路 + T4 未完成），修复后复审 **APPROVE**。

**Journey log** — 根因是桌面每安装自签 vs 手机固定捆绑证书，不是 token/密码。指纹必须与 Android `X509Certificate.encoded` 的 SHA-256 对齐（两端 wire-compatible）。复审抓到 legacy pin 会绕过 fp/TOFU，必须删干净。Android 侧无法本地跑 JVM 测试时，用纯函数测试 + 复审代替并在报告标明。

## [S1] Problem

手机端（Cone AI New2）连不上 conecode 远程控制：桌面**每次安装生成自有自签 TLS 证书**（`remote-tls.json`），Android 却只信任 `res/raw/conecode_cert.pem` 这张**固定捆绑证书**。LAN HTTPS 握手因此失败。另：远程镜像页在小屏上信息密、触控区偏小。

## [S2] Design

### TLS pairing (fingerprint + TOFU)

1. **Desktop** (`electron/remote/tls.ts`, `main.ts`, `RemotePanel`):
   - `certFingerprint(certPem)` — SHA-256 of DER, lowercase hex。
   - `remoteStatus()` / 配对 URL 增加 `&fp=<fingerprint>`（LAN 与 tunnel）。
2. **Android** (`RemoteEndpoint`, `RemoteTls`, `RemoteTrust`):
   - `RemoteEndpoint.parse` 解析 `fp`（64 hex）。
   - 信任顺序：① 系统 CA / ② `fp` 匹配 / ③ TOFU（`host:port` → fp）。**无**捆绑证书回退。
   - Hostname：`fp`/TOFU 匹配时允许 IP 无 SAN。
3. **Server auth** 不变：token + 可选密码；隧道无密码仍拒绝公网转发头。

### Mobile mirror UI (RemoteScreen)

- 顶部 ConnectionPill（连接中/已连接/需密码/被踢/未连接）。
- 失败/被踢卡片 + 重连；会话行 `heightIn(min=52.dp)`，删除按钮 48dp。
- ≤360dp 收紧连接表单边距；composer 保留 safe-area。

### Testing boundary

- Desktop：`certFingerprint` 稳定哈希/区分证书。
- Android：`RemoteEndpoint.parse` 含 `fp`；`RemoteTrust` 接受 fp/TOFU、拒绝未知。
- 不测真机 TLS E2E。

## [S3] Out of Scope

- 不改 conecode 鉴权模型、隧道供应商。
- 不重做 Android 主聊天/设置页。
- 不引入第三方 TLS 库。

## Tasks

- [x] T1: Desktop certFingerprint + 配对 URL/状态带 fp — acceptance: 纯函数测试通过；remoteStatus/QR URL 含 fp= (covers: S2)
- [x] T2: Android RemoteEndpoint.parse 支持 fp — acceptance: 解析测试通过 (covers: S2; depends: T1)
- [x] T3: Android RemoteTls 指纹 + TOFU 信任链 — acceptance: 纯函数信任决策测试（接受 fp/TOFU，拒绝未知） (covers: S2; depends: T2)
- [x] T4: RemoteScreen 镜像 UI 优化 — acceptance: 连接态/列表/底栏触控与小屏样式更新，typecheck/编译源通过 (covers: S2)
