#!/usr/bin/env node
/**
 * 一键本地构建部署：构建扩展并在调试浏览器中自动 reload。
 *
 * 流程：
 *   1. wxt build（构建 .output/chrome-mv3）
 *   2. 探测目标浏览器的 Chrome DevTools 协议端口
 *      - 已有调试实例 → 直接复用
 *      - 没有 → 自动启动独立 profile 的调试实例（不影响日常浏览器；
 *        Chrome/Edge 136+ 禁止默认 profile 开远程调试端口，独立 user-data-dir 是官方允许的方式）
 *   3. 在 chrome://extensions 页面通过 chrome.developerPrivate.reload() 重载扩展
 *
 * 目标浏览器（--browser= 参数选择，默认 chrome）：
 *   chrome  Google Chrome            端口 9223  profile .debug-profile
 *   cent    Cent Browser 百分浏览器   端口 9224  profile .debug-profile-cent
 *   edge    Microsoft Edge            端口 9225  profile .debug-profile-edge
 * 各目标端口与 profile 相互独立，可同时部署/共存。
 *
 * 首次使用：调试实例启动后若列表里还没有本扩展，请在它打开的 chrome://extensions
 * 页面「加载已解压的扩展程序」一次（选择 .output/chrome-mv3），此后每次部署全自动。
 * （Cent Browser 5.x 基于 Chromium 132，无 Chrome 137+ 忽略 --load-extension 的限制，
 *  首次部署通常即可自动挂载；MV3 扩展要求 Cent Browser 5.x 及以上。）
 *
 * 环境变量：
 *   XUNLEI_DEBUG_PORT     调试端口，默认按目标浏览器取上表端口
 *   XUNLEI_DEBUG_BROWSER  浏览器可执行文件路径，指定后跳过自动探测
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(projectRoot, ".output", "chrome-mv3");

const EXT_NAME_HINT = "nas 迅雷"; // manifest 里的 name「NAS 迅雷助手」，匹配时忽略大小写
const OUTPUT_DIR_HINT = "chrome-mv3"; // 未打包扩展的 path 会包含该目录名
/** 刚构建出的 manifest 版本（deploy 日志用，避免读到 reload 前的旧版本） */
let builtVersion = "unknown";

/** 目标浏览器：默认端口、独立调试 profile、可执行文件探测路径（按优先级） */
const BROWSER_TARGETS = {
  chrome: {
    label: "Google Chrome",
    port: 9223,
    profileDir: path.join(projectRoot, ".debug-profile"),
    // 项目内由 @puppeteer/browsers 安装的 Chrome for Testing 优先（见 findForTestingChrome）
    useForTestingChrome: true,
    candidates: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
  },
  cent: {
    label: "Cent Browser 百分浏览器",
    port: 9224,
    profileDir: path.join(projectRoot, ".debug-profile-cent"),
    useForTestingChrome: false,
    candidates: [
      // 本机实际安装位置（便携版，5.2.1168.83 / Chromium 132）
      "D:\\Software\\CentBrowser\\Application\\chrome.exe",
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, "CentBrowser", "Application", "chrome.exe")
        : null,
      "C:\\Program Files\\CentBrowser\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\CentBrowser\\Application\\chrome.exe",
      "C:\\Program Files\\Cent Browser\\Application\\chrome.exe",
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, "Cent Browser", "Application", "chrome.exe")
        : null,
    ],
  },
  edge: {
    label: "Microsoft Edge",
    port: 9225,
    profileDir: path.join(projectRoot, ".debug-profile-edge"),
    useForTestingChrome: false,
    candidates: [
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
  },
};

function resolveTarget() {
  const arg = process.argv.find((a) => a.startsWith("--browser="));
  const name = arg?.split("=")[1]?.trim().toLowerCase() || "chrome";
  const target = BROWSER_TARGETS[name];
  if (!target) {
    throw new Error(
      `未知浏览器目标「${name}」，可选：${Object.keys(BROWSER_TARGETS).join(" / ")}`,
    );
  }
  return { name, ...target };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(msg) {
  console.log(`[deploy] ${msg}`);
}

async function runBuild() {
  log("开始构建（pnpm build）…");
  const child = spawn("pnpm", ["build"], {
    cwd: projectRoot,
    stdio: "inherit",
    shell: true,
  });
  await new Promise((resolve, reject) => {
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`构建失败，退出码 ${code}`)),
    );
    child.on("error", reject);
  });
  if (!existsSync(path.join(outputDir, "manifest.json"))) {
    throw new Error(`未找到构建产物 manifest：${outputDir}`);
  }
  // getExtensionsInfo 在 reload 前返回的是旧 manifest，日志统一用刚构建出的版本
  builtVersion = JSON.parse(
    readFileSync(path.join(outputDir, "manifest.json"), "utf8"),
  ).version;
  log("构建完成");
}

