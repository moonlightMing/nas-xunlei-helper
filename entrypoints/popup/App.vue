<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import { parseLinks } from '@/utils/links';
import type { OpenXunleiResponse, SendLinksResponse } from '@/utils/messaging';
import { getSendErrorMeta } from '@/utils/sendErrors';
import { ensureSettingsLoaded, getSettings, validateXunleiUrl } from '@/utils/settings';

const settingsReady = ref(false);
const settingsLoading = ref(true);
const linksText = ref('');
const sending = ref(false);
const result = ref<SendLinksResponse | null>(null);

const parsed = computed(() => parseLinks(linksText.value));
const linkCount = computed(() => parsed.value.links.length);
const paused = computed(() => Boolean(result.value?.paused));
const resultMeta = computed(() =>
  result.value && (!result.value.ok || paused.value)
    ? getSendErrorMeta(result.value.code)
    : null,
);
const pathFallback = computed(() =>
  Boolean(
    result.value?.ok &&
      result.value.pathApplied?.needed &&
      !result.value.pathApplied.applied,
  ),
);
const matchWarning = computed(() => {
  const match = result.value?.match;
  return Boolean(
    result.value?.ok &&
      !paused.value &&
      match &&
      (match.status === 'partial' || match.status === 'empty'),
  );
});
const resultType = computed(() => {
  if (!result.value) return 'info';
  if (paused.value) return 'warning';
  if (!result.value.ok) return 'error';
  return pathFallback.value || matchWarning.value ? 'warning' : 'success';
});
const primaryAction = computed(() => resultMeta.value?.primary ?? null);
const primaryLabel = computed(() => (primaryAction.value === 'open-options' ? '打开设置' : '打开迅雷'));
const canRetry = computed(() => Boolean(resultMeta.value?.retryable && !sending.value));

const metaText = computed(() => {
  const parts: string[] = [];
  if (linkCount.value) parts.push(`${linkCount.value} 个链接`);
  if (parsed.value.duplicates) parts.push(`已去重 ${parsed.value.duplicates} 个`);
  if (parsed.value.unsupported.length) parts.push(`${parsed.value.unsupported.length} 个链接协议不支持`);
  if (parsed.value.truncated) parts.push('单次最多 50 个');
  return parts.join(' · ');
});

const hintText = computed(() => {
  if (!linksText.value.trim()) {
    return '支持 thunder://、magnet:、ed2k:、http(s)://，可多行或空格分隔';
  }
  return metaText.value || '未识别到下载链接';
});

onMounted(async () => {
  try {
    await ensureSettingsLoaded();
    settingsReady.value = Boolean(getSettings().xunleiUrl.trim());
  } finally {
    settingsLoading.value = false;
  }
});

watch(linksText, () => {
  if (result.value) result.value = null;
});

const handleSend = async () => {
  if (sending.value) return;
  const links = parsed.value.links;
  if (!links.length) {
    message.warning(
      parsed.value.unsupported.length ? '没有受支持的下载链接' : '请先粘贴至少一个下载链接',
    );
    return;
  }

  sending.value = true;
  result.value = null;
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'download',
      action: 'sendLinks',
      data: { links, source: 'popup' },
    })) as SendLinksResponse | undefined;
    result.value =
      response ?? { stage: 'prepare', ok: false, code: 'unknown', message: '后台无响应，请重试' };
  } catch (error) {
    result.value = {
      stage: 'prepare',
      ok: false,
      code: 'unknown',
      message: (error as Error).message || '发送失败',
    };
  } finally {
    sending.value = false;
  }
};

const handleKeydown = (event: KeyboardEvent) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    void handleSend();
  }
};

const handleRetry = () => {
  void handleSend();
};

const handleOpenSettings = async () => {
  await chrome.runtime.openOptionsPage();
  window.close();
};

const handleOpenXunlei = async () => {
  await ensureSettingsLoaded();
  const urlError = validateXunleiUrl(getSettings().xunleiUrl);
  if (urlError) {
    message.warning(urlError);
    return;
  }
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'xunlei',
      action: 'open',
    })) as OpenXunleiResponse | undefined;
    if (response && !response.ok) {
      message.warning(response.message || '打开迅雷页面失败');
      return;
    }
    window.close();
  } catch (error) {
    message.error((error as Error).message || '打开迅雷页面失败');
  }
};

const handlePrimaryAction = () => {
  if (primaryAction.value === 'open-options') void handleOpenSettings();
  else void handleOpenXunlei();
};
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

    <a-textarea
      v-model:value="linksText"
      :rows="5"
      autofocus
      :disabled="sending"
      placeholder="粘贴下载链接，可多行或空格分隔&#10;thunder://、magnet:、ed2k:、http(s):// ..."
      @keydown="handleKeydown"
    />
    <div class="meta">
      <span :class="{ warn: parsed.unsupported.length > 0 || parsed.truncated }">{{ hintText }}</span>
      <span v-if="linkCount" class="shortcut">Ctrl / ⌘ + Enter 发送</span>
    </div>

    <a-button
      type="primary"
      block
      :loading="sending"
      :disabled="settingsLoading || !settingsReady"
      @click="handleSend"
    >
      {{ sending ? '正在发送到 NAS…' : '发送到 NAS 迅雷' }}
    </a-button>

    <a-alert
      v-if="result"
      :type="resultType"
      show-icon
      class="notice result"
      aria-live="polite"
    >
      <template #message>{{ result.message }}</template>
      <template v-if="resultMeta?.hint && (!result.ok || paused)" #description>
        {{ resultMeta.hint }}
      </template>
    </a-alert>

    <div
      v-if="result && (paused || matchWarning || pathFallback || (!result.ok && (primaryAction || canRetry)))"
      class="result-actions"
    >
      <template v-if="paused || matchWarning || pathFallback">
        <a-button size="small" @click="handleOpenXunlei">打开迅雷</a-button>
        <a-button size="small" @click="handleOpenSettings">打开设置</a-button>
      </template>
      <template v-else>
        <a-button v-if="primaryAction" size="small" @click="handlePrimaryAction">
          {{ primaryLabel }}
        </a-button>
        <a-button v-if="canRetry" size="small" @click="handleRetry">重试</a-button>
      </template>
    </div>

    <footer class="footer">
      <a-button type="link" size="small" @click="handleOpenXunlei">打开迅雷页面</a-button>
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

.result {
  margin-top: 10px;
  margin-bottom: 0;
}

.meta {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin: 6px 0 10px;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
}

.meta .warn {
  color: #d46b08;
}

.shortcut {
  flex-shrink: 0;
  color: rgba(0, 0, 0, 0.35);
}

.result-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

.footer {
  display: flex;
  justify-content: center;
  gap: 16px;
  margin-top: 6px;
}
</style>
