# AGENTS.md

本文件面向在本仓库工作的 AI 编码代理。面向用户的安装与使用说明见 [README.md](README.md)。

## 项目概览

- Manifest V3 浏览器扩展：把下载链接发送到 NAS 迅雷（[cnk3x/xunlei](https://github.com/cnk3x/xunlei) 提供的群晖套件版 `pan-xunlei-com`），**没有 NAS 端组件，也没有后端服务**。
- 技术栈：WXT 0.21 + Vue 3 + TypeScript + Ant Design Vue 4 + pnpm。
- Node.js **>= 22**（WXT 0.21 要求，部署脚本也依赖全局 `fetch` / `WebSocket`），必须使用 pnpm（仓库有 `pnpm-lock.yaml`，勿改用 npm/yarn）。
- 发送原理：有两条可选链路，由设置项 `sendMode` 切换。**页面自动化（`dom`，默认）**复用浏览器已登录的迅雷 Web 会话，用 `chrome.scripting.executeScript` 注入脚本，按 DOM 选择器模拟「新建任务 → 填链接 → 解析 → 立即下载」，保存路径通过读取页面 Vuex 并调用面板自身的目录 action 预选。**接口直连（`api`）**不打开页面，由 `utils/xunleiApi.ts` 调用套件自身的 `drive/v1` gRPC-gateway 接口（解析 → 番号匹配 → 建任务），鉴权用套件首页下发的短期令牌，不存储账号密码。接口模式的「确认后下载」由扩展自绘确认窗口完成（见「接口模式的确认窗口」），不是迅雷弹窗。**下载模式默认「确认后下载」**：页面自动化停在迅雷确认框，接口模式打开自绘确认窗口。发送前有页面探针与错误分类（仅 `dom`）；两种模式都可监控下载任务状态——`dom` 通道只读复用页面 Vuex 与面板自身的 `drive/getTask`，`api` 通道直接读 `drive/v1/tasks`，都不自行拼接任务查询请求。
- 番号匹配：磁力/种子解析后从 BT 文件树中按番号自动勾选目标文件；默认严格模式，可切换回退；支持类型/大小/关键词/排序/每任务上限。两种模式共用 `utils/avMatch.ts` 的纯函数决策，差别只在落地方式——`dom` 调面板树组件 `setCheckedKeys`，`api` 把选中序号编码成接口的 `sub_file_index`。`api` 模式下每个链接是独立任务，未匹配的只暂停自己，不会像 `dom` 那样受单个「立即下载」按钮连累整单。配置页独立 tab，含只读规则预览（粘贴文件名、本地文件夹、当前迅雷弹窗），不上传文件。
- 通知体系使用固定通知 ID 与 `storage.session` 保存的按钮动作，区分发送失败、路径回退、任务失败与任务完成；发送成功通知和任务完成通知默认关闭，发送失败与任务失败默认开启。
- 当前为原型重写版。`manifest.version` 在 `wxt.config.ts` 中硬编码（以该文件当前值为准，不要在别处内联版本号），与 `package.json` 的 `version` 需保持同步，递增与日志规则见「版本与更新日志」。

## 上游与许可

- 适配后端：[cnk3x/xunlei](https://github.com/cnk3x/xunlei)（群晖套件版 `pan-xunlei-com`），`drive/v1` 契约实测于 v3.23.5。
- 灵感来源：[Soraika/nas-thunder-helper](https://github.com/Soraika/nas-thunder-helper)；协议：[MIT License](LICENSE)。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm install` | 安装依赖（postinstall 执行 `wxt prepare`） |
| `pnpm dev` | WXT 开发模式，启动开发服务器并打开浏览器 |
| `pnpm compile` | 类型检查（`vue-tsc --noEmit`） |
| `pnpm build` | 生产构建，输出到 `.output/chrome-mv3` |
| `pnpm check` | `compile` + `build`，提交前至少执行一次 |
| `pnpm test` | vitest 单元测试（`tests/` 纯函数回归），提交前必须全绿 |
| `pnpm zip` | 构建并生成 `.output/nas-xunlei-helper-<version>-chrome.zip` |
| `pnpm deploy` | 构建并部署到 Chrome 调试实例（端口 9223） |
| `pnpm deploy:cent` | 构建并部署到 Cent Browser 调试实例（端口 9224） |
| `node scripts/deploy.mjs --browser=edge` | 构建并部署到 Edge 调试实例（端口 9225） |

## 版本与更新日志

- **三处同步**：`package.json` 的 `version`、`wxt.config.ts` 的 `manifest.version`、[CHANGELOG.md](CHANGELOG.md) 顶部条目必须在同一次改动中一起更新，版本号完全一致。`wxt.config.ts` 是 manifest 版本的唯一来源，不要在其他文件硬编码版本。
- **自动递增**：任何影响扩展行为的改动（`feat`、`fix`、有行为变化的 `refactor`）都要在同一次提交里递增版本并补更新日志，不需要用户额外提醒。纯文档、注释、格式化、锁文件更新不动版本。
- **递增规则（0.x 阶段）**：新功能 → 次版本 +1（如 `0.3.0` → `0.4.0`）；缺陷修复或小幅调整 → 补丁 +1（如 `0.3.0` → `0.3.1`）；破坏性变更或整体重写 → 次版本 +1 并在日志标注「破坏性变更」。1.0 之后按标准 SemVer（major/minor/patch）。
- **一个工作批次只递增一次**：同一批未发布的多个 commit 共用目标版本，以该批次最后一个提交定稿，不要每个 commit 各 bump 一次。
- **日志格式**：`## [x.y.z] - YYYY-MM-DD`，最新版本在最上方；分类使用 `新增 / 修复 / 调整 / 文档 / 验证`，只写用户可感知的变化，不堆内部实现细节。
- **提交前核对**：`pnpm check` 通过，并确认三处版本号一致、CHANGELOG 顶部条目与本次改动相符。
- 需要分发时执行 `pnpm zip`，产物名自动带版本号；不要自动创建 git tag，除非用户明确要求。

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
6. 验收：部署日志出现 `已重载扩展「NAS 迅雷助手」v...`（或回退重启日志）与 `部署完成 ✅`，且 `chrome://extensions` 中确认扩展已挂载；再按[开发文档的手动测试清单](docs/DEVELOPMENT.md#手动测试清单)做真实 NAS 端到端验证。

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
- 发布分发包用 `pnpm zip`；解压后按 [README 的安装说明](README.md#安装)加载。版本号同时写在 `package.json` 和 `wxt.config.ts` 的 `manifest.version`，并与 `CHANGELOG.md` 顶部条目保持一致，详见「版本与更新日志」。

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
| `utils/xunleiApi.ts` | 接口模式客户端：`uiauth` 令牌提取与缓存、`drive/v1` 调用、解析/拍平/`sub_file_index` 编码、目录与任务读写 |
| `utils/confirm.ts` | 接口模式确认窗口：待确认任务 `storage.session` 读写、文件树还原、勾选→`sub_file_index` 的纯函数 |
| `entrypoints/confirm/` | 自绘的确认下载窗口（Vue）：文件勾选/仅选中此项/扩展名筛选、任务名编辑、下载目录、提交与取消 |
| `utils/history.ts` | 发送记录、监控摘要回写、中断标记、清空与监听 |
| `utils/notifications.ts` | 固定通知 ID、按钮动作、发送/任务通知策略 |
| `utils/taskMonitor.ts` | 任务监控 session、1 分钟 alarm、状态比对、合并通知 |
| `utils/taskSort.ts` | popup 任务列表排序纯函数：按页签字段/方向偏好、菜单点击转移、存储读回归一化（含旧格式迁移）、标签、稳定排序 |
| `utils/popupFit.ts` | 弹窗被浏览器限高时把 `#app` 钉到视口高度，让列表压缩到可见空间内滚动（仅在文档真实溢出时写入样式） |
| `entrypoints/options/` | 控制面板：设置、番号匹配、测试连接、目录树、发送记录、引导 |
| `entrypoints/options/components/` | `AvMatchPanel.vue` 配置表单、`AvMatchPreview.vue` 只读规则预览 |
| `entrypoints/popup/` | 工具栏弹窗：`a-tabs` 双页外壳（下载任务 / 发送链接）、打开设置与迅雷 |
| `entrypoints/popup/components/` | `TasksPanel.vue` 任务列表与进度/速度轮询、暂停/继续/删除、两页签任务排序（`utils/taskSort.ts`，偏好存 `nas_xunlei_task_sort`）；`SendPanel.vue` 链接解析去重与发送结果动作 |
| `scripts/deploy.mjs` | 本地构建与调试浏览器部署 |
| `docs/DEVELOPMENT.md` | 面向开发者：工作原理、结构、构建命令、调试部署、开发排障、手动测试清单 |
| `wxt.config.ts` | manifest：权限（含 `alarms`）、host 权限、options 页、图标、版本 |
| `public/icons/` | 16/48/128 像素扩展图标 |

发送链路：`popup` 或右键菜单 → `background.sendLinksToNas()`（内存锁 + `storage.session` 持久锁与 5 分钟总超时，见上）→ 解析/校验链接与设置 → 写 running 历史 → **按 `sendMode` 分流**：`api` 走 `sendViaApi()`（解析→番号匹配→建任务，全程不碰页面，见「关键实现约束」；`downloadMode: 'confirm'` 时只准备待确认任务并打开确认窗口，不建任务）；`dom` 继续下面的注入链路 → `openXunleiTab()`（复用标签页时激活、必要时 reload、等待加载）→ `inspectXunleiPage()` / `classifyProbe()` 预检 → `readTaskState()` 记录任务 id 基线（立即模式同时用于重复资源只读查重）→ `runSendFlow()` 逐步注入：

1. `create-task`：点击 `.create__task`
2. `fill-links`：写入 `.el-textarea__inner` 并点击 `.task-parse-btn`；点击后短查错误 toast
3. `confirm-download` / `wait-dialog`：等待 `.result-nas-task-dialog` 与其中的「立即下载」按钮就绪；
   读取页面主世界的 Vuex，按配置路径解析目录并预选保存位置；等待期间同时检测登录失效/解析失败
4. `immediate` 模式随后点击「立即下载」并读取当前任务 id；`confirm` 模式停在此处，由用户手动确认

开启番号匹配时，`runSendFlow` 在 `wait-dialog` 后插入只读 `read-file-list`（拍平 BT 文件树）→ 后台用 `utils/avMatch.ts` 计算计划 → `apply-file-selection`（调用面板树组件 `setCheckedKeys`）应用勾选；立即模式最后点击「立即下载」（`skipPath=1`，避免重复改 Vuex 路径）。严格模式任一任务未匹配/文件树异常时不点击并返回 `paused`；回退模式保留未匹配任务原勾选继续。非 BT 直链跳过匹配。

最后更新历史 → 发送通知 → 按需 `startMonitor()`。每步单独注入，元素等待超时 10 秒（`STEP_TIMEOUT_MS`），磁力解析结果等待放宽到 45 秒（`PARSE_WAIT_TIMEOUT_MS`，DHT 拉元数据远慢于普通步骤）。整条发送链路有互斥：内存锁 + `storage.session` 的 `nas_xunlei_send_lock`（SW 重启后按时间戳判断孤儿），总超时 5 分钟后释放锁并返回超时结果。诊断入口（测试连接/读目录/读弹窗文件树）与发送共用该互斥。

### 错误码与通知

错误码定义在 `utils/sendErrors.ts`：`no-links`、`settings-missing`、`settings-invalid`、`tab-open-failed`、`tab-load-timeout`、`tab-closed`、`nas-unreachable`、`login-required`、`page-mismatch`、`panel-not-ready`、`dialog-open`、`parse-failed`、`parse-timeout`、`download-click-failed`、`injection-failed`、`av-unmatched`、`av-file-list-timeout`、`av-selection-failed`、`duplicate-task`、`busy`、`unknown`。每个错误码带提示、主动作（打开设置/打开迅雷）、是否可重试、是否通知。

`av-unmatched`/`av-file-list-timeout`/`duplicate-task` 是**暂停**语义（`SendOutcome.paused=true`，`ok` 仍为 true）：不点击下载、保留弹窗、历史 `paused`、通知「已暂停」（暂停通知不受「发送失败通知」开关控制）；DOM 暂停时没有可监控的新任务、接口模式部分暂停时已建任务照常进入监控；`av-selection-failed` 是技术失败（`ok:false`），表示勾选未能安全应用，绝不继续点击。`duplicate-task` 的 `paused.reason` 是 `'duplicate'`，popup 与设置页发送记录都给出「仍然发送」带 `force: true` 重发（不是走 `retryable`，避免误点重试就覆盖旧任务）。

固定通知 ID：`nas-xunlei-send-result`、`nas-xunlei-task-failure`、`nas-xunlei-task-complete`、`nas-xunlei-info`。发送失败/路径回退/任务失败使用 `requireInteraction`；发送成功/任务完成不常驻。通知按钮最多两个，动作映射写入 `storage.session` 的 `nas_xunlei_notification_actions`，Service Worker 重启后仍可用。

### 存储键

- `nas_xunlei_settings`：设置（含 `avMatch` 嵌套配置），`storage.local`
- `nas_xunlei_history`：发送记录，`storage.local`，上限 50；状态含 `paused`，可带 `match` 摘要（仅计数/最多 3 个番号或任务名，不存完整文件列表）
- `nas_xunlei_monitor`：活跃监控 session，`storage.local`，上限 5 个 session、每个最多 200 个任务
- `nas_xunlei_task_sort`：popup 任务列表排序偏好，按页签 `{ing: {field, dir}, done: {field, dir}}`，`storage.local`，读回归一化兼容旧单页签格式；读写失败均静默退化为默认排序；不进 `nas_xunlei_settings`（弹窗 UI 偏好，非功能配置）
- `nas_xunlei_last_send`：最近发送的链接，`storage.session`，30 分钟过期，用于通知重试
- `nas_xunlei_notification_actions`：通知按钮动作，`storage.session`
- `nas_xunlei_pan_auth`：接口模式的 `uiauth` JWT 缓存（含签发地址与 exp），`storage.session`，不落 local/sync
- `nas_xunlei_pending_confirm`：接口模式等待用户确认的任务（文件树/预选/目录，不含令牌），`storage.session`，30 分钟过期；成功提交、显式取消或关闭窗口后删除，**全部建任务失败时保留**（确认窗口内可「重试提交」），确认页按 `PENDING_TTL_MS` 自行显示剩余时间并过期禁提交
- `nas_xunlei_send_lock`：发送互斥锁 `{at}`，`storage.session`，超过总超时视为孤儿可被覆盖；诊断入口与发送共用

### 任务监控

发送前读取 `drive.all/tasks/tasksDone` 得到任务 id 基线；立即下载时 `confirm-download` 还会返回点击后的当前任务 id，background 用「当前 id - 基线」得到候选。`utils/taskMonitor.ts` 用 1 分钟 alarm 扫描，session 分两条通道：`channel: 'dom'` 复用迅雷页面——发现期（立即下载 2 分钟、确认后下载 30 分钟）把新任务纳入，跟踪期对非终态任务复用 `drive/getTask`（每次最多 3 个）；`channel: 'api'` 用于接口模式发送（建任务后即拿到精确 id），扫描直接调 `drive/v1/tasks` 按 id 批量读取，不要求打开迅雷页面，令牌/接口连续失败按 `api-unavailable` 停止。两条通道都读 `PHASE_TYPE_*` 状态：`PHASE_TYPE_ERROR` 记失败、`PHASE_TYPE_COMPLETE` 记完成，`PAUSED` 不通知。每轮扫描最多一条失败和一条完成通知，名称最多列 3 个；同一任务按 id 去重。全部终态、无任务、页面关闭（仅 dom 通道）、连续读取失败、用户关闭监控或 24 小时硬超时后停止，并把摘要/原因写回发送记录。页面关闭不自动重开。

## 关键实现约束

- **注入函数必须自包含**：`injectedRunStep`、`injectedProbe`、`injectedReadTasks`、`injectedReadFileList`、`injectedApplyFileSelection` 都会被序列化进页面执行，不能引用模块顶层变量，只能使用参数和自身内部定义。修改时尤其注意。
- **MAIN world 边界**：`confirm-download` / `wait-dialog` / `check-path` / `list-dir` 需要读取页面主世界的 Vuex（`__vue_app__`），必须以 `world: 'MAIN'` 注入；探针、任务读取、文件树读取/应用同样是独立 MAIN 注入；其余纯 DOM 步骤保持 `ISOLATED`。
- **番号匹配读写分离**：`injectedReadFileList` 只读拍平 BT 文件树并返回快照；`injectedApplyFileSelection` 只调用面板树组件 `setCheckedKeys` 并校验父组件 ID 集合/按钮状态；所有番号识别、类型分类、排序上限必须在 `utils/avMatch.ts` 纯函数中，不要塞进注入函数。树 hash 不一致/文件消失时两种模式都暂停；读取失败或组件能力缺失时严格暂停、回退按原勾选继续；父状态未同步或按钮禁用时两种模式都不点击。
- **番号匹配产品边界**：只对 BT 文件树生效，直链跳过；严格模式下单个弹窗多任务任一未匹配就整单暂停（迅雷只有一个「立即下载」按钮）；排序只决定保留集合，不重排界面；`maxFilesPerTask` 可能漏分集，默认 0。
- **根名番号只在零命中时兜底**：根/任务名带番号时，只有所有文件都未命中该番号才把无番号文件按根名继承（文件夹包场景）；一旦有文件命中，其余无番号文件一律 `code-mismatch` 排除，避免把广告/说明视频继承进来。手动番号同理。
- **组件能力探测**：迅雷生产构建未开启 `__FEATURE_PROD_DEVTOOLS__`，DOM 上没有 `__vueParentComponent`（`#app.__vue_app__._instance` 也可能为 null），因此注入脚本必须从 `#app._vnode.component` 向下遍历 vnode/组件树，按 `setCheckedKeys/getCheckedKeys/treeData/flatNodeList/checkedSource/handelBtSelectChange` 能力识别文件树与父组件，不依赖组件显示名；仅开发构建才回退到 DOM 的 `__vueParentComponent` 上溯。迅雷升级后能力缺失时严格暂停/回退继续，绝不瞎点。`confirm-download` 点击前必须检查按钮 `disabled`/`is-disabled`。
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
- **UI 约定**：界面与通知文案使用中文；Vue SFC 使用 `<script setup lang="ts">` 与 scoped 样式；组件使用 Ant Design Vue。设置页（含番号匹配 tab）修改后自动保存（防抖 + `pagehide` 冲刷，`avMatch` 由各自 tab 独立写），不要再加保存按钮。
- **不要提交生成物**：`node_modules`、`.output`、`.wxt`、`.debug-profile*`、`chrome/`、`.zcode/` 与 `.env*` 均被忽略；不要为了让某个改动提交而修改 `.gitignore` 放行这些目录。
- **不要绕过产品路线**：页面自动化模式仍然只用 DOM 自动化 + 面板自身的建任务流程，路径预选/任务监控/文件勾选复用面板 Vuex 与 action，不自行拼接请求。接口模式是**有意为之的第二条链路**，只调用官方套件 `drive/v1` 接口（见下条），两种模式都不引入账号密码存储。
- **接口模式（`sendMode: 'api'`）边界**：契约来自官方 SPK 内 `xunlei-pan-cli` 的 grpc-gateway，实测于套件 v3.23.5，全部集中在 `utils/xunleiApi.ts`——上层不得自行拼 URL 或发裸 `fetch`。要点：鉴权用套件首页内嵌 `uiauth` JWT（约 3 天有效），以 `pan-auth` 头 + `pan_auth` 查询参数双通道下发，**不依赖 cookie**，因此可在 Service Worker 直连、无需标签页；服务端不接受 PATCH/DELETE，客户端自动隧道成 `POST method/patch/…`、`POST method/delete/…`；接口路径不能以 `/` 开头。写操作只允许 `createTask` / `operateTask` / `renameTask` / `deleteTasks` 四个显式方法。**`operateTask` 的 `set_params.spec` 内 phase 必须用套件前端的短形式 `pause` / `running`**（连文件删除是 `delete`，刻意不提供）——传 `PHASE_TYPE_*` 完整枚举值服务端不识别，返回 2xx 但静默忽略（2026-10-31 用户实测：点「继续」状态无变化），已在 `tests/xunleiApi.test.ts` 用请求体断言锁死。迅雷升级导致首页取不到令牌时抛 `token-missing`，必须提示切回页面自动化模式，不要猜测新契约。**`DELETE drive/v1/files/{id}` 是永久删除 NAS 上的真实文件/目录**（套件确认框原文「将同时删除本地文件」，不是移到回收站），因此**刻意不纳入客户端写白名单**；插件没有任何删除用户文件的理由，需要清理请交给用户在迅雷界面或文件管理器里做。**目录 Id 已线上确认同一套**：从 `drive/v1/files` 根节点逐级下钻拿到的 Id，与真实任务 `params.parent_folder_id`、以及 `device/download_paths` 的 `Id` 一致，所以 `resolveFolderIdByPath` 可以直接喂给 `createTask`；路径不存在时它返回**最深匹配层**的 Id 仅作诊断用，`sendViaApi` 在 `missing` 非空时一律回退迅雷默认目录（`parent_folder_id` 传空），绝不猜建目录。
- **接口模式的番号匹配**：`utils/xunleiApi.ts` 的 `parseResources` 解析 BT 文件树 → `flattenResourceFiles` 拍平（**根节点是任务名，绝不拼进文件 path**，否则根名里的番号会让所有文件恒命中，与 `injectedReadFileList` 同一护栏）→ 复用 `utils/avMatch.ts` 的 `buildMatchPlan` 纯函数决策 → `selectSubFiles` 把 `selectedIds` 映射回文件序号并用 `encodeSubFileIndex` 编码成迅雷的 `sub_file_index`（连续段折叠为 `"a-b"`，与套件前端 `convertSubFileIndexToString` 一致）。`file_index` 服务端会省略 0，需回退到 `id` 末段推导。任务 `file_size` 传**选中文件之和**、`total_file_count` 传根节点 `file_count`。严格模式下未命中的链接单独跳过不建任务（不像 DOM 模式受单个「立即下载」按钮连累整单），回退模式整包下发；**编码结果为空一律按未命中处理，不得退化成整包**。另有两条必须保住的判据：① **是否进入匹配按解析结果判定，不按 URL 协议**——只有 `root.is_dir` 为真才算 BT 文件树，`thunder://` 只是外壳、里面可能是普通直链，误判会让严格模式把一个正常直链下载给暂停（非目录一律整包）；② **`page_size` 截断必须显式处理**——返回叶子数顶到 `PARSE_PAGE_SIZE`（2000，与迅雷 BT 弹窗一致）时该链接**单独**按截断处理（严格暂停 / 回退整包，`analyzeApiLinks` 里隔离出匹配计划之外，不连累同批其它健康链接）；DOM 弹窗仍走 `snapshot.truncated` → `buildMatchPlan` 整单 `status:'skipped'`（单弹窗单「立即下载」按钮的语义）。无论哪种通道都不许带着残缺文件树静默整包下发。③ **没有 BT 文件树不暂停**：`no-file-list` 在页面自动化里走 `finishWithoutMatch` 照常发送（见 `xunleiAutomation.ts` 对 `plan.skipped === 'no-file-list'` 的处理），接口模式必须一致——解析不出目录树的链接（ed2k、`thunder://` 包直链等）整包发送并在结果里说明，**不得当成未命中暂停**，否则接口模式会比页面模式更严。但令牌失效/网络不通属系统性故障，要直接失败返回，不能退化成整包把故障吞掉。`thunder://` 已线上确认可被 `resource/list` 解析（与同源磁力得到相同文件树与相同 `sub_file_index`）。落地动作集中在 `avMatch.ts` 与 `xunleiApi.ts` 的纯函数里，`sendViaApi` 只做编排——这样可以在浏览器外直接测到生产代码。
- **接口模式的确认窗口（`downloadMode: 'confirm'`，默认）**：`sendViaApi` 只准备待确认任务（`utils/confirm.ts` 的 `PendingConfirmation`）写入 `storage.session`，再用 `chrome.windows.create` 打开 `confirm.html?id=…`，**不建任务**。确认页不接触 `pan-auth`/space，提交只回传 `{link, include, name, selectedIds/wholePackage}`；后台用 `buildConfirmCreateSpecs()` 按 pending 里的文件 id 重新映射 `file_index` 并编码，**绝不接受页面直接传索引**。BT 空选择跳过不建任务；`selectionDisabled`（文件树顶到 2000）只能整包，避免拿残缺列表逐文件选择；严格未命中默认不勾选但允许用户手动勾选（人工确认优先于自动规则），回退模式预选整包。提交防重入（内存 Set），**全部建任务失败时保留 pending**、响应带 `retryable: true`，确认页原地「重试提交」不丢勾选；至少建成一个任务则删除 pending（部分失败也删，重试会造成重复任务）。关闭窗口、30 分钟超时按取消写回历史；确认页按 `PENDING_TTL_MS` 显示剩余时间并过期禁提交。窗口在创建后按 `chrome.tabs.getZoom()` 放大（150%/200% 缩放时目标约 560 CSS 宽），后台取不到缩放时确认页挂载后再校正一次。

## 验证要求

- 完成代码修改后至少运行 `pnpm check`（类型检查 + 生产构建）。
- 仓库有 vitest 单元测试（`pnpm test`，`tests/` 只覆盖无副作用纯函数与 fetch 拦截断言），影响 `extractResourceKey`、`encodeSubFileIndex`、`buildMatchPlan`、`buildConfirmCreateSpecs`、设置回落方向的改动必须先补断言再改实现；lint 仍没有，不要声称运行了不存在的检查。
- 端到端功能依赖真实 NAS 与已登录的迅雷 Web 会话：优先在 `pnpm deploy` 打开的调试实例中验证；无法验证时必须在交付说明中明确写出「未做真实 NAS 端到端验证」，并列出待测项。
- 无副作用的验证：设置页「测试连接」、目录树读取、通知开关持久化、发送记录加载/清空。这些不需要创建真实下载任务。
- 番号匹配离线验证：设置页「规则测试」粘贴样例，或选择本地文件夹（如 `D:\downloads\movies`）只读文件名/大小；不读取文件内容、不上传。可用真实文件名核对标准码/FC2/Tokyo Hot/分集/站点前缀/编码器噪声。
- 番号匹配只读 NAS 验证：解析一个磁力后打开设置页「读取当前迅雷弹窗」，确认能读到任务/文件/大小/路径/勾选状态与按钮状态，且不创建任务；无弹窗时有友好提示。这是进入应用勾选前的风险门槛。
- 接口模式离线验证（基础断言已常驻为 `tests/xunleiApi.test.ts` 等单测，跑 `pnpm test`）：`utils/avMatch.ts` 与 `utils/xunleiApi.ts` 的匹配落地动作都是纯函数，补充真实线上样本的深度验证可用一次性脚本在仓库外跑、不入 git。两类断言：① 用真实 `drive/v1/resource/list` 返回样本跑 `flattenResourceFiles` → `buildMatchPlan` → `selectSubFiles`，核对 `sub_file_index`（套件会省略序号 0，需从 `id` 末段回退推导）；② 拦截 `globalThis.fetch` 核对线上格式——URL 路径、`method/patch/`·`method/delete/` 隧道、`pan-auth` 头与 `pan_auth` 查询参数、`task_ids`/`with` 重复参数、请求体逐字段。已用线上真实样本验证（番号按脱敏约定记作 ABC-123）：5 文件包应得到 `"0"`、大小 6469832070，与 NAS 上真实任务的 `params.sub_file_index`/`file_size` 一致。
- 接口模式确认窗口离线验证：`utils/confirm.ts` 的 `buildConfirmTree` / `buildConfirmCreateSpecs` 是纯函数，可用 `node --experimental-strip-types` + 一个极小的 `@/` ESM loader 直接 import 生产代码。断言至少覆盖：连续段折叠（`0-2,4`）、整包不传 `sub_file_index`、BT 空选择跳过不建任务、任务名覆盖、目录树层级与父目录大小。2026-10-24 已跑通。
- 接口模式确认窗口在线只读验证（不建任务，已做）：Sintel 磁力在 Chrome 155 调试实例（扩展页面 150% 缩放）打开确认窗口，得到 11 个文件 / 123 MB；关闭番号匹配时默认全选，严格模式零命中时 0 选中且「立即下载」禁用；两条直链显示两张任务卡；关闭窗口后发送记录写为暂停。窗口从 560×780 自动放大到 840×1000（约 550 CSS 宽）。**未点击「立即下载」**，因此真实提交建任务、回退/截断整包与提交失败路径仍未在 UI 上验证（提交会创建真实任务，需先取得批准）。
- 接口模式在线验证（会创建真实任务，先取得用户批准）：**已端到端实跑通过**（套件 v3.23.5，调试实例 + CDP 驱动扩展自身）。用生产代码 `createTask` 建任务返回真实 id，回读确认 `sub_file_index` / `parent_folder_id` / `file_size` / `total_file_count` 全被采纳（曾故意传非自动选择的索引 `"2"` 证明参数真被尊重）；再通过 `popup → background.sendViaApi` 真实发送一条磁力，结果消息为「已发送 1 个任务到 NAS·已按番号匹配勾选 1 个文件（ABC-123）」，摘要 `totalFiles:5 / matchedFiles:1 / selectedFiles:1`，任务实际大小 6170MB 恰为单个命中文件（整包 6498MB），证明勾选真的生效；**已在 UI 上验证**：接口模式开关生效、`sendViaApi` 真实建单、番号匹配摘要与文案回显、回退模式（`fallbackToDefault`）整包继续发送不暂停、`deleteTasks` 与任务列表读取。**仍未在 UI 上验证**：严格未匹配暂停（两次构造零命中都被根名继承救回，见下条）、保存路径不存在的回退、令牌过期重取——这三条的判据逻辑已由离线断言覆盖。
- 接口模式的响应字段有省略行为，写代码时不可当必存在：过滤无命中时 `drive/v1/tasks` 整个省略 `tasks` 字段（`ListTasksResult.tasks` 已标可选）；解析结果里序号为 0 的文件省略 `file_index`。
- **重复发送同一资源时迅雷的行为分两种**（均实测）：任务**已解析完成**（有 `info_hash`，如 COMPLETE）时重发会**顶掉旧任务记录**（原任务从列表消失，已下载文件与目录仍在，新任务落到 `名称(1)`、`(2)` 后缀目录）；任务**尚未解析完成**（PENDING/ERROR）时重发则**两条共存**。两种通道都有此行为，但接口模式不打开页面、用户看不见将被覆盖的是什么，误触成本最低。
- **接口模式防呆实现要点**：发送前用 `listTasks` 取最近 100 条，对每条同时用 `params.info_hash`（大写归一）与 `extractResourceKey(params.url)` 两个键建索引，再与本次链接的资源键比对；命中返回 `duplicate-task` 暂停、不建任务，由 popup「仍然发送」带 `force: true` 显式覆盖。页面自动化的**立即下载**模式同样拦截（弹窗停留不足 1 秒即被点击，无法人工核对），但改用只读页面 Vuex：`injectedReadTasks` 返回每条任务的 `url/infoHash`，与 `extractResourceKey` 归一后比对；页面任务列表没加载出 params（键集为空）时放行，宁可不拦也不误拦。确认模式有可见弹窗，维持人工核对不加拦截。**必须双键**：新建的 PENDING/ERROR 任务 `info_hash` 与 `name` 都是 `undefined`，只有 `params.url` 有值，单靠 `info_hash` 会漏掉"刚发出去还没解析完"的重复发送（第一版就栽在这里）。
- **`extractResourceKey` 的归一性是这个防呆的生命线**：磁力写法是 `xt=urn:btih:<hash>`（**冒号**，不是 `btih=`），服务端 `info_hash` 存**大写**，而 `thunder://` 只是 base64("AA"+url+"ZZ") 外壳——三者必须归一到同一个键，否则防呆静默失效（写第一版时就用错了 `btih=` 正则，是线上取样测试才暴露的）。改动这个函数必须配 `magnet / 裸磁力 / 大写 btih / thunder 外壳 / ed2k / http` 的归一断言，并至少用一条 NAS 上真实存在的任务做拦截验证。
- **`excludeKeywords` 可能反向放大广告文件**：若被排除的恰好是唯一带番号的文件，该分组就变成"零命中"，触发根名兜底继承，把其余**无番号的**文件（常是广告视频）整体选中（实测得到 `sub_file_index="1,3"`）。这是 `avMatch.ts` 既有规则、两种通道共有，不是接口模式引入的。改规则时要连同这条一起考虑。
- 需要真实任务的验证（先取得用户对测试链接的批准）：立即/确认两种模式、路径回退、解析失败、任务失败/完成监控、批量合并通知、监控中关闭迅雷页、通知按钮在 Service Worker 停止后仍可用、并发发送互斥、不刷新模式残留弹窗拦截、首次安装引导；以及番号匹配的全匹配/严格未匹配/回退/类型/大小/关键词/上限排序/多任务部分未匹配/非 BT 直链。
- 任务监控只在迅雷页打开时有效；测试时保持页面打开，并可用临时缩短硬超时/发现窗常量来验证停止路径（验证后恢复 24 小时/2 分钟/30 分钟）。
- 构建出现 chunk 超过 500 kB 的警告属当前预期（Ant Design Vue 全量引入），不是失败。

## 文档同步

- 修改命令、端口、环境变量、权限、部署脚本行为或浏览器兼容要求时，同步更新 **README.md**、**docs/DEVELOPMENT.md** 与 **AGENTS.md**，并检查 `scripts/deploy.mjs` 顶部注释是否仍然准确。
- README 面向使用者（安装、使用、限制）；[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 面向开发者（结构、构建、调试部署、测试清单）；AGENTS.md 面向编码代理（约定、代码地图、部署细节、验证要求）。
