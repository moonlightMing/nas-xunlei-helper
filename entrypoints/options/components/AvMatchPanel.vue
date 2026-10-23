<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { message, Modal } from 'ant-design-vue';
import {
  cloneAvMatchSettings,
  DEFAULT_AV_MATCH_SETTINGS,
  FILE_CATEGORIES,
  FILE_CATEGORY_LABELS,
  MATCH_SORT_LABELS,
  parseExcludeKeywords,
  parseManualCodes,
  type AvMatchSettings,
  type MatchSort,
} from '@/utils/avMatch';
import { ensureSettingsLoaded, getSettings, saveAvMatchSettings } from '@/utils/settings';
import AvMatchPreview from './AvMatchPreview.vue';

const props = defineProps<{ active: boolean }>();

const loading = ref(true);
const saving = ref(false);
const form = reactive<AvMatchSettings>(cloneAvMatchSettings(DEFAULT_AV_MATCH_SETTINGS));
const manualCodesText = ref('');
const keywordsText = ref('');

const manualParsed = computed(() => parseManualCodes(manualCodesText.value));
const previewSettings = computed<AvMatchSettings>(() => ({
  ...form,
  enabled: true,
  manualCodes: manualParsed.value.codes,
  excludeKeywords: parseExcludeKeywords(keywordsText.value),
  keepCategories: form.keepCategories.length ? [...form.keepCategories] : ['video'],
}));
const sortOptions = (Object.keys(MATCH_SORT_LABELS) as MatchSort[]).map((value) => ({
  value,
  label: MATCH_SORT_LABELS[value],
}));
const categoryOptions = FILE_CATEGORIES.map((value) => ({
  value,
  label: FILE_CATEGORY_LABELS[value],
}));

async function load(): Promise<void> {
  loading.value = true;
  try {
    await ensureSettingsLoaded();
    const current = getSettings().avMatch;
    Object.assign(form, cloneAvMatchSettings(current));
    manualCodesText.value = current.manualCodes.join('\n');
    keywordsText.value = current.excludeKeywords.join('，');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});

watch(
  () => props.active,
  (active) => {
    if (active) void load();
  },
);

async function handleSave(): Promise<void> {
  if (!form.keepCategories.length) {
    message.warning('至少保留一种文件类型');
    return;
  }
  saving.value = true;
  try {
    const manual = parseManualCodes(manualCodesText.value);
    await saveAvMatchSettings({
      ...form,
      manualCodes: manual.codes,
      excludeKeywords: parseExcludeKeywords(keywordsText.value),
    });
    const saved = getSettings().avMatch;
    Object.assign(form, cloneAvMatchSettings(saved));
    manualCodesText.value = saved.manualCodes.join('\n');
    keywordsText.value = saved.excludeKeywords.join('，');
    if (manual.invalid.length) {
      message.warning(`已保存；${manual.invalid.length} 行无法识别番号，已忽略`);
    } else {
      message.success('番号匹配设置已保存');
    }
  } catch {
    message.error('保存失败，请重试');
  } finally {
    saving.value = false;
  }
}

function handleReset(): void {
  Modal.confirm({
    title: '恢复番号匹配默认设置？',
    content:
      '将关闭番号匹配并清空手动番号，只保留视频类型；不会影响 NAS 地址、发送记录和任务监控。',
    okText: '恢复默认',
    okType: 'danger',
    cancelText: '取消',
    onOk: async () => {
      await saveAvMatchSettings(cloneAvMatchSettings(DEFAULT_AV_MATCH_SETTINGS));
      const saved = getSettings().avMatch;
      Object.assign(form, cloneAvMatchSettings(saved));
      manualCodesText.value = saved.manualCodes.join('\n');
      keywordsText.value = saved.excludeKeywords.join('，');
      message.success('已恢复番号匹配默认设置');
    },
  });
}
</script>

