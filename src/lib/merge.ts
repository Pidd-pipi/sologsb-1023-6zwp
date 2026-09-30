import { defaultRules, rowScore, statusFor } from './compare';
import { splitIntoUnits } from '../data';
import type {
  AlignmentRow,
  CollationDraftFile,
  ComparisonRules,
  FieldConflict,
  MergeBatch,
  MergeItem,
  MergeSummary,
  PersistedCollationState,
  TextUnit,
  VersionDocument
} from '../types';

export const FIELD_LABELS: Record<FieldConflict['field'], string> = {
  note: '校勘说明',
  source: '来源',
  accepted: '接受结论'
};

const SIDE_SEPARATOR = '\n———\n';

interface ResolvedVersion {
  target: VersionDocument;
  added: boolean;
  remapped: boolean;
}

function unitLocator(unit: TextUnit) {
  return `${unit.paragraphOrder}:${unit.sentenceOrder}`;
}

function pairKeyOf(left: TextUnit | undefined, right: TextUnit | undefined) {
  return `${left ? unitLocator(left) : '-'}|${right ? unitLocator(right) : '-'}`;
}

function resolveVersion(
  id: string,
  localVersions: VersionDocument[],
  incomingVersions: VersionDocument[]
): ResolvedVersion | undefined {
  const incoming = incomingVersions.find((item) => item.id === id);
  if (!incoming) return undefined;
  const exact = localVersions.find((item) => item.id === id);
  if (exact) return { target: exact, added: false, remapped: false };
  const sameText = localVersions.find((item) => item.text === incoming.text);
  if (sameText) return { target: sameText, added: false, remapped: true };
  // 随草稿带入的新版本：按本机 id 规则重建句单元，避免残留对方浏览器的版本前缀
  const normalized: VersionDocument = {
    ...incoming,
    units: splitIntoUnits(incoming.text, incoming.id)
  };
  return { target: normalized, added: true, remapped: false };
}

/**
 * 将对方句单元定位到合入后写入的目标版本中的句。
 * 目标始终是“本机侧版本”（已存在、按正文匹配、或随草稿新增并按本机规则重建句单元），
 * 按“段序:句序”定位；这样底本句/参校本句原文变化也能通过 incomingRow 与目标句比对发现。
 */
function mapUnit(unit: TextUnit | undefined, resolve: ResolvedVersion): TextUnit | undefined {
  if (!unit) return undefined;
  return (
    resolve.target.units.find((item) => unitLocator(item) === unitLocator(unit)) ??
    resolve.target.units.find((item) => item.text === unit.text) ??
    undefined
  );
}

function booleanText(value: string | boolean) {
  return value === true ? '已接受' : '未接受';
}

function makeFieldConflict(
  field: FieldConflict['field'],
  localValue: string | boolean,
  incomingValue: string | boolean,
  localName: string,
  peerName: string
): FieldConflict {
  return {
    field,
    label: FIELD_LABELS[field],
    localValue,
    incomingValue,
    sideBySide:
      field === 'accepted'
        ? `【${localName}】${booleanText(localValue)}${SIDE_SEPARATOR}【${peerName}】${booleanText(incomingValue)}`
        : `【${localName}】${localValue}${SIDE_SEPARATOR}【${peerName}】${incomingValue}`,
    // 文本字段与接受结论默认并排列出，等待人工确认
    resolution: 'both'
  };
}

function mergeTextField(localValue: string, incomingValue: string): { value: string; conflict: boolean } {
  const local = localValue.trim();
  const incoming = incomingValue.trim();
  if (local === incoming) return { value: local, conflict: false };
  if (!local) return { value: incomingValue, conflict: false };
  if (!incoming) return { value: localValue, conflict: false };
  return { value: localValue, conflict: true };
}

function rulesEqual(a: ComparisonRules, b: ComparisonRules) {
  return a.ignorePunctuation === b.ignorePunctuation && a.ignoreVariants === b.ignoreVariants;
}

/** 解析并校验草稿文件 */
export function parseDraftFile(raw: string): CollationDraftFile {
  const parsed = JSON.parse(raw) as CollationDraftFile;
  if (!parsed || parsed.kind !== 'collation-draft' || parsed.formatVersion !== 1 || !parsed.state) {
    throw new Error('不是校异斋导出的校勘草稿文件');
  }
  if (!Array.isArray(parsed.state.versions) || !Array.isArray(parsed.state.rows)) {
    throw new Error('草稿内容不完整：缺少版本或校勘行');
  }
  return parsed;
}

