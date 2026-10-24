<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { message as antMessage } from 'ant-design-vue';
import { classifyFileCategory, formatFileSize, getExtension } from '@/utils/avMatch';
import {
  buildConfirmTree,
  getPendingConfirmation,
  PENDING_TTL_MS,
  type ConfirmFile,
  type ConfirmSelectionInput,
  type ConfirmTask,
  type ConfirmTreeNode,
  type PendingConfirmation,
} from '@/utils/confirm';

interface TaskState {
  included: boolean;
  name: string;
  selected: Set<string>;
  wholePackage: boolean;
  collapsed: string[];
}

interface FlatRow {
  key: string;
  depth: number;
  isDir: boolean;
  name: string;
  size: number;
  file?: ConfirmFile;
  expanded: boolean;
}

interface TypeTag {
  key: string;
  label: string;
  active: boolean;
}

interface ResultState {
  tone: 'ok' | 'warn' | 'error';
  title: string;
  message: string;
  showXunlei: boolean;
  /** 后台保留了待确认状态，可直接重试提交 */
  retryable?: boolean;
}

const theme = {
  token: {
    colorPrimary: '#3f85ff',
    colorLink: '#3f85ff',
    borderRadius: 4,
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', sans-serif",
  },
};

const pending = ref<PendingConfirmation | null>(null);
const loading = ref(true);
const fatal = ref('');
const submitting = ref(false);
const result = ref<ResultState | null>(null);
const selectedPath = ref('');
const taskStates = reactive<Record<string, TaskState>>({});

const stateOf = (index: number): TaskState =>
  taskStates[String(index)] ?? { included: false, name: '', selected: new Set(), wholePackage: false, collapsed: [] };

const isSingle = computed(() => pending.value?.tasks.length === 1);

const pathOptions = computed(() =>
  (pending.value?.paths ?? []).map((item) => ({ label: item.path, value: item.id })),
);

const sizeText = (value: number): string => (value > 0 ? formatFileSize(value) : '0 B');

function collectDirKeys(nodes: ConfirmTreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.isDir) {
      out.push(node.key);
      collectDirKeys(node.children, out);
    }
  }
  return out;
}

function initialize(data: PendingConfirmation): void {
  pending.value = data;
  selectedPath.value = data.parentFolderId;
  data.tasks.forEach((task, index) => {
    const collapsed =
      task.files.length > 200 ? collectDirKeys(buildConfirmTree(task.files)) : [];
    taskStates[String(index)] = {
      included: task.kind === 'direct' ? true : task.preselectedIds.length > 0,
      name: task.name,
      selected: new Set(task.preselectedIds),
      wholePackage: task.wholePackageDefault,
      collapsed,
    };
  });
  startTtlCountdown(data);
}

// 30 分钟有效期只靠后台 SW 重启剪裁，窗口里要自己感知剩余时间并过期禁提交
const expiresAt = ref(0);
const expired = ref(false);
const remainingText = ref('');
let ttlTimer: number | undefined;

function startTtlCountdown(data: PendingConfirmation): void {
  expiresAt.value = data.createdAt + PENDING_TTL_MS;
  expired.value = Date.now() >= expiresAt.value;
  if (ttlTimer !== undefined) window.clearInterval(ttlTimer);
  const tick = () => {
    const rest = expiresAt.value - Date.now();
    if (rest <= 0) {
      expired.value = true;
      remainingText.value = '已过期';
      if (ttlTimer !== undefined) window.clearInterval(ttlTimer);
      return;
    }
    const minutes = Math.floor(rest / 60_000);
    const seconds = Math.floor((rest % 60_000) / 1000);
    remainingText.value = `${minutes}:${String(seconds).padStart(2, '0')}`;
  };
  tick();
  if (!expired.value) ttlTimer = window.setInterval(tick, 1000);
}

onBeforeUnmount(() => {
  if (ttlTimer !== undefined) window.clearInterval(ttlTimer);
});

