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

## 工作原理

沿用原型的 **DOM 自动化** 路线：复用浏览器里已登录的迅雷 Web 会话，通过
`chrome.scripting.executeScript` 向迅雷页面注入脚本，模拟点击「新建任务 → 填链接 → 解析 → 立即下载」。
不直接调用 NAS HTTP 接口，无需存储账号密码。

迅雷 Web UI 的关键选择器集中在 [utils/xunleiAutomation.ts](utils/xunleiAutomation.ts)，套件更新导致 DOM 变化时只需调整该文件。

> 本仓库只有浏览器扩展，没有 NAS 端组件或后端服务；NAS 侧只需已有可用的迅雷套件。

## 环境要求

- Node.js **>= 22**（WXT 0.21 要求）与 pnpm
- 支持 Manifest V3 的浏览器：
  - Google Chrome / Microsoft Edge
  - Cent Browser（百分浏览器）**5.x 及以上**（Chromium 118/132 内核）；4.x（Chromium 80）无法加载
- NAS 已安装并运行迅雷套件，且你已在浏览器中登录过其 Web 页面

## 项目结构

```text
entrypoints/
  background.ts          # 右键菜单、popup 消息路由、发送编排
  options/               # 控制面板（独立标签页）
  popup/                 # 工具栏弹窗：批量粘贴链接发送
utils/
  settings.ts            # 设置的读写、校验与跨上下文同步
  xunleiAutomation.ts    # 注入迅雷页面的 DOM 自动化与选择器
scripts/
  deploy.mjs             # 本地一键构建并部署到调试浏览器
public/icons/            # 扩展图标
wxt.config.ts            # 扩展清单与构建配置
```

## 开发与构建

| 命令 | 说明 |
| --- | --- |
| `pnpm install` | 安装依赖（postinstall 自动执行 `wxt prepare`） |
| `pnpm dev` | 开发模式：启动 WXT 开发服务器并打开浏览器，支持热更新 |
| `pnpm compile` | 类型检查（`vue-tsc --noEmit`） |
| `pnpm build` | 生产构建，产物输出到 `.output/chrome-mv3` |
| `pnpm check` | `compile` + `build`，提交前至少执行一次 |
| `pnpm zip` | 构建并打包为 `.output/nas-xunlei-helper-<version>-chrome.zip` |
| `pnpm deploy` | 构建并部署到 Chrome 调试实例（见下） |
| `pnpm deploy:cent` | 构建并部署到 Cent Browser 调试实例（见下） |

> 构建时可能出现 chunk 超过 500 kB 的警告（Ant Design Vue 全量引入，尚未做按需拆分），不影响功能。

## 部署

### 方式一：一键部署到本地调试浏览器（开发 / 验收推荐）

`scripts/deploy.mjs` 会完成「构建 → 复用或启动独立调试实例 → 重载扩展」的全流程。

| 目标浏览器 | 命令 | 调试端口 | 独立 profile |
| --- | --- | --- | --- |
| Google Chrome | `pnpm deploy` | 9223 | `.debug-profile` |
| Cent Browser | `pnpm deploy:cent` | 9224 | `.debug-profile-cent` |
| Microsoft Edge | `node scripts/deploy.mjs --browser=edge` | 9225 | `.debug-profile-edge` |

不同目标的端口与 profile 相互独立，可同时部署、共存；调试实例与日常浏览器互不影响。

#### 执行步骤