<template>
  <a-spin :spinning="loading">
    <div class="panel">
      <p class="intro">
        从磁力/种子的解析文件列表中，按番号与文件类型自动勾选目标视频。只改变勾选，不重命名文件，也不会改变迅雷弹窗中的文件顺序。
      </p>

      <div class="switch-row">
        <div>
          <div class="switch-label">启用番号匹配</div>
          <div class="switch-extra">
            关闭时发送行为与现在完全一致。开启后只对带文件树的磁力/种子生效，普通直链会自动跳过。
          </div>
        </div>
        <a-switch v-model:checked="form.enabled" />
      </div>

      <div class="section-title">识别规则</div>
      <a-alert
        type="info"
        show-icon
        class="tip"
        message="自动识别始终开启"
        description="优先从任务/种子名称识别番号，并校验文件是否匹配；名称没有番号时，才用文件中的高频番号兜底。种子名有番号但文件对不上时不会擅自改选其他番号。"
      />

      <a-form layout="vertical">
        <a-form-item>
          <template #label><span class="label">手动补充番号（选填）</span></template>
          <a-textarea
            v-model:value="manualCodesText"
            :rows="4"
            allow-clear
            placeholder="ABC-123&#10;SSIS00123&#10;FC2-PPV-1234567"
          />
          <template #extra>
            <span class="extra">
              每行一个，支持 ABC-123、SSIS00123、FC2-PPV-1234567 等写法；命中的文件优先保留。仅保存在本机，不会上传。
            </span>
          </template>
        </a-form-item>
        <div class="parse-summary">
          <a-tag color="blue">识别 {{ manualParsed.codes.length }} 个</a-tag>
          <a-tag v-if="manualParsed.invalid.length" color="orange">
            忽略 {{ manualParsed.invalid.length }} 行
          </a-tag>
          <span v-if="manualParsed.invalid.length" class="invalid-lines">
            {{ manualParsed.invalid.slice(0, 3).join('、') }}
          </span>
        </div>

        <div class="section-title">文件筛选</div>
        <a-form-item>
          <template #label><span class="label">保留文件类型</span></template>
          <a-checkbox-group v-model:value="form.keepCategories" :options="categoryOptions" />
          <template #extra>
            <span class="extra">未勾选的类型会被过滤；至少保留一种。默认只保留视频。</span>
          </template>
        </a-form-item>

        <a-form-item>
          <template #label><span class="label">最小文件大小</span></template>
          <a-input-number
            v-model:value="form.minFileSizeMB"
            :min="0"
            :max="102400"
            :step="50"
            style="width: 140px"
          />
          <span class="unit">MB</span>
          <template #extra>
            <span class="extra">0 = 不限；大小未知的文件不会被误杀。</span>
          </template>
        </a-form-item>

        <a-form-item>
          <template #label><span class="label">排除文件名关键词</span></template>
          <a-textarea
            v-model:value="keywordsText"
            :rows="2"
            allow-clear
            placeholder="sample, trailer, 广告"
          />
          <template #extra>
            <span class="extra">逗号、分号或换行分隔；文件名不区分大小写包含即排除。</span>
          </template>
        </a-form-item>

        <div class="section-title">匹配上限与排序</div>
        <a-form-item>
          <template #label><span class="label">每个任务最多保留</span></template>
          <a-input-number
            v-model:value="form.maxFilesPerTask"
            :min="0"
            :max="200"
            :step="1"
            style="width: 140px"
          />
          <span class="unit">个文件</span>
          <template #extra>
            <span class="extra">0 = 不限。设置上限可能漏掉分集，建议保持 0。</span>
          </template>
        </a-form-item>

        <a-form-item>
          <template #label><span class="label">匹配到多个文件时</span></template>
          <a-select v-model:value="form.sort" :options="sortOptions" style="width: 220px" />
          <template #extra>
            <span class="extra">
              排序只决定勾选哪些文件（尤其配合数量上限），不会改变迅雷弹窗中的显示顺序。
            </span>
          </template>
        </a-form-item>

        <div class="section-title">未匹配处理</div>
        <div class="switch-row">
          <div>
            <div class="switch-label">未匹配时回退到迅雷默认勾选</div>
            <div class="switch-extra">
              <template v-if="form.fallbackToDefault">
                未识别任务保留原勾选并继续下载，可能包含广告文件；已匹配任务仍按番号勾选。
              </template>
              <template v-else>
                严格模式：任一任务未识别就整单暂停，不点击「立即下载」，保留弹窗供手动处理。迅雷只有一个提交按钮，无法只下载已匹配任务。
              </template>
            </div>
          </div>
          <a-switch v-model:checked="form.fallbackToDefault" />
        </div>

        <a-form-item class="actions">
          <a-space wrap>
            <a-button type="primary" :loading="saving" @click="handleSave">
              保存番号匹配设置
            </a-button>
            <a-button danger @click="handleReset">恢复默认</a-button>
          </a-space>
        </a-form-item>
      </a-form>

      <AvMatchPreview :settings="previewSettings" :master-enabled="form.enabled" />
    </div>
  </a-spin>
</template>

<style scoped>
.panel {
  font-size: 13px;
}

.intro {
  margin: 0 0 8px;
  color: rgba(0, 0, 0, 0.55);
  line-height: 1.7;
}

.switch-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 14px 0;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.switch-label {
  font-size: 14px;
  font-weight: 500;
  color: rgba(0, 0, 0, 0.88);
}

.switch-extra {
  max-width: 600px;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: rgba(0, 0, 0, 0.45);
}

.section-title {
  margin: 22px 0 10px;
  font-size: 15px;
  font-weight: 600;
  color: rgba(0, 0, 0, 0.88);
}

.tip {
  margin-bottom: 14px;
}

.label {
  font-size: 14px;
  font-weight: 500;
  color: rgba(0, 0, 0, 0.88);
}

.extra {
  font-size: 12px;
  line-height: 1.6;
  color: rgba(0, 0, 0, 0.45);
}

.unit {
  margin-left: 8px;
  color: rgba(0, 0, 0, 0.45);
}

.parse-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: -8px 0 16px;
}

.invalid-lines {
  font-size: 12px;
  color: #d46b08;
}

.actions {
  margin-top: 18px;
}
</style>
