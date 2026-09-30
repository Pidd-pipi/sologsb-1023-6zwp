import { computed, onMounted, ref, watch } from 'vue';
import { sampleVersions, splitIntoUnits } from '../data';
import { defaultRules, normalized, rowScore, similarity, statusFor } from '../lib/compare';
import { parseDraftFile, planMergeWithLocalRules, resolveMerge } from '../lib/merge';
import {
  STORAGE_KEY,
  StorageQuotaError,
  getItem,
  loadClientIdentity,
  saveClientName,
  setItemSafe,
  setItemSafeChecked
} from '../lib/storage';
import type {
  AlignmentRow,
  CollationDraftFile,
  ComparisonRules,
  DifferenceStatus,
  MergeSummary,
  PersistedCollationState,
  TextUnit,
  VersionDocument
} from '../types';

export type { MergeSummary };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

async function alignUnits(
  leftUnits: TextUnit[],
  rightUnits: TextUnit[],
  rules: ComparisonRules,
  onProgress: (value: number) => void
): Promise<AlignmentRow[]> {
  const rows: AlignmentRow[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < leftUnits.length || rightIndex < rightUnits.length) {
    const left = leftUnits[leftIndex];
    const right = rightUnits[rightIndex];

    if (!left) {
      rows.push(makeRow(undefined, right, rules, '自动补齐右侧新增内容'));
      rightIndex += 1;
    } else if (!right) {
      rows.push(makeRow(left, undefined, rules, '自动标记左侧缺失内容'));
      leftIndex += 1;
    } else {
      const sameParagraph =
        left.paragraphOrder === right.paragraphOrder || Math.abs(left.paragraphOrder - right.paragraphOrder) <= 1;
      const ratio = similarity(normalized(left.text, rules), normalized(right.text, rules));
      const nextLeftRatio =
        leftUnits[leftIndex + 1] && right
          ? similarity(normalized(leftUnits[leftIndex + 1].text, rules), normalized(right.text, rules))
          : 0;
      const nextRightRatio =
        rightUnits[rightIndex + 1] && left
          ? similarity(normalized(left.text, rules), normalized(rightUnits[rightIndex + 1].text, rules))
          : 0;

      if (sameParagraph && (ratio >= 0.28 || (nextLeftRatio < 0.58 && nextRightRatio < 0.58))) {
        const score = Number(ratio.toFixed(3));
        rows.push({
          id: `row-${rows.length + 1}-${left.id}-${right.id}`,
          left,
          right,
          status: statusFor(left, right, score),
          similarity: score,
          note: '',
          source: '',
          accepted: score > 0.995,
          manuallyAdjusted: false
        });
        leftIndex += 1;
        rightIndex += 1;
      } else if (nextRightRatio > ratio && nextRightRatio > nextLeftRatio) {
        rows.push(makeRow(undefined, right, rules, '右侧有段落或句子插入'));
        rightIndex += 1;
      } else {
        rows.push(makeRow(left, undefined, rules, '左侧有段落或句子缺失'));
        leftIndex += 1;
      }
    }

    if (rows.length % 24 === 0) {
      onProgress(Math.round(((leftIndex + rightIndex) / Math.max(1, leftUnits.length + rightUnits.length)) * 100));
      await yieldToBrowser();
    }
  }
  onProgress(100);
  return rows;
}

