/* Фокус+ — облачная синхронизация (офлайн-first)
 * Локально: localStorage всегда работает без интернета.
 * В облаке: jsonblob.com — общий код на телефоне и ПК.
 */
const FocusSync = (() => {
  const META_KEY = 'focusplus_sync_meta';
  const API = 'https://jsonblob.com/api/jsonBlob';
  const PUSH_DELAY = 3000;
  const AUTO_SYNC_MS = 180000;

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

  function statusInfo() {
    const meta = loadMeta();
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

    // Тема — с текущего устройства
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

  async function apiCreate(body) {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Создание облака: ${res.status}`);
    const loc = res.headers.get('Location') || res.headers.get('location') || '';
    const id = loc.split('/').filter(Boolean).pop() || '';
    if (!id) throw new Error('Не получен код синхронизации');
    return id;
  }

  async function apiGet(blobId) {
    const res = await fetch(`${API}/${encodeURIComponent(blobId)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (res.status === 404) throw new Error('Код не найден. Проверьте код синхронизации.');
    if (res.status === 429) throw new Error('Слишком много запросов. Подождите минуту и нажмите «Синхронизировать сейчас».');
    if (!res.ok) throw new Error(`Чтение облака: ${res.status}`);
    const data = await res.json();
    const etag = res.headers.get('ETag') || res.headers.get('etag') || '';
    return { data, etag };
  }

  async function apiPut(blobId, body, etag) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (etag) headers['If-Match'] = etag;
    const res = await fetch(`${API}/${encodeURIComponent(blobId)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    if (res.status === 404) throw new Error('Код не найден');
    if (res.status === 412) {
      const err = new Error('conflict');
      err.code = 'conflict';
      throw err;
    }
    if (res.status === 429) throw new Error('Слишком много запросов. Подождите минуту.');
    if (!res.ok) throw new Error(`Запись в облако: ${res.status}`);
    const nextEtag = res.headers.get('ETag') || res.headers.get('etag') || '';
    let data = body;
    try {
      data = await res.json();
    } catch {
      /* keep body */
    }
    return { data, etag: nextEtag };
  }

  /**
   * Безопасная запись в облако: читаем → меняем → пишем.
   * При конфликте (кто-то успел сохранить раньше) — повторяем.
   */
  async function withCloudLock(blobId, mutator, meta, maxTries = 5) {
    let lastError;
    for (let i = 0; i < maxTries; i += 1) {
      const { data: raw, etag } = await apiGet(blobId);
      const current = FocusStorage.migrate(raw);
      const next = await mutator(current);
      if (!next) return current;
      const body = payloadFrom(next, meta || { deviceId: 'device' });
      try {
        await apiPut(blobId, body, etag);
        return FocusStorage.migrate(body);
      } catch (err) {
        lastError = err;
        if (err.code !== 'conflict') throw err;
        // повтор с свежими данными
      }
    }
    throw lastError || new Error('Не удалось сохранить из‑за конфликта');
  }

  async function enable(localData) {
    let meta = ensureDeviceId(loadMeta());
    if (!isOnline()) throw new Error('Нужен интернет, чтобы создать синхронизацию');

    syncing = true;
    notify(statusInfo());
    try {
      const body = payloadFrom(localData, meta);
      const blobId = await apiCreate(body);
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
    if (!isOnline()) throw new Error('Нужен интернет, чтобы подключить синхронизацию');

    syncing = true;
    notify(statusInfo());
    try {
      const saved = await withCloudLock(
        id,
        (remote) => mergeData(localData, remote),
        meta
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
    const meta = { ...defaultMeta(), deviceId: loadMeta().deviceId };
    saveMeta(meta);
    notify(statusInfo());
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

    syncing = true;
    notify(statusInfo());
    try {
      const local = FocusStorage.load();
      const saved = await withCloudLock(
        meta.blobId,
        (remote) => mergeData(local, remote),
        meta
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

    syncing = true;
    notify(statusInfo());
    try {
      const local = FocusStorage.load();
      const { data: raw } = await apiGet(meta.blobId);
      const remote = FocusStorage.migrate(raw);
      const merged = mergeData(local, remote);

      // Если локально были правки — аккуратно записываем merged обратно
      let saved = merged;
      if (meta.dirty) {
        saved = await withCloudLock(
          meta.blobId,
          (fresh) => mergeData(merged, fresh),
          meta
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

    // Чаще, когда вкладка открыта — чтобы онлайн-записи быстрее появлялись
    setInterval(() => {
      if (isOnline() && loadMeta().enabled && document.visibilityState === 'visible') run();
    }, 45000);

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
    /** Публичная запись: { data, etag } */
    cloudGet: apiGet,
    cloudPut: apiPut,
    payloadFrom,
  };
})();
