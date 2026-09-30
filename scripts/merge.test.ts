import { assert } from 'node:console';
import { planMergeWithLocalRules, resolveMerge, parseDraftFile } from '../src/lib/merge';
import type {
  AlignmentRow,
  CollationDraftFile,
  PersistedCollationState,
  VersionDocument
} from '../src/types';

let passed = 0;
function check(name: string, condition: boolean, detail = '') {
  if (!condition) {
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  } else {
    passed += 1;
    console.log(`✓ ${name}`);
  }
}

function unit(versionId: string, p: number, s: number, text: string) {
  return {
    id: `${versionId}-p-${p}-s-${s}`,
    paragraphId: `${versionId}-p-${p}`,
    paragraphOrder: p,
    sentenceOrder: s,
    paragraphText: text,
    text
  };
}

function version(id: string, text: string, sentences: string[]): VersionDocument {
  return {
    id,
    name: id,
    source: '',
    createdAt: '',
    text,
    units: sentences.map((t, i) => unit(id, 1, i + 1, t))
  };
}

const v1 = version('v-base', 'A。B。', ['A。', 'B。']);
const v2 = version('v-ref', 'X。Y。', ['X。', 'Y。']);

function row(left: ReturnType<typeof unit> | undefined, right: ReturnType<typeof unit> | undefined, patch: Partial<AlignmentRow> = {}): AlignmentRow {
  return {
    id: `r-${Math.random().toString(36).slice(2)}`,
    left,
    right,
    status: 'changed',
    similarity: 0.1,
    note: '',
    source: '',
    accepted: false,
    manuallyAdjusted: false,
    ...patch
  };
}

function baseState(overrides: Partial<PersistedCollationState> = {}): PersistedCollationState {
  return {
    versions: [v1, v2],
    leftVersionId: 'v-base',
    rightVersionId: 'v-ref',
    rows: [],
    rules: { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 },
    selectedRowId: '',
    clientId: 'c-local',
    clientName: '本机',
    ...overrides
  };
}

function draft(state: PersistedCollationState, name = '对方'): CollationDraftFile {
  return {
    kind: 'collation-draft',
    formatVersion: 1,
    clientId: `c-${name}`,
    clientName: name,
    exportedAt: '2026-09-30T00:00:00.000Z',
    state
  };
}

/* 测试 1：不同字段直接并入；同字段冲突并排；接受结论冲突待裁 */
{
  const local = baseState({
    rows: [
      row(v1.units[0], v2.units[0], { note: '本机校记', source: '', accepted: true }),
      row(v1.units[1], v2.units[1], { accepted: true })
    ]
  });
  const incomingState = baseState({
    clientId: 'c-peer',
    clientName: '对方',
    rows: [
      row(v1.units[0], v2.units[0], { note: '对方校记', source: '对方来源', accepted: false }),
      row(v1.units[1], v2.units[1], { note: '仅对方校记', accepted: true })
    ]
  });

  const summary = planMergeWithLocalRules(local, draft(incomingState), '本机');
  const batch = summary.batches[0];
  const first = batch.items[0];
  const second = batch.items[1];

  check('第一句存在校记冲突', first.conflicts.some((c) => c.field === 'note'));
  check('第一句接受结论冲突', first.conflicts.some((c) => c.field === 'accepted'));
  check('第一句无来源冲突（本机为空，直接并入对方）', !first.conflicts.some((c) => c.field === 'source'));
  check('第二句校记直接并入，无冲突', second.conflicts.length === 0 && second.isNewPair === false);

  const resolved = resolveMerge(summary, local);
  const mergedFirst = resolved.state.rows.find((r) => r.left?.id === v1.units[0].id)!;
  check('默认并排：校记包含双方内容', mergedFirst.note.includes('本机校记') && mergedFirst.note.includes('对方校记'));
  check('默认并排：来源直接采用对方', mergedFirst.source === '对方来源');
  check('默认并排：接受冲突暂判未接受', mergedFirst.accepted === false);
  check('默认并排：分歧写入校记', mergedFirst.note.includes('接受状态分歧'));

  const mergedSecond = resolved.state.rows.find((r) => r.left?.id === v1.units[1].id)!;
  check('第二句并入对方校记', mergedSecond.note === '仅对方校记');
  check('第二句保持已接受', mergedSecond.accepted === true);
}

