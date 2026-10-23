# AGENTS.md

本文件面向在本仓库工作的 AI 编码代理。面向用户的安装与使用说明见 [README.md](README.md)。

## 项目概览

- Manifest V3 浏览器扩展：把下载链接发送到 NAS 迅雷（群晖套件版 `pan-xunlei-com`），**没有 NAS 端组件，也没有后端服务**。
- 技术栈：WXT 0.21 + Vue 3 + TypeScript + Ant Design Vue 4 + pnpm。
- Node.js **>= 22**（WXT 0.21 要求，部署脚本也依赖全局 `fetch` / `WebSocket`），必须使用 pnpm（仓库有 `pnpm-lock.yaml`，勿改用 npm/yarn）。
- 发送原理：复用浏览器已登录的迅雷 Web 会话，用 `chrome.scripting.executeScript` 注入脚本，按 DOM 选择器模拟「新建任务 → 填链接 → 解析 → 立即下载」。保存路径通过读取页面 Vuex 并调用面板自身的目录 action 预选；发送前有页面探针与错误分类，发送后可选择监控下载任务状态。任务监控只读复用页面 Vuex 与面板自身的 `drive/getTask`，不自行拼接建任务请求，不存储账号密码。
- 通知体系使用固定通知 ID 与 `storage.session` 保存的按钮动作，区分发送失败、路径回退、任务失败与任务完成；发送成功通知和任务完成通知默认关闭，发送失败与任务失败默认开启。
- 番号匹配：磁力/种子解析后从 BT 文件树中按番号自动勾选目标文件；默认严格模式，任一任务未匹配整单暂停，可切换回退；支持类型/大小/关键词/排序/每任务上限。配置页独立 tab，含只读规则预览（粘贴文件名、本地文件夹、当前迅雷弹窗），不上传文件。
- 当前为原型重写版。`manifest.version` 在 `wxt.config.ts` 中硬编码（现为 `0.2.0`），与 `package.json` 的 `version` 需保持同步。

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
| `entrypoints/background.ts` | 右键菜单、消息路由、发送编排、并发锁、预检、通知动作、任务监控 alarm、只读文件树诊断 |
| `utils/settings.ts` | 设置默认值、校验、`chrome.storage.local` 单 key 读写、跨上下文监听；含通知/监控/刷新开关与 `avMatch` |
| `utils/avMatch.ts` | 番号识别/归一化、文件类型分类、自动/手动匹配、排序上限、`MatchPlan/MatchSummary`、配置归一化 |
| `utils/links.ts` | 链接提取、去重、协议校验（http(s)/magnet/thunder/ed2k） |
| `utils/sendErrors.ts` | 错误码、用户提示、通知主动作、重试资格、注入异常分类 |
| `utils/messaging.ts` | popup/options/background 共享的消息与响应类型 |
| `utils/xunleiTab.ts` | 迅雷标签页查找、打开/复用、聚焦、加载等待（5 秒轮询保活） |
| `utils/xunleiAutomation.ts` | 迅雷页面选择器、步骤注入、错误/登录识别、路径解析、目录列表、任务读取、BT 文件树只读/应用 |
| `utils/history.ts` | 发送记录、监控摘要回写、中断标记、清空与监听 |
| `utils/notifications.ts` | 固定通知 ID、按钮动作、发送/任务通知策略 |
| `utils/taskMonitor.ts` | 任务监控 session、1 分钟 alarm、状态比对、合并通知 |
| `entrypoints/options/` | 控制面板：设置、番号匹配、测试连接、目录树、发送记录、引导 |
| `entrypoints/options/components/` | `AvMatchPanel.vue` 配置表单、`AvMatchPreview.vue` 只读规则预览 |
| `entrypoints/popup/` | 工具栏弹窗：链接解析/去重、短错误动作、打开设置/迅雷 |
| `scripts/deploy.mjs` | 本地构建与调试浏览器部署 |
| `wxt.config.ts` | manifest：权限（含 `alarms`）、host 权限、options 页、图标、版本 |
| `public/icons/` | 16/48/128 像素扩展图标 |

发送链路：`popup` 或右键菜单 → `background.sendLinksToNas()`（模块级 `activeSend` 并发锁）→ 解析/校验链接与设置 → 写 running 历史 → `openXunleiTab()`（复用标签页时激活、必要时 reload、等待加载）→ `inspectXunleiPage()` / `classifyProbe()` 预检 → `readTaskState()` 记录任务 id 基线 → `runSendFlow()` 逐步注入：

