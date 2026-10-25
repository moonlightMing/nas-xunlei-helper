<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import { parseLinks } from '@/utils/links';
import type { SendLinksResponse } from '@/utils/messaging';
import { getSendErrorMeta } from '@/utils/sendErrors';

const props = defineProps<{ settingsReady: boolean }>();

const linksText = ref('');
const sending = ref(false);
const result = ref<SendLinksResponse | null>(null);

const parsed = computed(() => parseLinks(linksText.value));
const linkCount = computed(() => parsed.value.links.length);
const paused = computed(() => Boolean(result.value?.paused));
const resultMeta = computed(() =>
  result.value && (!result.value.ok || paused.value) ? getSendErrorMeta(result.value.code) : null,
);
const pathFallback = computed(() =>
  Boolean(result.value?.ok && result.value.pathApplied?.needed && !result.value.pathApplied.applied),
);
const matchWarning = computed(() => {
  const match = result.value?.match;
  return Boolean(
    result.value?.ok && !paused.value && match && (match.status === 'partial' || match.status === 'empty'),
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
const isDuplicate = computed(() => result.value?.code === 'duplicate-task');

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

watch(linksText, () => {
  if (result.value) result.value = null;
});

const submit = async (force: boolean) => {
  if (sending.value) return;
  const links = parsed.value.links;
  if (!links.length) {
    message.warning(parsed.value.unsupported.length ? '没有受支持的下载链接' : '请先粘贴至少一个下载链接');
    return;
  }

  sending.value = true;
  result.value = null;
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'download',
      action: 'sendLinks',
      data: { links, source: 'popup', force },
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

const handleSend = () => {
  void submit(false);
};

/** 重复资源防呆被拦下后，由用户显式确认覆盖旧任务记录 */
const handleForceSend = () => {
  void submit(true);
};

const handleKeydown = (event: KeyboardEvent) => {
  // 快捷键与按钮走同一可用条件，避免绕过 settingsReady 直接发送
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    if (props.settingsReady) void submit(false);
  }
};

const handleOpenSettings = async () => {
  await chrome.runtime.openOptionsPage();
  window.close();
};

const handleOpenXunlei = async () => {
  await chrome.runtime.sendMessage({ type: 'xunlei', action: 'open' });
  window.close();
};

const handlePrimaryAction = () => {
  if (primaryAction.value === 'open-options') void handleOpenSettings();
  else void handleOpenXunlei();
};
</script>

<template>
  <div class="send">
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
      :disabled="!settingsReady"
      @click="handleSend"
    >
      {{ sending ? '正在发送到 NAS…' : '发送到 NAS 迅雷' }}
    </a-button>

    <a-alert v-if="result" :type="resultType" show-icon class="notice" aria-live="polite">
      <template #message>{{ result.message }}</template>
      <template v-if="resultMeta?.hint && (!result.ok || paused)" #description>
        {{ resultMeta.hint }}
      </template>
    </a-alert>

    <div
      v-if="result && (isDuplicate || paused || matchWarning || pathFallback || (!result.ok && (primaryAction || canRetry)))"
      class="result-actions"
    >
      <template v-if="isDuplicate">
        <a-popconfirm
          title="重发会顶掉 NAS 上原有的同资源任务记录，确定？"
          ok-text="仍然发送"
          cancel-text="取消"
          @confirm="handleForceSend"
        >
          <a-button size="small" type="primary" :disabled="sending">仍然发送</a-button>
        </a-popconfirm>
        <a-button size="small" @click="handleOpenXunlei">查看原任务</a-button>
      </template>
      <template v-else-if="paused || matchWarning || pathFallback">
        <a-button size="small" @click="handleOpenXunlei">打开迅雷</a-button>
        <a-button size="small" @click="handleOpenSettings">打开设置</a-button>
      </template>
      <template v-else>
        <a-button v-if="primaryAction" size="small" @click="handlePrimaryAction">
          {{ primaryLabel }}
        </a-button>
        <a-button v-if="canRetry" size="small" @click="handleSend">重试</a-button>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 内容超出弹窗剩余高度时在页签内部滚动，页脚始终可见（滚动条按需出现）。
   basis auto 让内容高度参与弹窗自动计高；
   弹窗被浏览器限高、#app 钉到视口后这里高度确定，子项不收缩、整体滚动 */
.send {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.send > :deep(*) {
  flex-shrink: 0;
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

.notice {
  margin-top: 10px;
  margin-bottom: 0;
}

.result-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
</style>
