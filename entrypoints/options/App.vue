<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { message, Modal } from 'ant-design-vue';
import {
  clearHistory,
  listHistory,
  watchHistory,
  type SendHistoryEntry,
} from '@/utils/history';
import type {
  DiagnoseCheck,
  ListDirResponse,
  OpenXunleiResponse,
  SendLinksResponse,
  TestConnectionResponse,
} from '@/utils/messaging';
import type { DirItem } from '@/utils/xunleiAutomation';
import AvMatchPanel from './components/AvMatchPanel.vue';
import {
  DEFAULT_SETTINGS,
  DOWNLOAD_MODE_LABELS,
  ensureSettingsLoaded,
  getSettings,
  resetSettings,
  saveSettings,
  SEND_MODE_LABELS,
  validateDownloadPath,
  validateXunleiUrl,
  type XunleiSettings,
} from '@/utils/settings';

interface DirNode {
  key: string;
  title: string;
  id: string;
  path: string;
  realPath?: string;
  writable: boolean;
  isLeaf?: boolean;
  children?: DirNode[];
}

const loading = ref(true);
const saving = ref(false);
const testing = ref(false);
const form = reactive<XunleiSettings>({ ...DEFAULT_SETTINGS });

const diagnoseChecks = ref<DiagnoseCheck[]>([]);
const diagnoseError = ref('');

const dirModalOpen = ref(false);
const dirLoading = ref(false);
const dirTreeData = ref<DirNode[]>([]);

const activeTab = ref<string | number>('settings');

const history = ref<SendHistoryEntry[]>([]);
const historyLoading = ref(false);
const clearingHistory = ref(false);
const retryingId = ref<string | null>(null);
let unwatchHistory: (() => void) | null = null;

const showOnboarding = computed(() => !loading.value && !form.xunleiUrl.trim());
const monitorDisabled = computed(() => !form.monitorDownloads);

onMounted(async () => {
  unwatchHistory = watchHistory((entries) => {
    history.value = entries;
  });
  try {
    await ensureSettingsLoaded();
    Object.assign(form, getSettings());
  } finally {
    loading.value = false;
  }
  await loadHistory();
});

onBeforeUnmount(() => {
  unwatchHistory?.();
  unwatchHistory = null;
});

async function loadHistory(): Promise<void> {
  historyLoading.value = true;
  try {
    history.value = await listHistory();
  } finally {
    historyLoading.value = false;
  }
}

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
    // 番号匹配由独立 tab 保存，设置页保存时不要用旧内存值覆盖它
    const baseSettings: Partial<XunleiSettings> = { ...form };
    delete baseSettings.avMatch;
    await saveSettings({
      ...baseSettings,
      xunleiUrl: form.xunleiUrl.trim(),
      downloadPath: form.downloadPath.trim(),
    });
    Object.assign(form, getSettings());
    message.success('设置已保存');
  } catch {
    message.error('保存失败，请重试');
  } finally {
    saving.value = false;
  }
};

const handleTestConnection = async () => {
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

  testing.value = true;
  diagnoseChecks.value = [];
  diagnoseError.value = '';
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'diagnostics',
      action: 'testConnection',
      data: {
        url: form.xunleiUrl.trim(),
        downloadPath: form.downloadPath.trim() || undefined,
      },
    })) as TestConnectionResponse | undefined;

    if (!response) {
      diagnoseError.value = '后台无响应，请重试';
      message.error(diagnoseError.value);
      return;
    }
    diagnoseChecks.value = response.checks ?? [];
    if (response.ok) message.success('连接正常');
    else message.warning(response.message || '测试未通过，请查看下方结果');
  } catch (error) {
    diagnoseError.value = (error as Error).message || '测试连接失败';
    message.error(diagnoseError.value);
  } finally {
    testing.value = false;
  }
};

const handleOpenXunlei = async () => {
  const urlError = validateXunleiUrl(form.xunleiUrl);
  if (urlError) {
    message.warning(urlError);
    return;
  }
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'xunlei',
      action: 'open',
      data: { url: form.xunleiUrl.trim() },
    })) as OpenXunleiResponse | undefined;
    if (response && !response.ok) {
      message.warning(response.message || '打开迅雷页面失败');
    }
  } catch (error) {
    message.error((error as Error).message || '打开迅雷页面失败');
  }
};

const handleReset = () => {
  Modal.confirm({
    title: '恢复默认设置？',
    content:
      '将清空 NAS 迅雷地址、默认下载位置、通知/任务监控设置以及番号匹配规则，并将下载模式重置为「立即下载」。发送记录不会被清除。',
    okText: '恢复默认',
    okType: 'danger',
    cancelText: '取消',
    onOk: async () => {
      await resetSettings();
      Object.assign(form, getSettings());
      diagnoseChecks.value = [];
      diagnoseError.value = '';
      message.success('已恢复默认设置');
    },
  });
};