1. `create-task`：点击 `.create__task`
2. `fill-links`：写入 `.el-textarea__inner` 并点击 `.task-parse-btn`；点击后短查错误 toast
3. `confirm-download` / `wait-dialog`：等待 `.result-nas-task-dialog` 与其中的「立即下载」按钮就绪；
   读取页面主世界的 Vuex，按配置路径解析目录并预选保存位置；等待期间同时检测登录失效/解析失败
4. `immediate` 模式随后点击「立即下载」并读取当前任务 id；`confirm` 模式停在此处，由用户手动确认

开启番号匹配时，`runSendFlow` 在 `wait-dialog` 后插入只读 `read-file-list`（拍平 BT 文件树）→ 后台用 `utils/avMatch.ts` 计算计划 → `apply-file-selection`（调用面板树组件 `setCheckedKeys`）应用勾选；立即模式最后点击「立即下载」（`skipPath=1`，避免重复改 Vuex 路径）。严格模式任一任务未匹配/文件树异常时不点击并返回 `paused`；回退模式保留未匹配任务原勾选继续。非 BT 直链跳过匹配。

最后更新历史 → 发送通知 → 按需 `startMonitor()`。每步单独注入，超时为 10 秒（`STEP_TIMEOUT_MS`）。

### 错误码与通知

错误码定义在 `utils/sendErrors.ts`：`no-links`、`settings-missing`、`settings-invalid`、`tab-open-failed`、`tab-load-timeout`、`tab-closed`、`nas-unreachable`、`login-required`、`page-mismatch`、`panel-not-ready`、`dialog-open`、`parse-failed`、`parse-timeout`、`download-click-failed`、`injection-failed`、`av-unmatched`、`av-file-list-timeout`、`av-selection-failed`、`busy`、`unknown`。每个错误码带提示、主动作（打开设置/打开迅雷）、是否可重试、是否通知。

`av-unmatched`/`av-file-list-timeout` 是**暂停**语义（`SendOutcome.paused=true`，`ok` 仍为 true）：不点击下载、保留弹窗、历史 `paused`、通知「已暂停」，默认不启动任务监控；`av-selection-failed` 是技术失败（`ok:false`），表示勾选未能安全应用，绝不继续点击。

固定通知 ID：`nas-xunlei-send-result`、`nas-xunlei-task-failure`、`nas-xunlei-task-complete`、`nas-xunlei-info`。发送失败/路径回退/任务失败使用 `requireInteraction`；发送成功/任务完成不常驻。通知按钮最多两个，动作映射写入 `storage.session` 的 `nas_xunlei_notification_actions`，Service Worker 重启后仍可用。

### 存储键

- `nas_xunlei_settings`：设置（含 `avMatch` 嵌套配置），`storage.local`
- `nas_xunlei_history`：发送记录，`storage.local`，上限 50；状态含 `paused`，可带 `match` 摘要（仅计数/最多 3 个番号或任务名，不存完整文件列表）
- `nas_xunlei_monitor`：活跃监控 session，`storage.local`，上限 5 个 session、每个最多 200 个任务
- `nas_xunlei_last_send`：最近发送的链接，`storage.session`，30 分钟过期，用于通知重试
- `nas_xunlei_notification_actions`：通知按钮动作，`storage.session`

### 任务监控

发送前读取 `drive.all/tasks/tasksDone` 得到任务 id 基线；立即下载时 `confirm-download` 还会返回点击后的当前任务 id，background 用「当前 id - 基线」得到候选。`utils/taskMonitor.ts` 用 1 分钟 alarm 扫描：发现期（立即下载 2 分钟、确认后下载 30 分钟）把新任务纳入，跟踪期对非终态任务复用 `drive/getTask`（每次最多 3 个），读取 `PHASE_TYPE_*` 状态。`PHASE_TYPE_ERROR` 记失败、`PHASE_TYPE_COMPLETE` 记完成，`PAUSED` 不通知。每轮扫描最多一条失败和一条完成通知，名称最多列 3 个；同一任务按 id 去重。全部终态、无任务、页面关闭、连续读取失败、用户关闭监控或 24 小时硬超时后停止，并把摘要/原因写回发送记录。页面关闭不自动重开。

## 关键实现约束

