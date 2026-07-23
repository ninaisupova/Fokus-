/* Фокус+ — хранилище (localStorage, офлайн)
 * Этап 2 (онлайн-запись): клиент может сам перенести запись 1 раз
 * (clientRescheduleCount < 1); дальше — только после подтверждения фотографа.
 */
const FocusStorage = (() => {
  const KEY = 'focusplus_v15';
  const VERSION = 1.8;

  const defaultSettings = () => ({
    theme: 'light',
    workStart: '10:00',
    workEnd: '20:00',
    settingsUpdatedAt: '',
    // Этап 2: сколько раз клиент может перенести слот сам
    freeClientReschedules: 1,
    // Публичная запись
    bookingDuration: 1,
    bookingSlotStep: 60,
    bookingDaysAhead: 60,
  });

  const defaultData = () => ({
    version: VERSION,
    records: [],
    clients: [],
    notes: [],
    projects: [],
    trash: { records: {}, clients: {}, notes: {} },
    settings: defaultSettings(),
    syncRevision: 0,
    syncedAt: '',
  });

  function migrateRecord(r) {
    return {
      ...r,
      kind: r.kind === 'personal' ? 'personal' : 'client',
      clientRescheduleCount: Number(r.clientRescheduleCount) || 0,
      duration: Number(r.duration) || 1,
    };
  }

  function migrate(data) {
    const trash = data.trash || { records: {}, clients: {}, notes: {} };
    const merged = {
      ...defaultData(),
      ...data,
      version: VERSION,
      settings: { ...defaultSettings(), ...(data.settings || {}) },
      records: Array.isArray(data.records) ? data.records.map(migrateRecord) : [],
      clients: Array.isArray(data.clients) ? data.clients : [],
      notes: Array.isArray(data.notes) ? data.notes : [],
      projects: Array.isArray(data.projects) ? data.projects : [],
      trash: {
        records: { ...(trash.records || {}) },
        clients: { ...(trash.clients || {}) },
        notes: { ...(trash.notes || {}) },
      },
      syncRevision: Number(data.syncRevision) || 0,
      syncedAt: data.syncedAt || '',
    };
    return merged;
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaultData();
      const data = JSON.parse(raw);
      const migrated = migrate(data);
      if (Number(data.version) !== VERSION) {
        save(migrated);
      }
      return migrated;
    } catch {
      return defaultData();
    }
  }

  function save(data) {
    localStorage.setItem(KEY, JSON.stringify({ ...data, version: VERSION }));
  }

  function uid() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function normalizePhone(phone) {
    return String(phone || '').replace(/\D/g, '');
  }

  function findOrCreateClient(data, { name, phone, vk }) {
    const digits = normalizePhone(phone);
    let client = data.clients.find((c) => {
      if (digits && normalizePhone(c.phone) === digits) return true;
      return false;
    });

    if (!client) {
      client = {
        id: uid(),
        name: (name || 'Без имени').trim(),
        phone: (phone || '').trim(),
        vk: (vk || '').trim(),
        comment: '',
        createdAt: new Date().toISOString(),
      };
      data.clients.push(client);
    } else {
      if (name) client.name = name.trim();
      if (phone) client.phone = phone.trim();
      if (vk) client.vk = vk.trim();
    }
    return client;
  }

  function remainder(price, prepaid) {
    return Math.max(0, Number(price || 0) - Number(prepaid || 0));
  }

  /** Минуты от полуночи для "HH:MM" */
  function timeToMinutes(time) {
    const [h, m] = String(time || '00:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  function minutesToTime(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  /** Список слотов с шагом 30 мин в рабочих часах */
  function buildTimeSlots(workStart, workEnd) {
    const start = timeToMinutes(workStart || '10:00');
    const end = timeToMinutes(workEnd || '20:00');
    const slots = [];
    for (let t = start; t <= end; t += 30) {
      slots.push(minutesToTime(t));
    }
    return slots;
  }

  /**
   * Пересечение интервалов [start, start+duration) в минутах.
   * excludeId — не учитывать эту запись (редактирование / перенос).
   */
  function hasConflict(records, { date, time, duration, excludeId }) {
    const start = timeToMinutes(time);
    const end = start + Math.round(Number(duration || 1) * 60);
    return records.some((r) => {
      if (r.id === excludeId) return false;
      if (r.status === 'cancelled') return false;
      if (r.date !== date) return false;
      const rStart = timeToMinutes(r.time);
      const rEnd = rStart + Math.round(Number(r.duration || 1) * 60);
      return start < rEnd && end > rStart;
    });
  }

  function dayIntervals(records, date) {
    return records
      .filter((r) => r.date === date && r.status !== 'cancelled')
      .map((r) => {
        const start = timeToMinutes(r.time);
        const end = start + Math.round(Number(r.duration || 1) * 60);
        return { start, end };
      })
      .sort((a, b) => a.start - b.start);
  }

  function localTodayISO(now = new Date()) {
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
  }

  /** Дата/время уже в прошлом (запись туда недоступна). */
  function isSlotInPast(date, time, now = new Date()) {
    const todayISO = localTodayISO(now);
    if (!date || date < todayISO) return true;
    if (date > todayISO) return false;
    return timeToMinutes(time) <= now.getHours() * 60 + now.getMinutes();
  }

  /**
   * Свободные старты слотов в рабочих часах.
   * Публичный вид: только время, без имён и сумм.
   * По умолчанию: прошлые дни пустые; на сегодня прошедшие часы не предлагаются.
   * options.blockPast === false — считать слоты без отсечения «сейчас» (для крестов в архиве).
   */
  function getFreeSlots(
    records,
    date,
    workStart,
    workEnd,
    durationHours = 0.5,
    stepMinutes = 30,
    options = {}
  ) {
    const blockPast = options.blockPast !== false;
    const workFrom = timeToMinutes(workStart || '10:00');
    const workTo = timeToMinutes(workEnd || '20:00');
    const need = Math.round(Number(durationHours) * 60);
    const step = Math.max(15, Number(stepMinutes) || 30);
    const occupied = dayIntervals(records, date);
    const free = [];

    const now = new Date();
    const todayISO = localTodayISO(now);

    if (blockPast && date < todayISO) return free;

    const nowMinutes =
      blockPast && date === todayISO ? now.getHours() * 60 + now.getMinutes() : -1;

    for (let t = workFrom; t + need <= workTo; t += step) {
      // Сегодня: слот уже начался или наступил — не предлагать
      if (nowMinutes >= 0 && t <= nowMinutes) continue;

      const end = t + need;
      const clash = occupied.some((iv) => t < iv.end && end > iv.start);
      if (!clash) free.push(minutesToTime(t));
    }
    return free;
  }

  /** День полностью занят (крест), если нет ни одного свободного слота на 30 мин */
  function isDayFullyBooked(records, date, workStart, workEnd) {
    const todayISO = localTodayISO();
    // Прошлые дни: крест по занятости записями, без отсечения текущего времени
    return (
      getFreeSlots(records, date, workStart, workEnd, 0.5, 30, {
        blockPast: date >= todayISO,
      }).length === 0
    );
  }

  function dayHasBookings(records, date) {
    return records.some((r) => r.date === date && r.status !== 'cancelled');
  }

  function paymentStatus(price, prepaid) {
    const p = Number(price || 0);
    const pre = Number(prepaid || 0);
    if (p <= 0 && pre <= 0) return { key: 'none', label: 'Без суммы' };
    if (pre <= 0) return { key: 'unpaid', label: 'Не оплачено' };
    if (pre >= p && p > 0) return { key: 'paid', label: 'Оплачено' };
    return { key: 'prepay', label: 'Предоплата' };
  }

  function exportJson() {
    return JSON.stringify(load(), null, 2);
  }

  function importJson(text) {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object') throw new Error('Неверный файл');
    const merged = migrate(data);
    save(merged);
    return merged;
  }

  function clearAll() {
    localStorage.removeItem(KEY);
    return defaultData();
  }

  function touchTrash(data, collection, id) {
    if (!data.trash) data.trash = { records: {}, clients: {}, notes: {} };
    if (!data.trash[collection]) data.trash[collection] = {};
    data.trash[collection][id] = new Date().toISOString();
  }

  return {
    KEY,
    VERSION,
    load,
    save,
    uid,
    findOrCreateClient,
    remainder,
    exportJson,
    importJson,
    clearAll,
    normalizePhone,
    timeToMinutes,
    minutesToTime,
    buildTimeSlots,
    hasConflict,
    dayIntervals,
    getFreeSlots,
    isSlotInPast,
    localTodayISO,
    isDayFullyBooked,
    dayHasBookings,
    paymentStatus,
    defaultSettings,
    migrate,
    touchTrash,
  };
})();