function makeRow(
  left: TextUnit | undefined,
  right: TextUnit | undefined,
  rules: ComparisonRules,
  source: string
): AlignmentRow {
  const score = rowScore(left, right, rules);
  return {
    id: `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    left,
    right,
    status: statusFor(left, right, score),
    similarity: score,
    note: '',
    source,
    accepted: score > 0.995,
    manuallyAdjusted: false
  };
}

export function useCollation() {
  const identity = loadClientIdentity();
  const versions = ref<VersionDocument[]>(clone(sampleVersions));
  const leftVersionId = ref(versions.value[0].id);
  const rightVersionId = ref(versions.value[1].id);
  const rows = ref<AlignmentRow[]>([]);
  const rules = ref<ComparisonRules>(defaultRules());
  const selectedRowId = ref('');
  const selectedRowIds = ref<(string | number)[]>([]);
  const processing = ref(false);
  const progress = ref(0);
  const message = ref('正在载入本地校勘数据…');
  const clientId = ref(identity.id);
  const clientName = ref(identity.name);
  const lastPersistError = ref('');
  const history = ref<string[]>([]);
  const future = ref<string[]>([]);
  const canUndo = computed(() => history.value.length > 0);
  const canRedo = computed(() => future.value.length > 0);
  const leftVersion = computed(() => versions.value.find((item) => item.id === leftVersionId.value));
  const rightVersion = computed(() => versions.value.find((item) => item.id === rightVersionId.value));
  const selectedRow = computed(() => rows.value.find((item) => item.id === selectedRowId.value));
  const differenceCount = computed(() => rows.value.filter((row) => row.status !== 'same').length);
  const acceptedCount = computed(() => rows.value.filter((row) => row.accepted).length);
  const unresolvedCount = computed(() => rows.value.filter((row) => !row.accepted && row.status !== 'same').length);

  function snapshot(): string {
    const data: PersistedCollationState = {
      versions: versions.value,
      leftVersionId: leftVersionId.value,
      rightVersionId: rightVersionId.value,
      rows: rows.value,
      rules: rules.value,
      selectedRowId: selectedRowId.value,
      clientId: clientId.value,
      clientName: clientName.value
    };
    return JSON.stringify(data);
  }

  function persist() {
    const raw = snapshot();
    setItemSafe(STORAGE_KEY, raw);
    lastPersistError.value = '';
  }

  function commit(label: string, mutate: () => void) {
    history.value.push(snapshot());
    if (history.value.length > 50) history.value.shift();
    future.value = [];
    mutate();
    message.value = label;
    try {
      persist();
    } catch (error) {
      lastPersistError.value = error instanceof Error ? error.message : String(error);
      message.value = '本地存储空间不足，本次修改保留在页面，请立即导出草稿备份';
    }
  }

  function restore(raw: string) {
    const parsed = JSON.parse(raw) as PersistedCollationState;
    versions.value = parsed.versions;
    leftVersionId.value = parsed.leftVersionId;
    rightVersionId.value = parsed.rightVersionId;
    rows.value = parsed.rows;
    rules.value = parsed.rules;
    selectedRowId.value = parsed.selectedRowId;
    if (parsed.clientId) clientId.value = parsed.clientId;
    if (parsed.clientName) clientName.value = parsed.clientName;
    persist();
  }

  function undo() {
    const previous = history.value.pop();
    if (!previous) return;
    future.value.push(snapshot());
    restore(previous);
    message.value = '已撤销上一步操作';
  }

  function redo() {
    const next = future.value.pop();
    if (!next) return;
    history.value.push(snapshot());
    restore(next);
    message.value = '已重做上一步操作';
  }

  async function runAlignment(commitHistory = true) {
    if (!leftVersion.value || !rightVersion.value || processing.value) return;
    processing.value = true;
    progress.value = 0;
    message.value = '正在分片执行自动对齐…';
    const previous = commitHistory ? snapshot() : '';
    try {
      const result = await alignUnits(leftVersion.value.units, rightVersion.value.units, rules.value, (value) => {
        progress.value = value;
      });
      if (commitHistory) {
        history.value.push(previous);
        future.value = [];
      }
      rows.value = result;
      selectedRowId.value = result.find((row) => row.status !== 'same')?.id ?? result[0]?.id ?? '';
      selectedRowIds.value = [];
      message.value = `自动对齐完成：${result.filter((row) => row.status !== 'same').length} 处差异`;
      persist();
    } finally {
      processing.value = false;
    }
  }

  function recalculate() {
    let invalidated = 0;
    commit('已按比较规则重算差异', () => {
      rows.value = rows.value.map((row) => {
        if (!row.left || !row.right) return row;
        const score = rowScore(row.left, row.right, rules.value);
        const nextStatus = statusFor(row.left, row.right, score);
        const next: AlignmentRow = { ...row, similarity: score, status: nextStatus };
        // 规则变化导致判断结果翻转的已接受记录失效，待人工重新确认
        if (row.accepted && nextStatus !== row.status && !row.manuallyAdjusted) {
          next.accepted = false;
          invalidated += 1;
        }
        return next;
      });
      selectedRowIds.value = [];
    });
    if (invalidated > 0) {
      message.value = `已按比较规则重算差异，${invalidated} 条接受记录因判断改变失效，请重新确认`;
    }
  }

  function updateRow(id: string, patch: Partial<AlignmentRow>) {
    commit('已更新校勘行', () => {
      const row = rows.value.find((item) => item.id === id);
      if (row) Object.assign(row, patch, { manuallyAdjusted: true });
    });
  }

  function shiftPairing(id: string, direction: -1 | 1) {
    commit(direction < 0 ? '已向前调整错位' : '已向后调整错位', () => {
      const index = rows.value.findIndex((row) => row.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= rows.value.length) return;
      const current = rows.value[index];
      const target = rows.value[targetIndex];
      const currentLeft = current.left;
      current.left = target.left;
      target.left = currentLeft;
      for (const row of [current, target]) {
        if (row.left && row.right) {
          row.similarity = rowScore(row.left, row.right, rules.value);
          row.status = statusFor(row.left, row.right, row.similarity);
        } else {
          row.status = row.left ? 'removed' : 'added';
          row.similarity = 0;
        }
        row.manuallyAdjusted = true;
      }
    });
  }

  function moveRow(id: string, direction: -1 | 1) {
    commit('已移动校勘顺序', () => {
      const index = rows.value.findIndex((row) => row.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= rows.value.length) return;
      const [row] = rows.value.splice(index, 1);
      rows.value.splice(targetIndex, 0, row);
      row.manuallyAdjusted = true;
    });
  }

  function acceptRows(ids: string[]) {
    if (!ids.length) return;
    commit(`已接受 ${ids.length} 条校对建议`, () => {
      const selected = new Set(ids);
      rows.value.forEach((row) => {
        if (selected.has(row.id)) row.accepted = true;
      });
      selectedRowIds.value = [];
    });
  }

  function acceptAll() {
    commit('已批量接受全部差异建议', () => {
      rows.value.forEach((row) => {
        row.accepted = true;
      });
      selectedRowIds.value = [];
    });
  }

  function nextDifference() {
    const start = rows.value.findIndex((row) => row.id === selectedRowId.value);
    for (let offset = 1; offset <= rows.value.length; offset += 1) {
      const index = (start + offset) % rows.value.length;
      const row = rows.value[index];
      if (row && row.status !== 'same' && !row.accepted) {
        selectedRowId.value = row.id;
        message.value = `已跳到第 ${index + 1} 条未接受差异`;
        persist();
        return;
      }
    }
    message.value = '没有更多未接受的差异';
  }

  function addVersion(name: string, source: string, text: string) {
    const id = `version-${Date.now().toString(36)}`;
    const item: VersionDocument = {
      id,
      name: name.trim() || `版本 ${versions.value.length + 1}`,
      source: source.trim() || '手工导入',
      text,
      units: splitIntoUnits(text, id),
      createdAt: new Date().toISOString()
    };
    commit(`已导入版本：${item.name}`, () => {
      versions.value.push(item);
    });
    rightVersionId.value = id;
    void runAlignment();
  }

  function renameClient(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    clientName.value = trimmed;
    try {
      const updated = saveClientName(trimmed);
      clientId.value = updated.id;
      persist();
      message.value = `本机整理员名称已改为：${trimmed}`;
    } catch (error) {
      lastPersistError.value = error instanceof Error ? error.message : String(error);
    }
  }

  /* ---------------- 离线协作：导出 / 合流 ---------------- */

  function buildDraftFile(): CollationDraftFile {
    return {
      kind: 'collation-draft',
      formatVersion: 1,
      clientId: clientId.value,
      clientName: clientName.value,
      exportedAt: new Date().toISOString(),
      state: JSON.parse(snapshot()) as PersistedCollationState
    };
  }

  function exportDraft(): string {
    return JSON.stringify(buildDraftFile(), null, 2);
  }

  function previewMerge(raw: string): MergeSummary {
    const file = parseDraftFile(raw);
    const current = JSON.parse(snapshot()) as PersistedCollationState;
    return planMergeWithLocalRules(current, file, clientName.value);
  }

  /**
   * 确认合流并写入。
   * 进入撤销历史；写入采用原子替换——空间不足时浏览器保留旧值，现有草稿一行不动，
   * 并返回合并后的完整草稿供下载备份，内存中的当前状态也不切换。
   */
  function confirmMerge(summary: MergeSummary):
    | { ok: true; invalidatedCount: number; switchedPair: boolean }
    | { ok: false; error: string; raw: string } {
    const current = JSON.parse(snapshot()) as PersistedCollationState;
    const resolved = resolveMerge(summary, current);
    const mergedState: PersistedCollationState = {
      ...resolved.state,
      clientId: clientId.value,
      clientName: clientName.value
    };

    const mergedFile: CollationDraftFile = {
      kind: 'collation-draft',
      formatVersion: 1,
      clientId: clientId.value,
      clientName: clientName.value,
      exportedAt: new Date().toISOString(),
      state: mergedState
    };
    const serialized = JSON.stringify(mergedState);

    // 先写后改：容量不足时探针预检拒绝写入，正式草稿一行不动，内存状态也不切换
    try {
      setItemSafeChecked(STORAGE_KEY, serialized);
    } catch (error) {
      lastPersistError.value = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: lastPersistError.value,
        raw: JSON.stringify(mergedFile, null, 2)
      };
    }
    lastPersistError.value = '';

    history.value.push(snapshot());
    if (history.value.length > 50) history.value.shift();
    future.value = [];

    versions.value = mergedState.versions;
    leftVersionId.value = mergedState.leftVersionId;
    rightVersionId.value = mergedState.rightVersionId;
    rows.value = mergedState.rows;
    rules.value = mergedState.rules;
    selectedRowIds.value = [];
    selectedRowId.value = mergedState.rows.find((row) => !row.accepted && row.status !== 'same')?.id ?? '';
    message.value =
      `已合入 ${summary.incomingClientName} 的校勘草稿，并入 ${resolved.mergedRowCount} 行；` +
      `${resolved.invalidated.length} 条接受记录因底本句、参校本句或规则变化失效待重校`;
    return {
      ok: true,
      invalidatedCount: resolved.invalidated.length,
      switchedPair: resolved.switchedPair
    };
  }

  function exportMarkdown() {
    const changed = rows.value.filter((row) => row.status !== 'same' || row.note || row.source);
    const lines = [
      '# 校勘记',
      '',
      `- 底本：${leftVersion.value?.name ?? '未选择'}`,
      `- 参校本：${rightVersion.value?.name ?? '未选择'}`,
      `- 比较规则：${rules.value.ignorePunctuation ? '忽略标点；' : ''}${rules.value.ignoreVariants ? '忽略异体字；' : ''}保留正文。`,
      `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
      '',
      '| 序 | 类别 | 底本 | 参校本 | 校记 | 来源 | 状态 |',
      '|---|---|---|---|---|---|---|'
    ];
    changed.forEach((row, index) => {
      const cell = (value?: string) => (value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
      lines.push(
        `| ${index + 1} | ${statusLabel(row.status)} | ${cell(row.left?.text)} | ${cell(row.right?.text)} | ${cell(row.note)} | ${cell(row.source)} | ${row.accepted ? '已接受' : '待处理'} |`
      );
    });
    lines.push('', `共 ${changed.length} 条校勘记录。`);
    return lines.join('\n');
  }

  function exportJson() {
    return JSON.stringify(
      {
        left: leftVersion.value,
        right: rightVersion.value,
        rules: rules.value,
        rows: rows.value,
        exportedAt: new Date().toISOString()
      },
      null,
      2
    );
  }

  onMounted(() => {
    try {
      const raw = getItem(STORAGE_KEY);
      if (raw) {
        restore(raw);
        message.value = '已恢复浏览器中的校勘草稿';
      } else {
        message.value = '已载入示例版本，正在自动对齐…';
        void runAlignment(false);
      }
    } catch (error) {
      message.value =
        error instanceof StorageQuotaError
          ? '本地存储空间不足，请先导出草稿备份'
          : '本地草稿读取失败，已载入示例数据';
      void runAlignment(false);
    }
  });

  watch(
    [leftVersionId, rightVersionId, () => rules.value.ignorePunctuation, () => rules.value.ignoreVariants],
    () => {
      if (!processing.value) {
        try {
          persist();
        } catch (error) {
          lastPersistError.value = error instanceof Error ? error.message : String(error);
        }
      }
    }
  );

  return {
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
    history,
    future,
    canUndo,
    canRedo,
    leftVersion,
    rightVersion,
    selectedRow,
    differenceCount,
    acceptedCount,
    unresolvedCount,
    clientId,
    clientName,
    lastPersistError,
    runAlignment,
    recalculate,
    updateRow,
    shiftPairing,
    moveRow,
    acceptRows,
    acceptAll,
    nextDifference,
    addVersion,
    undo,
    redo,
    renameClient,
    exportMarkdown,
    exportJson,
    exportDraft,
    previewMerge,
    confirmMerge,
    commit
  };
}

export function statusLabel(status: DifferenceStatus) {
  return {
    same: '相同',
    changed: '改动',
    added: '右侧新增',
    removed: '左侧删减',
    misaligned: '疑错位'
  }[status];
}
