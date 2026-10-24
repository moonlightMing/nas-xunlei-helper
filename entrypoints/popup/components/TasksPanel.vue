<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { message } from 'ant-design-vue';
import type { ListTasksResponse, TaskActionResponse, TaskSummary } from '@/utils/messaging';
import { getSendErrorMeta, type SendErrorCode } from '@/utils/sendErrors';
import type { XunleiPhase } from '@/utils/xunleiApi';

const PHASE_LABELS: Record<string, string> = {
  PHASE_TYPE_PENDING: '等待中',
  PHASE_TYPE_RUNNING: '下载中',
  PHASE_TYPE_PAUSED: '已暂停',
  PHASE_TYPE_ERROR: '失败',
  PHASE_TYPE_COMPLETE: '已完成',
};

const PHASE_TONES: Record<string, string> = {
  PHASE_TYPE_RUNNING: 'running',
  PHASE_TYPE_PENDING: 'pending',
  PHASE_TYPE_PAUSED: 'paused',
  PHASE_TYPE_ERROR: 'error',
  PHASE_TYPE_COMPLETE: 'done',
};

const scopeOptions = [
  { label: '进行中', value: 'ing' },
  { label: '已完成', value: 'done' },
];

const scope = ref<'ing' | 'done'>('ing');
const tasks = ref<TaskSummary[]>([]);
const loading = ref(false);
const errorText = ref('');
const errorCode = ref<string>('');
/** 服务端建议的刷新间隔（秒），夹在 2-10 之间 */
const intervalSeconds = ref(3);
const pendingIds = ref<Set<string>>(new Set());
const listRef = ref<HTMLElement | null>(null);

let timer: ReturnType<typeof setTimeout> | null = null;
let fitKey = '';
/** 卸载后不再排下一轮轮询，避免在途请求返回时又把定时器拉起来 */
let unmounted = false;

const bytes = (value: number): string => {
  if (!value || value < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
};

const statusTone = (phase: string): string => PHASE_TONES[phase] ?? 'pending';

const messageTone = (phase: string): string => {
  if (phase === 'PHASE_TYPE_ERROR') return 'error';
  if (phase === 'PHASE_TYPE_PAUSED') return 'warn';
  return 'info';
};

const statText = (task: TaskSummary): string => {
  const percent = `${Math.max(0, Math.min(100, Math.round(task.progress)))}%`;
  if (task.phase === 'PHASE_TYPE_COMPLETE') return bytes(task.totalSize);
  if (task.phase === 'PHASE_TYPE_RUNNING') {
    return `${percent} · ${bytes(task.speed)}/s · ${bytes(task.totalSize)}`;
  }
  return `${percent} · ${bytes(task.checkedSize)} / ${bytes(task.totalSize)}`;
};

const schedule = () => {
  if (timer) clearTimeout(timer);
  if (unmounted) return;
  const delay = Math.min(10, Math.max(2, intervalSeconds.value)) * 1000;
  timer = setTimeout(() => void load(true), delay);
};

/** 弹窗被浏览器限高时压缩列表，让滚动留在列表内部，不给整个页面加滚动条 */
const fitListHeight = async () => {
  const key = `${scope.value}:${tasks.value.length}`;
  if (key === fitKey) return;
  fitKey = key;

  const listEl = listRef.value;
  if (!listEl) return;
  listEl.style.maxHeight = '';
  await nextTick();

  for (let i = 0; i < 3; i += 1) {
    const doc = document.documentElement;
    const overflow = doc.scrollHeight - doc.clientHeight;
    if (overflow <= 0) break;
    const height = listEl.getBoundingClientRect().height;
    listEl.style.maxHeight = `${Math.max(120, Math.round(height - overflow - 2))}px`;
    await nextTick();
  }
};

/** 静默轮询失败时保留旧列表，只叠加错误提示，避免列表闪空再恢复 */
const load = async (silent = false) => {
  if (!silent) loading.value = true;
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'tasks',
      action: 'list',
      data: { tab: scope.value, limit: 50 },
    })) as ListTasksResponse | undefined;
    if (!response) {
      errorText.value = '后台无响应，请确认扩展已重载';
      errorCode.value = 'unknown';
      if (!silent) tasks.value = [];
      return;
    }
    if (!response.ok) {
      errorText.value = response.message || '读取下载任务失败';
      errorCode.value = response.code ?? 'unknown';
      if (!silent) tasks.value = [];
      return;
    }
    errorText.value = '';
    errorCode.value = '';
    tasks.value = response.tasks;
    if (response.expiresIn) intervalSeconds.value = response.expiresIn;
  } catch (error) {
    errorText.value = (error as Error).message || '读取下载任务失败';
    errorCode.value = 'unknown';
    if (!silent) tasks.value = [];
  } finally {
    loading.value = false;
    schedule();
    void fitListHeight();
  }
};