- **注入函数必须自包含**：`injectedRunStep`、`injectedProbe`、`injectedReadTasks`、`injectedReadFileList`、`injectedApplyFileSelection` 都会被序列化进页面执行，不能引用模块顶层变量，只能使用参数和自身内部定义。修改时尤其注意。
- **MAIN world 边界**：`confirm-download` / `wait-dialog` / `check-path` / `list-dir` 需要读取页面主世界的 Vuex（`__vue_app__`），必须以 `world: 'MAIN'` 注入；探针、任务读取、文件树读取/应用同样是独立 MAIN 注入；其余纯 DOM 步骤保持 `ISOLATED`。
- **番号匹配读写分离**：`injectedReadFileList` 只读拍平 BT 文件树并返回快照；`injectedApplyFileSelection` 只调用面板树组件 `setCheckedKeys` 并校验父组件 ID 集合/按钮状态；所有番号识别、类型分类、排序上限必须在 `utils/avMatch.ts` 纯函数中，不要塞进注入函数。树 hash 不一致/文件消失时两种模式都暂停；读取失败或组件能力缺失时严格暂停、回退按原勾选继续；父状态未同步或按钮禁用时两种模式都不点击。
- **番号匹配产品边界**：只对 BT 文件树生效，直链跳过；严格模式下单个弹窗多任务任一未匹配就整单暂停（迅雷只有一个「立即下载」按钮）；排序只决定保留集合，不重排界面；`maxFilesPerTask` 可能漏分集，默认 0。
- **根名番号只在零命中时兜底**：根/任务名带番号时，只有所有文件都未命中该番号才把无番号文件按根名继承（文件夹包场景）；一旦有文件命中，其余无番号文件一律 `code-mismatch` 排除，避免把广告/说明视频继承进来。手动番号同理。
- **组件能力探测**：文件树/对话框通过 DOM 的 `__vueParentComponent` 向上按 `setCheckedKeys/getCheckedKeys/treeData/handelBtSelectChange` 能力识别，不依赖组件显示名；迅雷升级后能力缺失时严格暂停/回退继续，绝不瞎点。`confirm-download` 点击前必须检查按钮 `disabled`/`is-disabled`。
- **番号匹配隐私**：手动番号/关键词仅 `storage.local`；历史只存计数和最多 3 个番号/任务名；预览本地文件夹只读文件名/大小，不上传；不引入模型或外部服务。
- **选择器集中管理**：所有迅雷 DOM 选择器放在 `XUNLEI_SELECTORS`（`utils/xunleiAutomation.ts`）。页面结构变化时只改这里，不要散落到别处。结果对话框与「添加链接」对话框都有 `.task-parse-btn`，查找按钮时必须限定在结果对话框内；错误 toast 只在 `.el-message--error` / `.el-notification--error` 和结果框内 class 含 error/fail 的节点中匹配保守短语，避免文件名误报。
- **保存路径解析**：`resolveDownloadPath(path, commit)` 通过 Vuex 的 `drive.treeNodeId/treeNodePath` 解析目录，复用面板自身 action `drive/getFolderList`、`drive/loadFolders`，只对已存在且可写目录生效。`commit=false` 只读检查，不修改面板；`commit=true` 才写入并校验。找不到目录时清空选择并回退迅雷当前目录，通知必须如实说明原因。不要自动创建目录，也不要自行拼接建任务请求。
- **任务监控只读**：只读取 `drive.all/tasks/tasksDone` 并按需复用 `drive/getTask`；不调用 `fetchTasks` 改写列表，不自行请求 NAS HTTP API；页面关闭不自动重开，停止原因写回发送记录。监控失败不能影响发送结果或 popup 响应。
- **点击步骤不自动重试**：新建任务、填链接、点击立即下载都有副作用，自动重试可能重复开弹窗或重复建任务；失败由用户通过通知/记录里的「重试」整链重跑。
- **设置读取顺序**：`getSettings()` 是同步内存读取；使用前先 `await ensureSettingsLoaded()`。保存用 `saveSettings()`，其它上下文通过 `watchSettingsStorage()` 感知变更。存储 key 为 `nas_xunlei_settings`，位于 `storage.local`（不要改成 sync）；通知/监控/刷新开关都在同一 key 内。
- **右键菜单注册时机**：只在 `onInstalled` 中 `removeAll` 后重建；Service Worker 冷启动不会再触发 `onInstalled`，菜单本身由浏览器持久化，不要每次启动重复创建。菜单 contexts 为 `link/selection/video/audio`，点击时从 `linkUrl`、`srcUrl` 或 `selectionText` 提取链接。
- **标签页复用**：`findXunleiTab` 去掉 hash 后匹配，优先当前激活页；`openXunleiTab` 复用时会先确保 URL 指向配置地址（含 hash），需要时再 reload；`waitTabComplete` 每 5 秒 `chrome.tabs.get` 轮询，兼顾关闭检测与 Service Worker 保活。
- **通知动作**：固定 ID 见 `utils/notifications.ts`；按钮动作存入 `storage.session`，Service Worker 重启后仍可点击。重试只读取 30 分钟内保存的 `nas_xunlei_last_send`，过期时提示重新发送，不要自动构造请求。
- **WXT 约定**：`defineBackground` 等 API 由 WXT 自动导入，不要手动 import；`@/` 指向项目根目录（如 `@/utils/settings`）。
- **manifest 权限**：当前为 `storage, contextMenus, tabs, scripting, notifications, alarms`；`host_permissions` 放行全部 http/https 是因为 NAS 地址由用户动态配置。`alarms` 用于任务监控的每分钟检查，新增权限需同步更新 README 并说明用途。
- **UI 约定**：界面与通知文案使用中文；Vue SFC 使用 `<script setup lang="ts">` 与 scoped 样式；组件使用 Ant Design Vue。
- **不要提交生成物**：`node_modules`、`.output`、`.wxt`、`.debug-profile*`、`chrome/`、`.zcode/` 与 `.env*` 均被忽略；不要为了让某个改动提交而修改 `.gitignore` 放行这些目录。
- **不要绕过产品路线**：发送链路仍是 DOM 自动化 + 面板自身的建任务流程；路径预选、任务监控、文件勾选都复用面板 Vuex/action/树组件，不自行拼接建任务或任务查询 HTTP 请求，也不要引入账号密码存储。

