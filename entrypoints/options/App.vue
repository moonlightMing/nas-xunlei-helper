<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { message, Modal } from 'ant-design-vue';
import {
  DEFAULT_SETTINGS,
  DOWNLOAD_MODE_LABELS,
  ensureSettingsLoaded,
  getSettings,
  resetSettings,
  saveSettings,
  validateDownloadPath,
  validateXunleiUrl,
  type DownloadMode,
  type XunleiSettings,
} from '@/utils/settings';

const loading = ref(true);
const saving = ref(false);

const form = reactive<XunleiSettings>({ ...DEFAULT_SETTINGS });

onMounted(async () => {
  await ensureSettingsLoaded();
  Object.assign(form, getSettings());
  loading.value = false;
});

const handleSave = async () => {
  const urlError = validateXunleiUrl(form.xunleiUrl);
  if (urlError) {
    message.warning(urlError);
    return;
  }
  const pathError = validateDownloadPath(form.downloadPath);
  if (pathError) {
    message.warning(pathError);
    return;
  }
  saving.value = true;
  try {
    await saveSettings({ ...form, xunleiUrl: form.xunleiUrl.trim(), downloadPath: form.downloadPath.trim() });
    message.success('设置已保存');
  } catch {
    message.error('保存失败，请重试');
  } finally {
    saving.value = false;
  }
};

const handleOpenXunleiPage = async () => {
  const urlError = validateXunleiUrl(form.xunleiUrl);
  if (urlError) {
    message.warning(urlError);
    return;
  }
  await chrome.tabs.create({ url: form.xunleiUrl.trim() });
};

const handleReset = () => {
  Modal.confirm({
    title: '恢复默认设置？',
    content: '将清空 NAS 迅雷地址、默认下载位置，并将下载模式重置为「立即下载」。',
    okText: '恢复默认',
    okType: 'danger',
    cancelText: '取消',
    onOk: async () => {
      await resetSettings();
      Object.assign(form, getSettings());
      message.success('已恢复默认设置');
    },
  });
};
</script>

<template>
  <div class="page">
    <a-spin :spinning="loading">
      <div class="card">
        <header class="header">
          <img src="/icons/48.png" alt="logo" class="logo" />
          <div>
            <h1 class="title">NAS 迅雷助手</h1>
            <p class="subtitle">将浏览器中的下载链接一键发送到 NAS 迅雷远程下载</p>
          </div>
        </header>

        <a-form layout="vertical" class="form">
          <a-form-item required>
            <template #label>
              <span class="label">NAS 迅雷地址</span>
            </template>
            <a-input
              v-model:value="form.xunleiUrl"
              placeholder="http://192.168.5.2:2345/webman/3rdparty/pan-xunlei-com/index.cgi/#/home"
              allow-clear
            />
            <template #extra>
              <span class="extra">迅雷 NAS 套件（群晖 webman/3rdparty/pan-xunlei-com）的 Web 页面地址；发送前请先在浏览器登录一次迅雷。</span>
            </template>
          </a-form-item>

          <a-form-item>
            <template #label>
              <span class="label">默认下载位置</span>
            </template>
            <a-input v-model:value="form.downloadPath" placeholder="/downloads/movies" allow-clear />
            <template #extra>
              <span class="extra">
                NAS 上的保存路径，留空则使用 NAS 当前默认目录。「立即下载」模式下会尽力匹配该路径；
                「确认后下载」模式下始终可在迅雷对话框中手动修改。
              </span>
            </template>
          </a-form-item>

          <a-form-item>
            <template #label>
              <span class="label">下载模式</span>
            </template>
            <a-radio-group v-model:value="form.downloadMode">
              <a-radio-button value="immediate">{{ DOWNLOAD_MODE_LABELS.immediate }}</a-radio-button>
              <a-radio-button value="confirm">{{ DOWNLOAD_MODE_LABELS.confirm }}</a-radio-button>
            </a-radio-group>
            <template #extra>
              <span class="extra">
                <template v-if="form.downloadMode === 'immediate'">
                  发送后自动解析链接并点击「立即下载」，全程无需在迅雷页面操作。
                </template>
                <template v-else>
                  发送后自动解析链接并停留在迅雷下载确认框，由你编辑文件名、保存位置后再手动点击「立即下载」。
                </template>
              </span>
            </template>
          </a-form-item>

          <a-form-item>
            <a-space>
              <a-button type="primary" :loading="saving" @click="handleSave">保存设置</a-button>
              <a-button @click="handleOpenXunleiPage">打开迅雷页面</a-button>
              <a-button danger @click="handleReset">恢复默认</a-button>
            </a-space>
          </a-form-item>
        </a-form>
      </div>
    </a-spin>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  display: flex;
  justify-content: center;
  padding: 48px 16px;
  background: #f5f6f8;
}

.card {
  width: 640px;
  height: fit-content;
  background: #fff;
  border-radius: 12px;
  padding: 32px 36px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
}

.header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 28px;
}

.logo {
  width: 48px;
  height: 48px;
}

.title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: rgba(0, 0, 0, 0.88);
}

.subtitle {
  margin: 4px 0 0;
  font-size: 13px;
  color: rgba(0, 0, 0, 0.45);
}

.label {
  font-weight: 500;
}

.extra {
  font-size: 12px;
  line-height: 1.6;
  color: rgba(0, 0, 0, 0.45);
  white-space: normal;
}
</style>