const runAction = async (task: TaskSummary, action: 'operate' | 'delete', phase?: XunleiPhase) => {
  if (pendingIds.value.has(task.id)) return;
  pendingIds.value = new Set(pendingIds.value).add(task.id);
  try {
    const data = action === 'delete' ? { ids: [task.id] } : { id: task.id, phase };
    const response = (await chrome.runtime.sendMessage({
      type: 'tasks',
      action,
      data,
    })) as TaskActionResponse | undefined;
    if (!response?.ok) {
      message.error(response?.message || (action === 'delete' ? '删除失败' : '操作失败'));
      return;
    }
    message.success(response.message ?? '已处理');
    await load(true);
  } catch (error) {
    message.error((error as Error).message || '操作失败');
  } finally {
    const next = new Set(pendingIds.value);
    next.delete(task.id);
    pendingIds.value = next;
  }
};

const handleOpenXunlei = async () => {
  await chrome.runtime.sendMessage({ type: 'xunlei', action: 'open' });
  window.close();
};

const errorMeta = () => (errorCode.value ? getSendErrorMeta(errorCode.value as SendErrorCode) : null);

onMounted(() => void load());
onBeforeUnmount(() => {
  unmounted = true;
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <div class="tasks">
    <div class="toolbar">
      <a-segmented
        v-model:value="scope"
        :options="scopeOptions"
        size="small"
        @change="void load()"
      />
      <a-button size="small" :loading="loading" @click="void load()">刷新</a-button>
    </div>

    <a-alert v-if="errorText" type="warning" show-icon class="error">
      <template #message>{{ errorText }}</template>
      <template #description>
        <span>{{ errorMeta()?.hint }}</span>
        <a v-if="tasks.length === 0" class="link" @click="handleOpenXunlei">打开迅雷页面</a>
      </template>
    </a-alert>

    <a-spin :spinning="loading && tasks.length === 0">
      <p v-if="!errorText && !loading && tasks.length === 0" class="empty">
        {{ scope === 'ing' ? '暂无进行中的任务' : '暂无已完成任务' }}
      </p>
      <ul v-else ref="listRef" class="list">
        <li
          v-for="task in tasks"
          :key="task.id"
          class="item"
          :class="{ 'is-complete': task.phase === 'PHASE_TYPE_COMPLETE' }"
        >
          <div class="item-head">
            <span class="name" :title="task.name">{{ task.name }}</span>
            <span class="status" :class="statusTone(task.phase)">
              <i class="status-dot" />
              {{ PHASE_LABELS[task.phase] ?? task.phase }}
            </span>
            <span class="actions">
              <button
                v-if="task.phase === 'PHASE_TYPE_RUNNING' || task.phase === 'PHASE_TYPE_PENDING'"
                type="button"
                class="act"
                title="暂停"
                aria-label="暂停"
                :disabled="pendingIds.has(task.id)"
                @click="void runAction(task, 'operate', 'PHASE_TYPE_PAUSED')"
              >
                <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9.5 5.5v13M14.5 5.5v13" />
                </svg>
              </button>
              <button
                v-else-if="task.phase === 'PHASE_TYPE_PAUSED' || task.phase === 'PHASE_TYPE_ERROR'"
                type="button"
                class="act"
                title="继续"
                aria-label="继续"
                :disabled="pendingIds.has(task.id)"
                @click="void runAction(task, 'operate', 'PHASE_TYPE_RUNNING')"
              >
                <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M8.5 6v12c0 .8.9 1.3 1.6.9l9.5-6c.6-.4.6-1.3 0-1.7l-9.5-6c-.7-.5-1.6 0-1.6.8z" />
                </svg>
              </button>
              <a-popconfirm
                title="删除后迅雷会同时移除已下载的文件，确定？"
                ok-text="删除"
                cancel-text="取消"
                @confirm="void runAction(task, 'delete')"
              >
                <button
                  type="button"
                  class="act danger"
                  title="删除"
                  aria-label="删除"
                  :disabled="pendingIds.has(task.id)"
                >
                  <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4.5 6.6h15" />
                    <path d="M10 6.6V5.4c0-.8.6-1.4 1.4-1.4h1.2c.8 0 1.4.6 1.4 1.4v1.2" />
                    <path d="M6.6 6.6l.9 12c.06.9.8 1.6 1.7 1.6h5.6c.9 0 1.64-.7 1.7-1.6l.9-12" />
                    <path d="M10 10.6v6.2M14 10.6v6.2" />
                  </svg>
                </button>
              </a-popconfirm>
            </span>
          </div>
          <a-progress
            v-if="task.phase !== 'PHASE_TYPE_COMPLETE'"
            :percent="Math.max(0, Math.min(100, task.progress))"
            size="small"
            :show-info="false"
            :status="task.phase === 'PHASE_TYPE_ERROR' ? 'exception' : 'active'"
          />
          <div class="item-meta">
            <span class="stat">{{ statText(task) }}</span>
            <span v-if="task.realPath" class="path" :title="task.realPath">{{ task.realPath }}</span>
          </div>
          <div
            v-if="task.message && task.phase !== 'PHASE_TYPE_COMPLETE'"
            class="message"
            :class="messageTone(task.phase)"
          >
            {{ task.message }}
          </div>
        </li>
      </ul>
    </a-spin>
  </div>
</template>

<style scoped>
.tasks {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.error {
  margin-bottom: 0;
}

.link {
  margin-left: 6px;
}

/* auto 上下边距让空提示在拉伸后的面板里垂直居中（a-spin 有两层包装需要一起拉伸） */
.tasks :deep(.ant-spin-nested-loading),
.tasks :deep(.ant-spin-container) {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.empty {
  margin: auto 0;
  padding: 24px 0;
  text-align: center;
  font-size: 13px;
  color: rgba(0, 0, 0, 0.35);
}

.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 340px;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: rgba(0, 0, 0, 0.18) transparent;
}

.list::-webkit-scrollbar {
  width: 6px;
}

.list::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.18);
  border-radius: 3px;
}

.item {
  min-width: 0;
  padding: 9px 12px 8px;
  border: 1px solid #f0f0f0;
  border-radius: 10px;
  background: #fafbfc;
}

.item-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  color: rgba(0, 0, 0, 0.88);
}