onMounted(async () => {
  void fitWindowToZoom();
  const id = new URLSearchParams(location.search).get('id') ?? '';
  if (!id) {
    fatal.value = '缺少确认参数，请从发送弹窗重新发起。';
    loading.value = false;
    return;
  }
  try {
    const data = await getPendingConfirmation(id);
    if (!data) {
      fatal.value = '确认已失效或已完成，请重新发送链接。';
      return;
    }
    initialize(data);
  } catch (error) {
    fatal.value = (error as Error).message || '读取确认信息失败';
  } finally {
    loading.value = false;
  }
});

/**
 * 浏览器缩放会同比缩小扩展页面的 CSS 视口。后台创建窗口后立即取缩放
 * 有时还拿不到生效值，这里在页面加载后再校正一次，只放大不缩小。
 */
async function fitWindowToZoom(): Promise<void> {
  try {
    const zoom = await chrome.tabs.getZoom();
    if (!(zoom > 1.05)) return;
    const win = await chrome.windows.getCurrent();
    if (win?.id == null) return;
    const width = Math.min(1000, Math.round(560 * zoom));
    const height = Math.min(1000, Math.round(760 * zoom));
    if ((win.width ?? 0) >= width && (win.height ?? 0) >= height) return;
    await chrome.windows.update(win.id, {
      width: Math.max(win.width ?? 0, width),
      height: Math.max(win.height ?? 0, height),
    });
  } catch {
    /* 无法读取缩放时保持后台创建的尺寸 */
  }
}

function rowsFor(index: number, task: ConfirmTask): FlatRow[] {
  const state = stateOf(index);
  const walk = (nodes: ConfirmTreeNode[], depth: number): FlatRow[] =>
    nodes.flatMap((node) => {
      if (node.isDir) {
        const expanded = !state.collapsed.includes(node.key);
        return [
          {
            key: node.key,
            depth,
            isDir: true,
            name: node.name,
            size: node.size,
            expanded,
          },
          ...(expanded ? walk(node.children, depth + 1) : []),
        ];
      }
      return [
        {
          key: node.key,
          depth,
          isDir: false,
          name: node.name,
          size: node.size,
          file: node.file,
          expanded: false,
        },
      ];
    });
  return walk(buildConfirmTree(task.files), 0);
}

function toggleFolder(index: number, key: string): void {
  const state = stateOf(index);
  state.collapsed = state.collapsed.includes(key)
    ? state.collapsed.filter((item) => item !== key)
    : [...state.collapsed, key];
}

function setFile(index: number, fileId: string, checked: boolean): void {
  const state = stateOf(index);
  const next = new Set(state.selected);
  if (checked) next.add(fileId);
  else next.delete(fileId);
  state.selected = next;
}

function onFileChange(index: number, fileId: string, event: { target?: { checked?: boolean } }): void {
  setFile(index, fileId, Boolean(event?.target?.checked));
}

function toggleAll(index: number, task: ConfirmTask): void {
  const state = stateOf(index);
  const all = task.files.length > 0 && task.files.every((file) => state.selected.has(file.id));
  state.selected = all ? new Set() : new Set(task.files.map((file) => file.id));
}

function resetDefault(index: number, task: ConfirmTask): void {
  const state = stateOf(index);
  state.selected = new Set(task.preselectedIds);
  state.wholePackage = task.wholePackageDefault;
}

function typeTags(index: number, task: ConfirmTask): TypeTag[] {
  const state = stateOf(index);
  const groups = new Map<string, string[]>();
  for (const file of task.files) {
    const label = getExtension(file.name) || '其他';
    const list = groups.get(label) ?? [];
    list.push(file.id);
    groups.set(label, list);
  }
  return [...groups.entries()].slice(0, 12).map(([label, ids]) => ({
    key: label,
    label,
    active: ids.every((id) => state.selected.has(id)),
  }));
}

function toggleType(index: number, task: ConfirmTask, key: string): void {
  const state = stateOf(index);
  const ids = task.files
    .filter((file) => (getExtension(file.name) || '其他') === key)
    .map((file) => file.id);
  if (!ids.length) return;
  const all = ids.every((id) => state.selected.has(id));
  const next = new Set(state.selected);
  for (const id of ids) {
    if (all) next.delete(id);
    else next.add(id);
  }
  state.selected = next;
}

