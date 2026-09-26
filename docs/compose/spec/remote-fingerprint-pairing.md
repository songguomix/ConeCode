---
feature: remote-fingerprint-pairing
status: designed
updated: 2026-09-26
branch: fix/remote-fingerprint-pairing (conecode) + fix/remote-connect-ui (Cone AI New2)
commits: 
---

# Remote Fingerprint Pairing + Mobile Mirror UI

## Report

## [S1] Problem

手机端（Cone AI New2）连不上 conecode 远程控制：桌面**每次安装生成自有自签 TLS 证书**（`remote-tls.json`），Android 却只信任 `res/raw/conecode_cert.pem` 这张**固定捆绑证书**。LAN HTTPS 握手因此失败。另：远程镜像页在小屏上信息密、触控区偏小。

## [S2] Design

### TLS pairing (fingerprint + TOFU)

1. **Desktop** (`electron/remote/tls.ts`, `main.ts`, `RemotePanel`):
   - Export `certFingerprint(certPem: string): string` — SHA-256 of DER, lowercase hex (no colons).
   - `remoteStatus()` / 配对 URL 增加 `&fp=<fingerprint>`（LAN 与 tunnel 都带上；tunnel 仍以系统 CA 为准）。
   - QR 内容不变结构，只多一个 query。
2. **Android** (`RemoteEndpoint`, `RemoteTls`):
   - `RemoteEndpoint.parse` 解析 `fp`（可空）。
   - 信任顺序：① 系统 CA / ② 配对 URL 的 `fp` 与对端证书 SHA-256 一致 / ③ TOFU 本地库（`host:port` → fp，首次成功连接后写入）。
   - Hostname：`fp` 匹配时允许 IP 主机名不匹配（自签无 LAN SAN）。
   - **禁止**继续信任与 `fp`/TOFU 都不符的未知自签证书。
3. **Server auth** 不改：token + 可选密码；隧道无密码仍拒绝公网转发头。

### Mobile mirror UI (RemoteScreen)

- 连接态大状态条（连接中/已连接/需密码/被踢）+ 一键重连。
- 会话列表：更大触控目标（≥48dp）、状态点、变更文件芯片。
- 底部操作栏固定安全区；长内容滚动不挡发送/审批。
- 小屏（≤360dp）压缩边距，不砍功能。

### Testing boundary

- Desktop：`certFingerprint` 单测（稳定哈希）；URL 带 `fp` 的纯函数单测。
- Android：`RemoteEndpoint.parse` 含 `fp` 的单元测试；信任决策抽出纯函数单测（匹配 fp / TOFU / 拒绝）。
- 不测真机 TLS 握手 E2E（需安装包）。

## [S3] Out of Scope

- 不改 conecode 服务器鉴权模型、不改隧道供应商。
- 不重做 Android 主聊天 / 设置页。
- 不引入第三方 TLS 库。

## Tasks

- [ ] T1: Desktop certFingerprint + 配对 URL/状态带 fp — acceptance: 纯函数测试通过；remoteStatus/QR URL 含 fp= (covers: S2)
- [ ] T2: Android RemoteEndpoint.parse 支持 fp — acceptance: 解析测试通过 (covers: S2; depends: T1)
- [ ] T3: Android RemoteTls 指纹 + TOFU 信任链 — acceptance: 纯函数信任决策测试（接受 fp/TOFU，拒绝未知） (covers: S2; depends: T2)
- [ ] T4: RemoteScreen 镜像 UI 优化 — acceptance: 连接态/列表/底栏触控与小屏样式更新，typecheck/编译源通过 (covers: S2)