/**
 * 按 底本 × 参校本 × 比较规则 生成合流预览。
 * 一份草稿对应一个批次。
 */
export function planMerge(
  local: PersistedCollationState,
  file: CollationDraftFile,
  localClientName: string
): MergeSummary {
  const incoming = file.state;
  const peerName = file.clientName || '对方整理员';
  const leftResolve = resolveVersion(incoming.leftVersionId, local.versions, incoming.versions);
  const rightResolve = resolveVersion(incoming.rightVersionId, local.versions, incoming.versions);
  const addedVersions = [
    ...(leftResolve?.added ? [leftResolve.target] : []),
    ...(rightResolve?.added && rightResolve.target.id !== leftResolve?.target.id ? [rightResolve.target] : [])
  ];
  // 合入后版本库的构成：本机已有版本 + 随草稿带入（已按本机规则重建句单元）的版本
  const resolvedVersions = [...local.versions];
  for (const added of addedVersions) {
    if (!resolvedVersions.some((item) => item.id === added.id)) resolvedVersions.push(added);
  }

  const batch: MergeBatch = {
    id: `batch-${Date.now().toString(36)}`,
    leftVersionId: leftResolve?.target.id ?? incoming.leftVersionId,
    rightVersionId: rightResolve?.target.id ?? incoming.rightVersionId,
    leftVersionName: leftResolve?.target.name ?? '未知底本',
    rightVersionName: rightResolve?.target.name ?? '未知参校本',
    rules: { ...(incoming.rules ?? defaultRules()) },
    rulesChanged: !rulesEqual(local.rules, incoming.rules ?? defaultRules()),
    rulesChoice: 'local',
    addedVersions: addedVersions.map((item) => item.name),
    remappedVersions: [
      ...(leftResolve?.remapped ? [leftResolve.target.name] : []),
      ...(rightResolve?.remapped && rightResolve.target.id !== leftResolve?.target.id
        ? [rightResolve.target.name]
        : [])
    ],
    foreignPair:
      !!leftResolve &&
      !!rightResolve &&
      (leftResolve.target.id !== local.leftVersionId || rightResolve.target.id !== local.rightVersionId),
    localHasManualWork: local.rows.some((row) => row.note.trim() || row.source.trim() || row.manuallyAdjusted),
    missingVersion: !leftResolve || !rightResolve,
    resolvedVersions,
    items: []
  };

  if (leftResolve && rightResolve) {
    batch.items = buildItems(local, incoming, leftResolve, rightResolve, localClientName, peerName);
  }

  return {
    batches: [batch],
    incomingClientName: peerName,
    incomingExportedAt: file.exportedAt,
    incomingState: incoming
  };
}

function buildItems(
  local: PersistedCollationState,
  incoming: PersistedCollationState,
  leftResolve: ResolvedVersion,
  rightResolve: ResolvedVersion,
  localName: string,
  peerName: string
): MergeItem[] {
  const samePair =
    leftResolve.target.id === local.leftVersionId && rightResolve.target.id === local.rightVersionId;
  const localByKey = new Map(
    (samePair ? local.rows : []).map((row) => [pairKeyOf(row.left, row.right), row])
  );

  return incoming.rows.map((incomingRow) => {
    const leftUnit = mapUnit(incomingRow.left, leftResolve);
    const rightUnit = mapUnit(incomingRow.right, rightResolve);
    const key = pairKeyOf(leftUnit, rightUnit);
    const localRow = localByKey.get(key);
    const baseChanged =
      sentenceChanged(incomingRow.left, leftUnit) || sentenceChanged(incomingRow.right, rightUnit);

    const conflicts: FieldConflict[] = [];
    if (localRow && incomingRow) {
      if (mergeTextField(localRow.note, incomingRow.note).conflict) {
        conflicts.push(makeFieldConflict('note', localRow.note, incomingRow.note, localName, peerName));
      }
      if (mergeTextField(localRow.source, incomingRow.source).conflict) {
        conflicts.push(makeFieldConflict('source', localRow.source, incomingRow.source, localName, peerName));
      }
      if (localRow.accepted !== incomingRow.accepted) {
        conflicts.push(makeFieldConflict('accepted', localRow.accepted, incomingRow.accepted, localName, peerName));
      }
    }

    return {
      pairKey: key,
      localRow,
      incomingRow,
      units: { left: leftUnit, right: rightUnit },
      leftText: leftUnit?.text ?? '',
      rightText: rightUnit?.text ?? '',
      baseChanged,
      conflicts,
      invalidateAccepted: false,
      invalidateReason: '',
      isNewPair: !localRow
    };
  });
}

