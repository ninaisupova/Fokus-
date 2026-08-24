/* Фокус+ — облачная синхронизация (офлайн-first)
 * Кабинет: /focus/$code/admin (+ auth token)
 * Клиенты: /focus/$code/public (без пароля)
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
    if (
      typeof FocusAuth !== 'undefined' &&
      FocusAuth.requireAuth() &&
      FocusAuth.authConfigured() &&
      !FocusAuth.isLoggedIn()
    ) {
      return { state: 'error', label: 'Войдите в кабинет', meta };
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

  function baseUrl(databaseURL) {
    const base = getDatabaseURL(databaseURL);
    if (!base) {
      throw new Error('Не указан адрес облака Firebase. Откройте Настройки и следуйте инструкции.');
    }
    return base;
  }

  function encodeCode(blobId) {
    const code = encodeURIComponent(String(blobId || '').trim());
    if (!code) throw new Error('Нет кода синхронизации');
    return code;
  }

  function adminPath(blobId, databaseURL) {
    return `${baseUrl(databaseURL)}/v2/focus/${encodeCode(blobId)}/admin.json`;
  }

  function publicPath(blobId, databaseURL) {
    return `${baseUrl(databaseURL)}/v2/focus/${encodeCode(blobId)}/public.json`;
  }

  function legacyPath(blobId, databaseURL) {
    return `${baseUrl(databaseURL)}/focus/${encodeCode(blobId)}.json`;
  }

  async function authQuery(needAuth) {
    if (!needAuth || typeof FocusAuth === 'undefined') return '';
    if (FocusAuth.requireAuth && !FocusAuth.requireAuth()) return '';
    const token = await FocusAuth.getIdToken();
    return token ? `?auth=${encodeURIComponent(token)}` : '';
  }

  function adminAuthRequired() {
    return typeof FocusAuth !== 'undefined' && FocusAuth.requireAuth() && FocusAuth.isLoggedIn();
  }

  async function fetchJson(url, { method = 'GET', body, needAuth = false } = {}) {
    const q = await authQuery(needAuth);
    const full = `${url}${q}`;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
    let res;
    try {
      const opts = {
        method,
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        mode: 'cors',
        signal: ctrl?.signal,
      };
      if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      res = await fetch(full, opts);
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
      throw new Error(
        needAuth
          ? 'Нет доступа к календарю. Войдите в кабинет и проверьте Rules (см. FIREBASE_RULES.md).'
          : 'Облако закрыто. Проверьте Firebase Rules.'
      );
    }
    if (!res.ok) throw new Error(`${method === 'PUT' ? 'Запись' : 'Чтение'} облака: ${res.status}`);
    if (method === 'GET') {
      const data = await res.json();
      return { data: data || null };
    }
    return { data: body };
  }

  function emptyPublic() {
    return {
      settings: {},
      blocks: [],
      mine: {},
      inbox: {},
      publishedAt: '',
    };
  }

  function buildPublicMirror(data, prevPublic) {
    const settings = data.settings || {};
    const records = Array.isArray(data.records) ? data.records : [];
    const trashRecords = (data.trash && data.trash.records) || {};
    const blocks = records
      .filter((r) => r && r.status !== 'cancelled')
      .map((r) => ({
        id: r.id,
        date: r.date,
        time: r.time,
        duration: Number(r.duration) || 1,
        status: r.status || 'confirmed',
      }));

    // Только актуальные записи админа — удалённые не наследуем из prevPublic.mine
    const mine = {};
    records.forEach((r) => {
      if (!r?.publicToken) return;
      if (r.status === 'cancelled') return;
      if (trashRecords[r.id]) return;
      mine[r.publicToken] = {
        id: r.id,
        publicToken: r.publicToken,
        date: r.date,
        time: r.time,
        duration: Number(r.duration) || 1,
        type: r.type || '',
        status: r.status || 'pending',
        name: r.name || '',
        phone: r.phone || '',
        vk: r.vk || '',
        comment: r.comment || '',
        clientRescheduleCount: Number(r.clientRescheduleCount) || 0,
        proposedDate: r.proposedDate || '',
        proposedTime: r.proposedTime || '',
        updatedAt: r.updatedAt || r.createdAt || '',
      };
    });

    const adminIds = new Set(records.map((r) => r.id));
    const inbox = {};
    Object.entries(prevPublic?.inbox || {}).forEach(([id, rec]) => {
      if (!rec) return;
      // Уже в кабинете или удалена фотографом — клиенту не показываем
      if (adminIds.has(id) || trashRecords[id]) return;
      inbox[id] = rec;
    });

    return {
      settings: {
        workStart: settings.workStart || '10:00',
        workEnd: settings.workEnd || '20:00',
        bookingDuration: settings.bookingDuration ?? 1,
        bookingSlotStep: settings.bookingSlotStep ?? 60,
        bookingDaysAhead: settings.bookingDaysAhead ?? 60,
        freeClientReschedules: settings.freeClientReschedules ?? 1,
      },
      blocks,
      mine,
      inbox,
      publishedAt: new Date().toISOString(),
    };
  }

  function mergeInboxIntoAdmin(adminData, publicData) {
    const inbox = publicData?.inbox || {};
    const trashRecords = (adminData.trash && adminData.trash.records) || {};
    let changed = false;
    Object.values(inbox).forEach((rec) => {
      if (!rec?.id) return;
      // Не восстанавливать запись, которую фотограф уже удалил
      if (trashRecords[rec.id]) return;
      const idx = adminData.records.findIndex((r) => r.id === rec.id);
      if (idx < 0) {
        adminData.records.push(rec);
        if (rec.name || rec.phone) {
          FocusStorage.findOrCreateClient(adminData, {
            name: rec.name,
            phone: rec.phone,
            vk: rec.vk,
          });
        }
        changed = true;
      } else {
        const local = adminData.records[idx];
        if ((rec.updatedAt || '') > (local.updatedAt || '')) {
          adminData.records[idx] = { ...local, ...rec };
          changed = true;
        }
      }
    });
    return changed;
  }

  /** Загрузка admin: /v2/.../admin, иначе legacy /focus/code.json */
  async function apiGetAdmin(blobId, databaseURL) {
    try {
      const { data } = await fetchJson(adminPath(blobId, databaseURL), {
        needAuth: adminAuthRequired(),
      });
      if (data && typeof data === 'object' && (data.records || data.settings || data.version)) {
        return { data };
      }
    } catch (err) {
      const msg = String(err.message || '');
      if (msg.includes('Войдите') || msg.includes('Нет доступа')) {
        // попробуем legacy с тем же токеном (если Rules ещё разрешают /focus)
      } else if (!msg.includes('Чтение облака')) {
        /* continue to legacy */
      }
    }

    try {
      const { data: legacy } = await fetchJson(legacyPath(blobId, databaseURL), {
        needAuth: false,
      });
      if (legacy && typeof legacy === 'object' && (legacy.records || legacy.settings)) {
        return { data: legacy, fromLegacy: true };
      }
    } catch {
      /* нет legacy */
    }
    return { data: null };
  }

  async function apiPutAdmin(blobId, body, databaseURL) {
    return fetchJson(adminPath(blobId, databaseURL), {
      method: 'PUT',
      body,
      needAuth: adminAuthRequired(),
    });
  }

  async function apiGetPublic(blobId, databaseURL) {
    try {
      const { data } = await fetchJson(publicPath(blobId, databaseURL), { needAuth: false });
      if (data && typeof data === 'object') {
        return {
          data: {
            ...emptyPublic(),
            ...data,
            settings: { ...(emptyPublic().settings), ...(data.settings || {}) },
            blocks: Array.isArray(data.blocks) ? data.blocks : [],
            mine: data.mine && typeof data.mine === 'object' ? data.mine : {},
            inbox: data.inbox && typeof data.inbox === 'object' ? data.inbox : {},
          },
        };
      }
    } catch {
      /* empty */
    }
    return { data: emptyPublic() };
  }

  async function apiPutPublic(blobId, body, databaseURL) {
    return fetchJson(publicPath(blobId, databaseURL), {
      method: 'PUT',
      body,
      needAuth: false,
    });
  }

  async function publishPublic(blobId, adminData, databaseURL) {
    const { data: prev } = await apiGetPublic(blobId, databaseURL);
    const mirror = buildPublicMirror(adminData, prev);
    await apiPutPublic(blobId, mirror, databaseURL);
    return mirror;
  }

  async function withCloudLock(blobId, mutator, meta, maxTries = 5, databaseURL) {
    let lastError;
    for (let i = 0; i < maxTries; i += 1) {
      const { data: raw, fromLegacy } = await apiGetAdmin(blobId, databaseURL);
      let current = FocusStorage.migrate(raw && typeof raw === 'object' ? raw : {});

      try {
        const { data: pub } = await apiGetPublic(blobId, databaseURL);
        if (mergeInboxIntoAdmin(current, pub)) {
          current = FocusStorage.migrate(current);
        }
      } catch {
        /* public optional */
      }

      const next = await mutator(current);
      if (!next) {
        if (fromLegacy && raw) {
          await apiPutAdmin(blobId, payloadFrom(current, meta || { deviceId: 'device' }), databaseURL);
          await publishPublic(blobId, current, databaseURL);
        }
        return current;
      }
      const body = payloadFrom(next, meta || { deviceId: 'device' });
      try {
        const { data: freshRaw } = await apiGetAdmin(blobId, databaseURL);
        const fresh = FocusStorage.migrate(freshRaw && typeof freshRaw === 'object' ? freshRaw : {});
        const merged = mergeData(body, fresh);
        const finalBody = payloadFrom(merged, meta || { deviceId: 'device' });
        await apiPutAdmin(blobId, finalBody, databaseURL);
        await publishPublic(blobId, finalBody, databaseURL);
        return FocusStorage.migrate(finalBody);
      } catch (err) {
        lastError = err;
        if (i === maxTries - 1) throw err;
      }
    }
    throw lastError || new Error('Не удалось сохранить');
  }

  /** Блокировка только public (для book.html) */
  async function withPublicLock(blobId, mutator, maxTries = 5, databaseURL) {
    let lastError;
    for (let i = 0; i < maxTries; i += 1) {
      const { data: current } = await apiGetPublic(blobId, databaseURL);
      const next = await mutator({ ...emptyPublic(), ...current });
      if (!next) return current;
      try {
        const { data: fresh } = await apiGetPublic(blobId, databaseURL);
        // простое слияние inbox/mine/blocks по id
        const merged = {
          ...emptyPublic(),
          ...fresh,
          ...next,
          settings: { ...(fresh.settings || {}), ...(next.settings || {}) },
          blocks: mergeBlocks(fresh.blocks, next.blocks),
          mine: { ...(fresh.mine || {}), ...(next.mine || {}) },
          inbox: { ...(fresh.inbox || {}), ...(next.inbox || {}) },
          publishedAt: new Date().toISOString(),
        };
        // удалить ключи mine явно помеченные null
        Object.keys(merged.mine).forEach((k) => {
          if (merged.mine[k] == null) delete merged.mine[k];
        });
        await apiPutPublic(blobId, merged, databaseURL);
        return merged;
      } catch (err) {
        lastError = err;
        if (i === maxTries - 1) throw err;
      }
    }
    throw lastError || new Error('Не удалось сохранить запись');
  }

  function mergeBlocks(a = [], b = []) {
    const map = new Map();
    [...(a || []), ...(b || [])].forEach((bl) => {
      if (!bl?.id) return;
      map.set(bl.id, bl);
    });
    return [...map.values()].filter((bl) => bl.status !== 'cancelled');
  }

  /** Превращает public-зеркало в «records» для getFreeSlots / UI записи */
  function recordsFromPublic(pub) {
    const fromBlocks = (pub.blocks || []).map((bl) => ({
      id: bl.id,
      date: bl.date,
      time: bl.time,
      duration: Number(bl.duration) || 1,
      status: bl.status || 'confirmed',
      kind: 'client',
      name: '',
      phone: '',
    }));
    const fromInbox = Object.values(pub.inbox || {});
    const fromMine = Object.values(pub.mine || {});
    const map = new Map();
    [...fromBlocks, ...fromInbox, ...fromMine].forEach((r) => {
      if (!r?.id) return;
      const prev = map.get(r.id);
      if (!prev || (r.updatedAt || '') >= (prev.updatedAt || '')) map.set(r.id, r);
    });
    return [...map.values()];
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
    if (typeof FocusAuth !== 'undefined' && FocusAuth.requireAuth() && !FocusAuth.isLoggedIn()) {
      throw new Error('Сначала войдите в кабинет (email и пароль).');
    }

    syncing = true;
    notify(statusInfo());
    try {
      const blobId = newSyncCode();
      const body = payloadFrom(localData, meta);
      await apiPutAdmin(blobId, body, meta.databaseURL);
      await publishPublic(blobId, body, meta.databaseURL);
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
    if (typeof FocusAuth !== 'undefined' && FocusAuth.requireAuth() && !FocusAuth.isLoggedIn()) {
      throw new Error('Сначала войдите в кабинет (email и пароль).');
    }

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
    if (typeof FocusAuth !== 'undefined' && FocusAuth.requireAuth() && !FocusAuth.isLoggedIn()) {
      return null;
    }

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
    if (typeof FocusAuth !== 'undefined' && FocusAuth.requireAuth() && !FocusAuth.isLoggedIn()) {
      return null;
    }

    syncing = true;
    notify(statusInfo());
    try {
      const local = FocusStorage.load();
      const { data: raw } = await apiGetAdmin(meta.blobId, meta.databaseURL);
      let remote = FocusStorage.migrate(raw && typeof raw === 'object' ? raw : {});
      let inboxChanged = false;
      try {
        const { data: pub } = await apiGetPublic(meta.blobId, meta.databaseURL);
        inboxChanged = mergeInboxIntoAdmin(remote, pub);
        remote = FocusStorage.migrate(remote);
      } catch {
        /* ignore */
      }
      let saved = mergeData(local, remote);

      if (meta.dirty || inboxChanged) {
        saved = await withCloudLock(
          meta.blobId,
          (fresh) => {
            const merged = mergeData(saved, fresh);
            return merged;
          },
          meta,
          5,
          meta.databaseURL
        );
      } else {
        // Обновить public-зеркало (настройки/блоки), не трогая admin без нужды
        try {
          await publishPublic(meta.blobId, saved, meta.databaseURL);
        } catch {
          /* ignore */
        }
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
      if (typeof FocusAuth !== 'undefined' && FocusAuth.requireAuth() && !FocusAuth.isLoggedIn()) {
        return;
      }
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
    withPublicLock,
    cloudGet: apiGetAdmin,
    cloudPut: apiPutAdmin,
    cloudGetPublic: apiGetPublic,
    cloudPutPublic: apiPutPublic,
    publishPublic,
    buildPublicMirror,
    recordsFromPublic,
    emptyPublic,
    payloadFrom,
    getDatabaseURL,
    cloudReady,
    setDatabaseURL,
  };
})();
