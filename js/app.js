/* Фокус+ — приложение */
(() => {
  const money = (n) =>
    `${Math.round(Number(n) || 0).toLocaleString('ru-RU')} ₽`;

  const state = {
    data: FocusStorage.load(),
    view: 'calendar',
    cursor: new Date(),
    selectedDate: FocusCalendar.toISODate(new Date()),
    filter: 'all',
    activeRecordId: null,
    clientQuery: '',
    formKind: 'client',
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function persist() {
    FocusStorage.save(state.data);
    FocusSync.markDirty();
    updateSyncStatusUI();
  }

  const SEEN_KEY = 'focusplus_seen_public';

  function loadSeenPublic() {
    try {
      return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'));
    } catch {
      return new Set();
    }
  }

  function saveSeenPublic(set) {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...set].slice(-200)));
  }

  function formatRuShort(iso, time) {
    try {
      const d = FocusCalendar.parseISODate(iso);
      const date = d.toLocaleDateString('ru-RU', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      });
      return `${date} · ${time}`;
    } catch {
      return `${iso} ${time}`;
    }
  }

  function updateNotifyStatus() {
    const el = $('#notifyStatus');
    if (!el || !('Notification' in window)) {
      if (el) el.textContent = 'Этот браузер не поддерживает уведомления.';
      return;
    }
    const p = Notification.permission;
    if (p === 'granted') el.textContent = 'Уведомления включены (и когда вкладка свёрнута).';
    else if (p === 'denied') el.textContent = 'Уведомления запрещены в настройках браузера.';
    else el.textContent = 'Можно включить системные уведомления кнопкой выше.';
  }

  function showBrowserNotify(record) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const n = new Notification('Новая запись · Фокус+', {
        body: `${record.name} · ${formatRuShort(record.date, record.time)} · ${record.type || ''}`,
        tag: `booking-${record.id}`,
        renotify: true,
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      /* ignore */
    }
  }

  let toastRecordId = null;

  function hideBookingToast() {
    $('#bookingToast')?.classList.add('hidden');
    toastRecordId = null;
  }

  function showBookingToast(record) {
    toastRecordId = record.id;
    const title = $('#bookingToastTitle');
    const body = $('#bookingToastBody');
    if (title) title.textContent = record.name || 'Клиент записался';
    if (body) {
      body.textContent = `${formatRuShort(record.date, record.time)}\n${record.type || ''}${
        record.phone ? `\n${record.phone}` : ''
      }`;
      body.style.whiteSpace = 'pre-line';
    }
    $('#bookingToast')?.classList.remove('hidden');
    showBrowserNotify(record);
  }

  function applyCloudData(data, { announce = false } = {}) {
    const beforeIds = new Set(state.data.records.map((r) => r.id));
    const seen = loadSeenPublic();
    state.data = data;

    const brandNew = data.records.filter(
      (r) =>
        r.source === 'public' &&
        r.status !== 'cancelled' &&
        !beforeIds.has(r.id) &&
        !seen.has(r.id)
    );

    if (brandNew.length) {
      const newest = [...brandNew].sort((a, b) =>
        (b.createdAt || `${b.date}${b.time}`).localeCompare(a.createdAt || `${a.date}${a.time}`)
      )[0];
      state.selectedDate = newest.date;
      state.filter = 'all';
      $$('#recordFilters .chip').forEach((c) =>
        c.classList.toggle('active', c.dataset.filter === 'all')
      );
      const d = FocusCalendar.parseISODate(newest.date);
      state.cursor = new Date(d.getFullYear(), d.getMonth(), 1);
      brandNew.forEach((r) => seen.add(r.id));
      if (announce) showBookingToast(newest);
    }

    data.records.forEach((r) => {
      if (r.source === 'public') seen.add(r.id);
    });
    saveSeenPublic(seen);

    render();
    return brandNew;
  }

  function seedSeenPublicIds() {
    const seen = loadSeenPublic();
    state.data.records.forEach((r) => {
      if (r.source === 'public') seen.add(r.id);
    });
    saveSeenPublic(seen);
  }

  async function runManualSync({ quiet = false } = {}) {
    if (!FocusSync.isOnline()) {
      if (!quiet) alert('Нет интернета. Локальные данные сохранены.');
      return null;
    }
    const meta = FocusSync.loadMeta();
    if (!meta.enabled) {
      if (!quiet) alert('Сначала включите синхронизацию в Настройках.');
      return null;
    }
    const data = await FocusSync.syncNow();
    if (data) {
      const fresh = applyCloudData(data, { announce: true });
      if (!quiet && !fresh.length) alert('Синхронизация выполнена. Новых онлайн-записей нет.');
      return data;
    }
    updateSyncStatusUI();
    if (!quiet) {
      const err = FocusSync.loadMeta().lastError;
      alert(err || 'Не удалось синхронизировать');
    }
    return null;
  }

  function updateSyncStatusUI() {
    const info = FocusSync.statusInfo();
    const text = $('#syncStatusText');
    const dot = $('#syncStatusDot');
    const settingsStatus = $('#syncSettingsStatus');
    const codeWrap = $('#syncCodeWrap');
    const joinWrap = $('#syncJoinWrap');
    const codeDisplay = $('#syncCodeDisplay');

    if (text) text.textContent = info.label;
    if (dot) {
      dot.className = `sync-dot sync-${info.state}`;
    }
    if (settingsStatus) {
      settingsStatus.textContent = info.meta.lastError
        ? `${info.label}: ${info.meta.lastError}`
        : info.label;
    }

    const enabled = info.meta.enabled && info.meta.blobId;
    codeWrap?.classList.toggle('hidden', !enabled);
    if (enabled && codeDisplay) codeDisplay.value = info.meta.blobId;
    joinWrap?.classList.toggle('hidden', !!enabled);
  }

  function todayISO() {
    return FocusCalendar.toISODate(new Date());
  }

  function workHours() {
    const s = state.data.settings;
    return {
      start: s.workStart || '10:00',
      end: s.workEnd || '20:00',
    };
  }

  function busyDatesSet() {
    // Крест только на днях без свободных слотов (клиенту некуда записаться)
    const { start, end } = workHours();
    const set = new Set();
    const dates = new Set(
      state.data.records.filter((r) => r.status !== 'cancelled').map((r) => r.date)
    );
    dates.forEach((date) => {
      if (FocusStorage.isDayFullyBooked(state.data.records, date, start, end)) {
        set.add(date);
      }
    });
    // Также отметить дни без записей, но с нулевым окном? Нет — пустой день свободен.
    // Дни вне рабочих часов не рассматриваются отдельно.
    return set;
  }

  function partialDatesSet() {
    // Есть записи, но остались свободные часы — без креста
    const { start, end } = workHours();
    const set = new Set();
    const dates = new Set(
      state.data.records.filter((r) => r.status !== 'cancelled').map((r) => r.date)
    );
    dates.forEach((date) => {
      if (!FocusStorage.isDayFullyBooked(state.data.records, date, start, end)) {
        set.add(date);
      }
    });
    return set;
  }

  function formatDuration(hours) {
    const h = Number(hours);
    if (h === 0.5) return '30 мин';
    if (h === 1) return '1 ч';
    if (h === 8) return '8 ч';
    return `${h} ч`;
  }

  /** Длительность по умолчанию для вида съёмки (кабинет) */
  function defaultDurationForType(_type) {
    return 2;
  }

  function applyTypeDefaults(_type, { forceDuration = false } = {}) {
    // Для клиентов длительность задаётся в настройках онлайн-записи.
    // В кабинете вид съёмки больше не меняет часы автоматически.
    if (forceDuration) {
      const durationEl = $('#fDuration');
      if (durationEl && !durationEl.value) durationEl.value = '2';
    }
    checkFormConflict();
  }

  function fillTimeSelect(selectEl, selected) {
    if (!selectEl) return;
    const { start, end } = workHours();
    const slots = FocusStorage.buildTimeSlots(start, end);
    const value = selected && slots.includes(selected) ? selected : (slots.includes('12:00') ? '12:00' : slots[0] || '12:00');
    // Если выбранное время вне рабочих часов — всё равно показать
    const options = selected && !slots.includes(selected) ? [selected, ...slots] : slots;
    selectEl.innerHTML = options
      .map((t) => `<option value="${t}"${t === value ? ' selected' : ''}>${t}</option>`)
      .join('');
  }

  function fillWorkHourSelects() {
    const allDay = FocusStorage.buildTimeSlots('06:00', '23:00');
    const startEl = $('#workStart');
    const endEl = $('#workEnd');
    if (!startEl || !endEl) return;
    const { start, end } = workHours();
    startEl.innerHTML = allDay.map((t) => `<option value="${t}"${t === start ? ' selected' : ''}>${t}</option>`).join('');
    endEl.innerHTML = allDay.map((t) => `<option value="${t}"${t === end ? ' selected' : ''}>${t}</option>`).join('');
  }

  function openActionsFor(recordId) {
    state.activeRecordId = recordId;
    const r = state.data.records.find((x) => x.id === recordId);
    $('#actionsTitle').textContent = r ? r.name : 'Запись';
    const needApprove = r?.status === 'reschedule_requested';
    $('#approveRescheduleBtn')?.classList.toggle('hidden', !needApprove);
    $('#rejectRescheduleBtn')?.classList.toggle('hidden', !needApprove);
    if (needApprove && r) {
      $('#actionsTitle').textContent = `${r.name} → ${r.proposedDate || ''} ${r.proposedTime || ''}`;
    }
    openSheet('actionsSheet');
  }

  function bookingLink() {
    const meta = FocusSync.loadMeta();
    if (!meta.enabled || !meta.blobId) return '';
    const db = FocusSync.getDatabaseURL();
    if (!db) return '';
    const base = `${location.origin}${location.pathname.replace(/index\.html$/i, '')}`;
    const root = base.endsWith('/') ? base : `${base}/`;
    return `${root}book.html?c=${encodeURIComponent(meta.blobId)}&db=${encodeURIComponent(db)}`;
  }

  function fillBookingSettings() {
    const s = state.data.settings;
    const dur = $('#bookingDuration');
    const step = $('#bookingSlotStep');
    if (dur) dur.value = String(s.bookingDuration ?? 1);
    if (step) step.value = String(s.bookingSlotStep ?? 60);
    const fb = $('#firebaseUrlInput');
    if (fb) fb.value = FocusSync.getDatabaseURL() || '';
    const link = bookingLink();
    const input = $('#bookingLinkDisplay');
    const openBtn = $('#openBookingLinkBtn');
    if (input) input.value = link || '';
    if (openBtn) {
      openBtn.href = link || 'book.html';
    }
  }

  function applyTheme() {
    const theme = state.data.settings.theme || 'light';
    document.documentElement.setAttribute('data-theme', theme);
    const icon = $('#themeButton i');
    if (icon) {
      icon.setAttribute('data-lucide', theme === 'dark' ? 'sun' : 'moon');
      lucide.createIcons();
    }
  }

  function openSheet(id) {
    $('#sheetOverlay')?.classList.remove('hidden');
    const sheet = document.getElementById(id);
    if (!sheet) return;
    sheet.classList.add('open');
    sheet.setAttribute('aria-hidden', 'false');
    lucide.createIcons();
  }

  function closeSheets() {
    $('#sheetOverlay')?.classList.add('hidden');
    $$('.bottom-sheet').forEach((el) => {
      el.classList.remove('open');
      el.setAttribute('aria-hidden', 'true');
    });
    $('#fabMenu')?.classList.add('hidden');
    $('#fabButton')?.classList.remove('open');
  }

  function setView(name) {
    state.view = name;
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    closeSheets();
    render();
  }

  function updateRemainderUI() {
    const rem = FocusStorage.remainder($('#fPrice')?.value, $('#fPrepaid')?.value);
    const el = $('#fRemainder');
    if (el) el.textContent = money(rem);
  }

  function setFormKind(kind) {
    state.formKind = kind === 'personal' ? 'personal' : 'client';
    $('#fKind').value = state.formKind;
    $$('.kind-btn').forEach((b) => b.classList.toggle('active', b.dataset.kind === state.formKind));

    const isPersonal = state.formKind === 'personal';
    $('#clientFields')?.classList.toggle('hidden', isPersonal);
    $('#paymentFields')?.classList.toggle('hidden', isPersonal);
    $('#personalTitleLabel')?.classList.toggle('hidden', !isPersonal);

    ['#fName', '#fPhone', '#fVk', '#fType', '#fPrice', '#fPrepaid'].forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      el.disabled = isPersonal;
    });

    const nameInput = $('#fName');
    if (nameInput) {
      if (isPersonal) nameInput.removeAttribute('required');
      else nameInput.setAttribute('required', '');
    }
  }

  function checkFormConflict() {
    const hint = $('#conflictHint');
    const id = $('#recordId')?.value || null;
    const date = $('#fDate')?.value;
    const time = $('#fTime')?.value;
    const duration = Number($('#fDuration')?.value || 1);
    if (!date || !time) {
      hint?.classList.add('hidden');
      return false;
    }
    const conflict = FocusStorage.hasConflict(state.data.records, {
      date,
      time,
      duration,
      excludeId: id || undefined,
    });
    hint?.classList.toggle('hidden', !conflict);
    return conflict;
  }

  function checkMoveConflict() {
    const hint = $('#moveConflictHint');
    const id = $('#moveRecordId')?.value;
    const record = state.data.records.find((r) => r.id === id);
    const date = $('#moveDate')?.value;
    const time = $('#moveTime')?.value;
    if (!record || !date || !time) {
      hint?.classList.add('hidden');
      return false;
    }
    const conflict = FocusStorage.hasConflict(state.data.records, {
      date,
      time,
      duration: record.duration,
      excludeId: id,
    });
    hint?.classList.toggle('hidden', !conflict);
    return conflict;
  }

  function fillRecordForm(record) {
    const kind = record?.kind === 'personal' ? 'personal' : 'client';
    $('#recordId').value = record?.id || '';
    $('#recordSheetTitle').textContent = record?.id
      ? kind === 'personal'
        ? 'Редактировать личное'
        : 'Редактировать запись'
      : kind === 'personal'
        ? 'Личное дело'
        : 'Новая запись';

    setFormKind(kind);

    $('#fName').value = kind === 'personal' ? '' : record?.name || '';
    $('#fPhone').value = record?.phone || '';
    $('#fVk').value = record?.vk || '';
    $('#fPersonalTitle').value = kind === 'personal' ? record?.name || '' : '';
    $('#fType').value = record?.type || 'Индивидуальная съёмка';
    $('#fStatus').value = record?.status || (kind === 'personal' ? 'confirmed' : 'pending');
    $('#fDate').value = record?.date || state.selectedDate;
    fillTimeSelect($('#fTime'), record?.time || '12:00');
    const type = $('#fType').value;
    $('#fDuration').value = String(
      record?.duration != null ? record.duration : 2
    );
    $('#fLocation').value = record?.location || '';
    $('#fPrice').value = record?.price ?? '';
    $('#fPrepaid').value = record?.prepaid ?? '';
    $('#fComment').value = record?.comment || '';
    updateRemainderUI();
    checkFormConflict();
  }

  function openNewRecord(prefill = {}) {
    const type = prefill.type || 'Индивидуальная съёмка';
    const duration =
      prefill.duration ??
      (prefill.kind === 'personal' ? 1 : 2);
    fillRecordForm({
      date: state.selectedDate,
      time: '12:00',
      status: prefill.kind === 'personal' ? 'confirmed' : 'pending',
      duration,
      type,
      kind: 'client',
      ...prefill,
      duration: prefill.duration ?? duration,
      type: prefill.type || type,
    });
    openSheet('recordSheet');
  }

  function openEditRecord(id) {
    const record = state.data.records.find((r) => r.id === id);
    if (!record) return;
    fillRecordForm(record);
    openSheet('recordSheet');
  }

  function statusLabel(s) {
    return (
      {
        pending: 'Ожидает',
        confirmed: 'Подтверждена',
        done: 'Проведена',
        cancelled: 'Отмена',
        reschedule_requested: 'Запрос переноса',
      }[s] || s
    );
  }

  function recordCard(r) {
    const isPersonal = r.kind === 'personal';
    const rem = FocusStorage.remainder(r.price, r.prepaid);
    const pay = isPersonal ? null : FocusStorage.paymentStatus(r.price, r.prepaid);
    const title = isPersonal ? r.name || 'Личное дело' : r.name;
    const subtitle = isPersonal
      ? `Личное · ${r.time} · ${formatDuration(r.duration)}`
      : `${escapeHtml(r.type)} · ${r.time} · ${formatDuration(r.duration)}`;

    return `
      <article class="record-card${isPersonal ? ' personal-card' : ''}" data-id="${r.id}">
        <div class="record-top">
          <div>
            <h3>${escapeHtml(title)}</h3>
            <p class="muted">${subtitle}</p>
          </div>
          <div class="badge-stack">
            ${isPersonal ? '<span class="badge badge-personal">Личное</span>' : ''}
            <span class="badge badge-${r.status}">${statusLabel(r.status)}</span>
            ${pay && pay.key !== 'none' ? `<span class="badge badge-pay-${pay.key}">${pay.label}</span>` : ''}
            ${r.source === 'public' ? '<span class="badge">Онлайн</span>' : ''}
          </div>
        </div>
        <div class="record-meta">
          <span>${FocusCalendar.formatRuDate(r.date).split(',')[0]}</span>
          ${r.location ? `<span>${escapeHtml(r.location)}</span>` : ''}
        </div>
        ${
          isPersonal
            ? ''
            : `<div class="record-money">
          <span>Стоимость: ${money(r.price)}</span>
          <span>Предоплата: ${money(r.prepaid)}</span>
          <span>Остаток: ${money(rem)}</span>
        </div>`
        }
        ${r.comment ? `<p class="record-comment">${escapeHtml(r.comment)}</p>` : ''}
        ${
          r.status === 'reschedule_requested'
            ? `<p class="record-comment">Клиент просит: ${escapeHtml(r.proposedDate || '')} ${escapeHtml(r.proposedTime || '')}</p>`
            : ''
        }
      </article>
    `;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function filteredRecords() {
    const today = todayISO();
    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrow = FocusCalendar.toISODate(tomorrowDate);

    let list = [...state.data.records];

    if (state.filter === 'all') {
      list = list.filter((r) => r.date === state.selectedDate);
    } else if (state.filter === 'today') {
      list = list.filter((r) => r.date === today);
    } else if (state.filter === 'tomorrow') {
      list = list.filter((r) => r.date === tomorrow);
    } else if (state.filter === 'online') {
      list = list.filter((r) => r.source === 'public' && r.status !== 'cancelled');
    } else if (state.filter === 'no-prepay') {
      list = list.filter(
        (r) =>
          r.kind !== 'personal' &&
          Number(r.prepaid || 0) <= 0 &&
          r.status !== 'cancelled'
      );
    } else if (state.filter === 'prepay') {
      list = list.filter(
        (r) =>
          r.kind !== 'personal' &&
          Number(r.prepaid || 0) > 0 &&
          r.status !== 'cancelled'
      );
    } else if (state.filter === 'past') {
      list = list.filter((r) => r.date < today);
    }

    return list.sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  }

  function renderCalendar() {
    const y = state.cursor.getFullYear();
    const m = state.cursor.getMonth();
    FocusCalendar.render({
      gridEl: $('#calendarGrid'),
      titleEl: $('#monthTitle'),
      year: y,
      month: m,
      selectedDate: state.selectedDate,
      busyDates: busyDatesSet(),
      partialDates: partialDatesSet(),
      todayISO: todayISO(),
      onSelect: (date) => {
        state.selectedDate = date;
        state.filter = 'all';
        $$('#recordFilters .chip').forEach((c) => c.classList.toggle('active', c.dataset.filter === 'all'));
        render();
      },
    });

    const todayLabel = $('#todayDate');
    if (todayLabel) todayLabel.textContent = FocusCalendar.formatRuDate(todayISO());

    const todayEvents = state.data.records
      .filter((r) => r.date === todayISO() && r.status !== 'cancelled')
      .sort((a, b) => a.time.localeCompare(b.time));

    const todayBox = $('#todayEvents');
    if (todayBox) {
      todayBox.innerHTML = todayEvents.length
        ? todayEvents
            .map((r) => {
              const label = r.kind === 'personal' ? r.name || 'Личное' : r.name;
              const type = r.kind === 'personal' ? 'личное' : r.type;
              return `<div class="today-item${r.kind === 'personal' ? ' today-personal' : ''}"><strong>${r.time}</strong> ${escapeHtml(label)} · ${escapeHtml(type)}</div>`;
            })
            .join('')
        : 'Пока нет записей';
    }

    const dayLabel = $('#selectedDayLabel');
    if (dayLabel) {
      const d = FocusCalendar.parseISODate(state.selectedDate);
      dayLabel.textContent = `· ${d.getDate()} ${FocusCalendar.MONTHS[d.getMonth()].toLowerCase()}`;
    }
  }

  function renderFreeSlots() {
    const box = $('#clientFreeSlots');
    if (!box) return;

    // Блок «как видят клиенты» — только для выбранного дня (фильтр «Все»)
    if (state.filter !== 'all') {
      box.classList.add('hidden');
      return;
    }

    const { start, end } = workHours();
    const free = FocusStorage.getFreeSlots(state.data.records, state.selectedDate, start, end, 1);
    const freeHalf = FocusStorage.getFreeSlots(state.data.records, state.selectedDate, start, end, 0.5);
    const full = freeHalf.length === 0;

    box.classList.remove('hidden');

    if (full) {
      box.innerHTML = `
        <h3 class="subheading">Свободные часы для клиентов</h3>
        <p class="muted free-slots-note">День полностью занят. Клиенты видят только крест — без имён и сумм.</p>
      `;
      return;
    }

    const chips =
      free.length > 0
        ? free.map((t) => `<span class="slot-chip">${t}</span>`).join('')
        : freeHalf.map((t) => `<span class="slot-chip">${t} · 30 мин</span>`).join('');

    box.innerHTML = `
      <h3 class="subheading">Свободные часы для клиентов</h3>
      <p class="muted free-slots-note">Клиенты не видят, кто записан и суммы — только свободное время и свою запись.</p>
      <div class="slot-chips">${chips}</div>
    `;
  }

  function renderRecords() {
    const list = $('#recordsList');
    if (!list) return;
    const records = filteredRecords();
    const notes =
      state.filter === 'all'
        ? state.data.notes.filter((n) => n.date === state.selectedDate)
        : [];

    const notesHtml = notes
      .map(
        (n) => `
      <article class="record-card note-card">
        <div class="record-top">
          <div>
            <h3>Заметка</h3>
            <p class="muted">${escapeHtml(n.text)}</p>
          </div>
          <span class="badge">без блокировки</span>
        </div>
      </article>`
      )
      .join('');

    if (!records.length && !notes.length) {
      list.innerHTML = '<div class="empty">Записей нет</div>';
    } else {
      list.innerHTML = `${records.map(recordCard).join('')}${notesHtml}`;
    }

    list.querySelectorAll('.record-card[data-id]').forEach((card) => {
      card.addEventListener('click', () => openActionsFor(card.dataset.id));
    });

    renderFreeSlots();
  }

  function renderClients() {
    const box = $('#clientsList');
    if (!box) return;
    const q = state.clientQuery.trim().toLowerCase();
    const clients = state.data.clients
      .filter((c) => {
        if (!q) return true;
        return (
          c.name.toLowerCase().includes(q) ||
          FocusStorage.normalizePhone(c.phone).includes(q.replace(/\D/g, '')) ||
          (c.vk || '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    box.innerHTML = clients.length
      ? clients
          .map((c) => {
            const history = state.data.records.filter(
              (r) =>
                r.kind !== 'personal' &&
                (r.clientId === c.id ||
                  (r.phone &&
                    FocusStorage.normalizePhone(r.phone) === FocusStorage.normalizePhone(c.phone)))
            );
            const count = history.filter((r) => r.status !== 'cancelled').length;
            return `
              <article class="client-card" data-id="${c.id}">
                <div class="record-top">
                  <div>
                    <h3>${escapeHtml(c.name)}</h3>
                    <p class="muted">${escapeHtml(c.phone || 'без телефона')}${c.vk ? ` · ${escapeHtml(c.vk)}` : ''}</p>
                  </div>
                  <span class="badge">${count} съёмки</span>
                </div>
                ${c.comment ? `<p class="record-comment">${escapeHtml(c.comment)}</p>` : ''}
                <div class="client-history">
                  ${
                    history.length
                      ? history
                          .sort((a, b) => b.date.localeCompare(a.date))
                          .slice(0, 4)
                          .map((r) => `<div>${r.date} · ${r.time} · ${escapeHtml(r.type)}</div>`)
                          .join('')
                      : '<div class="muted">Истории пока нет</div>'
                  }
                </div>
              </article>
            `;
          })
          .join('')
      : '<div class="empty">Клиентов пока нет</div>';

    box.querySelectorAll('.client-card').forEach((card) => {
      card.addEventListener('click', () => {
        const c = state.data.clients.find((x) => x.id === card.dataset.id);
        if (!c) return;
        $('#clientId').value = c.id;
        $('#clientSheetTitle').textContent = 'Клиент';
        $('#cName').value = c.name;
        $('#cPhone').value = c.phone || '';
        $('#cVk').value = c.vk || '';
        $('#cComment').value = c.comment || '';
        openSheet('clientSheet');
      });
    });
  }

  function renderFinance() {
    const y = state.cursor.getFullYear();
    const m = state.cursor.getMonth();
    const prefix = `${y}-${String(m + 1).padStart(2, '0')}`;
    const monthRecords = state.data.records.filter(
      (r) => r.kind !== 'personal' && r.date.startsWith(prefix) && r.status !== 'cancelled'
    );

    const prepaid = monthRecords.reduce((s, r) => s + Number(r.prepaid || 0), 0);
    const expected = monthRecords.reduce((s, r) => s + FocusStorage.remainder(r.price, r.prepaid), 0);
    const income = monthRecords.reduce((s, r) => s + Number(r.price || 0), 0);

    $('#statPrepaid').textContent = money(prepaid);
    $('#statExpected').textContent = money(expected);
    $('#statCount').textContent = String(monthRecords.length);
    $('#statIncome').textContent = money(income);
    $('#financeMonthLabel').textContent = `${FocusCalendar.MONTHS[m]} ${y}`;

    const upcoming = state.data.records
      .filter((r) => r.date >= todayISO() && r.status !== 'cancelled')
      .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))
      .slice(0, 8);

    const box = $('#upcomingList');
    if (box) {
      box.innerHTML = upcoming.length
        ? upcoming.map(recordCard).join('')
        : '<div class="empty">Ближайших съёмок нет</div>';
      box.querySelectorAll('.record-card').forEach((card) => {
        card.addEventListener('click', () => openActionsFor(card.dataset.id));
      });
    }
  }

  function renderSettings() {
    if (state.view === 'settings') {
      fillWorkHourSelects();
      fillBookingSettings();
      updateNotifyStatus();
    }
    updateSyncStatusUI();
  }

  function render() {
    applyTheme();
    renderCalendar();
    renderRecords();
    if (state.view === 'clients') renderClients();
    if (state.view === 'overview') renderFinance();
    renderSettings();
    lucide.createIcons();
  }

  function bind() {
    $('#prevMonth')?.addEventListener('click', () => {
      state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() - 1, 1);
      render();
    });
    $('#nextMonth')?.addEventListener('click', () => {
      state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + 1, 1);
      render();
    });
    $('#todayButton')?.addEventListener('click', () => {
      const now = new Date();
      state.cursor = new Date(now.getFullYear(), now.getMonth(), 1);
      state.selectedDate = todayISO();
      state.filter = 'all';
      $$('#recordFilters .chip').forEach((c) => c.classList.toggle('active', c.dataset.filter === 'all'));
      render();
    });

    $('#themeButton')?.addEventListener('click', () => {
      state.data.settings.theme = state.data.settings.theme === 'dark' ? 'light' : 'dark';
      persist();
      applyTheme();
    });

    $$('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => setView(btn.dataset.view));
    });

    $('#addRecord')?.addEventListener('click', () => openNewRecord({ kind: 'client' }));
    $('#addClientBtn')?.addEventListener('click', () => {
      $('#clientId').value = '';
      $('#clientSheetTitle').textContent = 'Новый клиент';
      $('#clientForm').reset();
      openSheet('clientSheet');
    });

    $('#recordFilters')?.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      state.filter = chip.dataset.filter;
      $$('#recordFilters .chip').forEach((c) => c.classList.toggle('active', c === chip));
      renderRecords();
    });

    $('#clientSearch')?.addEventListener('input', (e) => {
      state.clientQuery = e.target.value;
      renderClients();
    });

    $('#sheetOverlay')?.addEventListener('click', closeSheets);
    $('#closeRecordSheet')?.addEventListener('click', closeSheets);
    $('#closeClientSheet')?.addEventListener('click', closeSheets);
    $('#closeNoteSheet')?.addEventListener('click', closeSheets);
    $('#closeActionsSheet')?.addEventListener('click', closeSheets);
    $('#closeMoveSheet')?.addEventListener('click', closeSheets);

    $$('.kind-btn').forEach((btn) => {
      btn.addEventListener('click', () => setFormKind(btn.dataset.kind));
    });

    $('#fPrice')?.addEventListener('input', updateRemainderUI);
    $('#fPrepaid')?.addEventListener('input', updateRemainderUI);
    $('#fDate')?.addEventListener('change', checkFormConflict);
    $('#fTime')?.addEventListener('change', checkFormConflict);
    $('#fDuration')?.addEventListener('change', checkFormConflict);

    $('#fType')?.addEventListener('change', (e) => {
      applyTypeDefaults(e.target.value, { forceDuration: true });
    });

    $('#btnPrepay1000')?.addEventListener('click', () => {
      $('#fPrepaid').value = '1000';
      updateRemainderUI();
    });

    $('#btnPayFull')?.addEventListener('click', () => {
      const price = Number($('#fPrice').value || 0);
      if (price <= 0) {
        alert('Сначала укажите стоимость');
        return;
      }
      $('#fPrepaid').value = String(price);
      updateRemainderUI();
    });

    $('#workStart')?.addEventListener('change', (e) => {
      state.data.settings.workStart = e.target.value;
      state.data.settings.settingsUpdatedAt = new Date().toISOString();
      if (FocusStorage.timeToMinutes(state.data.settings.workEnd) < FocusStorage.timeToMinutes(e.target.value)) {
        state.data.settings.workEnd = e.target.value;
        fillWorkHourSelects();
      }
      persist();
    });

    $('#workEnd')?.addEventListener('change', (e) => {
      state.data.settings.workEnd = e.target.value;
      state.data.settings.settingsUpdatedAt = new Date().toISOString();
      if (FocusStorage.timeToMinutes(e.target.value) < FocusStorage.timeToMinutes(state.data.settings.workStart)) {
        state.data.settings.workStart = e.target.value;
        fillWorkHourSelects();
      }
      persist();
    });

    $('#saveFirebaseUrlBtn')?.addEventListener('click', () => {
      const url = $('#firebaseUrlInput')?.value.trim();
      if (!url || !url.includes('http')) {
        alert('Вставьте ссылку Firebase целиком, она начинается с https://');
        return;
      }
      FocusSync.setDatabaseURL(url);
      fillBookingSettings();
      updateSyncStatusUI();
      alert('Адрес облака сохранён. Теперь нажмите «Создать новый код».');
    });

    $('#enableSyncBtn')?.addEventListener('click', async () => {
      try {
        const result = await FocusSync.enable(state.data);
        state.data = FocusStorage.load();
        updateSyncStatusUI();
        render();
        alert(`Синхронизация создана.\n\nСкопируйте код и введите его на втором устройстве:\n${result.meta.blobId}`);
        fillBookingSettings();
      } catch (err) {
        updateSyncStatusUI();
        alert(err.message || 'Не удалось создать синхронизацию');
      }
    });

    $('#joinSyncBtn')?.addEventListener('click', async () => {
      const code = $('#syncCodeInput')?.value.trim();
      try {
        const result = await FocusSync.join(code, state.data);
        state.data = result.data;
        updateSyncStatusUI();
        fillBookingSettings();
        render();
        alert('Устройства связаны. Данные синхронизируются при наличии интернета.');
      } catch (err) {
        updateSyncStatusUI();
        alert(err.message || 'Не удалось подключить синхронизацию');
      }
    });

    $('#copySyncCodeBtn')?.addEventListener('click', async () => {
      const code = $('#syncCodeDisplay')?.value;
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code);
        alert('Код скопирован');
      } catch {
        $('#syncCodeDisplay')?.select();
        alert('Скопируйте код вручную');
      }
    });

    $('#syncNowBtn')?.addEventListener('click', () => runManualSync());
    $('#syncStatusBar')?.addEventListener('click', () => runManualSync());

    $('#disableSyncBtn')?.addEventListener('click', () => {
      if (!confirm('Отключить синхронизацию на этом устройстве? Локальные данные останутся.')) return;
      FocusSync.disable();
      updateSyncStatusUI();
      fillBookingSettings();
    });

    $('#bookingDuration')?.addEventListener('change', (e) => {
      state.data.settings.bookingDuration = Number(e.target.value);
      state.data.settings.settingsUpdatedAt = new Date().toISOString();
      persist();
    });

    $('#bookingSlotStep')?.addEventListener('change', (e) => {
      state.data.settings.bookingSlotStep = Number(e.target.value);
      state.data.settings.settingsUpdatedAt = new Date().toISOString();
      persist();
    });

    $('#enableNotifyBtn')?.addEventListener('click', async () => {
      if (!('Notification' in window)) {
        alert('Этот браузер не поддерживает уведомления');
        return;
      }
      const perm = await Notification.requestPermission();
      updateNotifyStatus();
      if (perm === 'granted') {
        alert('Готово. Когда кто-то запишется, придёт уведомление.');
      } else {
        alert('Разрешение не выдано. Можно пользоваться всплывающим окном внутри приложения.');
      }
    });

    $('#bookingToastClose')?.addEventListener('click', hideBookingToast);
    $('#bookingToast')?.addEventListener('click', (e) => {
      if (e.target === $('#bookingToast')) hideBookingToast();
    });
    $('#bookingToastOpen')?.addEventListener('click', () => {
      hideBookingToast();
      setView('calendar');
      render();
    });

    $('#copyBookingLinkBtn')?.addEventListener('click', async () => {
      if (!FocusSync.cloudReady()) {
        alert('Сначала сохраните адрес Firebase (шаг 1 в Настройках).');
        return;
      }
      const meta = FocusSync.loadMeta();
      if (!meta.enabled || !meta.blobId) {
        alert('Сначала нажмите «Создать новый код» (шаг 2).');
        return;
      }
      const link = bookingLink();
      if (!link || !link.includes('book.html')) {
        alert('Ссылка не собралась. Обновите страницу и попробуйте снова.');
        return;
      }
      fillBookingSettings();
      try {
        await navigator.clipboard.writeText(link);
        alert(
          'Ссылка для клиентов скопирована.\n\nВажно: давайте клиентам ИМЕННО её (там book.html).\nНе давайте ссылку на кабинет.\n\n' +
            link
        );
      } catch {
        $('#bookingLinkDisplay')?.select();
        alert('Скопируйте ссылку вручную из поля. В ней должно быть слово book.html');
      }
    });

    $('#recordForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (checkFormConflict()) {
        alert('Это время уже занято');
        return;
      }

      const kind = $('#fKind').value === 'personal' ? 'personal' : 'client';
      const id = $('#recordId').value || FocusStorage.uid();
      const existing = state.data.records.find((r) => r.id === id);

      let name;
      let phone = '';
      let vk = '';
      let type;
      let price = 0;
      let prepaid = 0;
      let clientId;

      if (kind === 'personal') {
        name = ($('#fPersonalTitle').value.trim() || 'Личное дело');
        type = 'Личное';
      } else {
        name = $('#fName').value.trim();
        if (!name) {
          alert('Укажите имя клиента');
          return;
        }
        phone = $('#fPhone').value.trim();
        vk = $('#fVk').value.trim();
        type = $('#fType').value;
        price = Number($('#fPrice').value || 0);
        prepaid = Number($('#fPrepaid').value || 0);
      }

      const payload = {
        id,
        kind,
        name,
        phone,
        vk,
        type,
        status: $('#fStatus').value,
        date: $('#fDate').value,
        time: $('#fTime').value,
        duration: Number($('#fDuration').value),
        location: $('#fLocation').value.trim(),
        price,
        prepaid,
        comment: $('#fComment').value.trim(),
        clientRescheduleCount: existing?.clientRescheduleCount ?? 0,
        updatedAt: new Date().toISOString(),
      };

      if (kind === 'client') {
        const client = FocusStorage.findOrCreateClient(state.data, payload);
        payload.clientId = client.id;
      } else {
        payload.clientId = undefined;
      }

      const idx = state.data.records.findIndex((r) => r.id === id);
      if (idx >= 0) {
        state.data.records[idx] = { ...state.data.records[idx], ...payload };
      } else {
        payload.createdAt = new Date().toISOString();
        state.data.records.push(payload);
      }

      state.selectedDate = payload.date;
      const d = FocusCalendar.parseISODate(payload.date);
      state.cursor = new Date(d.getFullYear(), d.getMonth(), 1);
      persist();
      closeSheets();
      render();
    });

    $('#clientForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const id = $('#clientId').value || FocusStorage.uid();
      const existing = state.data.clients.find((c) => c.id === id);
      const client = {
        id,
        name: $('#cName').value.trim(),
        phone: $('#cPhone').value.trim(),
        vk: $('#cVk').value.trim(),
        comment: $('#cComment').value.trim(),
        createdAt: existing?.createdAt || new Date().toISOString(),
      };
      if (existing) Object.assign(existing, client);
      else state.data.clients.push(client);
      persist();
      closeSheets();
      setView('clients');
    });

    $('#noteForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      state.data.notes.push({
        id: FocusStorage.uid(),
        date: $('#nDate').value,
        text: $('#nText').value.trim(),
        createdAt: new Date().toISOString(),
      });
      const noteDate = $('#nDate').value;
      state.selectedDate = noteDate;
      const d = FocusCalendar.parseISODate(noteDate);
      state.cursor = new Date(d.getFullYear(), d.getMonth(), 1);
      persist();
      closeSheets();
      setView('calendar');
    });

    $('#actionsSheet')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = state.activeRecordId;
      const record = state.data.records.find((r) => r.id === id);
      if (!record) return;

      const action = btn.dataset.action;
      if (action === 'edit') {
        closeSheets();
        openEditRecord(id);
      } else if (action === 'approve-reschedule') {
        if (!record.proposedDate || !record.proposedTime) return;
        if (
          FocusStorage.hasConflict(state.data.records, {
            date: record.proposedDate,
            time: record.proposedTime,
            duration: record.duration,
            excludeId: record.id,
          })
        ) {
          alert('Предложенное время уже занято');
          return;
        }
        record.date = record.proposedDate;
        record.time = record.proposedTime;
        record.status = 'confirmed';
        record.clientRescheduleCount = Number(record.clientRescheduleCount || 0) + 1;
        delete record.proposedDate;
        delete record.proposedTime;
        record.updatedAt = new Date().toISOString();
        persist();
        closeSheets();
        render();
      } else if (action === 'reject-reschedule') {
        record.status = 'confirmed';
        delete record.proposedDate;
        delete record.proposedTime;
        record.updatedAt = new Date().toISOString();
        persist();
        closeSheets();
        render();
      } else if (action === 'delete') {
        if (confirm('Удалить запись?')) {
          FocusStorage.touchTrash(state.data, 'records', id);
          state.data.records = state.data.records.filter((r) => r.id !== id);
          persist();
          closeSheets();
          render();
        }
      } else if (action === 'copy') {
        closeSheets();
        openNewRecord({
          ...record,
          id: undefined,
          date: state.selectedDate,
          status: record.kind === 'personal' ? 'confirmed' : 'pending',
          clientRescheduleCount: 0,
        });
        $('#recordId').value = '';
        $('#recordSheetTitle').textContent = 'Копия записи';
      } else if (action === 'move') {
        closeSheets();
        $('#moveRecordId').value = id;
        $('#moveDate').value = record.date;
        fillTimeSelect($('#moveTime'), record.time);
        checkMoveConflict();
        openSheet('moveSheet');
      }
    });

    $('#moveDate')?.addEventListener('change', checkMoveConflict);
    $('#moveTime')?.addEventListener('change', checkMoveConflict);

    $('#moveForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (checkMoveConflict()) {
        alert('Это время уже занято');
        return;
      }
      const id = $('#moveRecordId').value;
      const record = state.data.records.find((r) => r.id === id);
      if (!record) return;
      // Админский перенос всегда свободный; clientRescheduleCount не трогаем
      record.date = $('#moveDate').value;
      record.time = $('#moveTime').value;
      record.updatedAt = new Date().toISOString();
      state.selectedDate = record.date;
      const d = FocusCalendar.parseISODate(record.date);
      state.cursor = new Date(d.getFullYear(), d.getMonth(), 1);
      persist();
      closeSheets();
      render();
    });

    $('#fabButton')?.addEventListener('click', () => {
      $('#fabMenu')?.classList.toggle('hidden');
      $('#fabButton')?.classList.toggle('open');
    });

    $('#fabMenu')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-fab]');
      if (!btn) return;
      const type = btn.dataset.fab;
      closeSheets();
      if (type === 'record') openNewRecord({ kind: 'client' });
      else if (type === 'personal') openNewRecord({ kind: 'personal', duration: 1 });
      else if (type === 'client') {
        $('#clientId').value = '';
        $('#clientSheetTitle').textContent = 'Новый клиент';
        $('#clientForm').reset();
        openSheet('clientSheet');
      } else if (type === 'note') {
        $('#noteForm').reset();
        $('#nDate').value = state.selectedDate;
        openSheet('noteSheet');
      }
    });

    $('#exportDataBtn')?.addEventListener('click', () => {
      const blob = new Blob([FocusStorage.exportJson()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `focusplus-backup-${todayISO()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });

    $('#importDataInput')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        state.data = FocusStorage.importJson(text);
        FocusSync.markDirty();
        render();
        alert('Данные импортированы');
      } catch {
        alert('Не удалось импортировать файл');
      }
      e.target.value = '';
    });

    $('#clearDataBtn')?.addEventListener('click', () => {
      if (!confirm('Удалить все записи и клиентов?')) return;
      state.data = FocusStorage.clearAll();
      persist();
      render();
    });

    $('#forceRefreshBtn')?.addEventListener('click', async () => {
      try {
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        }
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister()));
        }
      } catch (e) {}
      alert('Кэш сброшен. Сейчас страница перезагрузится.');
      location.reload(true);
    });
  }

  seedSeenPublicIds();

  // Сначала кнопки — даже если синхронизация упадёт
  try {
    bind();
  } catch (err) {
    console.error(err);
    alert('Ошибка интерфейса. Обновите страницу или очистите кэш браузера.');
  }

  try {
    applyTheme();
    updateSyncStatusUI();
    updateNotifyStatus();
  } catch (err) {
    console.error(err);
  }

  try {
    if (typeof FocusSync !== 'undefined') {
      FocusSync.setHandler(() => {
        updateSyncStatusUI();
      });

      if (FocusSync.getDatabaseURL() && !FocusSync.loadMeta().databaseURL) {
        FocusSync.setDatabaseURL(FocusSync.getDatabaseURL());
      }

      FocusSync.startAutoSync(
        () => state.data,
        (data) => {
          applyCloudData(data, { announce: true });
        }
      );
    }
  } catch (err) {
    console.error(err);
  }

  try {
    render();
  } catch (err) {
    console.error(err);
  }

  // Сброс залипших оверлеев
  try {
    $('#bookingToast')?.classList.add('hidden');
    $('#sheetOverlay')?.classList.add('hidden');
    $$('.bottom-sheet').forEach((el) => el.classList.remove('open'));
  } catch (err) {}
})();