function toDirNode(item: DirItem): DirNode {
  return {
    key: item.id,
    title: `${item.name || item.path}${item.writable ? '' : '（不可写）'}`,
    id: item.id,
    path: item.path,
    realPath: item.realPath,
    writable: item.writable,
    isLeaf: false,
  };
}

async function fetchDir(parentId: string, parentPath: string): Promise<DirItem[]> {
  const response = (await chrome.runtime.sendMessage({
    type: 'diagnostics',
    action: 'listDir',
    data: {
      url: form.xunleiUrl.trim(),
      parentId: parentId || undefined,
      parentPath: parentPath || undefined,
    },
  })) as ListDirResponse | undefined;

  if (!response) throw new Error('后台无响应，请重试');
  if (!response.ok) throw new Error(response.message || '读取迅雷目录失败');
  return response.items;
}

const handleOpenDirPicker = async () => {
  const urlError = validateXunleiUrl(form.xunleiUrl);
  if (urlError) {
    message.warning(urlError);
    return;
  }

  dirModalOpen.value = true;
  dirLoading.value = true;
  dirTreeData.value = [];
  try {
    const items = await fetchDir('', '');
    dirTreeData.value = items.map(toDirNode);
    if (!items.length) message.info('迅雷中没有可用的下载目录');
  } catch (error) {
    message.error((error as Error).message || '读取迅雷目录失败');
  } finally {
    dirLoading.value = false;
  }
};

const loadDirChildren = async (node: any): Promise<void> => {
  const data = (node?.dataRef ?? node) as DirNode | undefined;
  if (!data?.id) return;
  try {
    const items = await fetchDir(data.id, data.path);
    data.children = items.map(toDirNode);
    if (!items.length) data.isLeaf = true;
    dirTreeData.value = [...dirTreeData.value];
  } catch (error) {
    data.isLeaf = true;
    message.error((error as Error).message || '读取子目录失败');
  }
};

const handleSelectDir = (_keys: unknown, info: { node?: unknown }): void => {
  const data = ((info.node as { dataRef?: DirNode })?.dataRef ?? info.node) as
    | DirNode
    | undefined;
  if (!data) return;
  if (!data.path) {
    message.warning('未能读取该目录路径，请重试');
    return;
  }
  if (data.writable === false) {
    message.warning('该目录不可写，请选择其它目录');
    return;
  }
  form.downloadPath = data.path;
  dirModalOpen.value = false;
  message.success(`已选择 ${data.path}，保存后生效`);
};

const handleHistoryRetry = async (item: SendHistoryEntry): Promise<void> => {
  if (!item.links.length || retryingId.value) return;
  retryingId.value = item.id;
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'download',
      action: 'sendLinks',
      data: { links: item.links, source: 'history' },
    })) as SendLinksResponse | undefined;

    if (!response) {
      message.error('后台无响应，请重试');
    } else if (response.code === 'busy' || response.paused) {
      message.warning(response.message);
    } else if (response.ok) {
      message.success(response.message);
    } else {
      message.error(response.message);
    }
  } catch (error) {
    message.error((error as Error).message || '重试失败');
  } finally {
    retryingId.value = null;
  }
};

const handleClearHistory = () => {
  Modal.confirm({
    title: '清空发送记录？',
    content: '将删除本机保存的所有发送记录，不影响已有下载任务。',
    okText: '清空',
    okType: 'danger',
    cancelText: '取消',
    onOk: async () => {
      clearingHistory.value = true;
      try {
        await clearHistory();
        history.value = [];
        message.success('已清空发送记录');
      } finally {
        clearingHistory.value = false;
      }
    },
  });
};

