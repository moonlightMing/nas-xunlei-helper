<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { message } from 'ant-design-vue';
import {
  buildMatchPlan,
  FILE_CATEGORY_LABELS,
  formatFileSize,
  MATCH_SORT_LABELS,
  type AvMatchSettings,
  type FileListSnapshot,
  type MatchFileReason,
  type SnapshotGroup,
} from '@/utils/avMatch';
import type { ReadDialogFilesResponse } from '@/utils/messaging';

const props = defineProps<{ settings: AvMatchSettings; masterEnabled: boolean }>();

interface PreviewRow {
  key: string;
  group: string;
  name: string;
  path: string;
  category: string;
  size: string;
  codes: string;
  rank: string;
  result: 'keep' | 'drop';
  reason: string;
  source?: string;
}

const REASON_LABELS: Record<MatchFileReason, string> = {
  matched: '命中',
  'type-filtered': '类型过滤',
  'keyword-filtered': '关键词过滤',
  'size-filtered': '大小过滤',
  'code-mismatch': '番号不匹配',
  'over-limit': '超出上限',
};

const taskName = ref('');
const sampleText = ref('');
const groups = ref<SnapshotGroup[]>([]);
const sourceLabel = ref('');
const reading = ref(false);
const readError = ref('');
const readDebug = ref('');
const folderInput = ref<HTMLInputElement | null>(null);

const multiGroup = computed(() => plan.value.groups.length > 1);
const tableScrollX = computed(() => (multiGroup.value ? 700 : 660));
const columns = computed(() => [
  ...(multiGroup.value
    ? [{ title: '任务', dataIndex: 'group', key: 'group', width: 90, ellipsis: true }]
    : []),
  { title: '文件', dataIndex: 'name', key: 'name', width: multiGroup.value ? 170 : 200, ellipsis: true },
  { title: '类型', dataIndex: 'category', key: 'category', width: 80 },
  { title: '大小', dataIndex: 'size', key: 'size', width: 80 },
  { title: '番号', dataIndex: 'codes', key: 'codes', width: 100, ellipsis: true },
  { title: '结果', dataIndex: 'result', key: 'result', width: multiGroup.value ? 180 : 200 },
]);

const snapshot = computed<FileListSnapshot>(() => ({
  kind: 'bt',
  treeHash: '',
  groups: groups.value,
  checkedIds: [],
  buttonDisabled: false,
  truncated: false,
}));

const plan = computed(() =>
  buildMatchPlan(snapshot.value, { ...props.settings, enabled: true }, []),
);
const allCodes = computed(() => [...new Set(plan.value.groups.flatMap((group) => group.codes))]);
const summary = computed(() => plan.value.summary || '暂无预览');
const rows = computed<PreviewRow[]>(() => {
  const result: PreviewRow[] = [];
  for (const group of plan.value.groups) {
    for (const file of group.files) {
      result.push({
        key: `${group.rootId}-${file.id}`,
        group: group.rootName || '未命名任务',
        name: file.name,
        path: file.path,
        category: FILE_CATEGORY_LABELS[file.category],
        size: formatFileSize(file.size),
        codes: file.codes.join('、') || '—',
        rank: file.rank ? String(file.rank) : '',
        result: file.selected ? 'keep' : 'drop',
        reason: REASON_LABELS[file.reason],
        source: file.matchSource === 'manual' ? '手动' : file.matchSource === 'auto' ? '自动' : undefined,
      });
    }
  }
  return result;
});

function parseSizeMB(value: string): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number * 1024 * 1024 : 0;
}

function parseSample(): void {
  const lines = sampleText.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    groups.value = [];
    sourceLabel.value = '';
    return;
  }
  const files = lines
    .slice(0, 5000)
    .map((line, index) => {
      const [namePart, sizePart] = line.split('|');
      const name = (namePart || '').trim();
      return {
        id: `sample-${index}`,
        name,
        path: name,
        size: parseSizeMB(sizePart || ''),
      };
    })
    .filter((file) => file.name);
  groups.value = files.length
    ? [{ rootId: 'sample', rootName: taskName.value.trim() || '示例任务', files }]
    : [];
  sourceLabel.value = `手动样例（${files.length} 个文件）`;
}