/* 测试 2：冲突解决方式 local / incoming 生效 */
{
  const local = baseState({ rows: [row(v1.units[0], v2.units[0], { note: 'L', accepted: true })] });
  const incomingState = baseState({
    clientId: 'c-peer',
    clientName: '对方',
    rows: [row(v1.units[0], v2.units[0], { note: 'R', accepted: false })]
  });
  const summary = planMergeWithLocalRules(local, draft(incomingState), '本机');
  const noteConflict = summary.batches[0].items[0].conflicts.find((c) => c.field === 'note')!;
  const accConflict = summary.batches[0].items[0].conflicts.find((c) => c.field === 'accepted')!;
  noteConflict.resolution = 'local';
  accConflict.resolution = 'incoming';
  const resolved = resolveMerge(summary, local);
  const merged = resolved.state.rows[0];
  check('保留本机校记', merged.note === 'L');
  check('采用对方接受结论（未接受）', merged.accepted === false);
}

/* 测试 3：底本句变化，已接受记录失效 */
{
  const local = baseState({
    rules: { ignorePunctuation: false, ignoreVariants: false, candidateWindow: 3 },
    rows: [row(v1.units[0], v2.units[0], { status: 'same', similarity: 1, accepted: true })]
  });
  const changedV1 = version('v-base', 'A改。B。', ['A改。', 'B。']);
  const incomingState: PersistedCollationState = {
    ...baseState(),
    versions: [changedV1, v2],
    clientId: 'c-peer',
    clientName: '对方',
    rows: [row(changedV1.units[0], v2.units[0], { status: 'changed', accepted: true })]
  };
  const summary = planMergeWithLocalRules(local, draft(incomingState), '本机');
  const item = summary.batches[0].items[0];
  check('检测到底本句变化', item.baseChanged === true);
  const resolved = resolveMerge(summary, local);
  const merged = resolved.state.rows[0];
  check('底本句变化后接受记录失效', merged.accepted === false);
  check('本机底本正文未被改写', resolved.state.versions.find((v) => v.id === 'v-base')!.text === 'A。B。');
  check('失效记录被收集', resolved.invalidated.length === 1);
}

/* 测试 4：比较规则变化导致状态翻转，已接受记录失效重算 */
{
  // 為/为 在忽略异体字时相同，不忽略时改动
  const vTraditional = version('vb', '為。', ['為。']);
  const vSimplified = version('vs', '为。', ['为。']);
  const local: PersistedCollationState = {
    versions: [vTraditional, vSimplified],
    leftVersionId: 'vb',
    rightVersionId: 'vs',
    rules: { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 },
    rows: [row(vTraditional.units[0], vSimplified.units[0], { status: 'same', similarity: 1, accepted: true })],
    selectedRowId: '',
    clientId: 'c-local',
    clientName: '本机'
  };
  const incomingState: PersistedCollationState = {
    ...local,
    clientId: 'c-peer',
    clientName: '对方',
    rules: { ignorePunctuation: true, ignoreVariants: false, candidateWindow: 3 },
    rows: [row(vTraditional.units[0], vSimplified.units[0], { status: 'same', similarity: 1, accepted: true })]
  };
  const summary = planMergeWithLocalRules(local, draft(incomingState), '本机');
  check('检测到规则变化', summary.batches[0].rulesChanged === true);
  summary.batches[0].rulesChoice = 'incoming';
  const resolved = resolveMerge(summary, local);
  const merged = resolved.state.rows[0];
  check('规则变化后重算为非相同（改动/疑错位）', merged.status !== 'same', `实际：${merged.status}`);
  check('状态翻转导致接受失效', merged.accepted === false);
}

/* 测试 5：跨版本对且本机有人工作业时拦截标记 */
{
  const v3 = version('v-other', 'O。', ['O。']);
  const local = baseState({
    versions: [v1, v2, v3],
    rows: [row(v1.units[0], v2.units[0], { note: '本机在另一对上的劳动' })]
  });
  const incomingState: PersistedCollationState = {
    versions: [v1, v3],
    leftVersionId: 'v-base',
    rightVersionId: 'v-other',
    rules: local.rules,
    rows: [row(v1.units[0], v3.units[0], { accepted: true })],
    selectedRowId: '',
    clientId: 'c-peer',
    clientName: '对方'
  };
  const summary = planMergeWithLocalRules(local, draft(incomingState), '本机');
  check('识别为跨版本对', summary.batches[0].foreignPair === true);
  check('本机有人工作业时标记拦截', summary.batches[0].localHasManualWork === true);
}

