import { basisHash, normalized, rowKey, rulesMatch, similarity, statusFor } from './collation';
import type {
  AlignmentRow,
  ComparisonRules,
  DraftBatch,
  FieldConflict,
  MergeField,
  MergeResult,
  TextUnit
} from './types';

interface Entry {
  draftId: string;
  draftName: string;
  savedAt: string;
  rules: ComparisonRules;
  row: AlignmentRow;
}

interface Accumulator {
  key: string;
  left?: TextUnit;
  right?: TextUnit;
  entries: Entry[];
}

function isMergeField(field: string): field is MergeField {
  return field === 'note' || field === 'source' || field === 'accepted';
}

function fieldLabel(field: MergeField): string {
  return { note: '校勘说明', source: '来源', accepted: '接受结论' }[field];
}

function valueOf(row: AlignmentRow, field: MergeField): string | boolean {
  return row[field];
}

/**
 * 合并多个离线草稿批次。
 *
 * 合流键为「底本句 + 参校本句」，同一对句段的校记按字段分别比对：
 * 仅一方填写的字段直接并入；多方填写且结论一致的直接采用；
 * 同一字段结论冲突（含接受结论冲突）则并排列出，交由人工确认后写入。
 * 状态与相似度为派生字段，一律按当前比较规则重算，不参与冲突。
 */
export function mergeBatches(currentRules: ComparisonRules, batches: DraftBatch[]): MergeResult {
  const map = new Map<string, Accumulator>();

  const collect = (batch: DraftBatch) => {
    batch.rows.forEach((row) => {
      const key = rowKey(row.left, row.right);
      let acc = map.get(key);
      if (!acc) {
        acc = { key, left: row.left, right: row.right, entries: [] };
        map.set(key, acc);
      }
      // 以最近保存批次的句段为代表，保证正文取最新一版
      if (!acc.left && row.left) acc.left = row.left;
      if (!acc.right && row.right) acc.right = row.right;
      acc.entries.push({
        draftId: batch.draftId,
        draftName: batch.draftName,
        savedAt: batch.savedAt,
        rules: batch.rules,
        row
      });
    });
  };

  batches.forEach(collect);

  const conflicts: FieldConflict[] = [];
  const rows: AlignmentRow[] = [];
  let invalidated = 0;
  let merged = 0;

  map.forEach((acc) => {
    const { left, right, entries } = acc;

    // 派生字段按当前规则重算
    const score =
      left && right
        ? Number(similarity(normalized(left.text, currentRules), normalized(right.text, currentRules)).toFixed(3))
        : 0;
    const status = statusFor(left, right, score);

    // 以最近保存的条目为底稿，叠加各方字段
    const sorted = [...entries].sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
    const base = sorted[0]?.row;
    const row: AlignmentRow = {
      id: base?.id ?? `row-merge-${acc.key}`,
      left,
      right,
      status,
      similarity: score,
      note: base?.note ?? '',
      source: base?.source ?? '',
      accepted: false,
      manuallyAdjusted: entries.some((entry) => entry.row.manuallyAdjusted),
      basisHash: basisHash(left, right, currentRules)
    };

    // 校记 / 来源：非空才参与比对
    (['note', 'source'] as MergeField[]).forEach((field) => {
      const options = entries
        .map((entry) => ({
          draftId: entry.draftId,
          draftName: entry.draftName,
          savedAt: entry.savedAt,
          value: valueOf(entry.row, field) as string
        }))
        .filter((option) => option.value.trim().length > 0);
      if (!options.length) return;
      const distinct = new Set(options.map((option) => option.value));
      if (distinct.size === 1) {
        row[field] = options[0].value as never;
      } else {
        // 冲突：并排列出，默认选中最近保存一方
        const preferred = options.reduce((best, option) => (option.savedAt > best.savedAt ? option : best));
        row[field] = preferred.value as never;
        conflicts.push({
          key: acc.key,
          leftText: left?.text ?? '',
          rightText: right?.text ?? '',
          field,
          fieldLabel: fieldLabel(field),
          options
        });
      }
    });

    // 接受结论：仅当该批次比较规则与当前一致时才有效，否则视为依据变化、失效重算
    const validAccepted = entries.filter((entry) => rulesMatch(entry.rules, currentRules));
    if (validAccepted.length) {
      const options = validAccepted.map((entry) => ({
        draftId: entry.draftId,
        draftName: entry.draftName,
        savedAt: entry.savedAt,
        value: entry.row.accepted
      }));
      const distinct = new Set(options.map((option) => option.value));
      if (distinct.size === 1) {
        row.accepted = options[0].value;
      } else {
        const preferred = options.reduce((best, option) => (option.savedAt > best.savedAt ? option : best));
        row.accepted = preferred.value;
        conflicts.push({
          key: acc.key,
          leftText: left?.text ?? '',
          rightText: right?.text ?? '',
          field: 'accepted',
          fieldLabel: fieldLabel('accepted'),
          options
        });
      }
    } else {
      // 没有任何一方在当前规则下给出接受结论 → 失效
      row.accepted = false;
      if (entries.some((entry) => entry.row.accepted)) invalidated += 1;
    }

    // 依据指纹变化 → 接受结论失效重算
    const previousHash = base?.basisHash;
    if (previousHash && previousHash !== row.basisHash && row.accepted) {
      row.accepted = false;
      invalidated += 1;
    }

    if (entries.length > 1) merged += 1;
    rows.push(row);
  });

  return {
    rows,
    conflicts,
    stats: {
      total: rows.length,
      merged,
      added: rows.length - merged,
      invalidated,
      conflictCount: conflicts.length
    }
  };
}

/**
 * 按当前比较规则重算每一行的相似度与状态，
 * 并让依据指纹（底本句 / 参校本句 / 规则）发生变化的接受结论失效。
 */
export function invalidateStale(rows: AlignmentRow[], rules: ComparisonRules): { rows: AlignmentRow[]; invalidated: number } {
  let invalidated = 0;
  const next = rows.map((row) => {
    const score =
      row.left && row.right
        ? Number(similarity(normalized(row.left.text, rules), normalized(row.right.text, rules)).toFixed(3))
        : 0;
    const status = statusFor(row.left, row.right, score);
    const hash = basisHash(row.left, row.right, rules);
    const stale = Boolean(row.basisHash) && row.basisHash !== hash;
    if (stale && row.accepted) invalidated += 1;
    return {
      ...row,
      status,
      similarity: score,
      accepted: stale ? false : row.accepted,
      basisHash: hash
    };
  });
  return { rows: next, invalidated };
}

export { isMergeField };