function fillExample(): void {
  taskName.value = 'ABC-123';
  sampleText.value = [
    'ABC-123.mp4|4096',
    'ABC-123-CD2.mp4|2048',
    'ABC-1234.mp4|3072',
    'sample.mp4|12',
    'poster.jpg|2',
    'readme.txt|0.01',
  ].join('\n');
  parseSample();
}

function chooseFolder(): void {
  folderInput.value?.click();
}

function handleFolder(event: Event): void {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []).slice(0, 5000);
  const first = files[0];
  if (!first) return;
  const firstPath =
    (first as File & { webkitRelativePath?: string }).webkitRelativePath || first.name;
  const topFolder = firstPath.split('/')[0] || '本地文件夹';
  groups.value = [
    {
      rootId: 'folder',
      rootName: topFolder,
      files: files.map((file, index) => ({
        id: `folder-${index}`,
        name: file.name,
        path:
          (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        size: file.size,
      })),
    },
  ];
  taskName.value = topFolder;
  sourceLabel.value = `本地文件夹：${topFolder}（${files.length} 个文件）`;
  readError.value = '';
  readDebug.value = '';
  input.value = '';
}

async function readDialog(): Promise<void> {
  reading.value = true;
  readError.value = '';
  readDebug.value = '';
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'avMatch',
      action: 'readDialogFiles',
    })) as ReadDialogFilesResponse | undefined;

    if (!response) {
      readError.value = '后台无响应，请重试';
      return;
    }
    if (!response.ok || !response.snapshot) {
      readError.value = response.message || '读取失败';
      readDebug.value = response.debug || '';
      return;
    }
    if (response.snapshot.kind !== 'bt') {
      readError.value = '当前任务没有 BT 文件树（可能是直链任务），不参与番号匹配';
      return;
    }
    if (response.snapshot.truncated) {
      readError.value = '文件超过 5000 个，已停止读取；请手动处理或关闭番号匹配';
      return;
    }
    if (!response.snapshot.groups.length) {
      readError.value = '没有读到文件，请确认迅雷解析已完成';
      return;
    }

    groups.value = response.snapshot.groups;
    taskName.value = response.snapshot.groups[0]?.rootName || '';
    const fileCount = response.snapshot.groups.reduce(
      (count, group) => count + group.files.length,
      0,
    );
    sourceLabel.value = `当前迅雷弹窗（${response.snapshot.groups.length} 个任务，${fileCount} 个文件）`;
    readDebug.value = response.debug || '';
  } catch (error) {
    readError.value = (error as Error).message || '读取失败';
  } finally {
    reading.value = false;
  }
}

onMounted(() => {
  fillExample();
});
</script>