/* 测试 6：对方版本本机缺失时随草稿带入 */
{
  const local = baseState();
  const vNew = version('v-new', 'N。', ['N。']);
  const incomingState: PersistedCollationState = {
    versions: [v1, vNew],
    leftVersionId: 'v-base',
    rightVersionId: 'v-new',
    rules: local.rules,
    rows: [row(v1.units[0], vNew.units[0], { note: '新版本校记' })],
    selectedRowId: '',
    clientId: 'c-peer',
    clientName: '对方'
  };
  const summary = planMergeWithLocalRules(local, draft(incomingState), '本机');
  check('缺失版本被标记为随草稿并入', summary.batches[0].addedVersions.includes('v-new'));
  const resolved = resolveMerge(summary, local);
  check('合入后版本库包含新版本', resolved.state.versions.some((v) => v.id === 'v-new'));
  const added = resolved.state.versions.find((v) => v.id === 'v-new')!;
  check('带入版本句单元 id 符合本机规则', added.units[0].id === 'v-new-p-1-s-1');
  const insertedRow = resolved.state.rows.find((r) => r.right?.id === added.units[0].id);
  check('新行引用的是重建后的句单元', Boolean(insertedRow));
}

/* 测试 7：草稿解析校验 */
{
  let threw = false;
  try {
    parseDraftFile(JSON.stringify({ kind: 'wrong' }));
  } catch {
    threw = true;
  }
  check('非法草稿被拒绝', threw);
}

/* 测试 8：跨浏览器版本 id 不同、正文相同，按段句定位符映射 */
{
  const peerBase = version('zzz-other-id', 'A。B。', ['A。', 'B。']);
  const local = baseState();
  const incomingState: PersistedCollationState = {
    versions: [peerBase, v2],
    leftVersionId: 'zzz-other-id',
    rightVersionId: 'v-ref',
    rules: local.rules,
    rows: [row(peerBase.units[0], v2.units[0], { note: '对方在异 id 同正文版本上的校记' })],
    selectedRowId: '',
    clientId: 'c-peer',
    clientName: '对方'
  };
  const summary = planMergeWithLocalRules(local, draft(incomingState), '本机');
  check('识别为正文匹配的异 id 版本', summary.batches[0].remappedVersions.includes('v-base'));
  check('不新增版本', summary.batches[0].addedVersions.length === 0);
  const resolved = resolveMerge(summary, local);
  const merged = resolved.state.rows[0];
  check('映射后写入本机版本句单元 id', merged.left?.id === v1.units[0].id);
  check('对方校记并入', merged.note === '对方在异 id 同正文版本上的校记');
}

/* 测试 9：单侧增删行按定位符合流 */
{
  const local = baseState({
    rows: [row(undefined, v2.units[0], { status: 'added', accepted: true })]
  });
  const incomingState = baseState({
    clientId: 'c-peer',
    clientName: '对方',
    rows: [row(undefined, v2.units[0], { status: 'added', source: '对方标注的新增来源', accepted: true })]
  });
  const summary = planMergeWithLocalRules(local, draft(incomingState), '本机');
  const item = summary.batches[0].items[0];
  check('单侧行能配对', item.pairKey === '-|1:1');
  check('单侧行来源直接并入无冲突', item.conflicts.length === 0);
  const resolved = resolveMerge(summary, local);
  check('单侧行来源已并入', resolved.state.rows[0].source === '对方标注的新增来源');
}

/* 测试 10：对方新增的全新配对（本机无此行）整体并入 */
{
  const local = baseState({ rows: [row(v1.units[0], v2.units[0], { accepted: true })] });
  const incomingState = baseState({
    clientId: 'c-peer',
    clientName: '对方',
    rows: [
      row(v1.units[0], v2.units[0], { accepted: true }),
      row(v1.units[1], v2.units[1], { note: '对方多校的一行', accepted: false })
    ]
  });
  const summary = planMergeWithLocalRules(local, draft(incomingState), '本机');
  const newItem = summary.batches[0].items.find((i) => i.isNewPair);
  check('识别全新配对', Boolean(newItem));
  const resolved = resolveMerge(summary, local);
  const inserted = resolved.state.rows.find((r) => r.left?.id === v1.units[1].id);
  check('全新配对被追加', Boolean(inserted) && inserted!.note === '对方多校的一行');
}

console.log(`\n${passed} 项通过`);