function allActive(index: number, task: ConfirmTask): boolean {
  const state = stateOf(index);
  return task.files.length > 0 && task.files.every((file) => state.selected.has(file.id));
}

function defaultActive(index: number, task: ConfirmTask): boolean {
  const state = stateOf(index);
  if (state.wholePackage !== task.wholePackageDefault) return false;
  // 预选就是全选时只高亮「全选」，避免两个标签同时点亮
  if (task.files.length > 0 && task.preselectedIds.length === task.files.length) return false;
  if (state.selected.size !== task.preselectedIds.length) return false;
  return task.preselectedIds.every((id) => state.selected.has(id));
}

function selectedFiles(index: number, task: ConfirmTask): ConfirmFile[] {
  const state = stateOf(index);
  return task.files.filter((file) => state.selected.has(file.id));
}

function selectedSummary(index: number, task: ConfirmTask): string {
  const files = selectedFiles(index, task);
  return `已选 ${files.length} 个文件，共 ${sizeText(files.reduce((sum, file) => sum + file.size, 0))}`;
}

function taskIncluded(index: number, task: ConfirmTask): boolean {
  const state = stateOf(index);
  if (task.kind === 'direct') return state.included;
  if (task.selectionDisabled) return state.wholePackage;
  return state.selected.size > 0;
}

const includedCount = computed(() => {
  const data = pending.value;
  if (!data) return 0;
  return data.tasks.filter((task, index) => taskIncluded(index, task)).length;
});

const totalSelectedSize = computed(() => {
  const data = pending.value;
  if (!data) return 0;
  return data.tasks.reduce((sum, task, index) => {
    if (!taskIncluded(index, task)) return sum;
    const state = stateOf(index);
    if (task.kind === 'direct' || task.selectionDisabled) return sum + task.size;
    return sum + selectedFiles(index, task).reduce((inner, file) => inner + file.size, 0);
  }, 0);
});

const totalSelectedSizeText = computed(() =>
  totalSelectedSize.value > 0 ? sizeText(totalSelectedSize.value) : '大小未知',
);

const canSubmit = computed(
  () => !submitting.value && !expired.value && includedCount.value > 0,
);

function toneFor(file: ConfirmFile): string {
  return `cat-${classifyFileCategory(file.name)}`;
}

async function handleSubmit(): Promise<void> {
  const data = pending.value;
  if (!data || submitting.value || expired.value) return;
  // 从失败结果页重试时先清掉旧结果，回到编辑/提交态
  result.value = null;
  const single = data.tasks.length === 1;
  const selections: ConfirmSelectionInput[] = data.tasks.map((task, index) => {
    const state = stateOf(index);
    const name = single ? state.name.trim() : undefined;
    if (task.kind === 'direct') {
      return { link: task.link, include: state.included, name };
    }
    if (task.selectionDisabled) {
      return {
        link: task.link,
        include: state.wholePackage,
        name,
        wholePackage: state.wholePackage,
      };
    }
    return {
      link: task.link,
      include: state.selected.size > 0,
      name,
      selectedIds: [...state.selected],
    };
  });

  if (!selections.some((item) => item.include)) {
    antMessage.warning('请至少选择一个要下载的文件或任务');
    return;
  }

  submitting.value = true;
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'confirm',
      action: 'submit',
      data: { id: data.id, selections, parentFolderId: selectedPath.value },
    })) as
      | { ok?: boolean; message?: string; paused?: { reason?: string }; retryable?: boolean }
      | undefined;
    if (!response) {
      result.value = {
        tone: 'error',
        title: '后台无响应',
        message: '请关闭窗口后重新发送；如果扩展刚重载过，请重试一次。',
        showXunlei: false,
      };
      return;
    }
    const paused = Boolean(response.paused);
    const ok = Boolean(response.ok) && !paused;
    result.value = {
      tone: ok ? 'ok' : paused ? 'warn' : 'error',
      title: ok ? '已发送到 NAS 迅雷' : paused ? '未创建下载' : '创建下载失败',
      message:
        response.message ||
        (ok ? '任务已创建，可到迅雷页面查看进度。' : response.retryable ? '可重试提交。' : '请稍后重试。'),
      showXunlei: ok,
      retryable: !ok && !paused && Boolean(response.retryable),
    };
  } catch (error) {
    result.value = {
      tone: 'error',
      title: '提交失败',
      message: (error as Error).message || '无法连接扩展后台',
      showXunlei: false,
    };
  } finally {
    submitting.value = false;
  }
}