1. 安装依赖：`pnpm install`
2. （可选）先做类型检查和构建：`pnpm check`
3. 执行上表对应命令。脚本会再构建一次，因此无需提前 `pnpm build`
4. **首次部署**：若调试实例的扩展列表里没有「NAS 迅雷助手」，在它自动打开的 `chrome://extensions` 页面开启「开发者模式」，点击「加载已解压的扩展程序」，选择 `.output/chrome-mv3`；之后同一调试 profile 的部署均可全自动
5. 在扩展设置页填入 NAS 迅雷地址，并在调试实例中打开迅雷页面登录一次
6. 右键任意链接或在 popup 中发送，按 [手动测试清单](#手动测试清单) 验收

#### 脚本做了什么

1. 执行 `pnpm build`，并确认 `.output/chrome-mv3/manifest.json` 存在
2. 探测目标端口的 Chrome DevTools Protocol（CDP）：已有调试实例则复用，否则用独立 `--user-data-dir` 启动并等待端口就绪
3. 通过 `chrome://extensions` 页面的 `chrome.developerPrivate.reload()` 重载扩展
4. 若找不到扩展或重载失败：关闭调试实例、清理 Service Worker 脚本缓存，再带 `--load-extension` 重启。该回退仅对仍支持 `--load-extension` 的浏览器（Chrome for Testing、Cent 5.x 等）等效于完成部署；Chrome 137+ 正式版仍需手动加载一次

#### 环境变量

- `XUNLEI_DEBUG_PORT`：覆盖调试端口，例如 `XUNLEI_DEBUG_PORT=9333 pnpm deploy`
- `XUNLEI_DEBUG_BROWSER`：指定浏览器可执行文件路径，跳过自动探测

PowerShell 中设置方式为 `$env:XUNLEI_DEBUG_PORT=9333; pnpm deploy`。

#### 注意事项

- **Chrome 137+ 正式版忽略 `--load-extension`**：首次通常需要按上文手动「加载已解压的扩展程序」。若项目根目录存在 Chrome for Testing（`chrome/win64-<version>/chrome-win64/chrome.exe`，该目录已被 git 忽略），`pnpm deploy` 会优先使用它，可自动挂载；也可设 `XUNLEI_DEBUG_BROWSER` 指向其它 Chromium 构建
- Cent Browser 5.x（已适配 5.2.1168.83 / Chromium 132）没有该限制，首次部署通常即可自动挂载；安装在便携目录（如 `D:\Software\CentBrowser\Application\chrome.exe`）时脚本可自动探测，其它位置请设 `XUNLEI_DEBUG_BROWSER`
- 调试 profile 是项目内的独立目录且已被 git 忽略，不会污染日常浏览器，也不要提交
- 部署后如果行为仍是旧版本，按 [常见问题](#常见问题) 清理 Service Worker 脚本缓存

### 方式二：安装到日常浏览器

1. `pnpm build`
2. 打开 `chrome://extensions`，开启「开发者模式」
3. 「加载已解压的扩展程序」选择 `.output/chrome-mv3`
4. 打开扩展设置页，填入 NAS 迅雷地址（如 `http://192.168.5.2:2345/webman/3rdparty/pan-xunlei-com/index.cgi/#/home`）
5. **先在浏览器中打开一次迅雷页面并登录**（本插件复用已登录会话，不管理凭证）
6. 在任意网页右键链接「发送到 NAS 迅雷」，或在 popup 中粘贴链接发送

### 方式三：打包分发

`pnpm zip` 生成 `.output/nas-xunlei-helper-<version>-chrome.zip`。解压后按「方式二」加载，或提交到浏览器扩展商店。

> 部署仅发生在本地浏览器；NAS 不需要安装、上传或重启任何东西。

## 常见问题

**部署脚本提示未找到浏览器**
脚本未能自动探测到浏览器安装位置。设置 `XUNLEI_DEBUG_BROWSER` 指向浏览器主程序（如 `...\Application\chrome.exe`）后重试。

**调试端口等待超时**
端口可能被非调试进程占用，或浏览器启动失败。先访问 `http://127.0.0.1:<端口>/json/version` 检查；关闭遗留的调试实例，或通过 `XUNLEI_DEBUG_PORT` 换一个端口。

**调试实例里没有本扩展，或部署后仍是旧行为**
- 首次：按「执行步骤」第 4 步手动加载 `.output/chrome-mv3`
- 旧行为：Chromium 会按 profile 缓存扩展 Service Worker 的脚本字节码。完全退出调试浏览器后，删除对应 profile 下的 `Default/Service Worker/ScriptCache` 目录，再重新部署（`chrome` 目标为 `.debug-profile`，Cent 为 `.debug-profile-cent`，Edge 为 `.debug-profile-edge`）

**发送时提示未配置地址或地址非法**
到扩展设置页填写以 `http://` 或 `https://` 开头的完整迅雷 Web 地址并保存。

**发送超时或提示等待元素失败**
确认迅雷页面已打开且处于登录状态；若迅雷套件刚升级过，页面 DOM 可能已变化，需调整 [utils/xunleiAutomation.ts](utils/xunleiAutomation.ts) 中的选择器。

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

## 相关文档

- [AGENTS.md](AGENTS.md)：面向 AI 编码代理的项目约定、完整部署步骤与修改注意事项