async function isCdpAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpAlive(port)) return true;
    await sleep(500);
  }
  return false;
}

// 项目内由 @puppeteer/browsers 安装的 Chrome for Testing（chrome/win64-<ver>/chrome-win64/chrome.exe）。
// Chrome 137+ 正式版忽略 --load-extension，for-testing 构建完整保留该参数，是自动挂载扩展的首选。
function findForTestingChrome() {
  const base = path.join(projectRoot, "chrome");
  if (!existsSync(base)) return null;
  const versions = readdirSync(base)
    .filter((d) => /^win64-/.test(d))
    .sort()
    .reverse();
  for (const v of versions) {
    const exe = path.join(base, v, "chrome-win64", "chrome.exe");
    if (existsSync(exe)) return exe;
  }
  return null;
}

function findBrowserExecutable(target) {
  const candidates = [
    process.env.XUNLEI_DEBUG_BROWSER,
    target.useForTestingChrome ? findForTestingChrome() : null,
    ...target.candidates,
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `未找到 ${target.label}，请通过 XUNLEI_DEBUG_BROWSER 指定浏览器可执行文件路径`,
    );
  }
  return found;
}

function launchDebugBrowser(target, port) {
  const exe = findBrowserExecutable(target);
  log(`启动调试浏览器（独立 profile：${target.profileDir}）`);
  log(`浏览器：${exe}`);
  const child = spawn(
    exe,
    [
      `--user-data-dir=${target.profileDir}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Chrome 137+ 正式版会忽略该参数；旧版本/其它 Chromium 分支（如 Cent 5.x）可直接自动加载
      `--load-extension=${outputDir}`,
      "chrome://extensions/",
    ],
    // detached 让浏览器独立于脚本进程常驻，脚本退出后调试实例仍在
    { stdio: "ignore", detached: true },
  );
  child.unref();
  return exe;
}

async function cdpListTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  return await res.json();
}

async function cdpOpenExtensionsPage(port) {
  // 复用已打开的 chrome://extensions 标签页，避免每次部署都新开
  const targets = await cdpListTargets(port);
  const existing = targets.find(
    (t) => t.type === "page" && t.url.startsWith("chrome://extensions"),
  );
  if (existing?.webSocketDebuggerUrl) return existing;

  const encoded = encodeURIComponent("chrome://extensions/");
  let created;
  try {
    // 新版 Chrome 要求 PUT
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${encoded}`, {
      method: "PUT",
      signal: AbortSignal.timeout(3000),
    });
    created = await res.json();
  } catch {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${encoded}`, {
      signal: AbortSignal.timeout(3000),
    });
    created = await res.json();
  }
  await sleep(1000); // 等页面初步加载
  return created;
}

function evaluateOnPage(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("CDP 执行超时"));
    }, 8000);

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression,
            awaitPromise: true,
            returnByValue: true,
          },
        }),
      );
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id !== 1) return;
      clearTimeout(timeout);
      ws.close();
      if (msg.error) {
        reject(new Error(`CDP 错误：${msg.error.message}`));
        return;
      }
      resolve(msg.result?.result?.value ?? null);
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("CDP WebSocket 连接失败"));
    };
  });
}

const RELOAD_EXPRESSION = `
new Promise((resolve) => {
  try {
    chrome.developerPrivate.getExtensionsInfo((infos) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, reason: "api-error", error: chrome.runtime.lastError.message });
        return;
      }
      const unpacked = infos.filter((i) => i.location === "UNPACKED");
      const target = unpacked.find((i) =>
        (i.path || "").toLowerCase().includes(${JSON.stringify(OUTPUT_DIR_HINT)}) ||
        (i.name || "").toLowerCase().includes(${JSON.stringify(EXT_NAME_HINT)})
      );
      if (!target) {
        resolve({
          ok: false,
          reason: "not-found",
          unpacked: unpacked.map((i) => ({ name: i.name, path: i.path })),
        });
        return;
      }
      chrome.developerPrivate.reload(
        target.id,
        { failQuietly: false, populateErrorForUnpacked: true },
        () => {
          const err = chrome.runtime.lastError;
          resolve({
            ok: !err,
            id: target.id,
            name: target.name,
            version: target.version,
            path: target.path,
            error: err ? err.message : null,
          });
        }
      );
    });
  } catch (e) {
    resolve({ ok: false, reason: "api-error", error: String(e) });
  }
})
`;

async function reloadExtension(port) {
  // 页面/developerPrivate API 可能尚未就绪，重试几次
  for (let attempt = 1; attempt <= 10; attempt++) {
    const page = await cdpOpenExtensionsPage(port);
    if (!page?.webSocketDebuggerUrl) {
      throw new Error("无法打开或连接 chrome://extensions 页面");
    }
    const result = await evaluateOnPage(page.webSocketDebuggerUrl, RELOAD_EXPRESSION);

    if (result?.reason === "api-error") {
      await sleep(800); // 页面还在加载，稍后重试
      continue;
    }

    if (result?.reason === "not-found") {
      throw new Error(
        "调试浏览器里没有本扩展（后续将回退为重启浏览器，由 --load-extension 挂载）",
      );
    }

    if (!result?.ok) {
      throw new Error(`扩展 reload 失败：${result?.error ?? "未知错误"}`);
    }

    log(`已重载扩展「${result.name}」v${builtVersion}（id: ${result.id}）`);
    return;
  }
  throw new Error("chrome://extensions 页面迟迟未就绪，请重试");
}

/**
 * 清空扩展 SW 脚本缓存。Chromium 会按 URL 缓存 unpacked 扩展 SW 的脚本字节码
 * （持久 profile 的 Service Worker/ScriptCache）：仅重启浏览器而不清缓存时，
 * SW 可能继续执行旧脚本——表面上部署成功、磁盘文件已是新构建，行为却不变
 * （video-search-plugin 2026-10-14 for-testing 153 实测：新加的 message 分支一直无人应答）。
 * 须在浏览器进程退出后调用，此时删目录才安全。
 */
function clearSwScriptCache(profileDir) {
  const dir = path.join(profileDir, "Default", "Service Worker", "ScriptCache");
  try {
    rmSync(dir, { recursive: true, force: true });
    log("已清 SW 脚本缓存（避免重启后仍执行旧脚本）");
  } catch (e) {
    log(`SW 脚本缓存清理失败（不影响部署继续）：${e.message}`);
  }
}

/** 优雅关闭调试浏览器（Browser.close），并等待调试端口释放 */
async function closeDebugBrowser(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    const ver = await res.json();
    if (ver?.webSocketDebuggerUrl) {
      await new Promise((resolve) => {
        const ws = new WebSocket(ver.webSocketDebuggerUrl);
        ws.onopen = () => {
          ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
          setTimeout(resolve, 1500);
        };
        ws.onerror = resolve;
      });
    }
  } catch {
    // 端口已不可达即视为已关闭
  }
  for (let i = 0; i < 10; i++) {
    if (!(await isCdpAlive(port))) return;
    await sleep(500);
  }
}

async function main() {
  const target = resolveTarget();
  const port = Number(process.env.XUNLEI_DEBUG_PORT || target.port);
  log(`目标浏览器：${target.label}（端口 ${port}）`);

  await runBuild();

  let alive = await isCdpAlive(port);
  if (!alive) {
    launchDebugBrowser(target, port);
    log(`等待调试端口 127.0.0.1:${port} 就绪…`);
    alive = await waitForCdp(port);
    if (!alive) {
      throw new Error(`调试浏览器未在端口 ${port} 就绪，请检查是否已有其它实例占用`);
    }
  } else {
    log(`复用已运行的调试浏览器（端口 ${port}）`);
  }

  try {
    await reloadExtension(port);
  } catch (err) {
    // developerPrivate.reload 在部分版本回调不触发，或扩展丢失时，
    // 直接重启调试浏览器：--load-extension 启动参数会挂载新构建，等效完成部署
    log(`${err.message}`);
    log("回退方案：重启调试浏览器以挂载新构建…");
    await closeDebugBrowser(port);
    clearSwScriptCache(target.profileDir);
    launchDebugBrowser(target, port);
    const ready = await waitForCdp(port);
    if (!ready) {
      throw new Error(`调试浏览器重启后未在端口 ${port} 就绪`);
    }
  }

  log("部署完成 ✅");
}

main().catch((error) => {
  console.error(`[deploy] ${error.message}`);
  process.exit(1);
});
