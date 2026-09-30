import type { ComparisonRules, DifferenceStatus, TextUnit } from './types';

export const variantMap: Record<string, string> = {
  為: '为',
  爲: '为',
  識: '识',
  強: '强',
  與: '与',
  猶: '犹',
  鄰: '邻',
  儼: '俨',
  渙: '涣',
  將: '将',
  樸: '朴',
  曠: '旷',
  濁: '浊',
  靜: '静',
  動: '动',
  玅: '妙',
  裏: '里',
  裡: '里',
  說: '说',
  國: '国'
};

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function yieldToBrowser() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

export function normalized(value: string, rules: ComparisonRules) {
  let result = value.toLocaleLowerCase().trim();
  if (rules.ignoreVariants) {
    result = Array.from(result, (character) => variantMap[character] ?? character).join('');
  }
  if (rules.ignorePunctuation) {
    result = result.replace(/[\s，。！？；：、“”‘’「」『』（）()《》〈〉·,.!?;:'"[\]{}<>—\-…]/g, '');
  }
  return result;
}

export function similarity(left: string, right: string) {
  const a = Array.from(left);
  const b = Array.from(right);
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const old = previous[j];
      previous[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(previous[j], previous[j - 1]);
      diagonal = old;
    }
  }
  return previous[b.length] / Math.max(a.length, b.length);
}

export function statusFor(left: TextUnit | undefined, right: TextUnit | undefined, ratio: number): DifferenceStatus {
  if (!left) return 'added';
  if (!right) return 'removed';
  if (ratio > 0.995) return 'same';
  if (ratio >= 0.38) return 'changed';
  return 'misaligned';
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

/**
 * 句段在不同浏览器草稿中的稳定身份：
 * 同一底本/参校本的同一段同一句，其段落、句序与正文一致，
 * 不依赖各浏览器自行生成的临时行 id。
 */
export function unitKey(unit: TextUnit): string {
  return `${unit.paragraphOrder}-${unit.sentenceOrder}-${unit.text}`;
}

/** 对齐行的合流键：底本句 + 参校本句。 */
export function rowKey(left: TextUnit | undefined, right: TextUnit | undefined): string {
  const l = left ? unitKey(left) : '∅';
  const r = right ? unitKey(right) : '∅';
  return `${l}__${r}`;
}

/**
 * 接受结论所依赖的比对基指纹：
 * 底本句正文、参校本句正文与比较规则任一变化，指纹即变，
 * 据此判定此前的接受结论需要失效重算。
 */
export function basisHash(left: TextUnit | undefined, right: TextUnit | undefined, rules: ComparisonRules): string {
  return `${left?.text ?? ''}||${right?.text ?? ''}||${rules.ignorePunctuation ? 1 : 0}${rules.ignoreVariants ? 1 : 0}`;
}

export function rulesMatch(a: ComparisonRules, b: ComparisonRules): boolean {
  return a.ignorePunctuation === b.ignorePunctuation && a.ignoreVariants === b.ignoreVariants;
}

export function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: string; code?: number };
  return (
    candidate.name === 'QuotaExceededError' ||
    candidate.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    // 部分浏览器在隐私模式下抛出的异常名
    candidate.code === 22 ||
    candidate.code === 1014
  );
}