## 验证要求

- 完成代码修改后至少运行 `pnpm check`（类型检查 + 生产构建）。
- 仓库目前没有单元测试或 lint 脚本，不要声称运行了不存在的测试。
- 端到端功能依赖真实 NAS 与已登录的迅雷 Web 会话：优先在 `pnpm deploy` 打开的调试实例中验证；无法验证时必须在交付说明中明确写出「未做真实 NAS 端到端验证」，并列出待测项。
- 无副作用的验证：设置页「测试连接」、目录树读取、通知开关持久化、发送记录加载/清空。这些不需要创建真实下载任务。
- 番号匹配离线验证：设置页「规则测试」粘贴样例，或选择本地文件夹（如 `Z:\xfmovie`）只读文件名/大小；不读取文件内容、不上传。可用真实文件名核对标准码/FC2/Tokyo Hot/分集/站点前缀/编码器噪声。
- 番号匹配只读 NAS 验证：解析一个磁力后打开设置页「读取当前迅雷弹窗」，确认能读到任务/文件/大小/路径/勾选状态与按钮状态，且不创建任务；无弹窗时有友好提示。这是进入应用勾选前的风险门槛。
- 需要真实任务的验证（先取得用户对测试链接的批准）：立即/确认两种模式、路径回退、解析失败、任务失败/完成监控、批量合并通知、监控中关闭迅雷页、通知按钮在 Service Worker 停止后仍可用、并发发送互斥、不刷新模式残留弹窗拦截、首次安装引导；以及番号匹配的全匹配/严格未匹配/回退/类型/大小/关键词/上限排序/多任务部分未匹配/非 BT 直链。
- 任务监控只在迅雷页打开时有效；测试时保持页面打开，并可用临时缩短硬超时/发现窗常量来验证停止路径（验证后恢复 24 小时/2 分钟/30 分钟）。
- 构建出现 chunk 超过 500 kB 的警告属当前预期（Ant Design Vue 全量引入），不是失败。

## 文档同步

- 修改命令、端口、环境变量、权限、部署脚本行为或浏览器兼容要求时，同步更新 **README.md** 与 **AGENTS.md**，并检查 `scripts/deploy.mjs` 顶部注释是否仍然准确。
- README 面向使用者（安装、使用、测试清单、限制）；AGENTS.md 面向编码代理（约定、代码地图、部署细节、验证要求）。
