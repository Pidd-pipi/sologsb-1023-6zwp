<script setup lang="ts">
import { computed, ref } from 'vue';
import { statusLabel } from '../composables/useCollation';
import type { ComparisonRules, FieldConflict, MergeItem, MergeSummary } from '../types';

const props = defineProps<{
  visible: boolean;
  summary: MergeSummary | null;
  localRules: ComparisonRules;
  invalidPairs: Set<string>;
}>();

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
  (e: 'confirm', summary: MergeSummary): void;
  (e: 'export-local'): void;
}>();

const onlyAttention = ref(true);

const batch = computed(() => props.summary?.batches[0] ?? null);

const conflictTotal = computed(
  () => batch.value?.items.reduce((sum, item) => sum + item.conflicts.length, 0) ?? 0
);
const newPairTotal = computed(
  () => batch.value?.items.filter((item) => item.isNewPair).length ?? 0
);
const invalidTotal = computed(() => props.invalidPairs.size);
const attentionTotal = computed(
  () =>
    batch.value?.items.filter((item) => item.conflicts.length || item.baseChanged || item.isNewPair).length ?? 0
);

const visibleItems = computed<MergeItem[]>(() => {
  const b = batch.value;
  if (!b) return [];
  if (!onlyAttention.value) return b.items;
  return b.items.filter((item) => item.conflicts.length || item.baseChanged || item.isNewPair);
});

const blockedForeignPair = computed(
  () => Boolean(batch.value?.foreignPair && batch.value?.localHasManualWork)
);

function rulesText(rules: ComparisonRules) {
  return `${rules.ignorePunctuation ? '忽略标点' : '保留标点差异'}，${rules.ignoreVariants ? '忽略异体字' : '保留异体字差异'}`;
}

function fieldDisplay(conflict: FieldConflict, side: 'local' | 'incoming' | 'both') {
  if (conflict.field === 'accepted' && side !== 'both') {
    const value = side === 'local' ? conflict.localValue : conflict.incomingValue;
    return value === true ? '已接受' : '未接受';
  }
  if (side === 'both') return conflict.sideBySide;
  return String(side === 'local' ? conflict.localValue : conflict.incomingValue);
}

function isInvalid(item: MergeItem) {
  return props.invalidPairs.has(item.pairKey);
}

function close() {
  emit('update:visible', false);
}

function confirm() {
  if (!props.summary || blockedForeignPair.value) return;
  emit('confirm', props.summary);
}
</script>

