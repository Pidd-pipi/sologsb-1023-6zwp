<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import { statusLabel, useCollation } from './composables/useCollation';
import type { AlignmentRow, DifferenceStatus, DraftBatch, FieldConflict, MergeResult } from './types';

const {
  versions,
  leftVersionId,
  rightVersionId,
  rows,
  rules,
  selectedRowId,
  selectedRowIds,
  processing,
  progress,
  message,
  canUndo,
  canRedo,
  selectedRow,
  differenceCount,
  acceptedCount,
  unresolvedCount,
  draftName,
  runAlignment,
  recalculate,
  updateRow,
  shiftPairing,
  moveRow,
  acceptRows,
  acceptAll,
  nextDifference,
  addVersion,
  parseDraftFile,
  previewMerge,
  applyMerge,
  saveDraftName,
  undo,
  redo,
  exportMarkdown,
  exportJson,
  commit
} = useCollation();

const importVisible = ref(false);
const onlyDifferences = ref(false);
const rowQuery = ref('');
const noteDraft = ref('');
const sourceDraft = ref('');
const importForm = ref({ name: '', source: '', text: '' });
const fileInput = ref<HTMLInputElement | null>(null);

// 离线草稿合流
const mergeVisible = ref(false);
const mergeBatches = ref<DraftBatch[]>([]);
const mergeResult = ref<MergeResult | null>(null);
const resolutions = ref<Record<string, string | boolean>>({});
const mergeFileInput = ref<HTMLInputElement | null>(null);

const columns = [
  { title: '状态', dataIndex: 'status', slotName: 'status', width: 122, fixed: 'left' as const },
  { title: '底本', dataIndex: 'left', slotName: 'left', width: 330 },
  { title: '对准操作', dataIndex: 'align', slotName: 'align', width: 112, align: 'center' as const },
  { title: '参校本', dataIndex: 'right', slotName: 'right', width: 330 },
  { title: '校记 / 来源', dataIndex: 'note', slotName: 'note', width: 240 }
];

const filteredRows = computed(() => {
  const query = rowQuery.value.trim().toLocaleLowerCase();
  return rows.value.filter((row) => {
    if (onlyDifferences.value && row.status === 'same') return false;
    if (!query) return true;
    return [row.left?.text, row.right?.text, row.note, row.source, statusLabel(row.status)]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase().includes(query));
  });
});

const rowSelection = computed(() => ({
  type: 'checkbox' as const,
  showCheckedAll: true,
  selectedRowKeys: selectedRowIds.value,
  onlyCurrent: false
}));

watch(
  selectedRow,
  (row) => {
    noteDraft.value = row?.note ?? '';
    sourceDraft.value = row?.source ?? '';
  },
  { immediate: true }
);

function statusColor(status: DifferenceStatus) {
  return {
    same: 'gray',
    changed: 'orange',
    added: 'green',
    removed: 'red',
    misaligned: 'arcoblue'
  }[status] as 'gray' | 'orange' | 'green' | 'red' | 'arcoblue';
}

function rowClass(record: AlignmentRow) {
  return record.id === selectedRowId.value ? 'row-active' : '';
}

function onSelectionChange(keys: (string | number)[]) {
  selectedRowIds.value = keys;
}

function updateStatus(status: unknown) {
  if (!selectedRow.value) return;
  updateRow(selectedRow.value.id, { status: String(status) as DifferenceStatus });
}

function onRowClick(record: Record<string, unknown>) {
  const row = record as unknown as AlignmentRow;
  selectedRowId.value = row.id;
}

function saveAnnotation() {
  if (!selectedRow.value) return;
  updateRow(selectedRow.value.id, {
    note: noteDraft.value.trim(),
    source: sourceDraft.value.trim()
  });
  Message.success('校勘说明已保存');
}

function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function handleExport(kind: 'markdown' | 'json') {
  if (kind === 'markdown') {
    download('校勘记.md', exportMarkdown(), 'text/markdown;charset=utf-8');
  } else {
    download('校勘数据.json', exportJson(), 'application/json;charset=utf-8');
  }
}

function openImport() {
  importForm.value = { name: `导入版本 ${versions.value.length + 1}`, source: '', text: '' };
  importVisible.value = true;
}

