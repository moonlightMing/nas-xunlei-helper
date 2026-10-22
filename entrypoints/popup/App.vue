<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { message } from 'ant-design-vue';
import type { SendLinksResponse } from '@/entrypoints/background';
import { ensureSettingsLoaded, getSettings, validateXunleiUrl } from '@/utils/settings';

const settingsReady = ref(true);
const linksText = ref('');
const sending = ref(false);

const linkCount = computed(
  () => linksText.value.split('\n').map((l) => l.trim()).filter(Boolean).length,
);

onMounted(async () => {
  await ensureSettingsLoaded();
  settingsReady.value = Boolean(getSettings().xunleiUrl.trim());
});

const result = ref<{ ok: boolean; message: string } | null>(null);

const handleSend = async () => {
  const links = linksText.value.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!links.length) {
    message.warning('请先粘贴至少一个下载链接');
    return;
  }
  sending.value = true;
  result.value = null;
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'download',
      action: 'sendLinks',
      data: { links },
    })) as SendLinksResponse | undefined;
    result.value = response ?? { ok: false, message: '后台无响应，请重试' };
  } catch (error) {
    result.value = { ok: false, message: (error as Error).message || '发送失败' };
  } finally {
    sending.value = false;
  }
};

const handleOpenSettings = async () => {
  await chrome.runtime.openOptionsPage();
  window.close();
};

const handleOpenXunleiPage = async () => {
  await ensureSettingsLoaded();
  const settings = getSettings();
  const urlError = validateXunleiUrl(settings.xunleiUrl);
  if (urlError) {
    message.warning(urlError);
    return;
  }
  await chrome.tabs.create({ url: settings.xunleiUrl });
  window.close();
};
</script>

<template>
  <div class="popup">
    <header class="header">
      <img src="/icons/48.png" alt="logo" class="logo" />
      <span class="title">NAS 迅雷助手</span>
    </header>

    <a-alert
      v-if="!settingsReady"
      type="warning"
      show-icon
      class="notice"
    >
      <template #message>
        尚未配置 NAS 迅雷地址，
        <a @click="handleOpenSettings">前往设置</a>
      </template>
    </a-alert>

    <a-textarea
      v-model:value="linksText"
      :rows="5"
      placeholder="每行一个下载链接，支持批量发送&#10;thunder://、magnet:、ed2k:、http(s):// ..."
    />
    <div class="meta">
      <span v-if="linkCount">{{ linkCount }} 个链接</span>
      <span v-else>右键点击页面链接也可直接发送</span>
    </div>

    <a-button
      type="primary"
      block
      :loading="sending"
      :disabled="!settingsReady"
      @click="handleSend"
    >
      {{ sending ? '正在发送到 NAS…' : '发送到 NAS 迅雷' }}
    </a-button>

    <a-alert
      v-if="result"
      :type="result.ok ? 'success' : 'error'"
      show-icon
      class="notice"
    >
      <template #message>{{ result.message }}</template>
    </a-alert>

    <footer class="footer">
      <a-button type="link" size="small" @click="handleOpenXunleiPage">打开迅雷页面</a-button>
      <a-button type="link" size="small" @click="handleOpenSettings">设置</a-button>
    </footer>
  </div>
</template>

<style scoped>
.popup {
  width: 360px;
  padding: 14px 16px 10px;
  background: #fff;
}

.header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
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

.meta {
  margin: 6px 0 10px;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
}

.footer {
  display: flex;
  justify-content: center;
  gap: 16px;
  margin-top: 6px;
}
</style>
