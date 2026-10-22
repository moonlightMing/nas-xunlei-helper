# NAS 迅雷助手

浏览器扩展：把网页里的下载链接（`thunder://`、`magnet:`、`ed2k:`、`http(s)://`）一键发送到 NAS 迅雷（群晖套件版 `pan-xunlei-com`）远程下载。

基于 [WXT](https://wxt.dev) + Vue 3 + TypeScript + Ant Design Vue 构建，是 [nas-thunder-helper](../nas-thunder-helper) 原型的升级重构版。

## 功能

- **控制面板（设置页）**
  - NAS 迅雷地址：迅雷 NAS 套件 Web 页面地址（含格式校验）
  - 默认下载位置：NAS 保存路径，留空使用 NAS 当前默认目录
  - 下载模式：
    - **立即下载**——自动解析并点击「立即下载」，全程无需打开迅雷页面操作
    - **确认后下载**——自动解析后停留在迅雷下载确认框，由你编辑文件名、保存位置后手动确认
  - 一键打开迅雷页面验证地址、恢复默认设置
- **右键菜单发送**：任意网页链接右键 →「发送到 NAS 迅雷」
- **popup 批量发送**：工具栏弹窗粘贴多行链接批量发送
- **桌面通知**：发送成功/失败均有通知反馈

## 实现原理

沿用原型的 **DOM 自动化** 路线：复用浏览器里已登录的迅雷 Web 会话，通过
`chrome.scripting.executeScript` 向迅雷页面注入脚本，模拟点击「新建任务 → 填链接 → 解析 → 立即下载」。
不直接调用 NAS HTTP 接口，无需存储账号密码。

迅雷 Web UI 的关键选择器集中在 [utils/xunleiAutomation.ts](utils/xunleiAutomation.ts)，套件更新导致 DOM 变化时只需调整该文件。

## 开发

```bash
pnpm install      # 安装依赖
pnpm dev          # 开发模式（自动打开浏览器、热更新）
pnpm compile      # 类型检查（vue-tsc）
pnpm build        # 构建产物输出到 .output/chrome-mv3
pnpm check        # compile + build
pnpm deploy       # 本地构建部署到 Google Chrome 调试实例（端口 9223）
pnpm deploy:cent  # 本地构建部署到 Cent Browser 百分浏览器调试实例（端口 9224）
```

> 部署脚本会启动独立 profile 的调试浏览器（不影响日常浏览器），构建后自动重载扩展。
> 首次部署若扩展列表里没有本插件，在它打开的 `chrome://extensions` 页面「加载已解压的
> 扩展程序」选择 `.output/chrome-mv3`，之后每次部署全自动。各目标浏览器端口与 profile
> 独立、可共存；可用 `XUNLEI_DEBUG_PORT` / `XUNLEI_DEBUG_BROWSER` 覆盖端口与浏览器路径。

## 部署到 Cent Browser（百分浏览器）

- **版本要求**：本插件是 Manifest V3 扩展，需要 Cent Browser **5.x**（Chromium 118/132 内核）及以上；旧版 4.x（Chromium 80）无法加载
- 已适配 5.2.1168.83（Chromium 132）：`pnpm deploy:cent` 一键构建部署，调试实例使用项目内独立 profile `.debug-profile-cent`，与日常使用的 Cent 互不影响
- Cent 5.x 是 Chromium 132 分支，没有 Chrome 137+ 忽略 `--load-extension` 的限制，首次部署通常即可自动挂载
- 本机安装路径为便携目录（如 `D:\Software\CentBrowser\Application\chrome.exe`）时脚本可自动探测；其它位置请设 `XUNLEI_DEBUG_BROWSER` 指向主程序 `chrome.exe`

## 安装使用

1. `pnpm build` 后，在浏览器 `chrome://extensions` 开启「开发者模式」
2. 「加载已解压的扩展程序」选择 `.output/chrome-mv3`
3. 打开扩展设置页，填入 NAS 迅雷地址（如 `http://192.168.5.2:2345/webman/3rdparty/pan-xunlei-com/index.cgi/#/home`）
4. **先在浏览器中打开一次迅雷页面并登录**（本插件复用已登录会话，不管理凭证）
5. 在任意网页右键链接「发送到 NAS 迅雷」，或在 popup 中粘贴链接发送

## 手动测试清单

需要真实 NAS 环境验证：

- [ ] 设置页：空地址/非 http(s) 地址保存时有警告；合法地址保存成功
- [ ] 设置页：「打开迅雷页面」能打开所配地址
- [ ] 未配置地址时：右键菜单/popup 发送有明确提示
- [ ] 立即下载模式：右键发送一个磁力链接 → 弹出通知「任务已发送并开始下载」，NAS 任务列表出现该任务
- [ ] 确认后下载模式：右键发送 → 迅雷页面停在确认框，可编辑文件名/路径后手动确认
- [ ] 默认下载位置：配置路径后立即下载模式，注意通知中是否提示「未能定位默认路径」（路径选择为 best-effort，见下）
- [ ] popup 多行链接批量发送

## 已知限制

- **默认下载位置的自动匹配是 best-effort**：迅雷对话框中的目录选择区无稳定选择器，插件只做只读检测匹配，不盲目点击；未匹配时回退 NAS 默认目录并在通知中说明。「确认后下载」模式不受影响，可手动选择路径。
- DOM 自动化依赖迅雷 NAS 套件的页面结构，迅雷大版本更新后选择器可能需要适配。