function confirmImport() {
  if (!importForm.value.text.trim()) {
    Message.warning('请粘贴版本正文或选择文本文件');
    return;
  }
  addVersion(importForm.value.name, importForm.value.source, importForm.value.text.trim());
  importVisible.value = false;
}

function handleFile(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  file.text().then((text) => {
    importForm.value.text = text;
    if (!importForm.value.name || importForm.value.name.startsWith('导入版本')) {
      importForm.value.name = file.name.replace(/\.[^.]+$/, '');
    }
  });
}

function openMerge() {
  mergeBatches.value = [];
  mergeResult.value = null;
  resolutions.value = {};
  mergeVisible.value = true;
}

function handleMergeFile(event: Event) {
  const target = event.target as HTMLInputElement;
  const files = target.files;
  if (!files || !files.length) return;
  Array.from(files).forEach((file) => {
    file.text().then((text) => {
      try {
        const batch = parseDraftFile(text);
        if (mergeBatches.value.some((item) => item.draftId === batch.draftId)) {
          Message.warning(`草稿「${batch.draftName}」已添加，已跳过重复项`);
          return;
        }
        mergeBatches.value.push(batch);
        Message.success(`已添加草稿「${batch.draftName}」（${batch.rows.length} 行）`);
      } catch {
        Message.error(`草稿「${file.name}」解析失败，请确认是本工具导出的 JSON 文件`);
      }
    });
  });
  target.value = '';
}

function removeMergeBatch(draftId: string) {
  mergeBatches.value = mergeBatches.value.filter((item) => item.draftId !== draftId);
}

function runMerge() {
  if (!mergeBatches.value.length) {
    Message.warning('请先添加至少一个离线草稿文件');
    return;
  }
  saveDraftName(draftName.value.trim());
  const result = previewMerge(mergeBatches.value);
  mergeResult.value = result;
  // 默认选中每方中最近保存的取值
  const defaults: Record<string, string | boolean> = {};
  result.conflicts.forEach((conflict) => {
    const sorted = [...conflict.options].sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
    defaults[conflict.key] = sorted[0].value;
  });
  resolutions.value = defaults;
  if (!result.conflicts.length) {
    Message.success(`合流预览完成：共 ${result.stats.total} 行，${result.stats.merged} 行多方合并，${result.stats.invalidated} 条接受结论将失效重算。点击「确认写入」完成合流。`);
  } else {
    Message.info(`合流预览完成：${result.stats.conflictCount} 处冲突待确认，确认后写入`);
  }
}

function confirmMerge() {
  if (!mergeResult.value) return;
  const unresolved = mergeResult.value.conflicts.filter((conflict) => resolutions.value[conflict.key] === undefined);
  if (unresolved.length) {
    Message.warning(`还有 ${unresolved.length} 处冲突未选择取值`);
    return;
  }
  applyMerge(mergeResult.value, resolutions.value);
  Message.success('离线草稿已合流写入');
  mergeVisible.value = false;
}

function conflictOptions(conflict: FieldConflict) {
  return [...conflict.options].sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

function formatTime(iso: string) {
  if (!iso || iso === new Date(0).toISOString()) return '时间未知';
  return new Date(iso).toLocaleString('zh-CN');
}

function handleKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    redo();
    return;
  }
  if (typing) return;
  if (event.altKey && event.key === 'ArrowDown') {
    event.preventDefault();
    nextDifference();
  } else if (event.key.toLowerCase() === 'a' && selectedRowIds.value.length) {
    acceptRows(selectedRowIds.value.map(String));
  }
}

window.addEventListener('keydown', handleKeydown);

const beforeUnload = (event: BeforeUnloadEvent) => {
  if (unresolvedCount.value > 0) {
    event.preventDefault();
    event.returnValue = '';
  }
};
window.addEventListener('beforeunload', beforeUnload);
</script>