function sentenceChanged(incomingUnit: TextUnit | undefined, localUnit: TextUnit | undefined) {
  if (!incomingUnit && !localUnit) return false;
  if (!incomingUnit || !localUnit) return true;
  return incomingUnit.text !== localUnit.text;
}

/* ---------------- 预览统计（随解决方式变化） ---------------- */

export function directMergeCount(summary: MergeSummary) {
  const batch = summary.batches[0];
  let count = 0;
  for (const item of batch.items) {
    if (!item.localRow || !item.incomingRow) continue;
    const note = mergeTextField(item.localRow.note, item.incomingRow.note);
    const source = mergeTextField(item.localRow.source, item.incomingRow.source);
    if (!note.conflict && item.localRow.note.trim() !== note.value) count += 1;
    if (!source.conflict && item.localRow.source.trim() !== source.value) count += 1;
  }
  return count;
}

export function conflictCount(summary: MergeSummary) {
  return summary.batches[0].items.reduce((sum, item) => sum + item.conflicts.length, 0);
}

export function newPairCount(summary: MergeSummary) {
  return summary.batches[0].items.filter((item) => item.isNewPair).length;
}

/** 合入前该行是否处于已接受状态（并排版接受冲突会先判为未接受） */
function acceptedBeforeMerge(item: MergeItem): boolean {
  const acceptedConflict = item.conflicts.find((conflict) => conflict.field === 'accepted');
  if (acceptedConflict) {
    if (acceptedConflict.resolution === 'local') return acceptedConflict.localValue === true;
    if (acceptedConflict.resolution === 'incoming') return acceptedConflict.incomingValue === true;
    return false;
  }
  return item.localRow ? item.localRow.accepted : (item.incomingRow?.accepted ?? false);
}

/** 合入后该行是否被人工锁定过类别（本机或对方） */
function manuallyLocked(item: MergeItem): boolean {
  return Boolean(item.localRow?.manuallyAdjusted ?? item.incomingRow?.manuallyAdjusted);
}

function invalidateInfo(
  item: MergeItem,
  batch: MergeBatch,
  effectiveRules: ComparisonRules
): { invalidate: boolean; reason: string } {
  if (!acceptedBeforeMerge(item)) return { invalidate: false, reason: '' };
  if (item.baseChanged) {
    return { invalidate: true, reason: '底本句或参校本句原文已变化，接受记录失效重算' };
  }
  if (batch.rulesChanged && !manuallyLocked(item)) {
    const baseline = item.localRow ?? item.incomingRow;
    if (baseline) {
      const score = rowScore(item.units.left, item.units.right, effectiveRules);
      const nextStatus = statusFor(item.units.left, item.units.right, score);
      if (nextStatus !== baseline.status) {
        return { invalidate: true, reason: '比较规则变化后判断结果改变，接受记录失效重算' };
      }
    }
  }
  return { invalidate: false, reason: '' };
}

/** 按当前规则与字段取舍预览将失效重算的接受记录 */
export function invalidatedPairs(summary: MergeSummary): Set<string> {
  const result = new Set<string>();
  const batch = summary.batches[0];
  if (batch.missingVersion) return result;
  const effectiveRules = batch.rulesChoice === 'incoming' ? batch.rules : effectiveLocalRules(summary);
  for (const item of batch.items) {
    if (invalidateInfo(item, batch, effectiveRules).invalidate) result.add(item.pairKey);
  }
  return result;
}

function effectiveLocalRules(summary: MergeSummary): ComparisonRules {
  return localRulesBySummary.get(summary) ?? defaultRules();
}

