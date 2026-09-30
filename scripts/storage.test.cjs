function makeStorage(quotaBytes, initial = {}) {
  const map = new Map(Object.entries(initial));
  const storage = {
    get length() {
      return map.size;
    },
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      const currentSize = [...map.entries()].reduce((sum, [k, v]) => sum + k.length + v.length, 0);
      const replacing = map.has(key) ? key.length + map.get(key).length : 0;
      if (currentSize - replacing + key.length + value.length > quotaBytes) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      map.set(key, value);
    },
    removeItem(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    }
  };
  return { storage, map };
}

let passed = 0;
function check(name, condition, detail = '') {
  if (!condition) {
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  } else {
    passed += 1;
    console.log(`✓ ${name}`);
  }
}

const KEY = 'main';
const PROBE = `${KEY}/quota-probe`;

const STORAGE_LIB = require('path').resolve(process.cwd(), process.env.STORAGE_LIB);
function loadWith(quota, initial) {
  const { storage, map } = makeStorage(quota, initial);
  globalThis.window = { localStorage: storage };
  delete require.cache[require.resolve(STORAGE_LIB)];
  return { mod: require(STORAGE_LIB), map };
}

// 场景 A：配额充足，写入成功
{
  const { mod, map } = loadWith(100000, { [KEY]: 'x'.repeat(10) });
  let err = null;
  try {
    mod.setItemSafeChecked(KEY, 'y'.repeat(50));
  } catch (e) {
    err = e;
  }
  check('配额充足时写入成功', !err && map.get(KEY) === 'y'.repeat(50));
}

// 场景 B：配额不足、新值更大——拒绝覆盖，旧草稿完整保留
{
  const { mod, map } = loadWith(100, { [KEY]: 'x'.repeat(40) });
  const oldValue = map.get(KEY);
  let err = null;
  try {
    mod.setItemSafeChecked(KEY, 'y'.repeat(90));
  } catch (e) {
    err = e;
  }
  check('空间不足抛 StorageQuotaError', err instanceof mod.StorageQuotaError);
  check('旧草稿完整保留', map.get(KEY) === oldValue && oldValue === 'x'.repeat(40));
  check('探针键已清理', !map.has(PROBE));
}

// 场景 C：新值更小，配额紧张时替换仍成功（腾出空间）
{
  const { mod, map } = loadWith(100, { [KEY]: 'x'.repeat(90) });
  let err = null;
  try {
    mod.setItemSafeChecked(KEY, 'y'.repeat(30));
  } catch (e) {
    err = e;
  }
  check('缩容写入成功', !err && map.get(KEY) === 'y'.repeat(30));
  check('探针键已清理', !map.has(PROBE));
}

// 场景 D：估算剩余容量
{
  const { mod } = loadWith(1000, { other: 'x'.repeat(400) });
  const available = mod.estimateAvailableBytes();
  check('估算剩余容量接近真实值', available >= 500 && available <= 620, `估算 ${available}`);
}

// 场景 E：直接写入（非合流）失败时旧值保留
{
  const { mod, map } = loadWith(100, { [KEY]: 'x'.repeat(40) });
  const oldValue = map.get(KEY);
  let err = null;
  try {
    mod.setItemSafe(KEY, 'y'.repeat(200));
  } catch (e) {
    err = e;
  }
  check('普通写入超配额抛错', err instanceof mod.StorageQuotaError);
  check('普通写入失败旧值保留', map.get(KEY) === oldValue);
}

console.log(`\n${passed} 项通过`);
