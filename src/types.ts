export type DifferenceStatus = 'same' | 'changed' | 'added' | 'removed' | 'misaligned';

export interface TextUnit {
  id: string;
  paragraphId: string;
  paragraphOrder: number;
  sentenceOrder: number;
  paragraphText: string;
  text: string;
}

export interface VersionDocument {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  text: string;
  units: TextUnit[];
}

export interface AlignmentRow {
  id: string;
  left?: TextUnit;
  right?: TextUnit;
  status: DifferenceStatus;
  similarity: number;
  note: string;
  source: string;
  accepted: boolean;
  manuallyAdjusted: boolean;
}

export interface ComparisonRules {
  ignorePunctuation: boolean;
  ignoreVariants: boolean;
  candidateWindow: number;
}

export interface PersistedCollationState {
  versions: VersionDocument[];
  leftVersionId: string;
  rightVersionId: string;
  rows: AlignmentRow[];
  rules: ComparisonRules;
  selectedRowId: string;
  clientId?: string;
  clientName?: string;
  exportedAt?: string;
}

/** 可合并的人工校勘字段（不包含由原文与规则推导的状态、相似度） */
export type MergeField = 'note' | 'source' | 'accepted';

export type FieldResolution = 'local' | 'incoming' | 'both';

/** 单个字段在合流中的冲突情况 */
export interface FieldConflict {
  field: MergeField;
  label: string;
  localValue: string | boolean;
  incomingValue: string | boolean;
  /** 并排并列后的展示值 */
  sideBySide: string;
  /** 解决方式：local 保留本机值，incoming 采用对方值，both 并排列出 */
  resolution: FieldResolution;
}

/** 一个合流批次中的一对句子 */
export interface MergeItem {
  /** 稳定配对键：段序:句序|段序:句序 */
  pairKey: string;
  localRow?: AlignmentRow;
  incomingRow?: AlignmentRow;
  /** 合入后写入的本机侧句单元（跨 id 版本时为映射结果） */
  units: { left?: TextUnit; right?: TextUnit };
  leftText: string;
  rightText: string;
  /** 底本句 / 参校本句原文较本机是否发生变化 */
  baseChanged: boolean;
  conflicts: FieldConflict[];
  /** 受原文或规则影响，接受结论将失效重算 */
  invalidateAccepted: boolean;
  invalidateReason: string;
  /** 本机没有的配对（对方新增校记） */
  isNewPair: boolean;
}

/** 一个合流批次：相同的底本/参校本版本与比较规则 */
export interface MergeBatch {
  id: string;
  leftVersionId: string;
  rightVersionId: string;
  leftVersionName: string;
  rightVersionName: string;
  rules: ComparisonRules;
  rulesChanged: boolean;
  /** 规则冲突时采用哪一侧 */
  rulesChoice: 'local' | 'incoming';
  items: MergeItem[];
  /** 对方草稿引用的版本在本机不存在，但已随草稿带入 */
  addedVersions: string[];
  /** 对方版本 id 不同，按正文匹配到本机版本 */
  remappedVersions: string[];
  /** 合入目标版本对与本机当前版本对不同 */
  foreignPair: boolean;
  /** 版本对不同，且本机当前校勘已有人工作业，直接合入会覆盖，需拦截 */
  localHasManualWork: boolean;
  /** 对方草稿引用的版本无法解析（理论上不会出现，缺失版本会随草稿带入） */
  missingVersion: boolean;
  /** 合入后写入版本库的版本对象（随草稿带入的版本已按本机 id 规则重建句单元） */
  resolvedVersions: VersionDocument[];
}

export interface MergeSummary {
  batches: MergeBatch[];
  incomingClientName: string;
  incomingExportedAt: string;
  incomingState: PersistedCollationState;
}

export interface CollationDraftFile {
  kind: 'collation-draft';
  formatVersion: 1;
  clientId: string;
  clientName: string;
  exportedAt: string;
  state: PersistedCollationState;
}