function formatTime(at: number): string {
  return new Date(at).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function statusTag(item: SendHistoryEntry): { color: string; text: string } {
  if (item.status === 'running') return { color: 'blue', text: '发送中' };
  if (item.status === 'paused') return { color: 'orange', text: '已暂停' };
  if (item.status === 'ok') return { color: 'green', text: '成功' };
  if (item.status === 'partial') return { color: 'orange', text: '路径未生效' };
  return { color: 'red', text: '失败' };
}

function matchText(item: SendHistoryEntry): string {
  const match = item.match;
  if (!match) return '';
  const skipLabels: Record<string, string> = {
    'too-many-files': '文件过多',
    'empty-tree': '文件列表为空',
    disabled: '未启用',
  };
  if (match.skipped === 'no-file-list') return '番号匹配：无 BT 文件列表，已跳过';
  if (match.skipped) return `番号匹配：已跳过（${skipLabels[match.skipped] ?? match.skipped}）`;
  const codeText = match.codes.length ? ` · ${match.codes.slice(0, 2).join('、')}` : '';
  const base = `番号匹配：${match.matchedGroups}/${match.totalGroups} 个任务，番号勾选 ${match.selectedFiles}/${match.totalFiles} 个文件${codeText}`;
  if (match.status === 'partial' || match.status === 'empty') {
    return `${base}${match.policy === 'fallback' ? ' · 未匹配任务保留原勾选' : ' · 已暂停'}`;
  }
  return base;
}

function modeLabel(mode: SendHistoryEntry['mode']): string {
  return DOWNLOAD_MODE_LABELS[mode];
}

function monitorText(item: SendHistoryEntry): string {
  const monitor = item.monitor;
  if (!monitor) return '';
  const parts = [`任务监控：${monitor.completed} 完成 / ${monitor.failed} 失败 / 共 ${monitor.total} 个`];
  if (monitor.status === 'active') parts.push('监控中');
  else if (monitor.reason) parts.push(monitor.reason);
  return parts.join(' · ');
}
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

        <a-tabs v-model:activeKey="activeTab" class="tabs">
          <a-tab-pane key="settings" tab="设置">
            <a-alert v-if="showOnboarding" type="info" show-icon class="onboarding">
              <template #message>三步开始使用</template>
              <template #description>
                1. 填写 NAS 迅雷地址并保存；2. 点击「打开迅雷页面」并完成登录；
                3. 在任意网页右键链接/选中文本，或打开工具栏弹窗发送。
              </template>
            </a-alert>

            <a-form layout="vertical" class="form">
              <a-form-item required>
                <template #label><span class="label">NAS 迅雷地址</span></template>
                <a-input
                  v-model:value="form.xunleiUrl"
                  placeholder="http://192.168.5.2:2345/webman/3rdparty/pan-xunlei-com/index.cgi/#/home"
                  allow-clear
                />
                <template #extra>
                  <span class="extra">
                    迅雷 NAS 套件（群晖 webman/3rdparty/pan-xunlei-com）的 Web 页面地址；发送前请先在浏览器登录一次迅雷。
                  </span>
                </template>
              </a-form-item>

              <a-form-item>
                <template #label><span class="label">默认下载位置</span></template>
                <div class="path-row">
                  <a-input v-model:value="form.downloadPath" placeholder="/downloads/movies" allow-clear />
                  <a-button @click="handleOpenDirPicker">从迅雷选择</a-button>
                </div>
                <template #extra>
                  <span class="extra">
                    填写迅雷面板中显示的路径（如 /downloads/movies），不是 NAS 宿主机路径；留空则使用迅雷当前默认目录。
                    目录需已在迅雷中创建，插件不会自动建目录。
                  </span>
                </template>
              </a-form-item>

              <a-form-item>
                <template #label><span class="label">发送通道</span></template>
                <a-radio-group v-model:value="form.sendMode">
                  <a-radio-button value="dom">{{ SEND_MODE_LABELS.dom }}</a-radio-button>
                  <a-radio-button value="api">{{ SEND_MODE_LABELS.api }}</a-radio-button>
                </a-radio-group>
                <template #extra>
                  <span class="extra">
                    <template v-if="form.sendMode === 'api'">
                      直接调用迅雷套件的 drive/v1 接口建任务：不打开迅雷页面、不抢焦点、不模拟点击。
                      磁力/种子会先解析文件树再按番号规则勾选，勾选结果作为接口参数下发；严格模式下未命中的任务单独暂停，
                      不会连累同一批里的其它链接。鉴权用套件首页下发的短期令牌，插件不保存账号密码。
                    </template>
                    <template v-else>
                      打开迅雷页面并模拟「新建任务 → 填链接 → 解析 → 立即下载」，兼容性最好，支持番号匹配与确认后再下载。
                    </template>
                  </span>
                </template>
              </a-form-item>

              <a-form-item>
                <template #label><span class="label">下载模式</span></template>
                <a-radio-group v-model:value="form.downloadMode" :disabled="form.sendMode === 'api'">
                  <a-radio-button value="immediate">{{ DOWNLOAD_MODE_LABELS.immediate }}</a-radio-button>
                  <a-radio-button value="confirm">{{ DOWNLOAD_MODE_LABELS.confirm }}</a-radio-button>
                </a-radio-group>
                <template #extra>
                  <span class="extra">
                    <template v-if="form.sendMode === 'api'">
                      接口模式没有迅雷确认框，任务一律直接开始下载；需要「确认后下载」请切回页面自动化。
                    </template>
                    <template v-else-if="form.downloadMode === 'immediate'">
                      发送后自动解析链接并点击「立即下载」，全程无需在迅雷页面操作。
                    </template>
                    <template v-else>
                      发送后自动解析链接并停留在迅雷下载确认框，已预选保存位置，可编辑文件名或保存位置后再手动点击「立即下载」。
                    </template>
                  </span>
                </template>
              </a-form-item>

              <div class="switch-row" :class="{ disabled: form.sendMode === 'api' }">
                <div>
                  <div class="switch-label">发送前刷新迅雷页面</div>
                  <div class="switch-extra">
                    {{
                      form.sendMode === 'api'
                        ? '接口模式不打开页面，此开关暂不生效。'
                        : '开启后发送前会刷新迅雷页，保证干净状态；关闭可减少打断，但页面有未处理弹窗时会拦截发送。'
                    }}
                  </div>
                </div>
                <a-switch v-model:checked="form.reloadBeforeSend" :disabled="form.sendMode === 'api'" />
              </div>

              <div class="section-title">通知与任务监控</div>

              <div class="switch-row">
                <div>
                  <div class="switch-label">发送成功通知</div>
                  <div class="switch-extra">默认关闭，避免每次发送都打扰；结果仍会显示在弹窗和发送记录中。</div>
                </div>
                <a-switch v-model:checked="form.notifyOnSendSuccess" />
              </div>

              <div class="switch-row">
                <div>
                  <div class="switch-label">发送失败通知</div>
                  <div class="switch-extra">失败时弹桌面通知，可一键打开设置、打开迅雷或重试。</div>
                </div>
                <a-switch v-model:checked="form.notifyOnSendFailure" />
              </div>

              <div class="switch-row">
                <div>
                  <div class="switch-label">保存路径未生效时通知</div>
                  <div class="switch-extra">任务已发送但默认路径未应用时提醒，避免静默落到迅雷当前目录。</div>
                </div>
                <a-switch v-model:checked="form.notifyOnPathFallback" />
              </div>

              <div class="switch-row">
                <div>
                  <div class="switch-label">下载任务监控</div>
                  <div class="switch-extra">
                    发送后每分钟检查一次任务状态。需要保持迅雷页面打开；最多监控 24 小时，失败/完成结果会写入发送记录。
                  </div>
                </div>
                <a-switch v-model:checked="form.monitorDownloads" />
              </div>

              <div class="switch-row" :class="{ disabled: monitorDisabled }">
                <div>
                  <div class="switch-label">下载失败通知</div>
                  <div class="switch-extra">任务下载失败时通知，默认开启。需先开启任务监控。</div>
                </div>
                <a-switch v-model:checked="form.notifyOnDownloadFailure" :disabled="monitorDisabled" />
              </div>

              <div class="switch-row" :class="{ disabled: monitorDisabled }">
                <div>
                  <div class="switch-label">下载完成通知</div>
                  <div class="switch-extra">任务下载完成时通知，默认关闭。需先开启任务监控。</div>
                </div>
                <a-switch v-model:checked="form.notifyOnDownloadComplete" :disabled="monitorDisabled" />
              </div>

              <a-form-item class="actions">
                <a-space wrap>
                  <a-button type="primary" :loading="saving" @click="handleSave">保存设置</a-button>
                  <a-button :loading="testing" @click="handleTestConnection">测试连接</a-button>
                  <a-button @click="handleOpenXunlei">打开迅雷页面</a-button>
                  <a-button danger @click="handleReset">恢复默认</a-button>
                </a-space>
              </a-form-item>

              <div v-if="diagnoseError" class="diagnose-error">{{ diagnoseError }}</div>
              <div v-if="diagnoseChecks.length" class="diagnose">
                <div v-for="check in diagnoseChecks" :key="check.key" class="diagnose-row">
                  <a-tag :color="check.ok ? 'green' : 'red'">{{ check.ok ? '通过' : '失败' }}</a-tag>
                  <span class="diagnose-label">{{ check.label }}</span>
                  <span class="diagnose-detail">{{ check.detail }}</span>
                </div>
              </div>
            </a-form>
          </a-tab-pane>

          <a-tab-pane key="avMatch" tab="番号匹配">
            <AvMatchPanel :active="activeTab === 'avMatch'" />
          </a-tab-pane>

          <a-tab-pane key="history" tab="发送记录">
            <div class="card-head">
              <p class="history-subtitle">最近 50 条，仅保存在本机；失败记录可一键重试。</p>
              <a-button
                size="small"
                danger
                :disabled="!history.length"
                :loading="clearingHistory"
                @click="handleClearHistory"
              >
                清空记录
              </a-button>
            </div>

            <a-empty v-if="!history.length && !historyLoading" description="暂无发送记录" />
            <a-list v-else :data-source="history" :loading="historyLoading" item-layout="vertical" size="small">
              <template #renderItem="{ item }">
                <a-list-item>
                  <template #actions>
                    <a-button
                      v-if="item.links.length"
                      type="link"
                      size="small"
                      :loading="retryingId === item.id"
                      @click="handleHistoryRetry(item)"
                    >
                      重试
                    </a-button>
                  </template>
                  <div class="history-head">
                    <a-tag :color="statusTag(item).color">{{ statusTag(item).text }}</a-tag>
                    <span class="history-time">{{ formatTime(item.at) }}</span>
                    <span class="history-meta">
                      {{ item.linkCount }} 个链接 · {{ modeLabel(item.mode) }}
                    </span>
                  </div>
                  <div class="history-message">{{ item.message }}</div>
                  <div v-if="item.match" class="history-match">{{ matchText(item) }}</div>
                  <div v-if="item.monitor" class="history-monitor">{{ monitorText(item) }}</div>
                </a-list-item>
              </template>
            </a-list>
          </a-tab-pane>
        </a-tabs>
      </div>
    </a-spin>

    <a-modal
      v-model:open="dirModalOpen"
      title="选择迅雷下载目录"
      :width="560"
      :footer="null"
    >
      <a-spin :spinning="dirLoading">
        <div v-if="!dirTreeData.length && !dirLoading" class="dir-empty">
          未读取到目录。请确认已在迅雷页面登录，并检查 NAS 迅雷地址。
        </div>
        <a-tree
          v-if="dirTreeData.length"
          :tree-data="dirTreeData"
          :load-data="loadDirChildren"
          block-node
          @select="handleSelectDir"
        />
      </a-spin>
      <div class="dir-tip">只能选择已存在的目录；不可写目录已标注，插件不会自动创建目录。</div>
    </a-modal>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  padding: 48px 16px;
  background: #f5f6f8;
}

