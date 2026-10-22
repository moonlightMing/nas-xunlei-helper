# AGENTS.md

本文件面向在本仓库工作的 AI 编码代理。面向用户的安装与使用说明见 [README.md](README.md)。

## 项目概览

- Manifest V3 浏览器扩展：把下载链接发送到 NAS 迅雷（群晖套件版 `pan-xunlei-com`），**没有 NAS 端组件，也没有后端服务**。
- 技术栈：WXT 0.21 + Vue 3 + TypeScript + Ant Design Vue 4 + pnpm。
- Node.js **>= 22**（WXT 0.21 要求，部署脚本也依赖全局 `fetch` / `WebSocket`），必须使用 pnpm（仓库有 `pnpm-lock.yaml`，勿改用 npm/yarn）。
- 发送原理：复用浏览器已登录的迅雷 Web 会话，用 `chrome.scripting.executeScript` 注入脚本，按 DOM 选择器模拟「新建任务 → 填链接 → 解析 → 立即下载」。不调用 NAS HTTP API，不存储账号密码。
- 当前为原型重写版。`manifest.version` 在 `wxt.config.ts` 中硬编码（现为 `0.1.0`），与 `package.json` 的 `version` 需保持同步。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm install` | 安装依赖（postinstall 执行 `wxt prepare`） |
| `pnpm dev` | WXT 开发模式，启动开发服务器并打开浏览器 |
| `pnpm compile` | 类型检查（`vue-tsc --noEmit`） |
| `pnpm build` | 生产构建，输出到 `.output/chrome-mv3` |
| `pnpm check` | `compile` + `build`，提交前至少执行一次 |
| `pnpm zip` | 构建并生成 `.output/nas-xunlei-helper-<version>-chrome.zip` |
| `pnpm deploy` | 构建并部署到 Chrome 调试实例（端口 9223） |
| `pnpm deploy:cent` | 构建并部署到 Cent Browser 调试实例（端口 9224） |
| `node scripts/deploy.mjs --browser=edge` | 构建并部署到 Edge 调试实例（端口 9225） |

## 部署步骤

### 部署目标与端口

| 目标 | 命令 | CDP 端口 | 独立 profile |
| --- | --- | --- | --- |
| Google Chrome | `pnpm deploy` | 9223 | `.debug-profile` |
| Cent Browser | `pnpm deploy:cent` | 9224 | `.debug-profile-cent` |
| Microsoft Edge | `node scripts/deploy.mjs --browser=edge` | 9225 | `.debug-profile-edge` |

各目标的端口与 profile 相互独立，可同时存在。profile 目录均已被 git 忽略。

### 一键部署流程

1. 首次执行 `pnpm install`。
2. 执行 `pnpm check` 确认类型检查与构建通过。
3. 执行对应目标的部署命令。脚本内部会重新执行 `pnpm build`，不需要提前构建。
4. **仅首次部署需要手动挂载**：调试浏览器会打开 `chrome://extensions/`；若列表中没有「NAS 迅雷助手」，开启「开发者模式」→「加载已解压的扩展程序」→ 选择项目下的 `.output/chrome-mv3` 绝对路径。之后同一 profile 的部署全自动。
5. 在扩展设置页配置 NAS 迅雷地址，并在调试实例中打开迅雷页面登录一次。
6. 验收：部署日志出现 `已重载扩展「NAS 迅雷助手」v...`（或回退重启日志）与 `部署完成 ✅`，且 `chrome://extensions` 中确认扩展已挂载；再按 README 的「手动测试清单」做真实 NAS 端到端验证。

### `scripts/deploy.mjs` 的行为

1. 运行 `pnpm build`，并要求 `.output/chrome-mv3/manifest.json` 存在。
2. 探测 `http://127.0.0.1:<port>/json/version`：
   - 已有调试实例则复用；
   - 否则用 `--user-data-dir=<项目内 profile>`、`--remote-debugging-port=<port>`、`--load-extension=<输出目录>` 启动独立调试浏览器，并最多等待 30 秒。
