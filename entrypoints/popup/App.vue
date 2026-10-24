<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ensureSettingsLoaded, getSettings } from '@/utils/settings';
import SendPanel from './components/SendPanel.vue';
import TasksPanel from './components/TasksPanel.vue';

const settingsReady = ref(false);
const settingsLoading = ref(true);
const activeTab = ref('tasks');

const handleOpenSettings = async () => {
  await chrome.runtime.openOptionsPage();
  window.close();
};

const handleOpenXunlei = async () => {
  await chrome.runtime.sendMessage({ type: 'xunlei', action: 'open' });
  window.close();
};

onMounted(async () => {
  try {
    await ensureSettingsLoaded();
    settingsReady.value = Boolean(getSettings().xunleiUrl.trim());
  } finally {
    settingsLoading.value = false;
  }
});
</script>

<template>
  <div class="popup">
    <header class="header">
      <img src="/icons/48.png" alt="logo" class="logo" />
      <span class="title">NAS 迅雷助手</span>
    </header>

    <a-alert v-if="!settingsLoading && !settingsReady" type="warning" show-icon class="notice">
      <template #message>
        尚未配置 NAS 迅雷地址，
        <a @click="handleOpenSettings">前往设置</a>
      </template>
    </a-alert>

    <a-tabs v-model:activeKey="activeTab" size="small" class="tabs">
      <a-tab-pane key="tasks" tab="下载任务">
        <TasksPanel v-if="settingsReady" />
      </a-tab-pane>
      <a-tab-pane key="send" tab="发送链接">
        <SendPanel :settings-ready="settingsReady" />
      </a-tab-pane>
    </a-tabs>

    <footer class="footer">
      <a-button type="link" size="small" @click="handleOpenXunlei">打开迅雷页面</a-button>
      <a-button type="link" size="small" @click="handleOpenSettings">设置</a-button>
    </footer>
  </div>
</template>

<style scoped>
.popup {
  box-sizing: border-box;
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

.header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.logo {
  width: 24px;
  height: 24px;
}

.title {
  font-size: 15px;
  font-weight: 600;
  color: rgba(0, 0, 0, 0.88);
}

.notice {
  margin-bottom: 10px;
}

.tabs :deep(.ant-tabs-nav) {
  margin-bottom: 8px;
}

.tabs :deep(.ant-tabs-tabpane) {
  min-width: 0;
}

.footer {
  display: flex;
  justify-content: center;
  gap: 16px;
  margin-top: 6px;
  padding-top: 2px;
  border-top: 1px solid #f0f0f0;
}
</style>
