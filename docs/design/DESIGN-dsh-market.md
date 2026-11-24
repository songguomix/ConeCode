# DESIGN — ConeCode DSH 插件市场（Plugin Market）

## 1. 项目上下文

- **产品类型**：ConeCode 桌面端 AI 编程工作台内嵌的统一插件市场与运行时控制台（兼容 DeepSeek Harness / DSH 社区插件与 ConeCode 原生插件）。
- **目标视觉调性**：高密度编辑式极简工具工作台（Editorial Utility / Swiss Grid），同时无缝继承 ConeCode 浅色纸感暖白与暗色深炭灰主题变量。
- **前端技术栈**：React 18 + TypeScript + Tailwind CSS + CSS Custom Properties（`src/components/dsh-market/`、`src/components/dsh-market/dsh-market.css`）。

## 2. 流派定位与构图策略

- **核心视觉基准**：Linear / Raycast 扩展管理与瑞士国际主义信息层级——以清晰的 1px 细线、非对称分栏、等宽数字对齐与留白建立结构，消除多余装饰。
- **非对称栅格规则**：
  - **顶部导航栏**：左侧扁平单色图标标识 + 标题与运行时状态胶囊，右侧主视图标签切换（发现 / 已安装 / 来源与运行时）与同步/关闭操作。
  - **发现页（Discover）**：桌面端采用 `224px` 左侧固定筛选索引栏（分类 + 兼容状态筛选 + 格式筛选 + 标签）+ `minmax(0, 1fr)` 右侧主目录区（顶部搜索/排序条 + 双栏宽卡片列表 `grid-cols-1 lg:grid-cols-2`，打破默认居中 Hero + 三栏等宽套路）。
  - **已安装页（Installed）**：顶部紧凑型运行时指标条（已安装数 / 活跃工具 / 命令 / Skills / 宿主服务）+ 扁平单层行列表，操作区按主次分组，避免卡片套卡片。
  - **详情页（Detail）**：`minmax(0, 1fr) 316px` 非对称双栏，左侧 README 正文严格限制 `max-width: 65ch`，右侧元数据与兼容矩阵通过 `1px` 分割线分隔而非多层嵌套卡片。

## 3. 锁定态色彩系统 (60 / 30 / 10)

严格遵循带微弱色温的中性色层级，禁止使用纯黑 `#000000` 或刺眼纯白 `#FFFFFF` 作为大面积画布。默认映射 ConeCode 全局 CSS 变量，并在 `dsh-market.css` 中提供精确回退色值：

| 层级 | 占比 | 浅色模式 HEX | 暗色模式 HEX | 对应变量 / 用途 |
|---|---|---|---|---|
| **主画布 (Canvas)** | 60% | `#F7F6F2` | `#111214` | `--dm-canvas` (`var(--bg-0, #F7F6F2)`) 弹窗主画布 |
| **次级表面 (Surface)** | 22% | `#EFECE6` | `#17191D` | `--dm-surface` (`var(--bg-1, #EFECE6)`) 侧栏筛选区、输入框、行底色 |
| **抬升浮层 (Elevated)** | 8% | `#FAF9F6` | `#1E2127` | `--dm-elevated` (`var(--bg-2, #FAF9F6)`) 浮层弹窗、悬停态、激活 Tab |
| **主文字 (Ink Primary)** | — | `#18181B` | `#EDEDEF` | `--dm-ink` (`var(--text-primary)`) 标题、主数值 |
| **次文字 (Ink Secondary)** | — | `#52525B` | `#A1A1AA` | `--dm-ink-muted` (`var(--text-secondary)`) 描述、说明 |
| **弱文字 (Ink Subtle)** | — | `#71717A` | `#71717A` | `--dm-ink-subtle` (`var(--text-muted)`) 元数据、时间戳 |
| **品牌强调色 (Accent)** | 10% | `#C96442` | `#D97757` | `--dm-accent` (`var(--accent, #C96442)`) 主操作按钮、激活态 |
| **成功语义色 (Verified)** | — | `#15803D` | `#34D399` | 已验证兼容 / 运行正常 |
| **警告语义色 (Partial)** | — | `#B45309` | `#FBBF24` | 部分兼容 / 风险提示 |
| **错误语义色 (Incompatible)** | — | `#B91C1C` | `#F87171` | 不兼容 / 加载失败 |
| **信息语义色 (Client/Info)** | — | `#0369A1` | `#38BDF8` | 客户端能力 / DSH Web |
| **1px 边框 (Border)** | — | `rgba(24, 24, 27, 0.09)` | `rgba(255, 255, 255, 0.08)` | `--dm-border` 常规分割线 |
| **1px 悬停边框 (Border Hover)** | — | `rgba(24, 24, 27, 0.16)` | `rgba(255, 255, 255, 0.15)` | `--dm-border-hover` 交互态边框 |

