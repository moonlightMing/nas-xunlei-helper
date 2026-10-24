import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-vue"],
  manifest: {
    name: "NAS 迅雷助手",
    description: "将浏览器中的下载链接一键发送到 NAS 迅雷远程下载。",
    version: "0.4.4",
    // NAS 地址由用户在设置页动态配置，因此放行 http/https 全域，
    // 覆盖「打开迅雷页标签页注入脚本」与「右键菜单取链接」两类场景
    permissions: ["storage", "contextMenus", "tabs", "scripting", "notifications", "alarms"],
    host_permissions: ["http://*/*", "https://*/*"],
    options_ui: {
      page: "options.html",
      open_in_tab: true,
    },
    icons: {
      16: "/icons/16.png",
      48: "/icons/48.png",
      128: "/icons/128.png",
    },
  },
});