.page :deep(.ant-spin-nested-loading) {
  width: 100%;
  max-width: 760px;
}

.card {
  width: 760px;
  max-width: 100%;
  height: fit-content;
  background: #fff;
  border-radius: 12px;
  padding: 30px 34px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
}

.header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 12px;
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

.tabs :deep(.ant-tabs-nav) {
  margin-bottom: 16px;
}

.onboarding {
  margin-bottom: 20px;
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

.path-row {
  display: flex;
  gap: 8px;
}

.path-row .ant-input {
  flex: 1;
}

.section-title {
  margin: 8px 0 2px;
  padding-top: 18px;
  border-top: 1px solid #f0f0f0;
  font-size: 15px;
  font-weight: 600;
  color: rgba(0, 0, 0, 0.88);
}

.switch-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 12px 0;
  border-bottom: 1px solid #fafafa;
}

.switch-row.disabled {
  opacity: 0.62;
}

.switch-label {
  font-size: 14px;
  font-weight: 500;
  color: rgba(0, 0, 0, 0.85);
}

.switch-extra {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.6;
  color: rgba(0, 0, 0, 0.45);
}

.switch-row .ant-switch {
  flex-shrink: 0;
  margin-top: 2px;
}

.actions {
  margin-top: 20px;
  margin-bottom: 0;
}

.diagnose {
  margin-top: 16px;
  padding: 12px 14px;
  background: #fafafa;
  border-radius: 8px;
}

.diagnose-error {
  margin-top: 14px;
  color: #cf1322;
  font-size: 13px;
}

.diagnose-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
}

.diagnose-label {
  width: 90px;
  flex-shrink: 0;
  color: rgba(0, 0, 0, 0.65);
}

.diagnose-detail {
  color: rgba(0, 0, 0, 0.45);
  word-break: break-all;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.history-subtitle {
  margin: 0;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
}

.history-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.history-time,
.history-meta {
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
}

.history-message {
  margin-top: 4px;
  font-size: 13px;
  line-height: 1.6;
  color: rgba(0, 0, 0, 0.65);
  word-break: break-all;
}

.history-match {
  margin-top: 2px;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.55);
}

.history-monitor {
  margin-top: 2px;
  font-size: 12px;
  color: #1677ff;
}

.dir-empty {
  padding: 24px 0;
  text-align: center;
  color: rgba(0, 0, 0, 0.45);
}

.dir-tip {
  margin-top: 14px;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
}
</style>
