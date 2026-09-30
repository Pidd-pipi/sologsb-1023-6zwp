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
  /** 接受结论所依赖的比对基指纹（底本句正文 + 参校本句正文 + 比较规则），变化即失效重算 */
  basisHash?: string;
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
}

/** 单台浏览器离线保存的一个草稿批次 */
export interface DraftBatch {
  draftId: string;
  draftName: string;
  savedAt: string;
  rules: ComparisonRules;
  rows: AlignmentRow[];
}

export type MergeField = 'note' | 'source' | 'accepted';

export interface ConflictOption {
  draftId: string;
  draftName: string;
  savedAt: string;
  value: string | boolean;
}

export interface FieldConflict {
  key: string;
  leftText: string;
  rightText: string;
  field: MergeField;
  fieldLabel: string;
  options: ConflictOption[];
}

export interface MergeResult {
  rows: AlignmentRow[];
  conflicts: FieldConflict[];
  stats: {
    total: number;
    merged: number;
    added: number;
    invalidated: number;
    conflictCount: number;
  };
}