.status {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
}

.status-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

.status.running {
  color: #0958d9;
  background: #e8f1ff;
}

.status.pending {
  color: #8c8c8c;
  background: #f2f3f5;
}

.status.paused {
  color: #d46b08;
  background: #fff4e6;
}

.status.error {
  color: #cf1322;
  background: #fff1f0;
}

.status.done {
  color: #389e0d;
  background: #f0f9eb;
}

.item :deep(.ant-progress.ant-progress-line) {
  margin-inline-end: 0;
}

.item :deep(.ant-progress) {
  margin-top: 7px;
}

.item :deep(.ant-progress-inner) {
  background: rgba(0, 0, 0, 0.06);
}

.item-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-top: 3px;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
}

.stat {
  flex: none;
  font-variant-numeric: tabular-nums;
}

.path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  color: rgba(0, 0, 0, 0.35);
}

.item.is-complete .item-meta {
  margin-top: 8px;
}

.message {
  margin-top: 4px;
  font-size: 12px;
}

.message.info {
  color: rgba(0, 0, 0, 0.45);
}

.message.warn {
  color: #d46b08;
}

.message.error {
  color: #cf1322;
}

/* 操作收进标题行右上角：默认灰、悬停才显色，删除保持二次确认 */
.actions {
  flex: none;
  display: inline-flex;
  gap: 2px;
  margin-left: 2px;
}

.act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: rgba(0, 0, 0, 0.35);
  cursor: pointer;
  transition:
    background-color 0.15s,
    color 0.15s;
}

.act:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.05);
  color: rgba(0, 0, 0, 0.65);
}

.act:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.act.danger:hover:not(:disabled) {
  background: #fff1f0;
  color: #cf1322;
}

.ico {
  display: block;
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