<template>
  <a-modal
    :visible="visible"
    title="合流其他整理员的离线校勘草稿"
    :width="1080"
    :mask-closable="false"
    :ok-text="`确认合流并写入（${conflictTotal} 处冲突待裁）`"
    cancel-text="取消"
    :ok-button-props="{ disabled: blockedForeignPair }"
    @ok="confirm"
    @cancel="close"
  >
    <template v-if="summary && batch">
      <a-alert type="info" :show-icon="true" style="margin-bottom: 12px">
        <template #title>
          来自 {{ summary.incomingClientName }} 的草稿，导出于
          {{ new Date(summary.incomingExportedAt).toLocaleString('zh-CN') }}
        </template>
        底本：{{ batch.leftVersionName }} ｜ 参校本：{{ batch.rightVersionName }}
      </a-alert>

      <a-alert
        v-for="name in batch.addedVersions"
        :key="`add-${name}`"
        type="success"
        :show-icon="true"
        style="margin-bottom: 8px"
      >
        对方版本「{{ name }}」本机不存在，将随草稿一并并入版本库。
      </a-alert>

      <a-alert
        v-for="name in batch.remappedVersions"
        :key="`map-${name}`"
        type="warning"
        :show-icon="true"
        style="margin-bottom: 8px"
      >
        版本「{{ name }}」编号不同但正文一致，已按段落句子序号映射到本机同正文版本。
      </a-alert>

      <a-alert v-if="batch.rulesChanged" type="warning" :show-icon="true" style="margin-bottom: 12px">
        <template #title>比较规则不一致，需选择合流后采用哪一套</template>
        <a-radio-group v-model="batch.rulesChoice" direction="vertical" style="margin-top: 6px">
          <a-radio value="local">采用本机规则（{{ rulesText(localRules) }}）</a-radio>
          <a-radio value="incoming">采用对方规则（{{ rulesText(batch.rules) }}）</a-radio>
        </a-radio-group>
      </a-alert>

      <a-alert v-if="blockedForeignPair" type="error" :show-icon="true" style="margin-bottom: 12px">
        <template #title>这份草稿校勘的是另一对底本/参校本，直接合入会盖住本机现有的校记与接受判断</template>
        请先
        <a-button type="text" size="small" @click="emit('export-local')">导出本机完整草稿备份</a-button>
        ，再在新浏览器或清空工作区后合入，避免晚存草稿覆盖本机判断。
      </a-alert>

      <div class="merge-stats">
        <div class="merge-stat"><b>{{ attentionTotal }}</b><span>需处理</span></div>
        <div class="merge-stat"><b style="color: #d25f00">{{ conflictTotal }}</b><span>字段/结论冲突</span></div>
        <div class="merge-stat"><b style="color: #00875a">{{ newPairTotal }}</b><span>对方新增校记</span></div>
        <div class="merge-stat"><b style="color: #f53f3f">{{ invalidTotal }}</b><span>接受记录将失效重算</span></div>
      </div>

      <div style="display: flex; align-items: center; margin: 10px 0; gap: 10px">
        <a-checkbox v-model="onlyAttention">只看需人工处理的句子</a-checkbox>
        <span style="color: #86909c; font-size: 12px">
          不同字段直接并入；同一字段或接受结论冲突时，请逐处选择保留本机、采用对方或并排列出
        </span>
      </div>

      <div class="merge-list">
        <div
          v-for="item in visibleItems"
          :key="item.pairKey"
          class="merge-item"
          :class="{ invalid: isInvalid(item) }"
        >
          <div class="merge-item-head">
            <a-tag size="small" color="arcoblue">{{ item.pairKey }}</a-tag>
            <a-tag v-if="item.isNewPair" size="small" color="green">对方新增</a-tag>
            <a-tag v-if="item.baseChanged" size="small" color="red">底本/参校本句已变化</a-tag>
            <a-tag v-if="isInvalid(item)" size="small" color="orangered">接受记录失效待重算</a-tag>
            <a-tag
              v-else-if="item.localRow || item.incomingRow"
              size="small"
              :color="(item.localRow ?? item.incomingRow)?.status === 'same' ? 'gray' : 'orange'"
            >
              {{ statusLabel((item.localRow ?? item.incomingRow)!.status) }}
            </a-tag>
          </div>

          <div class="merge-sentences">
            <div class="merge-sentence"><span>底本</span>{{ item.leftText || '（无对应句）' }}</div>
            <div class="merge-sentence"><span>参校</span>{{ item.rightText || '（无对应句）' }}</div>
          </div>

          <div v-for="conflict in item.conflicts" :key="conflict.field" class="merge-conflict">
            <div class="conflict-label">{{ conflict.label }}冲突</div>
            <a-radio-group v-model="conflict.resolution" type="button" size="small">
              <a-radio value="local">保留本机</a-radio>
              <a-radio value="incoming">采用对方</a-radio>
              <a-radio value="both">并排列出来</a-radio>
            </a-radio-group>
            <div class="conflict-values">
              <div class="conflict-value" :class="{ chosen: conflict.resolution === 'local' }">
                <em>本机</em>{{ fieldDisplay(conflict, 'local') || '（空）' }}
              </div>
              <div class="conflict-value" :class="{ chosen: conflict.resolution === 'incoming' }">
                <em>对方</em>{{ fieldDisplay(conflict, 'incoming') || '（空）' }}
              </div>
              <div
                v-if="conflict.field !== 'accepted'"
                class="conflict-value both"
                :class="{ chosen: conflict.resolution === 'both' }"
              >
                <em>并排</em>{{ fieldDisplay(conflict, 'both') }}
              </div>
            </div>
          </div>

          <div v-if="!item.conflicts.length && item.isNewPair" class="merge-direct">
            对方校记将直接并入（校记：{{ item.incomingRow?.note || '—' }}；来源：{{ item.incomingRow?.source || '—' }}）
          </div>
        </div>

        <a-empty v-if="!visibleItems.length" description="没有需要人工处理的句子，全部可自动并入" style="padding: 30px 0" />
      </div>
    </template>
  </a-modal>
</template>

<style scoped>
.merge-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.merge-stat {
  padding: 10px;
  border: 1px solid #e5e6eb;
  border-radius: 8px;
  text-align: center;
  background: #f7f8fa;
}

.merge-stat b {
  display: block;
  font-size: 20px;
}

.merge-stat span {
  font-size: 11px;
  color: #86909c;
}

.merge-list {
  max-height: 52vh;
  overflow: auto;
  padding: 8px;
  border: 1px solid #e5e6eb;
  border-radius: 8px;
}

.merge-item {
  padding: 10px;
  margin-bottom: 8px;
  border: 1px solid #e5e6eb;
  border-radius: 8px;
  background: #fff;
}

.merge-item.invalid {
  border-color: #f53f3f;
  background: #fff7f5;
}

.merge-item-head {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.merge-sentences {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 8px;
}

.merge-sentence {
  padding: 7px 9px;
  border-radius: 6px;
  background: #f7f8fa;
  font-family: 'Songti SC', 'Noto Serif SC', serif;
  font-size: 14px;
  line-height: 1.6;
}

.merge-sentence span {
  display: block;
  margin-bottom: 3px;
  color: #86909c;
  font-family: inherit;
  font-size: 11px;
}

.merge-conflict {
  padding: 8px;
  margin-top: 6px;
  border-radius: 6px;
  background: #fff7e8;
}

.conflict-label {
  margin-bottom: 6px;
  color: #7d4e00;
  font-size: 12px;
  font-weight: 600;
}

.conflict-values {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-top: 8px;
}

.conflict-value {
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: #fff;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
}

.conflict-value.both {
  grid-column: 1 / -1;
}

.conflict-value.chosen {
  border-color: #165dff;
  background: #e8f3ff;
}

.conflict-value em {
  display: inline-block;
  margin-right: 6px;
  padding: 0 5px;
  border-radius: 4px;
  color: #fff;
  font-size: 11px;
  font-style: normal;
  background: #86909c;
}

.merge-direct {
  color: #4e5969;
  font-size: 12px;
}
</style>