async function handleCancel(): Promise<void> {
  const data = pending.value;
  if (data) {
    try {
      await chrome.runtime.sendMessage({ type: 'confirm', action: 'cancel', data: { id: data.id } });
    } catch {
      /* 窗口关闭优先，取消消息失败时后台会在窗口关闭事件里兜底 */
    }
  }
  window.close();
}

async function handleOpenXunlei(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'xunlei', action: 'open' });
  } catch {
    /* ignore */
  }
  closeWindow();
}

function closeWindow(): void {
  window.close();
}
</script>

<template>
  <a-config-provider :theme="theme">
    <div class="page">
      <div class="dialog">
        <div v-if="loading" class="state">
          <a-spin />
          <p>正在读取解析结果…</p>
        </div>

        <div v-else-if="fatal" class="state">
          <div class="state-icon error">!</div>
          <p class="state-title">无法打开确认窗口</p>
          <p class="state-message">{{ fatal }}</p>
          <a-button @click="closeWindow">关闭</a-button>
        </div>

        <template v-else-if="result">
          <div class="result">
            <div class="state-icon" :class="result.tone">
              {{ result.tone === 'ok' ? '✓' : '!' }}
            </div>
            <p class="state-title">{{ result.title }}</p>
            <p class="state-message">{{ result.message }}</p>
            <div class="result-actions">
              <a-button v-if="result.retryable" type="primary" :loading="submitting" @click="handleSubmit">
                重试提交
              </a-button>
              <a-button v-if="result.showXunlei" type="primary" @click="handleOpenXunlei">
                打开迅雷页面
              </a-button>
              <a-button @click="closeWindow">关闭</a-button>
            </div>
          </div>
        </template>

        <template v-else-if="pending">
          <header class="dialog-head">
            <span class="dialog-title">
              {{ isSingle ? '新建下载任务' : `确认下载（${pending.tasks.length} 个任务）` }}
            </span>
            <span class="dialog-ttl" :class="{ danger: expired || remainingText === '0:00' }">
              {{ expired ? '确认已超时，请关闭后重新发送' : `有效期剩余 ${remainingText}` }}
            </span>
          </header>

          <div class="dialog-body">
            <div v-if="pending.matchText" class="info">{{ pending.matchText }}</div>
            <div
              v-if="pending.pathApplied?.needed && !pending.pathApplied.applied"
              class="info warn"
            >
              {{ pending.pathApplied.reason || '设置中的保存目录不可用，已回退到迅雷默认目录。' }}
            </div>

            <section
              v-for="(task, index) in pending.tasks"
              :key="task.link"
              class="task"
              :class="{ excluded: !taskIncluded(index, task) }"
            >
              <div class="task-head">
                <a-checkbox
                  v-if="task.kind === 'direct'"
                  v-model:checked="stateOf(index).included"
                  class="head-check"
                />
                <div class="task-main">
                  <a-input
                    v-if="isSingle"
                    v-model:value="stateOf(index).name"
                    class="name-input"
                    :maxlength="200"
                    placeholder="任务名称"
                  />
                  <div v-else class="task-name" :title="task.name">{{ task.name }}</div>
                  <div class="task-meta">
                    {{ task.kind === 'direct' ? '直链' : `${task.files.length} 个文件` }}
                    · {{ task.size ? formatFileSize(task.size) : '大小未知' }}
                  </div>
                </div>
              </div>

              <div v-if="task.note" class="task-note">{{ task.note }}</div>

              <template v-if="task.kind === 'bt' && !task.selectionDisabled">
                <div class="tags">
                  <button
                    type="button"
                    class="tag"
                    :class="{ active: defaultActive(index, task) }"
                    @click="resetDefault(index, task)"
                  >
                    默认
                  </button>
                  <button
                    type="button"
                    class="tag"
                    :class="{ active: allActive(index, task) }"
                    @click="toggleAll(index, task)"
                  >
                    全选
                  </button>
                  <button
                    v-for="tag in typeTags(index, task)"
                    :key="tag.key"
                    type="button"
                    class="tag"
                    :class="{ active: tag.active }"
                    @click="toggleType(index, task, tag.key)"
                  >
                    {{ tag.label }}
                  </button>
                </div>
                <div class="selected-line">{{ selectedSummary(index, task) }}</div>

                <div class="tree">
                  <div
                    v-for="row in rowsFor(index, task)"
                    :key="row.key"
                    class="row"
                    :class="{ folder: row.isDir }"
                    :style="{ paddingLeft: `${10 + row.depth * 16}px` }"
                    @click="row.isDir ? toggleFolder(index, row.key) : undefined"
                  >
                    <span class="caret">{{ row.isDir ? (row.expanded ? '▾' : '▸') : '' }}</span>
                    <a-checkbox
                      v-if="!row.isDir && row.file"
                      :checked="stateOf(index).selected.has(row.file.id)"
                      class="row-check"
                      @click.stop
                      @change="onFileChange(index, row.file.id, $event)"
                    />
                    <span v-else class="row-check" />
                    <span
                      v-if="row.file"
                      class="file-dot"
                      :class="toneFor(row.file)"
                      aria-hidden="true"
                    />
                    <span class="row-name" :title="row.file?.path || row.name">{{ row.name }}</span>
                    <span class="row-size">{{ row.size ? formatFileSize(row.size) : '' }}</span>
                  </div>
                </div>
                <div v-if="!taskIncluded(index, task)" class="task-note">
                  未选择文件，不会创建此任务
                </div>
              </template>

              <div v-else-if="task.selectionDisabled" class="task-block">
                <a-checkbox v-model:checked="stateOf(index).wholePackage">
                  整包下载（文件列表不完整，无法逐项选择）
                </a-checkbox>
              </div>

              <div v-else class="task-block muted">该链接没有 BT 文件树，将整包下载。</div>
            </section>

            <div class="path-row">
              <span class="path-label">下载到：</span>
              <a-select
                v-if="pathOptions.length"
                v-model:value="selectedPath"
                :options="pathOptions"
                size="small"
                class="path-select"
              />
              <span v-else class="path-static">迅雷默认目录</span>
            </div>
          </div>

          <footer class="dialog-foot">
            <span class="foot-summary">
              已选 {{ includedCount }} 个任务 · {{ totalSelectedSizeText }}
            </span>
            <div class="foot-actions">
              <a-button :disabled="submitting" @click="handleCancel">取消</a-button>
              <a-button
                type="primary"
                :loading="submitting"
                :disabled="!canSubmit"
                @click="handleSubmit"
              >
                立即下载
              </a-button>
            </div>
          </footer>
        </template>
      </div>
    </div>
  </a-config-provider>