3. 在 `chrome://extensions` 页面执行 `chrome.developerPrivate.reload()` 重载扩展；按扩展路径包含 `chrome-mv3` 或名称包含 `nas 迅雷` 匹配目标，最多重试 10 次等待页面 API 就绪。
4. 找不到扩展或重载失败时回退：通过 CDP `Browser.close` 关闭调试实例 → 删除 profile 下 `Default/Service Worker/ScriptCache` → 带 `--load-extension` 重启。该回退只在浏览器仍支持 `--load-extension` 时等效于完成部署；Chrome 137+ 正式版会忽略该参数，重启后依然需要手动加载，且脚本此时仍可能输出 `部署完成 ✅`，务必到 `chrome://extensions` 确认扩展已挂载。

任何失败都会以非零退出码结束，并输出 `[deploy] ...` 日志。

### 浏览器限制与首次挂载

- **Chrome 137+ 正式版忽略 `--load-extension`**：首次必须手动加载已解压扩展，后续才能靠 reload 自动部署。
- 若项目根目录存在 Chrome for Testing（`chrome/win64-<version>/chrome-win64/chrome.exe`），Chrome 目标会优先使用它；该目录被 git 忽略，随项目保留即可，不要提交。
- Cent Browser 需要 **5.x 及以上**（已适配 5.2.1168.83 / Chromium 132）。Cent 5.x 没有 Chrome 137+ 的限制，首次通常可自动挂载；4.x（Chromium 80）不支持 MV3。
- 脚本内置了本机 Cent 便携路径 `D:\Software\CentBrowser\Application\chrome.exe`；其它机器用 `XUNLEI_DEBUG_BROWSER` 指定，不要为此改脚本里的机器专属路径。
- 调试实例使用独立 profile，与日常浏览器互不影响；但脚本会关闭/重启目标端口上的实例（包括复用的已有调试实例），若该端口被其它程序占用，请改用 `XUNLEI_DEBUG_PORT`。

### 环境变量

- `XUNLEI_DEBUG_PORT`：覆盖调试端口。例如 `XUNLEI_DEBUG_PORT=9333 pnpm deploy`。
- `XUNLEI_DEBUG_BROWSER`：指定浏览器可执行文件路径，跳过自动探测。

### 部署排障

- **未找到浏览器**：设置 `XUNLEI_DEBUG_BROWSER` 指向主程序。
- **端口等待超时**：检查 `http://127.0.0.1:<port>/json/version`；关闭遗留调试实例或换端口。
- **扩展列表里没有本插件**：按上文手动加载一次；Chrome 137+ 尤其常见。回退重启日志出现 `部署完成 ✅` 不代表扩展一定已挂载，需以 `chrome://extensions` 为准。
- **部署成功但行为未更新**：Chromium 会缓存 unpacked 扩展 Service Worker 的脚本字节码。完全退出调试浏览器后删除对应 profile 的 `Default/Service Worker/ScriptCache`，再重新部署。脚本只会在回退重启路径自动清理，正常 reload 不会。
- **修改了扩展显示名**：同步更新 `scripts/deploy.mjs` 顶部的 `EXT_NAME_HINT`，否则名称匹配可能失效（路径匹配通常仍可命中）。

### 部署边界

- 本仓库**没有 NAS 侧部署步骤**：不要上传文件到 NAS、不要假设有服务端接口或安装脚本。
- 不要在 CI、无图形环境或与当前任务无关时运行 `pnpm deploy`：它会打开本地浏览器并可能重启调试实例。
- 发布分发包用 `pnpm zip`；解压后按 README「方式二」加载。版本号目前同时写在 `package.json` 和 `wxt.config.ts` 的 `manifest.version`，发版时两处同步修改。

## 代码地图

| 路径 | 职责 |
| --- | --- |
| `entrypoints/background.ts` | 右键菜单注册、popup 消息处理、设置校验、查找/打开迅雷标签页、调用发送流程、桌面通知 |
| `utils/settings.ts` | 设置的默认值、校验、`chrome.storage.local` 单 key 读写、跨上下文监听 |
| `utils/xunleiAutomation.ts` | 迅雷页面选择器、步骤注入、解析/立即下载、默认路径 best-effort 检测 |
| `entrypoints/options/` | 控制面板（Ant Design Vue 表单，独立标签页） |
| `entrypoints/popup/` | 工具栏弹窗：多行链接批量发送、打开设置/迅雷页 |
| `scripts/deploy.mjs` | 本地构建与调试浏览器部署 |
| `wxt.config.ts` | manifest：权限、host 权限、options 页、图标、版本 |
| `public/icons/` | 16/48 像素扩展图标 |

