<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
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

const PHASE_COLORS: Record<string, string> = {
  PHASE_TYPE_RUNNING: 'processing',
  PHASE_TYPE_PENDING: 'default',
  PHASE_TYPE_PAUSED: 'warning',
  PHASE_TYPE_ERROR: 'error',
  PHASE_TYPE_COMPLETE: 'success',
};

const scope = ref<'ing' | 'done'>('ing');
const tasks = ref<TaskSummary[]>([]);
const loading = ref(false);
const errorText = ref('');
const errorCode = ref<string>('');
/** 服务端建议的刷新间隔（秒），夹在 2-10 之间 */
const intervalSeconds = ref(3);
const pendingIds = ref<Set<string>>(new Set());

let timer: ReturnType<typeof setTimeout> | null = null;

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

const speedText = (task: TaskSummary): string =>
  task.phase === 'PHASE_TYPE_RUNNING' ? `${bytes(task.speed)}/s` : bytes(task.checkedSize);

const schedule = () => {
  if (timer) clearTimeout(timer);
  const delay = Math.min(10, Math.max(2, intervalSeconds.value)) * 1000;
  timer = setTimeout(() => void load(true), delay);
};

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
      tasks.value = [];
      return;
    }
    if (!response.ok) {
      errorText.value = response.message || '读取下载任务失败';
      errorCode.value = response.code ?? 'unknown';
      tasks.value = [];
      return;
    }
    errorText.value = '';
    errorCode.value = '';
    tasks.value = response.tasks;
    if (response.expiresIn) intervalSeconds.value = response.expiresIn;
  } catch (error) {
    errorText.value = (error as Error).message || '读取下载任务失败';
    errorCode.value = 'unknown';
    tasks.value = [];
  } finally {
    loading.value = false;
    schedule();
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
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <div class="tasks">
    <div class="toolbar">
      <a-radio-group v-model:value="scope" size="small" button-style="solid" @change="void load()">
        <a-radio-button value="ing">进行中</a-radio-button>
        <a-radio-button value="done">已完成</a-radio-button>
      </a-radio-group>
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
      <a-empty v-if="!errorText && !loading && tasks.length === 0" description="暂无任务" />
      <ul v-else class="list">
        <li v-for="task in tasks" :key="task.id" class="item">
          <div class="row">
            <span class="name" :title="task.name">{{ task.name }}</span>
            <a-tag :color="PHASE_COLORS[task.phase] ?? 'default'">
              {{ PHASE_LABELS[task.phase] ?? task.phase }}
            </a-tag>
          </div>
          <a-progress
            :percent="Math.max(0, Math.min(100, task.progress))"
            size="small"
            :status="task.phase === 'PHASE_TYPE_ERROR' ? 'exception' : task.phase === 'PHASE_TYPE_COMPLETE' ? 'success' : 'active'"
          />
          <div class="meta">
            <span>{{ speedText(task) }} / {{ bytes(task.totalSize) }}</span>
            <span v-if="task.realPath" class="path" :title="task.realPath">{{ task.realPath }}</span>
          </div>
          <div v-if="task.message" class="message">{{ task.message }}</div>
          <div class="ops">
            <a-button
              v-if="task.phase === 'PHASE_TYPE_RUNNING' || task.phase === 'PHASE_TYPE_PENDING'"
              size="small"
              :disabled="pendingIds.has(task.id)"
              @click="void runAction(task, 'operate', 'PHASE_TYPE_PAUSED')"
            >
              暂停
            </a-button>
            <a-button
              v-else-if="task.phase === 'PHASE_TYPE_PAUSED' || task.phase === 'PHASE_TYPE_ERROR'"
              size="small"
              :disabled="pendingIds.has(task.id)"
              @click="void runAction(task, 'operate', 'PHASE_TYPE_RUNNING')"
            >
              继续
            </a-button>
            <a-popconfirm
              title="删除后迅雷会同时移除已下载的文件，确定？"
              ok-text="删除"
              cancel-text="取消"
              @confirm="void runAction(task, 'delete')"
            >
              <a-button size="small" danger :disabled="pendingIds.has(task.id)">删除</a-button>
            </a-popconfirm>
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
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.error {
  margin-bottom: 8px;
}

.link {
  margin-left: 6px;
}

.list {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 340px;
  overflow-y: auto;
}

.item {
  padding: 8px 0;
  border-bottom: 1px solid #f0f0f0;
}

.item:last-child {
  border-bottom: none;
}

.row {
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
  font-weight: 500;
  color: rgba(0, 0, 0, 0.88);
}

.meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
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

.message {
  margin-top: 2px;
  font-size: 12px;
  color: #d46b08;
}

.ops {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 6px;
}
</style>