</template>

<style scoped>
/* 自绘窗口即整个弹窗视口，不留外层容器边距 */
.page {
  box-sizing: border-box;
  height: 100%;
}

.dialog {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #fff;
}

.dialog-head {
  flex: none;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 46px;
  border-bottom: 1px solid #f0f0f0;
}

.dialog-ttl {
  position: absolute;
  right: 14px;
  font-size: 12px;
  color: #8c8c8c;
  white-space: nowrap;
}

.dialog-ttl.danger {
  color: #cf1322;
}

.dialog-title {
  max-width: calc(100% - 32px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  font-weight: 500;
  color: #1a1a1a;
}

.dialog-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px 10px;
}

.dialog-foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px 12px;
  border-top: 1px solid #f0f0f0;
}

.foot-summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #8c8c8c;
}

.foot-actions {
  flex: none;
  display: flex;
  gap: 8px;
}

.foot-actions :deep(.ant-btn-primary) {
  min-width: 92px;
}

.info {
  margin-bottom: 10px;
  padding: 6px 10px;
  border-radius: 4px;
  background: #f7f8fa;
  font-size: 12px;
  line-height: 1.6;
  color: #4d4d4d;
  word-break: break-word;
}

.info.warn {
  background: #fff7e6;
  color: #d46b08;
}

