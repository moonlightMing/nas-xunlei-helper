<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ensureSettingsLoaded, getSettings } from '@/utils/settings';
import { bytes } from '@/utils/format';
import { schedulePopupFit, watchPopupHeight } from '@/utils/popupFit';
import SendPanel from './components/SendPanel.vue';
import TasksPanel from './components/TasksPanel.vue';

const settingsReady = ref(false);
const settingsLoading = ref(true);
const activeTab = ref('tasks');
/** 任务面板轮询上抛的总速度（字节/秒），显示在页签行右侧；0 时不渲染 */
const totalSpeed = ref(0);
/** 弹窗上直接显示版本号，便于核对浏览器实际运行的构建 */
const version = chrome.runtime.getManifest().version;

const handleOpenSettings = async () => {
  await chrome.runtime.openOptionsPage();
  window.close();
};

const handleOpenXunlei = async () => {
  await chrome.runtime.sendMessage({ type: 'xunlei', action: 'open' });
  window.close();
};

let stopFitWatcher: (() => void) | null = null;

onMounted(async () => {
  stopFitWatcher = watchPopupHeight();
  schedulePopupFit();
  try {
    await ensureSettingsLoaded();
    settingsReady.value = Boolean(getSettings().xunleiUrl.trim());
  } finally {
    settingsLoading.value = false;
  }
});

onBeforeUnmount(() => {
  stopFitWatcher?.();
  stopFitWatcher = null;
});

/* 切走页签后旧面板会被加上 aria-hidden，焦点留在其中（如链接输入框）会触发浏览器可访问性警告 */
watch(activeTab, () => {
  void nextTick(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.closest('.ant-tabs-tabpane[aria-hidden="true"]')) {
      focused.blur();
    }
  });
});
</script>

<template>
  <div class="popup">
    <a-alert v-if="!settingsLoading && !settingsReady" type="warning" show-icon class="notice">
      <template #message>
        尚未配置 NAS 迅雷地址，
        <a @click="handleOpenSettings">前往设置</a>
      </template>
    </a-alert>

    <a-tabs v-model:activeKey="activeTab" size="small" class="tabs">
      <template #rightExtra>
        <div v-if="totalSpeed > 0" class="total-speed" title="进行中任务的下载速度之和">
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 4v10.5" />
            <path d="M7.5 11l4.5 4.5 4.5-4.5" />
            <path d="M5 19.5h14" />
          </svg>
          <span>总速度</span>
          <span class="value">{{ bytes(totalSpeed) }}/s</span>
        </div>
      </template>
      <a-tab-pane key="tasks" tab="下载任务">
        <TasksPanel v-if="settingsReady" @total-speed="totalSpeed = $event" />
      </a-tab-pane>
      <a-tab-pane key="send" tab="发送链接">
        <SendPanel :settings-ready="settingsReady" />
      </a-tab-pane>
    </a-tabs>

    <footer class="footer">
      <div class="brand">
        <img src="/icons/48.png" alt="logo" class="logo" />
        <span class="title">NAS 迅雷助手</span>
      </div>
      <div class="actions">
        <a-button type="link" size="small" @click="handleOpenXunlei">打开迅雷页面</a-button>
        <a-button type="link" size="small" @click="handleOpenSettings">设置</a-button>
      </div>
      <span class="version">v{{ version }}</span>
    </footer>
  </div>
</template>

<style scoped>
.popup {
  box-sizing: border-box;
  flex: 1 1 auto;
  /* #app 被钉到视口高度（弹窗被浏览器限高）后必须允许收缩，
     否则这里的自动最小尺寸（内容高）会挡住压缩，溢出依旧不可达 */
  min-height: 0;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 560px;
  margin: 0 auto;
  padding: 12px 14px 8px;
  background: #fff;
}

@media (max-width: 460px) {
  .popup {
    padding: 10px 10px 6px;
  }

  .footer {
    gap: 10px;
  }
}

.notice {
  margin-bottom: 10px;
  flex-shrink: 0;
}

.tabs {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.tabs :deep(.ant-tabs-nav) {
  margin-bottom: 8px;
}

/* 总速度徽标：任务面板轮询上抛，数字 tabular-nums 宽度变化极小，不推挤页签 */
.total-speed {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 180px;
  overflow: hidden;
  white-space: nowrap;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
  font-variant-numeric: tabular-nums;
}

.total-speed .ico {
  display: block;
  width: 13px;
  height: 13px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.total-speed .value {
  color: #0958d9;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 内容区随弹窗剩余高度拉伸，空状态提示得以在剩余空间内垂直居中。
   basis 必须 auto（同 TasksPanel）：弹窗按内容自适应高度，basis 0 会冻结弹窗高度 */
.tabs :deep(.ant-tabs-content-holder),
.tabs :deep(.ant-tabs-content),
.tabs :deep(.ant-tabs-tabpane) {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.tabs :deep(.ant-tabs-tabpane) {
  min-width: 0;
}

/* 三列 grid：左右两列等宽保证中间按钮始终居中，左侧品牌、右侧版本号 */
.footer {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 8px;
  margin-top: auto;
  padding-top: 8px;
  border-top: 1px solid #f0f0f0;
  flex-shrink: 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.logo {
  width: 20px;
  height: 20px;
  flex: none;
}

.title {
  font-size: 13px;
  font-weight: 600;
  color: rgba(0, 0, 0, 0.88);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.actions {
  display: flex;
  justify-content: center;
  gap: 16px;
}

.version {
  text-align: right;
  font-size: 11px;
  color: rgba(0, 0, 0, 0.3);
  font-variant-numeric: tabular-nums;
}
</style>