const localRulesBySummary = new WeakMap<MergeSummary, ComparisonRules>();

export function planMergeWithLocalRules(
  local: PersistedCollationState,
  file: CollationDraftFile,
  localClientName: string
): MergeSummary {
  const summary = planMerge(local, file, localClientName);
  localRulesBySummary.set(summary, { ...local.rules });
  return summary;
}

/* ---------------- 应用合流 ---------------- */

export interface ResolvedMerge {
  state: PersistedCollationState;
  invalidated: MergeItem[];
  mergedRowCount: number;
  switchedPair: boolean;
}

/** 按当前解决方式（字段取舍、规则取舍）计算合流后的完整状态 */
export function resolveMerge(summary: MergeSummary, local: PersistedCollationState): ResolvedMerge {
  const batch = summary.batches[0];
  const switchedPair = batch.foreignPair;

  // 已在规划阶段确定版本库构成（随草稿带入的版本已按本机规则重建句单元）
  const versions = batch.resolvedVersions.map((item) => structuredClone(item));

  const effectiveRules = batch.rulesChoice === 'incoming' ? batch.rules : { ...local.rules };

  // 跨版本对合入时以对方校勘行为基底；同版本对时以本机校勘行为基底
  const baseRows: AlignmentRow[] = switchedPair
    ? []
    : local.rows.map((row) => structuredClone(row));
  const byKey = new Map(baseRows.map((row) => [pairKeyOf(row.left, row.right), row]));
  const invalidated: MergeItem[] = [];

  for (const item of batch.items) {
    const incomingRow = item.incomingRow!;
    let row = byKey.get(item.pairKey);
    if (!row) {
      row = {
        ...structuredClone(incomingRow),
        id: `row-merge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        left: item.units.left,
        right: item.units.right
      };
      baseRows.push(row);
      byKey.set(item.pairKey, row);
    }

    row.note = resolveTextField(item, 'note', row.note, incomingRow.note);
    row.source = resolveTextField(item, 'source', row.source, incomingRow.source);

    const acceptedConflict = item.conflicts.find((conflict) => conflict.field === 'accepted');
    if (acceptedConflict) {
      if (acceptedConflict.resolution === 'local') {
        row.accepted = acceptedConflict.localValue === true;
      } else if (acceptedConflict.resolution === 'incoming') {
        row.accepted = acceptedConflict.incomingValue === true;
      } else {
        // 并排：接受结论暂判未接受，分歧原文写入校记由人工复核
        row.accepted = false;
        if (!row.note.includes('【接受状态分歧】')) {
          row.note = `${row.note}${row.note ? '\n' : ''}【接受状态分歧】${acceptedConflict.sideBySide}`.trim();
        }
      }
    } else if (item.isNewPair) {
      row.accepted = incomingRow.accepted;
    }

    if (incomingRow.manuallyAdjusted) row.manuallyAdjusted = true;

    if (row.left || row.right) {
      const score = rowScore(row.left, row.right, effectiveRules);
      row.similarity = score;
      if (!manuallyLocked(item)) row.status = statusFor(row.left, row.right, score);
    }

    const info = invalidateInfo(item, batch, effectiveRules);
    if (info.invalidate && row.accepted) {
      row.accepted = false;
      item.invalidateAccepted = true;
      item.invalidateReason = info.reason;
      invalidated.push(item);
    }
  }

  return {
    state: {
      versions,
      leftVersionId: switchedPair ? batch.leftVersionId : local.leftVersionId,
      rightVersionId: switchedPair ? batch.rightVersionId : local.rightVersionId,
      rows: baseRows,
      rules: effectiveRules,
      selectedRowId: local.selectedRowId,
      clientId: local.clientId,
      clientName: local.clientName
    },
    invalidated,
    mergedRowCount: batch.items.length,
    switchedPair
  };
}

function resolveTextField(
  item: MergeItem,
  field: 'note' | 'source',
  localValue: string,
  incomingValue: string
) {
  const conflict = item.conflicts.find((entry) => entry.field === field);
  if (!conflict) return mergeTextField(localValue, incomingValue).value;
  if (conflict.resolution === 'local') return String(conflict.localValue);
  if (conflict.resolution === 'incoming') return String(conflict.incomingValue);
  return conflict.sideBySide;
}