.task {
  margin-bottom: 10px;
  border: 1px solid #e6e6e6;
  border-radius: 6px;
  overflow: hidden;
}

.task.excluded {
  opacity: 0.66;
}

.task-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  background: #fafbfc;
}

.head-check {
  flex: none;
}

.task-main {
  flex: 1;
  min-width: 0;
}

.task-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  color: #1a1a1a;
}

.name-input {
  font-size: 14px;
}

.task-meta {
  margin-top: 3px;
  font-size: 12px;
  color: #8c8c8c;
}

.task-note {
  padding: 0 12px 8px;
  font-size: 12px;
  line-height: 1.6;
  color: #d46b08;
}

.task-head + .task-note {
  padding-top: 8px;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px 0;
}

.tag {
  height: 20px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 2px;
  background: #f5f5f5;
  color: #8c8c8c;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}

.tag:hover {
  color: #3f85ff;
}

.tag.active {
  border-color: #3f85ff;
  background: #fff;
  color: #3f85ff;
}

.selected-line {
  padding: 6px 12px 0;
  font-size: 12px;
  color: #4d4d4d;
}

.tree {
  margin-top: 8px;
  max-height: 250px;
  overflow: auto;
  border-top: 1px solid #f0f0f0;
  padding: 4px 0;
}

.row {
  display: flex;
  align-items: center;
  height: 28px;
  padding-right: 10px;
  font-size: 12px;
  color: #4d4d4d;
  cursor: default;
}

.row:hover {
  background: #f7f8fa;
}

.row.folder {
  cursor: pointer;
  color: #1a1a1a;
}

.caret {
  flex: none;
  width: 14px;
  text-align: center;
  font-size: 10px;
  color: #999;
}

.row-check {
  flex: none;
  display: inline-flex;
  width: 18px;
  margin-right: 4px;
}

.row-check:deep(.ant-checkbox-wrapper) {
  margin-inline-end: 0;
}

.file-dot {
  flex: none;
  width: 5px;
  height: 5px;
  margin: 0 6px 0 1px;
  border-radius: 50%;
  background: #bfbfbf;
}

.file-dot.cat-video {
  background: #3f85ff;
}

.file-dot.cat-image {
  background: #52c41a;
}

.file-dot.cat-text {
  background: #faad14;
}

.file-dot.cat-audio {
  background: #9254de;
}

.row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-size {
  flex: none;
  margin-left: 10px;
  font-size: 11px;
  color: #b3b3b3;
  font-variant-numeric: tabular-nums;
}

.task-block {
  padding: 8px 12px 10px;
  font-size: 12px;
  color: #4d4d4d;
}

.task-block.muted {
  color: #8c8c8c;
}

.path-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.path-label {
  flex: none;
  font-size: 13px;
  color: #4d4d4d;
}

.path-select {
  flex: 1;
  min-width: 0;
}

.path-select :deep(.ant-select-selector) {
  font-size: 12px;
}

.path-static {
  font-size: 12px;
  color: #4d4d4d;
}

.state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
  color: #8c8c8c;
  font-size: 12px;
}

.state-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: #1a1a1a;
}

.state-message {
  margin: 0;
  max-width: 420px;
  font-size: 12px;
  line-height: 1.7;
  color: #666;
  word-break: break-word;
}

.state-icon {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: #52c41a;
  color: #fff;
  font-size: 24px;
  font-weight: 700;
}

.state-icon.warn {
  background: #faad14;
}

.state-icon.error {
  background: #ff4d4f;
}

.result {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 24px;
  text-align: center;
}

.result .state-icon {
  margin-bottom: 14px;
}

.result .state-message {
  margin-top: 8px;
}

.result-actions {
  display: flex;
  gap: 10px;
  margin-top: 20px;
}

@media (max-width: 460px) {
  .dialog-body {
    padding: 10px 12px 8px;
  }

  .dialog-foot {
    padding: 8px 12px 10px;
  }

  .tree {
    max-height: 200px;
  }
}
</style>