发送链路：`popup` 或右键菜单 → `background.sendLinksToNas()` → `ensureSettingsLoaded()` 与地址校验 → `openXunleiTab()`（复用标签页时激活、reload、等待加载完成）→ `runSendFlow()` 逐步注入：

1. `create-task`：点击 `.create__task`
2. `fill-links`：写入 `.el-textarea__inner` 并点击 `.task-parse-btn`
3. `confirm` 模式：`wait-dialog` 等待 `.result-nas-task-dialog` 与「立即下载」按钮出现后停止
4. `immediate` 模式：`confirm-download` 做同样的等待后点击「立即下载」按钮

每步单独注入，超时为 10 秒（`STEP_TIMEOUT_MS`）。

## 关键实现约束

- **注入函数必须自包含**：`injectedRunStep` 会被序列化进页面执行，不能引用模块顶层变量，只能使用参数和自身内部定义。修改时尤其注意。
- **选择器集中管理**：所有迅雷 DOM 选择器放在 `XUNLEI_SELECTORS`（`utils/xunleiAutomation.ts`）。页面结构变化时只改这里，不要散落到别处。
- **默认路径只做只读检测**：`detectPath()` 不点击任何未知 DOM；没有稳定选择器前不要加自动选择目录的逻辑，失败时回退 NAS 默认目录并如实提示。
- **设置读取顺序**：`getSettings()` 是同步内存读取；使用前先 `await ensureSettingsLoaded()`。保存用 `saveSettings()`，其它上下文通过 `watchSettingsStorage()` 感知变更。存储 key 为 `nas_xunlei_settings`，位于 `storage.local`（不要改成 sync）。
- **右键菜单注册时机**：只在 `onInstalled` 中 `removeAll` 后重建；Service Worker 冷启动不会再触发 `onInstalled`，菜单本身由浏览器持久化，不要每次启动重复创建。
- **WXT 约定**：`defineBackground` 等 API 由 WXT 自动导入，不要手动 import；`@/` 指向项目根目录（如 `@/utils/settings`）。
- **manifest 权限**：当前为 `storage, contextMenus, tabs, scripting, notifications`；`host_permissions` 放行全部 http/https 是因为 NAS 地址由用户动态配置。新增权限需同步更新 README 并说明用途。
- **UI 约定**：界面与通知文案使用中文；Vue SFC 使用 `<script setup lang="ts">` 与 scoped 样式；组件使用 Ant Design Vue。
- **不要提交生成物**：`node_modules`、`.output`、`.wxt`、`.debug-profile*`、`chrome/`、`.zcode/` 与 `.env*` 均被忽略；不要为了让某个改动提交而修改 `.gitignore` 放行这些目录。
- **不要绕过产品路线**：发送链路是 DOM 自动化，未经明确要求不要改成直接调用 NAS HTTP 接口，也不要引入账号密码存储。

## 验证要求

- 完成代码修改后至少运行 `pnpm check`（类型检查 + 生产构建）。
- 仓库目前没有单元测试或 lint 脚本，不要声称运行了不存在的测试。
- 端到端功能依赖真实 NAS 与已登录的迅雷 Web 会话：优先在 `pnpm deploy` 打开的调试实例中验证；无法验证时必须在交付说明中明确写出「未做真实 NAS 端到端验证」，并列出待测项。
- 构建出现 chunk 超过 500 kB 的警告属当前预期（Ant Design Vue 全量引入），不是失败。

## 文档同步

- 修改命令、端口、环境变量、权限、部署脚本行为或浏览器兼容要求时，同步更新 **README.md** 与 **AGENTS.md**，并检查 `scripts/deploy.mjs` 顶部注释是否仍然准确。
- README 面向使用者（安装、使用、测试清单、限制）；AGENTS.md 面向编码代理（约定、代码地图、部署细节、验证要求）。
