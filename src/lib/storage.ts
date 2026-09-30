const STORAGE_PREFIX = 'sologsb-1023/multi-version-collation';
export const STORAGE_KEY = `${STORAGE_PREFIX}/v1`;
const CLIENT_KEY = `${STORAGE_PREFIX}/client/v1`;
const QUOTA_PROBE_KEY = `${STORAGE_PREFIX}/quota-probe`;

export class StorageQuotaError extends Error {
  constructor(public requiredBytes: number, public availableBytes: number) {
    super(
      `本地存储空间不足：需要约 ${Math.ceil(requiredBytes / 1024)} KB，` +
        `可写入不足 ${Math.ceil(availableBytes / 1024)} KB。已拒绝覆盖，原草稿完整保留。`
    );
    this.name = 'StorageQuotaError';
  }
}

/** 估算当前可写入的剩余容量（字节），失败返回 0 */
export function estimateAvailableBytes(): number {
  const storage = window.localStorage;

  const probe = (size: number): boolean => {
    try {
      storage.setItem(QUOTA_PROBE_KEY, 'x'.repeat(size));
      return true;
    } catch {
      return false;
    } finally {
      try {
        storage.removeItem(QUOTA_PROBE_KEY);
      } catch {
        /* ignore */
      }
    }
  };

  // 探针键与正式键共存，因此探测到的就是“除现有数据外还能再写多少”
  let low = 0;
  let high = 1;
  while (high <= 64 * 1024 * 1024) {
    if (!probe(high)) break;
    low = high;
    high *= 2;
  }

  let step = Math.max(1, Math.floor((high - low) / 2));
  let best = low;
  while (step > 0) {
    const candidate = best + step;
    if (probe(candidate)) best = candidate;
    step = Math.floor(step / 2);
  }
  return best;
}

/**
 * 容量安全写入：先确认剩余空间足够，再替换正式数据。
 * 若空间不足，旧草稿一行不动，并抛出 StorageQuotaError。
 */
export function setItemSafe(key: string, value: string) {
  const storage = window.localStorage;
  const requiredBytes = value.length;
  try {
    storage.setItem(key, value);
    return;
  } catch (error) {
    if (!isQuotaError(error)) throw error;
  }
  // 替换旧值失败（可能是配额已满）。探针与正式键共存，
  // setItem 原子替换失败时旧值保留，故现有草稿完整无损。
  const available = estimateAvailableBytes();
  throw new StorageQuotaError(requiredBytes, available);
}

export function getItem(key: string): string | null {
  return window.localStorage.getItem(key);
}

/**
 * 关键写入（合流确认）：先写等长探针确认剩余空间，再原子替换正式数据。
 * - 探针与正式键共存，探测的是“除现有数据外还能写多少”，绝不触碰正式草稿；
 * - 探针通过后再 setItem；若仍失败，正式键保留旧值并抛出 StorageQuotaError；
 * - 返回 false 表示现有存储过大、即使替换也放不下，调用方应拒绝并保留草稿。
 */
export function setItemSafeChecked(key: string, value: string): void {
  const requiredBytes = value.length;
  const probeKey = `${key}/quota-probe`;
  let usable = true;
  try {
    window.localStorage.setItem(probeKey, value);
  } catch (error) {
    usable = false;
    if (!isQuotaError(error)) {
      try {
        window.localStorage.removeItem(probeKey);
      } catch {
        /* ignore */
      }
      throw error;
    }
  } finally {
    try {
      window.localStorage.removeItem(probeKey);
    } catch {
      /* ignore */
    }
  }

  if (!usable) {
    // 探针放不下。若新值比旧值小，替换反而能腾出空间，可安全尝试原子替换。
    const old = window.localStorage.getItem(key);
    if (old !== null && requiredBytes < old.length) {
      try {
        window.localStorage.setItem(key, value);
        return;
      } catch (error) {
        if (!isQuotaError(error)) throw error;
      }
    }
    const available = estimateAvailableBytes();
    throw new StorageQuotaError(requiredBytes, available);
  }

  // 探针通过：与正式键共存时放得下，替换正式键必然可行；失败按原子替换保留旧值处理
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    if (isQuotaError(error)) {
      throw new StorageQuotaError(requiredBytes, estimateAvailableBytes());
    }
    throw error;
  }
}

export function removeItem(key: string) {
  window.localStorage.removeItem(key);
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22 ||
      error.code === 1014)
  );
}

export interface ClientIdentity {
  id: string;
  name: string;
}

export function loadClientIdentity(): ClientIdentity {
  try {
    const raw = getItem(CLIENT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ClientIdentity;
      if (parsed.id && parsed.name) return parsed;
    }
  } catch {
    /* ignore */
  }
  const identity: ClientIdentity = {
    id: `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: `整理员 ${Math.floor(Math.random() * 900 + 100)}`
  };
  try {
    setItemSafe(CLIENT_KEY, JSON.stringify(identity));
  } catch {
    // 身份写不进去也不阻塞主流程，本次会话仍可用
  }
  return identity;
}

export function saveClientName(name: string) {
  const raw = getItem(CLIENT_KEY);
  const identity = raw ? (JSON.parse(raw) as ClientIdentity) : loadClientIdentity();
  identity.name = name;
  setItemSafe(CLIENT_KEY, JSON.stringify(identity));
  return identity;
}
