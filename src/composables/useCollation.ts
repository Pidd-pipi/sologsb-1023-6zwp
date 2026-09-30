import { computed, onMounted, ref, watch } from 'vue';
import { sampleVersions, splitIntoUnits } from '../data';
import {
  basisHash,
  clone,
  isQuotaError,
  normalized,
  rowKey,
  similarity,
  statusFor,
  statusLabel,
  yieldToBrowser
} from '../collation';
import { invalidateStale, mergeBatches } from '../merge';
import type {
  AlignmentRow,
  ComparisonRules,
  DraftBatch,
  FieldConflict,
  MergeResult,
  PersistedCollationState,
  TextUnit,
  VersionDocument
} from '../types';

const STORAGE_KEY = 'sologsb-1023/multi-version-collation/v1';
const DRAFT_ID_KEY = 'sologsb-1023/multi-version-collation/draft-id';
const DRAFT_NAME_KEY = 'sologsb-1023/multi-version-collation/draft-name';

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
          manuallyAdjusted: false,
          basisHash: basisHash(left, right, rules)
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
  const score = left && right ? Number(similarity(normalized(left.text, rules), normalized(right.text, rules)).toFixed(3)) : 0;
  return {
    id: `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    left,
    right,
    status: statusFor(left, right, score),
    similarity: score,
    note: '',
    source,
    accepted: score > 0.995,
    manuallyAdjusted: false,
    basisHash: basisHash(left, right, rules)
  };
}

function defaultRules(): ComparisonRules {
  return { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 };
}

export function useCollation() {
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

  // 每台浏览器一个稳定身份，用于离线草稿合流时标注来源
  const draftId = ref(
    localStorage.getItem(DRAFT_ID_KEY) || `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  );
  const draftName = ref(localStorage.getItem(DRAFT_NAME_KEY) || '');
  if (!localStorage.getItem(DRAFT_ID_KEY)) localStorage.setItem(DRAFT_ID_KEY, draftId.value);

  function snapshot(): string {
    const data: PersistedCollationState = {
      versions: versions.value,
      leftVersionId: leftVersionId.value,
      rightVersionId: rightVersionId.value,
      rows: rows.value,
      rules: rules.value,
      selectedRowId: selectedRowId.value
    };
    return JSON.stringify(data);
  }

  /** 写入本地存储；容量不足时拒绝覆盖并保留原草稿。 */
  function persist(): boolean {
    try {
      localStorage.setItem(STORAGE_KEY, snapshot());
      return true;
    } catch (error) {
      if (isQuotaError(error)) {
        message.value = '本地存储空间不足，已保留原有完整草稿，未覆盖写入';
        return false;
      }
      throw error;
    }
  }

  function restore(raw: string) {
    const parsed = JSON.parse(raw) as PersistedCollationState;
    versions.value = parsed.versions;
    leftVersionId.value = parsed.leftVersionId;
    rightVersionId.value = parsed.rightVersionId;
    // 旧草稿可能缺少 basisHash，载入时按当前规则补算并失效过期接受结论
    const { rows: restored } = invalidateStale(parsed.rows ?? [], parsed.rules ?? defaultRules());
    rows.value = restored;
    rules.value = parsed.rules;
    selectedRowId.value = parsed.selectedRowId;
    persist();
  }

  function commit(label: string, mutate: () => void) {
    const previous = snapshot();
    history.value.push(previous);
    if (history.value.length > 50) history.value.shift();
    future.value = [];
    mutate();
    message.value = label;
    if (!persist()) {
      // 写入失败：回滚内存状态，保留存储中的完整旧草稿
      const parsed = JSON.parse(previous) as PersistedCollationState;
      versions.value = parsed.versions;
      leftVersionId.value = parsed.leftVersionId;
      rightVersionId.value = parsed.rightVersionId;
      rows.value = parsed.rows;
      rules.value = parsed.rules;
      selectedRowId.value = parsed.selectedRowId;
      history.value.pop();
      future.value = [];
    }
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
    commit('已按比较规则重算差异', () => {
      const { rows: next, invalidated } = invalidateStale(rows.value, rules.value);
      rows.value = next;
      selectedRowIds.value = [];
      if (invalidated) message.value = `比较规则已变化，${invalidated} 条接受结论已失效重算`;
    });
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
          row.similarity = Number(
            similarity(normalized(row.left.text, rules.value), normalized(row.right.text, rules.value)).toFixed(3)
          );
          row.status = statusFor(row.left, row.right, row.similarity);
        } else {
          row.status = row.left ? 'removed' : 'added';
          row.similarity = 0;
        }
        row.manuallyAdjusted = true;
        row.basisHash = basisHash(row.left, row.right, rules.value);
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

  /** 当前浏览器草稿作为一个离线批次，供合流使用。 */
  function currentBatch(): DraftBatch {
    return {
      draftId: draftId.value,
      draftName: draftName.value.trim() || '当前浏览器',
      savedAt: new Date().toISOString(),
      rules: clone(rules.value),
      rows: clone(rows.value)
    };
  }

  /** 解析一个离线草稿文件（JSON）为批次。 */
  function parseDraftFile(raw: string): DraftBatch {
    const parsed = JSON.parse(raw) as Partial<DraftBatch> & { rows?: AlignmentRow[] };
    if (!Array.isArray(parsed.rows)) throw new Error('草稿文件缺少 rows 字段');
    return {
      draftId: typeof parsed.draftId === 'string' ? parsed.draftId : `draft-${Date.now().toString(36)}`,
      draftName: typeof parsed.draftName === 'string' ? parsed.draftName : '未命名草稿',
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date(0).toISOString(),
      rules: parsed.rules ?? defaultRules(),
      rows: parsed.rows
    };
  }

  /**
   * 合流多个离线草稿批次。
   * 冲突项并排列出，由调用方在确认后通过 applyMerge 写入。
   */
  function previewMerge(batches: DraftBatch[]): MergeResult {
    const all = [currentBatch(), ...batches];
    return mergeBatches(rules.value, all);
  }

  /** 确认合并：写入合流结果与冲突取舍，进入撤销历史。 */
  function applyMerge(result: MergeResult, resolutions: Record<string, string | boolean>) {
    commit('已合流离线草稿', () => {
      // 应用冲突取舍
      result.conflicts.forEach((conflict) => {
        const choice = resolutions[conflict.key];
        if (choice === undefined) return;
        const row = result.rows.find((item) => rowKey(item.left, item.right) === conflict.key);
        if (!row) return;
        if (conflict.field === 'accepted') {
          row.accepted = Boolean(choice);
        } else {
          row[conflict.field] = String(choice);
        }
      });
      rows.value = result.rows;
      selectedRowId.value = result.rows.find((row) => row.status !== 'same')?.id ?? result.rows[0]?.id ?? '';
      selectedRowIds.value = [];
    });
  }

  function saveDraftName(name: string) {
    draftName.value = name;
    localStorage.setItem(DRAFT_NAME_KEY, name);
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
        draftId: draftId.value,
        draftName: draftName.value.trim() || '当前浏览器',
        savedAt: new Date().toISOString(),
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
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        restore(raw);
        message.value = '已恢复浏览器中的校勘草稿';
      } else {
        message.value = '已载入示例版本，正在自动对齐…';
        void runAlignment(false);
      }
    } catch {
      message.value = '本地草稿读取失败，已载入示例数据';
      void runAlignment(false);
    }
  });

  watch(
    [leftVersionId, rightVersionId, () => rules.value.ignorePunctuation, () => rules.value.ignoreVariants],
    () => {
      if (!processing.value) persist();
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
    draftId,
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
    currentBatch,
    parseDraftFile,
    previewMerge,
    applyMerge,
    saveDraftName,
    undo,
    redo,
    exportMarkdown,
    exportJson,
    commit
  };
}

export { statusLabel } from '../collation';