<template>
  <div class="preview">
    <div class="preview-head">
      <div>
        <div class="section-title">规则测试（只读，不上传）</div>
        <div class="hint">
          可以粘贴文件名，或从已经打开的迅雷解析弹窗读取文件列表；这里只做预览，不会创建下载任务。
        </div>
      </div>
      <a-space wrap>
        <a-button size="small" :loading="reading" @click="readDialog">
          读取当前迅雷弹窗
        </a-button>
        <a-button size="small" @click="chooseFolder">选择本地文件夹</a-button>
      </a-space>
    </div>

    <input
      ref="folderInput"
      type="file"
      class="hidden-input"
      webkitdirectory
      multiple
      @change="handleFolder"
    />

    <a-alert
      v-if="!masterEnabled"
      type="info"
      show-icon
      class="tip"
      message="总开关关闭"
      description="以下预览仅用于测试规则；实际发送不会应用。"
    />
    <a-alert v-if="readError" type="warning" show-icon class="tip" :message="readError" />

    <div class="toolbar">
      <a-input
        v-model:value="taskName"
        class="task-input"
        placeholder="任务/种子名称（用于自动识别）"
        @press-enter="parseSample"
      />
      <a-button size="small" @click="parseSample">生成预览</a-button>
      <a-button size="small" type="link" @click="fillExample">填入示例</a-button>
    </div>

    <a-textarea
      v-model:value="sampleText"
      :rows="4"
      class="sample-text"
      placeholder="每行：文件名|大小MB（大小可省略）&#10;ABC-123.mp4|4096"
    />

    <div v-if="sourceLabel" class="source">{{ sourceLabel }}</div>

    <div class="summary">
      <a-tag
        :color="
          plan.status === 'applied'
            ? 'green'
            : plan.status === 'partial'
              ? 'orange'
              : plan.status === 'empty'
                ? 'red'
                : 'default'
        "
      >
        {{
          plan.status === 'applied'
            ? '全部匹配'
            : plan.status === 'partial'
              ? '部分匹配'
              : plan.status === 'empty'
                ? '未匹配'
                : '已跳过'
        }}
      </a-tag>
      <a-tag v-if="allCodes.length" color="blue">
        识别：{{ allCodes.slice(0, 3).join('、') }}
      </a-tag>
      <span class="summary-text">{{ summary }}</span>
      <span class="summary-text">
        保留 {{ plan.selectedFiles }} / 匹配 {{ plan.matchedFiles }} / 共 {{ plan.totalFiles }}
      </span>
      <span class="summary-text">{{ MATCH_SORT_LABELS[settings.sort] }}</span>
      <span class="summary-text">{{ settings.fallbackToDefault ? '未匹配回退' : '严格暂停' }}</span>
    </div>

    <a-table
      v-if="rows.length"
      :columns="columns"
      :data-source="rows"
      row-key="key"
      size="small"
      :scroll="{ x: tableScrollX }"
      :pagination="{ pageSize: 20, showSizeChanger: false }"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          <a-tooltip :title="record.path">
            <span class="file-name">{{ record.name }}</span>
          </a-tooltip>
        </template>
        <template v-else-if="column.key === 'codes'">
          <a-tooltip :title="record.codes">
            <span>{{ record.codes }}</span>
          </a-tooltip>
        </template>
        <template v-else-if="column.key === 'result'">
          <a-tag :color="record.result === 'keep' ? 'green' : 'default'">
            {{ record.result === 'keep' ? '保留' : '排除' }}
          </a-tag>
          <span class="reason">
            <template v-if="record.rank">#{{ record.rank }} </template>
            {{ record.reason }}<template v-if="record.source"> · {{ record.source }}</template>
          </span>
        </template>
      </template>
    </a-table>
    <a-empty v-else description="粘贴文件名或读取当前迅雷弹窗后生成预览" />

    <div v-if="readDebug" class="debug">调试：{{ readDebug }}</div>
  </div>
</template>

<style scoped>
.preview {
  margin-top: 10px;
  padding-top: 18px;
  border-top: 1px solid rgba(0, 0, 0, 0.08);
}

.preview-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 10px;
}

.section-title {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
  color: rgba(0, 0, 0, 0.88);
}

.hint {
  max-width: 380px;
  font-size: 12px;
  line-height: 1.6;
  color: rgba(0, 0, 0, 0.45);
}

.tip {
  margin: 10px 0;
}

.hidden-input {
  display: none;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.task-input {
  flex: 1;
}

.sample-text {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.source {
  margin-top: 8px;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
}

.summary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 12px 0;
}

.summary-text {
  font-size: 12px;
  color: rgba(0, 0, 0, 0.55);
}

.file-name {
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reason {
  margin-left: 6px;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
}

.debug {
  margin-top: 10px;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.35);
  word-break: break-all;
}
</style>
