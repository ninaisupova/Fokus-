/* Фокус+ — облачная синхронизация (офлайн-first)
 * Локально: localStorage всегда работает без интернета.
 * Облако: Firebase Realtime Database (надёжнее, чем jsonblob).
 */
const FocusSync = (() => {
  const META_KEY = 'focusplus_sync_meta';
  const PUSH_DELAY = 3000;

  let pushTimer = null;
  let syncing = false;
  let onChange = null;

  function defaultMeta() {
    return {
      enabled: false,
      blobId: '',
      deviceId: '',
      lastSyncAt: '',
      lastError: '',
      dirty: false,
      databaseURL: '',
    };
  }

  function loadMeta() {
    try {
      const raw = localStorage.getItem(META_KEY);
      if (!raw) return defaultMeta();
      return { ...defaultMeta(), ...JSON.parse(raw) };
    } catch {
      return defaultMeta();
    }
  }

  function saveMeta(meta) {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  }

  function ensureDeviceId(meta) {
    if (meta.deviceId) return meta;
    meta.deviceId = FocusStorage.uid();
    saveMeta(meta);
    return meta;
  }

  function isOnline() {
    return typeof navigator !== 'undefined' ? navigator.onLine : true;
  }

  function setHandler(fn) {
    onChange = fn;
  }

  function notify(status) {
    onChange?.(status);
  }

  /** Адрес Firebase: настройки → cloud-config.js → параметр ссылки */
  function getDatabaseURL(override) {
    const fromMeta = (loadMeta().databaseURL || '').trim().replace(/\/$/, '');
    const fromConfig = String(window.FOCUS_CLOUD?.databaseURL || '')
      .trim()
      .replace(/\/$/, '');
    const fromArg = String(override || '')
      .trim()
      .replace(/\/$/, '');
    return fromArg || fromMeta || fromConfig || '';
  }

  function cloudReady(overrideUrl) {
    return Boolean(getDatabaseURL(overrideUrl));
  }

  function statusInfo() {
    const meta = loadMeta();
    if (!cloudReady()) {
      return {
        state: 'error',
        label: 'Нужно подключить облако (см. Настройки)',
        meta,
      };
    }
    if (!meta.enabled || !meta.blobId) {
      return { state: 'off', label: 'Синхронизация выключена', meta };
    }
    if (!isOnline()) {
      return { state: 'offline', label: 'Офлайн · данные сохранены здесь', meta };
    }
    if (syncing) {
      return { state: 'syncing', label: 'Синхронизация…', meta };
    }
    if (meta.lastError) {
      return { state: 'error', label: 'Ошибка синхронизации', meta };
    }
    if (meta.dirty) {
      return { state: 'pending', label: 'Есть несохранённые в облако', meta };
    }
    if (meta.lastSyncAt) {
      const t = new Date(meta.lastSyncAt);
      const time = t.toLocaleString('ru-RU', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
      return { state: 'ok', label: `Синхронизировано · ${time}`, meta };
    }
    return { state: 'ok', label: 'Синхронизация включена', meta };
  }

  function mergeById(localArr = [], remoteArr = [], trashMap = {}) {
    const map = new Map();
    const stamp = (item) => item?.updatedAt || item?.createdAt || '';

    [...(localArr || []), ...(remoteArr || [])].forEach((item) => {
      if (!item || !item.id) return;
      const prev = map.get(item.id);
      if (!prev || stamp(item) >= stamp(prev)) map.set(item.id, item);
    });

    Object.entries(trashMap || {}).forEach(([id, deletedAt]) => {
      const item = map.get(id);
      if (!item) return;
      if (String(deletedAt) >= stamp(item)) map.delete(id);
    });

    return [...map.values()];
  }

  function mergeTrash(a = {}, b = {}) {
    const out = { ...a };
    Object.entries(b || {}).forEach(([id, deletedAt]) => {
      if (!out[id] || String(deletedAt) > String(out[id])) out[id] = deletedAt;
    });
    return out;
  }

  function mergeData(local, remote) {
    const localTrash = local.trash || { records: {}, clients: {}, notes: {} };
    const remoteTrash = remote.trash || { records: {}, clients: {}, notes: {} };
    const trash = {
      records: mergeTrash(localTrash.records, remoteTrash.records),
      clients: mergeTrash(localTrash.clients, remoteTrash.clients),
      notes: mergeTrash(localTrash.notes, remoteTrash.notes),
    };

    const localSettings = local.settings || {};
    const remoteSettings = remote.settings || {};
    const settingsStamp = (s) => s.settingsUpdatedAt || '';
    const settings =
      settingsStamp(remoteSettings) > settingsStamp(localSettings)
        ? { ...localSettings, ...remoteSettings }
        : { ...remoteSettings, ...localSettings };

    settings.theme = localSettings.theme || settings.theme || 'light';

    return FocusStorage.migrate({
      ...local,
      ...remote,
      records: mergeById(local.records, remote.records, trash.records),
      clients: mergeById(local.clients, remote.clients, trash.clients),
      notes: mergeById(local.notes, remote.notes, trash.notes),
      projects: mergeById(local.projects || [], remote.projects || [], {}),
      trash,
      settings,
      syncRevision: Math.max(Number(local.syncRevision) || 0, Number(remote.syncRevision) || 0) + 1,
      syncedAt: new Date().toISOString(),
    });
  }

  function payloadFrom(data, meta) {
    return {
      ...data,
      syncRevision: (Number(data.syncRevision) || 0) + 1,
      syncedAt: new Date().toISOString(),
      syncedBy: meta.deviceId,
    };
  }

  function cloudPath(blobId, databaseURL) {
    const base = getDatabaseURL(databaseURL);
    if (!base) {
      throw new Error('Не указан адрес облака Firebase. Откройте Настройки и следуйте инструкции.');
    }
    const code = encodeURIComponent(String(blobId || '').trim());
    if (!code) throw new Error('Нет кода синхронизации');
    return `${base}/focus/${code}.json`;
  }

  async function apiGet(blobId, databaseURL) {
    const url = cloudPath(blobId, databaseURL);
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        mode: 'cors',
        signal: ctrl?.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error('Облако не отвечает. Проверьте интернет и Rules в Firebase.');
      }
      throw new Error(
        'Не удалось связаться с облаком. Проверьте интернет и адрес Firebase в Настройках.'
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('Облако закрыто. В Firebase → Rules должны быть разрешены read/write.');
    }
    if (!res.ok) throw new Error(`Чтение облака: ${res.status}`);
    const data = await res.json();
    return { data: data || null, etag: '' };
  }

  async function apiPut(blobId, body, _etag, databaseURL) {
    const url = cloudPath(blobId, databaseURL);
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
    let res;
    try {
      res = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        cache: 'no-store',
        mode: 'cors',
        signal: ctrl?.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error('Облако не отвечает при сохранении. Попробуйте ещё раз.');
      }
      throw new Error(
        'Не удалось сохранить в облако. Проверьте интернет и Firebase Rules.'
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('Облако закрыто. Откройте правила Firebase (read/write true).');
    }
    if (!res.ok) throw new Error(`Запись в облако: ${res.status}`);
    return { data: body, etag: '' };
  }

  async function withCloudLock(blobId, mutator, meta, maxTries = 5, databaseURL) {
    let lastError;
    for (let i = 0; i < maxTries; i += 1) {
      const { data: raw } = await apiGet(blobId, databaseURL);
      const current = FocusStorage.migrate(raw && typeof raw === 'object' ? raw : {});
      const next = await mutator(current);
      if (!next) return current;
      const body = payloadFrom(next, meta || { deviceId: 'device' });
      try {
        // Повторное чтение перед записью снижает риск затереть чужую запись
        const { data: freshRaw } = await apiGet(blobId, databaseURL);
        const fresh = FocusStorage.migrate(freshRaw && typeof freshRaw === 'object' ? freshRaw : {});
        const merged = mergeData(body, fresh);
        const finalBody = payloadFrom(merged, meta || { deviceId: 'device' });
        await apiPut(blobId, finalBody, '', databaseURL);
        return FocusStorage.migrate(finalBody);
      } catch (err) {
        lastError = err;
        if (i === maxTries - 1) throw err;
      }
    }
    throw lastError || new Error('Не удалось сохранить');
  }

  function newSyncCode() {
    const raw = FocusStorage.uid().replace(/-/g, '');
    return `fp${raw.slice(0, 20)}`;
  }

  async function enable(localData) {
    let meta = ensureDeviceId(loadMeta());
    if (!cloudReady()) {
      throw new Error('Сначала вставьте адрес Firebase в Настройках (блок «Облако»).');
    }
    if (!isOnline()) throw new Error('Нужен интернет, чтобы создать синхронизацию');

    syncing = true;
    notify(statusInfo());
    try {
      const blobId = newSyncCode();
      const body = payloadFrom(localData, meta);
      await apiPut(blobId, body, '', meta.databaseURL);
      meta = {
        ...meta,
        enabled: true,
        blobId,
        dirty: false,
        lastSyncAt: new Date().toISOString(),
        lastError: '',
      };
      saveMeta(meta);
      FocusStorage.save({ ...localData, syncedAt: body.syncedAt, syncRevision: body.syncRevision });
      return { meta, data: localData };
    } catch (err) {
      meta.lastError = err.message || String(err);
      saveMeta(meta);
      throw err;
    } finally {
      syncing = false;
      notify(statusInfo());
    }
  }

  async function join(blobId, localData) {
    let meta = ensureDeviceId(loadMeta());
    const id = String(blobId || '').trim();
    if (!id) throw new Error('Введите код синхронизации');
    if (!cloudReady()) {
      throw new Error('Сначала вставьте адрес Firebase в Настройках.');
    }
    if (!isOnline()) throw new Error('Нужен интернет, чтобы подключить синхронизацию');

    syncing = true;
    notify(statusInfo());
    try {
      const saved = await withCloudLock(
        id,
        (remote) => mergeData(localData, remote),
        meta,
        5,
        meta.databaseURL
      );
      FocusStorage.save(saved);
      meta = {
        ...meta,
        enabled: true,
        blobId: id,
        dirty: false,
        lastSyncAt: new Date().toISOString(),
        lastError: '',
      };
      saveMeta(meta);
      return { meta, data: saved };
    } catch (err) {
      meta.lastError = err.message || String(err);
      saveMeta(meta);
      throw err;
    } finally {
      syncing = false;
      notify(statusInfo());
    }
  }

  function disable() {
    const meta = loadMeta();
    const next = {
      ...defaultMeta(),
      deviceId: meta.deviceId,
      databaseURL: meta.databaseURL,
    };
    saveMeta(next);
    notify(statusInfo());
  }

  function setDatabaseURL(url) {
    const meta = loadMeta();
    meta.databaseURL = String(url || '')
      .trim()
      .replace(/\/$/, '');
    saveMeta(meta);
    notify(statusInfo());
    return meta;
  }

  function markDirty() {
    const meta = loadMeta();
    if (!meta.enabled || !meta.blobId) return;
    meta.dirty = true;
    saveMeta(meta);
    notify(statusInfo());
    schedulePush();
  }

  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      push().catch(() => {});
    }, PUSH_DELAY);
  }

  async function push() {
    const meta = loadMeta();
    if (!meta.enabled || !meta.blobId || !isOnline() || syncing) return null;
    if (!cloudReady()) return null;

    syncing = true;
    notify(statusInfo());
    try {
      const local = FocusStorage.load();
      const saved = await withCloudLock(
        meta.blobId,
        (remote) => mergeData(local, remote),
        meta,
        5,
        meta.databaseURL
      );
      FocusStorage.save(saved);
      const next = {
        ...meta,
        dirty: false,
        lastSyncAt: new Date().toISOString(),
        lastError: '',
      };
      saveMeta(next);
      return saved;
    } catch (err) {
      const m = loadMeta();
      m.lastError = err.message || String(err);
      saveMeta(m);
      return null;
    } finally {
      syncing = false;
      notify(statusInfo());
    }
  }

  async function pull() {
    const meta = loadMeta();
    if (!meta.enabled || !meta.blobId || !isOnline() || syncing) return null;
    if (!cloudReady()) return null;

    syncing = true;
    notify(statusInfo());
    try {
      const local = FocusStorage.load();
      const { data: raw } = await apiGet(meta.blobId, meta.databaseURL);
      const remote = FocusStorage.migrate(raw && typeof raw === 'object' ? raw : {});
      let saved = mergeData(local, remote);

      if (meta.dirty) {
        saved = await withCloudLock(
          meta.blobId,
          (fresh) => mergeData(saved, fresh),
          meta,
          5,
          meta.databaseURL
        );
      }

      FocusStorage.save(saved);
      const next = {
        ...meta,
        dirty: false,
        lastSyncAt: new Date().toISOString(),
        lastError: '',
      };
      saveMeta(next);
      return saved;
    } catch (err) {
      const m = loadMeta();
      m.lastError = err.message || String(err);
      saveMeta(m);
      return null;
    } finally {
      syncing = false;
      notify(statusInfo());
    }
  }

  async function syncNow() {
    if (!isOnline()) return null;
    const meta = loadMeta();
    if (!meta.enabled || !meta.blobId) return null;
    return pull();
  }

  function startAutoSync(getData, setData) {
    ensureDeviceId(loadMeta());

    const run = async () => {
      const data = await syncNow();
      if (data) setData(data);
    };

    window.addEventListener('online', () => {
      notify(statusInfo());
      run();
    });
    window.addEventListener('offline', () => notify(statusInfo()));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') run();
    });

    setInterval(() => {
      if (isOnline() && loadMeta().enabled && document.visibilityState === 'visible') run();
    }, 20000);

    if (isOnline() && loadMeta().enabled) {
      setTimeout(run, 500);
    }

    notify(statusInfo());
  }

  return {
    loadMeta,
    saveMeta,
    statusInfo,
    isOnline,
    setHandler,
    enable,
    join,
    disable,
    markDirty,
    push,
    pull,
    syncNow,
    startAutoSync,
    mergeData,
    withCloudLock,
    cloudGet: apiGet,
    cloudPut: apiPut,
    payloadFrom,
    getDatabaseURL,
    cloudReady,
    setDatabaseURL,
  };
})();