## 4. 字体族与字阶表

- **Display / Body 字体栈**：`'Inter', 'Plus Jakarta Sans', 'PingFang SC', 'Noto Sans SC', -apple-system, BlinkMacSystemFont, sans-serif`
- **Mono 字体栈**：`'JetBrains Mono', 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace`
- **字阶规范**：
  - 面板主标题：`16px` / 行高 `1.25` / 字重 `600` / `letter-spacing: -0.02em`
  - 插件详情主标题：`20px` / 行高 `1.15` / 字重 `600` / `letter-spacing: -0.025em`
  - 区块小标题：`12px` / 行高 `1.4` / 字重 `600`
  - 正文与 README：`13px` / 行高 `1.6` / `max-width: 65ch`
  - 卡片描述：`12px` / 行高 `1.55` / `max-width: 65ch`
  - 元数据 / 标签 / 版本号：`11px` / 行高 `1.35` / Mono 字体
- **数字等宽对齐**：所有计数、版本号、周下载量、GitHub Star、分页页码、耗时与时间戳强制设置 `font-variant-numeric: tabular-nums`（`.dm-num` / `tabular-nums`）。

## 5. 间距栅格与表面规范

- **基础步长**：`4px` 原子网格（`4 / 8 / 12 / 16 / 20 / 24px`）。
- **圆角体系**：
  - 主面板容器：`16px`（移动端 `12px`）
  - 内部容器 / 对话框：`12px`
  - 按钮 / 输入框：`8px`
  - 徽章 / 能力标签：`6px`
- **边框与阴影**：
  - 全部边界使用 `1px solid var(--dm-border)`，不堆叠粗实线。
  - 主弹窗多层环境光阴影：
    - 浅色：`0 1px 2px rgba(24, 24, 27, 0.05), 0 18px 48px -12px rgba(24, 24, 27, 0.16)`
    - 暗色：`inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 24px 64px -12px rgba(0, 0, 0, 0.55)`
  - 禁止同一视图超过 1 层的卡片嵌套；能用 `1px` 分割线和间距表达层级的地方不包圆角底色盒。

## 6. 交互状态与动效预算

- **缓动曲线**：统一使用 `cubic-bezier(0.16, 1, 0.3, 1)`，禁止 `linear` UI 过渡。
- **时长预算**：
  - 按钮 / 列表项 Hover / Border 提亮：`150ms`
  - 面板与对话框展开 / 切换：`240ms`
- **悬停反馈**：仅允许 `1px` 边框提亮与 `2%–4%` 背景明度微调，**严禁 `hover:scale` 放大效果**。
- **焦点状态**：所有可交互元素支持 `focus-visible` `2px` 强调色外描边。

## 7. 防平庸校验声明

本设计规范已逐项规避全部 10 条负面清单：
1. 不使用紫蓝渐变（同步移除原面板头部的强调色渐变块，改为克制的单色表面标识）。
2. 不添加背景模糊光晕球或 mesh gradient 装饰。
3. 不滥用“彩色圆底小图标”堆砌列表。
4. 全部文案均贴合真实 DSH 插件市场与运行时语境，无占位假文案。
5. 主画布不使用纯黑 `#000000` 或纯白 `#FFFFFF`。
6. 发现页改用“左侧固定索引筛选栏 + 右侧双栏宽列表”非对称构图，放弃默认三栏等宽卡片模板。
7. 列表项与插件卡片严禁使用 `hover:scale` 放大动画。
8. README 与长说明文本统一约束 `max-width: 65ch`。
9. 全部统计数字、下载量、Star、版本计数与分页强制应用 `tabular-nums`。
10. 本设计文档先于任何前端代码修改落盘，后续所有样式变量 100% 溯源本文档。
