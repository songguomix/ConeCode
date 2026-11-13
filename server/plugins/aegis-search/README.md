# Aegis AISearch 安全审查（后端）

这是 ConeCode 内可直接导入的 Node.js 模块，用于在打开搜索结果前批量审查候选链接。它使用 Aegis 的本地判定逻辑和域名库，不需要运行 Aegis、安装额外依赖或启动服务。导入和调用都不发起网络请求，也不依赖 Electron。ConeCode 原有的桌面搜索保持独立；调用方需主动传入候选链接。

将下面的示例保存为仓库根目录下的 `.mjs` 文件，使用 Node.js 22.12 或更新版本运行：

```js
import { createAegisSearch, scanSearchResults } from './server/plugins/aegis-search/index.mjs';

const report = await scanSearchResults([
  'https://github.com/docs?q=test#intro',
  'https://unrelated-example.net/guide',
]);
console.log(report.allowedUrls); // 只包含判为 allow 的完整链接

const reviewer = createAegisSearch({
  policyMode: 'strict',
  allowlist: ['docs.example.com'],
  denylist: ['blocked.example.com'],
});
console.log(await reviewer.scanSearchResults(['docs.example.com']));
```

每批传入 1–20 项，支持 HTTP(S) 链接和省略协议的域名（默认 HTTPS）。`results` 与输入顺序一一对应，每项包含 `url`、`hostname`、`decision`、`score` 和 `reasons`；无法规范化的输入判为 `block`，`url` 为 `null`。报告同时返回 `total`、`allow`、`review`、`block` 计数和批次最严格结论 `decision`。需要筛选候选时，使用 `allowedUrls` 中的完整规范化链接；`review` 需人工判断，`block` 应跳过。

每个 `createAegisSearch` 实例独立设置 `policyMode`。默认 `tri` 将普通未知域名标记为待审，`strict` 只允许官方域名和允许名单中的域名，`observe` 将相似域名标记为待审、允许普通未知域名。允许和拒绝名单均匹配填写的域名及其子域名；同时命中时，以拒绝名单为准。IP 地址和已知本地域名在所有模式下都会被拦截。

本地审查识别域名库中的官方域名、相似域名、Punycode 和混合文字等信号。它不会访问候选页面或重定向，也不会查询 VirusTotal、RDAP 或在线威胁情报；`allow` 表示通过当前本地策略，不保证网页内容安全。

本地判定与域名库移植自 Aegis，许可见 [`engine/LICENSE`](engine/LICENSE)。

```sh
node --test 'server/plugins/aegis-search/**/*.test.mjs'
```