<template>
  <a-layout class="workbench-shell">
    <a-layout-header class="topbar">
      <div style="display: flex; align-items: center; gap: 12px; width: 100%">
        <div class="brand-mark">校</div>
        <div>
          <h1 class="brand-title">校异斋 · 多版本校勘台</h1>
          <div class="brand-subtitle">自动对齐、人工修正、校记导出，全程本地保存</div>
        </div>
        <a-space style="margin-left: auto" wrap>
          <a-button :disabled="!canUndo" @click="undo">撤销</a-button>
          <a-button :disabled="!canRedo" @click="redo">重做</a-button>
          <a-button type="primary" :loading="processing" @click="runAlignment()">重新自动对齐</a-button>
          <a-button @click="openImport">导入版本</a-button>
          <a-button @click="openMerge">合并离线草稿</a-button>
          <a-dropdown>
            <a-button>导出校勘记</a-button>
            <template #content>
              <a-doption @click="handleExport('markdown')">Markdown 校勘记</a-doption>
              <a-doption @click="handleExport('json')">JSON 校勘数据</a-doption>
            </template>
          </a-dropdown>
        </a-space>
      </div>
    </a-layout-header>

    <a-layout class="main-layout">
      <a-layout-sider class="left-panel" :width="282">
        <section class="panel-section">
          <h2 class="panel-title">比对版本</h2>
          <div style="display: grid; gap: 10px">
            <a-select v-model="leftVersionId" aria-label="底本">
              <template #prefix>底本</template>
              <a-option v-for="version in versions" :key="version.id" :value="version.id">{{ version.name }}</a-option>
            </a-select>
            <a-select v-model="rightVersionId" aria-label="参校本">
              <template #prefix>参校</template>
              <a-option v-for="version in versions" :key="version.id" :value="version.id">{{ version.name }}</a-option>
            </a-select>
            <a-button long type="outline" @click="runAlignment()">执行分片自动对齐</a-button>
          </div>
          <a-progress v-if="processing" :percent="progress" size="small" style="margin-top: 12px" />
          <div v-if="processing" style="margin-top: 6px; color: #86909c; font-size: 12px">
            正在让出主线程，长文本编辑不会一直卡住
          </div>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">比较规则</h2>
          <a-space direction="vertical" fill>
            <a-checkbox v-model="rules.ignorePunctuation" @change="recalculate">忽略标点差异</a-checkbox>
            <a-checkbox v-model="rules.ignoreVariants" @change="recalculate">忽略常见异体字</a-checkbox>
          </a-space>
          <div style="margin-top: 10px; color: #86909c; font-size: 12px; line-height: 1.6">
            规则只影响相同/改动判断，原始正文始终保留；重算会进入撤销历史。
          </div>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">处理进度</h2>
          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-number">{{ differenceCount }}</div>
              <div class="stat-label">全部差异</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" style="color: #d25f00">{{ unresolvedCount }}</div>
              <div class="stat-label">待校勘</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" style="color: #00875a">{{ acceptedCount }}</div>
              <div class="stat-label">已接受</div>
            </div>
            <div class="stat-card">
              <div class="stat-number">{{ rows.length }}</div>
              <div class="stat-label">对齐句段</div>
            </div>
          </div>
          <a-button long type="primary" status="success" style="margin-top: 12px" :disabled="!unresolvedCount" @click="acceptAll">
            批量接受全部建议
          </a-button>
          <a-button long style="margin-top: 8px" @click="nextDifference">跳到下一处未接受差异</a-button>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">键盘辅助</h2>
          <div style="color: #4e5969; font-size: 12px; line-height: 2">
            <div><a-tag size="small">Alt ↓</a-tag> 下一处差异</div>
            <div><a-tag size="small">A</a-tag> 接受勾选建议</div>
            <div><a-tag size="small">Ctrl/⌘ Z</a-tag> 撤销</div>
            <div><a-tag size="small">Ctrl/⌘ Y</a-tag> 重做</div>
          </div>
        </section>
      </a-layout-sider>

      <a-layout-content class="center-panel">
        <a-card :bordered="false" style="margin-bottom: 12px">
          <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
            <a-input-search v-model="rowQuery" placeholder="搜索正文、校记或来源" allow-clear style="max-width: 360px" />
            <a-checkbox v-model="onlyDifferences">只看差异</a-checkbox>
            <a-tag color="arcoblue">{{ filteredRows.length }} / {{ rows.length }} 行</a-tag>
            <a-tag v-if="selectedRowIds.length" color="green">{{ selectedRowIds.length }} 行已勾选</a-tag>
            <a-button
              v-if="selectedRowIds.length"
              type="primary"
              status="success"
              size="small"
              style="margin-left: auto"
              @click="acceptRows(selectedRowIds.map(String))"
            >
              接受勾选建议
            </a-button>
          </div>
        </a-card>

        <a-card :bordered="false" :body-style="{ padding: 0 }">
          <a-alert :show-icon="processing" :type="unresolvedCount ? 'warning' : 'success'" style="border-radius: 0">
            {{ message }}<span v-if="unresolvedCount"> · {{ unresolvedCount }} 条差异尚未接受</span>
          </a-alert>
          <a-table
            class="virtual-table"
            row-key="id"
            :columns="columns"
            :data="filteredRows"
            :pagination="false"
            :row-selection="rowSelection"
            :row-class="rowClass"
            :scroll="{ x: 1160, y: 'calc(100vh - 260px)' }"
            :virtual-list-props="{ height: 590, threshold: 40 }"
            @selection-change="onSelectionChange"
            @row-click="onRowClick"
          >
            <template #status="{ record }">
              <a-tag :color="statusColor(record.status)">
                {{ statusLabel(record.status) }}
              </a-tag>
              <div style="margin-top: 6px; color: #86909c; font-size: 11px">
                相似度 {{ Math.round(record.similarity * 100) }}%
              </div>
              <div v-if="record.manuallyAdjusted" style="margin-top: 4px; color: #165dff; font-size: 11px">人工调整</div>
            </template>

            <template #left="{ record }">
              <div v-if="record.left">
                <div class="paragraph-label">段 {{ record.left.paragraphOrder }} · 句 {{ record.left.sentenceOrder }}</div>
                <div class="diff-text" :class="record.status === 'removed' ? 'removed' : record.status === 'changed' || record.status === 'misaligned' ? 'changed' : 'same'">
                  {{ record.left.text }}
                </div>
              </div>
              <div v-else style="padding: 20px 8px; color: #86909c; text-align: center">无对应底本句</div>
            </template>

            <template #align="{ record }">
              <a-space direction="vertical" size="mini">
                <a-button size="mini" @click.stop="shiftPairing(record.id, -1)">配对上移</a-button>
                <a-button size="mini" @click.stop="shiftPairing(record.id, 1)">配对下移</a-button>
                <a-button size="mini" @click.stop="moveRow(record.id, -1)">整行上移</a-button>
                <a-button size="mini" @click.stop="moveRow(record.id, 1)">整行下移</a-button>
                <a-tooltip content="接受这一行的自动判断">
                  <a-button size="mini" status="success" @click.stop="acceptRows([record.id])">接受</a-button>
                </a-tooltip>
              </a-space>
            </template>

            <template #right="{ record }">
              <div v-if="record.right">
                <div class="paragraph-label">段 {{ record.right.paragraphOrder }} · 句 {{ record.right.sentenceOrder }}</div>
                <div class="diff-text" :class="record.status === 'added' ? 'added' : record.status === 'changed' || record.status === 'misaligned' ? 'changed' : 'same'">
                  {{ record.right.text }}
                </div>
              </div>
              <div v-else style="padding: 20px 8px; color: #86909c; text-align: center">无对应参校本句</div>
            </template>

            <template #note="{ record }">
              <div style="font-size: 12px; line-height: 1.6; color: #4e5969">
                <div>{{ record.note || '尚未填写校勘说明' }}</div>
                <div v-if="record.source" style="margin-top: 5px; color: #86909c">来源：{{ record.source }}</div>
                <a-tag v-if="record.accepted" size="small" color="green" style="margin-top: 7px">已接受</a-tag>
                <a-tag v-else size="small" color="orange" style="margin-top: 7px">待处理</a-tag>
              </div>
            </template>

            <template #empty>
              <a-empty description="没有符合条件的对齐行" />
            </template>
          </a-table>
        </a-card>
      </a-layout-content>

      <a-layout-sider class="right-panel" :width="340">
        <section class="panel-section">
          <div style="display: flex; align-items: center">
            <h2 class="panel-title" style="margin: 0">校勘详情</h2>
            <a-tag v-if="selectedRow" color="arcoblue" style="margin-left: auto">{{ statusLabel(selectedRow.status) }}</a-tag>
          </div>
        </section>

        <template v-if="selectedRow">
          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">判断类别</div>
            <a-select :model-value="selectedRow.status" style="width: 100%" @change="updateStatus">
              <a-option value="same">相同</a-option>
              <a-option value="changed">改动</a-option>
              <a-option value="added">右侧新增</a-option>
              <a-option value="removed">左侧删减</a-option>
              <a-option value="misaligned">疑错位</a-option>
            </a-select>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">底本 / 参校本</div>
            <div class="diff-text same">{{ selectedRow.left?.text || '（无）' }}</div>
            <div style="height: 8px" />
            <div class="diff-text changed">{{ selectedRow.right?.text || '（无）' }}</div>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">校勘说明</div>
            <a-textarea
              v-model="noteDraft"
              placeholder="记录字形、词句、标点或语义差异的判断依据"
              :auto-size="{ minRows: 5, maxRows: 10 }"
            />
            <a-input v-model="sourceDraft" placeholder="来源，如：某刻本、某整理者" style="margin-top: 10px" />
            <a-button long type="primary" style="margin-top: 10px" @click="saveAnnotation">保存校勘说明</a-button>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">错位修正</div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">
              <a-button @click="shiftPairing(selectedRow.id, -1)">配对向前</a-button>
              <a-button @click="shiftPairing(selectedRow.id, 1)">配对向后</a-button>
              <a-button @click="moveRow(selectedRow.id, -1)">整行上移</a-button>
              <a-button @click="moveRow(selectedRow.id, 1)">整行下移</a-button>
            </div>
            <a-alert type="info" style="margin-top: 10px" :show-icon="true">
              配对移动只交换左栏句段，不会改写底本或参校本原文。
            </a-alert>
          </section>

          <section class="panel-section">
            <a-button
              long
              :status="selectedRow.accepted ? 'normal' : 'success'"
              :type="selectedRow.accepted ? 'outline' : 'primary'"
              @click="updateRow(selectedRow.id, { accepted: !selectedRow.accepted })"
            >
              {{ selectedRow.accepted ? '撤回接受状态' : '接受这条校勘建议' }}
            </a-button>
          </section>
        </template>

        <div v-else class="inspector-empty">
          <div>
            <div style="font-size: 30px; color: #c9cdd4">择</div>
            <p>选择中间表格的一行<br />即可调整错位并填写校勘说明</p>
          </div>
        </div>

        <section class="panel-section" style="margin-top: auto">
          <div style="color: #86909c; font-size: 11px; line-height: 1.7">
            最近状态：{{ message }}<br />
            数据保存在当前浏览器，刷新后继续。
          </div>
        </section>
      </a-layout-sider>
    </a-layout>
  </a-layout>

  <a-modal v-model:visible="importVisible" title="导入同一作品的新版本" width="700px" @ok="confirmImport">
    <a-form :model="importForm" layout="vertical">
      <a-grid :cols="2" :col-gap="12">
        <a-grid-item>
          <a-form-item label="版本名称">
            <a-input v-model="importForm.name" placeholder="如：某刻本 / 某校点本" />
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="来源">
            <a-input v-model="importForm.source" placeholder="馆藏、整理者或文件来源" />
          </a-form-item>
        </a-grid-item>
      </a-grid>
      <a-form-item label="选择文本文件">
        <input ref="fileInput" type="file" accept=".txt,.md,text/plain,text/markdown" @change="handleFile" />
      </a-form-item>
      <a-form-item label="或直接粘贴正文">
        <a-textarea
          v-model="importForm.text"
          placeholder="空行分段；句号、问号、感叹号或分号后自动分句"
          :auto-size="{ minRows: 10, maxRows: 18 }"
        />
      </a-form-item>
      <a-alert type="info" :show-icon="true">导入仅写入当前浏览器。对齐过程会分片执行，原文不会被自动改写。</a-alert>
    </a-form>
  </a-modal>

  <a-modal
    v-model:visible="mergeVisible"
    title="合并多台浏览器的离线草稿"
    width="820px"
    :ok-text="mergeResult ? '确认写入' : '开始合流'"
    :cancel-text="mergeResult ? '返回修改' : '取消'"
    :ok-button-props="{ disabled: mergeResult ? false : !mergeBatches.length }"
    @ok="mergeResult ? confirmMerge() : runMerge()"
    @cancel="mergeResult = null"
  >
    <a-alert type="info" :show-icon="true" style="margin-bottom: 14px">
      各浏览器离线导出的 JSON 草稿在此合流：同一对底本句 / 参校本句的校记按字段直接并入，
      同一字段或接受结论冲突时并排列出，确认后才写入。比较规则变化后，受影响的接受结论会失效重算。
    </a-alert>

    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px">
      <span style="color: #4e5969; font-size: 13px; white-space: nowrap">本机草稿名称</span>
      <a-input v-model="draftName" placeholder="如：张三的浏览器 / 整理组 A" style="max-width: 260px" @change="saveDraftName(draftName.trim())" />
      <a-tag color="arcoblue">本机作为合流一方参与</a-tag>
    </div>

    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px">
      <a-button @click="mergeFileInput?.click()">添加离线草稿文件</a-button>
      <input ref="mergeFileInput" type="file" accept="application/json,.json" multiple style="display: none" @change="handleMergeFile" />
      <span style="color: #86909c; font-size: 12px">可一次选择多个 JSON 草稿文件</span>
    </div>

    <div v-if="mergeBatches.length" style="border: 1px solid #e5e6eb; border-radius: 6px; margin-bottom: 12px">
      <div
        v-for="batch in mergeBatches"
        :key="batch.draftId"
        style="display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid #f2f3f5"
      >
        <a-tag color="green">{{ batch.draftName }}</a-tag>
        <span style="color: #4e5969; font-size: 13px">{{ batch.rows.length }} 行</span>
        <span style="color: #86909c; font-size: 12px">{{ formatTime(batch.savedAt) }}</span>
        <span style="color: #86909c; font-size: 12px">
          规则：{{ batch.rules.ignorePunctuation ? '忽略标点' : '保留标点' }} ·
          {{ batch.rules.ignoreVariants ? '忽略异体' : '保留异体' }}
        </span>
        <a-button size="mini" status="danger" style="margin-left: auto" @click="removeMergeBatch(batch.draftId)">移除</a-button>
      </div>
    </div>
    <a-empty v-else description="尚未添加离线草稿文件" style="padding: 16px 0" />

    <template v-if="mergeResult">
      <a-divider style="margin: 12px 0">合流结果</a-divider>
      <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px">
        <a-tag color="arcoblue">共 {{ mergeResult.stats.total }} 行</a-tag>
        <a-tag color="green">{{ mergeResult.stats.merged }} 行多方合并</a-tag>
        <a-tag color="orange">{{ mergeResult.stats.invalidated }} 条接受结论失效重算</a-tag>
        <a-tag v-if="mergeResult.stats.conflictCount" color="red">{{ mergeResult.stats.conflictCount }} 处冲突待确认</a-tag>
      </div>

      <div v-if="mergeResult.conflicts.length" style="display: grid; gap: 12px; max-height: 360px; overflow: auto">
        <a-card v-for="conflict in mergeResult.conflicts" :key="conflict.key" :bordered="true" size="small">
          <div style="margin-bottom: 8px">
            <a-tag color="red">{{ conflict.fieldLabel }}冲突</a-tag>
            <span style="color: #4e5969; font-size: 12px">
              底本「{{ conflict.leftText || '（无）' }}」 · 参校本「{{ conflict.rightText || '（无）' }}」
            </span>
          </div>
          <a-radio-group v-model="resolutions[conflict.key]" direction="vertical" style="width: 100%">
            <a-radio
              v-for="option in conflictOptions(conflict)"
              :key="`${conflict.key}-${option.draftId}`"
              :value="option.value"
              style="display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border: 1px solid #f2f3f5; border-radius: 4px; margin-bottom: 6px"
            >
              <div style="display: flex; flex-direction: column; gap: 2px">
                <div>
                  <a-tag size="small" color="arcoblue">{{ option.draftName }}</a-tag>
                  <span style="color: #86909c; font-size: 12px">{{ formatTime(option.savedAt) }}</span>
                </div>
                <div style="color: #1d2129; font-size: 13px; line-height: 1.6">
                  <template v-if="conflict.field === 'accepted'">
                    <a-tag :color="option.value ? 'green' : 'orange'">{{ option.value ? '已接受' : '待处理' }}</a-tag>
                  </template>
                  <template v-else>{{ option.value || '（空白）' }}</template>
                </div>
              </div>
            </a-radio>
          </a-radio-group>
        </a-card>
      </div>
      <a-alert v-else type="success" :show-icon="true">各方校记与接受结论一致，无冲突，可直接写入。</a-alert>
    </template>
  </a-modal>
</template>
