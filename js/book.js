/* Фокус+ — публичная запись клиентов */
(() => {
  const MY_KEY = 'focusplus_my_bookings';
  const params = new URLSearchParams(location.search);
  const cloudCode = (params.get('c') || params.get('code') || '').trim();
  const manageToken = (params.get('m') || params.get('token') || '').trim();
  const dbFromLink = (params.get('db') || '').trim();

  const state = {
    data: null,
    cursor: new Date(),
    selectedDate: null,
    selectedTime: null,
    mode: 'book',
    myRecord: null,
    databaseURL: dbFromLink || FocusSync.getDatabaseURL(),
  };

  const $ = (sel, root = document) => root.querySelector(sel);

  function todayISO() {
    return FocusCalendar.toISODate(new Date());
  }

  function settings() {
    return state.data?.settings || FocusStorage.defaultSettings();
  }

  function duration() {
    return Number(settings().bookingDuration) || 1;
  }

  function slotStep() {
    return Number(settings().bookingSlotStep) || 60;
  }

  function daysAhead() {
    return Number(settings().bookingDaysAhead) || 60;
  }

  function maxDateISO() {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead());
    return FocusCalendar.toISODate(d);
  }

  function showAlert(text, ok = false) {
    const el = $('#bookAlert');
    if (!el) return;
    if (!text) {
      el.classList.add('hidden');
      return;
    }
    el.textContent = text;
    el.classList.remove('hidden');
    el.classList.toggle('is-ok', !!ok);
  }

  function showPanel(mode) {
    const visible = {
      my: ['myBookingPanel'],
      date: ['datePanel'],
      slots: ['datePanel', 'slotsPanel'],
      form: ['formPanel'],
      success: ['successPanel'],
      myAndDate: ['myBookingPanel', 'datePanel'],
    }[mode] || ['datePanel'];

    ['myBookingPanel', 'datePanel', 'slotsPanel', 'formPanel', 'successPanel'].forEach((pid) => {
      $(`#${pid}`)?.classList.toggle('hidden', !visible.includes(pid));
    });
  }

  function loadMyBookings() {
    try {
      return JSON.parse(localStorage.getItem(MY_KEY) || '[]');
    } catch {
      return [];
    }
  }

  function saveMyBooking({ code, id, token }) {
    const list = loadMyBookings().filter((x) => !(x.code === code && x.id === id));
    list.unshift({ code, id, token, savedAt: new Date().toISOString() });
    localStorage.setItem(MY_KEY, JSON.stringify(list.slice(0, 20)));
  }

  function findMyRecord() {
    if (!state.data) return null;
    if (manageToken) {
      return state.data.records.find(
        (r) => r.publicToken === manageToken && r.status !== 'cancelled'
      ) || null;
    }
    const mine = loadMyBookings().find((x) => x.code === cloudCode);
    if (!mine) return null;
    return state.data.records.find(
      (r) => r.id === mine.id && r.publicToken === mine.token && r.status !== 'cancelled'
    ) || null;
  }

  function freeLimit() {
    return Number(settings().freeClientReschedules) || 1;
  }

  function canSelfReschedule(record) {
    return Number(record.clientRescheduleCount || 0) < freeLimit();
  }

  function busyDatesSet() {
    const { workStart, workEnd } = settings();
    const set = new Set();
    const start = todayISO();
    const end = maxDateISO();
    const d = FocusCalendar.parseISODate(start);
    const last = FocusCalendar.parseISODate(end);
    while (d <= last) {
      const iso = FocusCalendar.toISODate(d);
      const free = FocusStorage.getFreeSlots(
        state.data.records,
        iso,
        workStart,
        workEnd,
        duration(),
        slotStep()
      );
      if (free.length === 0) set.add(iso);
      d.setDate(d.getDate() + 1);
    }
    return set;
  }

  function partialDatesSet() {
    const { workStart, workEnd } = settings();
    const set = new Set();
    const start = todayISO();
    const end = maxDateISO();
    const d = FocusCalendar.parseISODate(start);
    const last = FocusCalendar.parseISODate(end);
    while (d <= last) {
      const iso = FocusCalendar.toISODate(d);
      const free = FocusStorage.getFreeSlots(
        state.data.records,
        iso,
        workStart,
        workEnd,
        duration(),
        slotStep()
      );
      const has = FocusStorage.dayHasBookings(state.data.records, iso);
      if (has && free.length > 0) set.add(iso);
      d.setDate(d.getDate() + 1);
    }
    return set;
  }

  function renderCalendar() {
    const y = state.cursor.getFullYear();
    const m = state.cursor.getMonth();
    const busy = busyDatesSet();
    const partial = partialDatesSet();
    const today = todayISO();
    const max = maxDateISO();

    FocusCalendar.render({
      gridEl: $('#bookCalendarGrid'),
      titleEl: $('#bookMonthTitle'),
      year: y,
      month: m,
      selectedDate: state.selectedDate,
      busyDates: busy,
      partialDates: partial,
      todayISO: today,
      onSelect: (date) => {
        if (date < today || date > max) {
          showAlert('Эта дата недоступна для записи');
          return;
        }
        if (busy.has(date)) {
          showAlert('На этот день свободного времени нет');
          return;
        }
        showAlert('');
        state.selectedDate = date;
        state.selectedTime = null;
        renderCalendar();
        renderSlots();
        showPanel('slots');
      },
    });

    // Блокируем прошлые и слишком дальние дни визуально
    $('#bookCalendarGrid')?.querySelectorAll('.day-cell').forEach((btn) => {
      const date = btn.dataset.date;
      if (!date) return;
      if (date < today || date > max) {
        btn.classList.add('is-past');
        btn.classList.remove('is-free', 'is-partial');
        btn.disabled = true;
      }
    });
  }

  function renderSlots() {
    const list = $('#slotsList');
    const label = $('#slotsDayLabel');
    if (!list || !state.selectedDate) return;

    const d = FocusCalendar.parseISODate(state.selectedDate);
    if (label) {
      label.textContent = `· ${d.getDate()} ${FocusCalendar.MONTHS[d.getMonth()].toLowerCase()}`;
    }

    const { workStart, workEnd } = settings();
    let free = FocusStorage.getFreeSlots(
      state.data.records,
      state.selectedDate,
      workStart,
      workEnd,
      duration(),
      slotStep()
    );

    // При переносе своей записи текущий слот тоже доступен
    if (state.mode !== 'book' && state.myRecord && state.myRecord.date === state.selectedDate) {
      if (!free.includes(state.myRecord.time)) {
        free = [...free, state.myRecord.time].sort();
      }
    }

    if (!free.length) {
      list.innerHTML = '<div class="empty">Свободного времени нет</div>';
      return;
    }

    list.innerHTML = free
      .map(
        (t) =>
          `<button type="button" class="slot-pick${t === state.selectedTime ? ' is-selected' : ''}" data-time="${t}">${t}</button>`
      )
      .join('');

    list.querySelectorAll('.slot-pick').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.selectedTime = btn.dataset.time;
        if (state.mode === 'book') {
          openForm();
        } else if (state.mode === 'reschedule') {
          confirmReschedule();
        } else if (state.mode === 'request') {
          submitRescheduleRequest();
        }
      });
    });
  }

  function openForm() {
    $('#formTitle').textContent = 'Ваши данные';
    $('#formSummary').textContent = `${formatDate(state.selectedDate)} · ${state.selectedTime}`;
    $('#bookSubmitBtn').textContent = 'Записаться';
    showPanel('form');
  }

  function formatDate(iso) {
    return FocusCalendar.formatRuDate(iso);
  }

  function formatDuration(h) {
    if (Number(h) === 0.5) return '30 мин';
    if (Number(h) === 1) return '1 ч';
    return `${h} ч`;
  }

  function renderMyBooking() {
    const panel = $('#myBookingPanel');
    const info = $('#myBookingInfo');
    const hint = $('#rescheduleHint');
    const btn = $('#rescheduleBtn');
    if (!state.myRecord) {
      panel?.classList.add('hidden');
      return;
    }

    panel?.classList.remove('hidden');
    info.innerHTML = `
      <div><strong>${escapeHtml(state.myRecord.name)}</strong></div>
      <div>${formatDate(state.myRecord.date)}</div>
      <div>${state.myRecord.time} · ${formatDuration(state.myRecord.duration)}</div>
      <div class="muted">${escapeHtml(state.myRecord.type || '')}</div>
      ${
        state.myRecord.status === 'reschedule_requested'
          ? `<div class="muted">Запрос на перенос: ${state.myRecord.proposedDate || ''} ${state.myRecord.proposedTime || ''} — ждите подтверждения</div>`
          : ''
      }
    `;

    const left = Math.max(0, freeLimit() - Number(state.myRecord.clientRescheduleCount || 0));
    if (state.myRecord.status === 'reschedule_requested') {
      btn.disabled = true;
      btn.textContent = 'Запрос отправлен';
      hint.textContent = 'Фотограф подтвердит новый слот.';
    } else if (left > 0) {
      btn.disabled = false;
      btn.textContent = 'Перенести';
      hint.textContent = `Бесплатный перенос: осталось ${left}.`;
    } else {
      btn.disabled = false;
      btn.textContent = 'Запросить перенос';
      hint.textContent = 'Бесплатный перенос уже использован — нужно подтверждение фотографа.';
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function refreshCloud() {
    const { data: raw } = await FocusSync.cloudGet(cloudCode, state.databaseURL);
    state.data = FocusStorage.migrate(raw && typeof raw === 'object' ? raw : {});
    state.myRecord = findMyRecord();
  }

  async function commitCloud(mutator) {
    const meta = { deviceId: `client_${FocusStorage.uid().slice(0, 8)}` };
    const saved = await FocusSync.withCloudLock(
      cloudCode,
      mutator,
      meta,
      5,
      state.databaseURL
    );
    state.data = saved;
    state.myRecord = findMyRecord();
    return state.data;
  }

  async function submitBooking(e) {
    e.preventDefault();
    if (!state.selectedDate || !state.selectedTime) return;

    const name = $('#bName').value.trim();
    const phone = $('#bPhone').value.trim();
    const vk = $('#bVk').value.trim();
    const type = $('#bType').value;
    const comment = $('#bComment').value.trim();
    if (!name || !phone) {
      showAlert('Укажите имя и телефон');
      return;
    }

    const btn = $('#bookSubmitBtn');
    btn.disabled = true;
    btn.textContent = 'Сохраняем…';
    showAlert('');

    try {
      let created = null;
      await commitCloud((data) => {
        const { workStart, workEnd } = data.settings;
        const free = FocusStorage.getFreeSlots(
          data.records,
          state.selectedDate,
          workStart,
          workEnd,
          duration(),
          slotStep()
        );
        if (!free.includes(state.selectedTime)) {
          throw new Error('Это время только что заняли. Выберите другой слот.');
        }

        const id = FocusStorage.uid();
        const publicToken = FocusStorage.uid().replace(/-/g, '').slice(0, 16);
        const client = FocusStorage.findOrCreateClient(data, { name, phone, vk });
        created = {
          id,
          kind: 'client',
          name,
          phone,
          vk,
          type,
          status: 'pending',
          date: state.selectedDate,
          time: state.selectedTime,
          duration: duration(),
          location: '',
          price: 0,
          prepaid: 0,
          comment,
          clientId: client.id,
          clientRescheduleCount: 0,
          publicToken,
          source: 'public',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        data.records.push(created);
        return data;
      });

      saveMyBooking({ code: cloudCode, id: created.id, token: created.publicToken });
      const dbQ = state.databaseURL
        ? `&db=${encodeURIComponent(state.databaseURL)}`
        : '';
      const manageUrl = `${location.origin}${location.pathname}?c=${encodeURIComponent(cloudCode)}&m=${encodeURIComponent(created.publicToken)}${dbQ}`;
      $('#manageLink').value = manageUrl;
      $('#successText').textContent = `${formatDate(created.date)} · ${created.time}`;
      showPanel('success');
      showAlert('Запись создана', true);
    } catch (err) {
      showAlert(err.message || 'Не удалось записаться');
      await refreshCloud();
      renderCalendar();
      renderSlots();
      showPanel('slots');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Записаться';
    }
  }

  async function confirmReschedule() {
    if (!state.myRecord || !state.selectedDate || !state.selectedTime) return;
    if (!canSelfReschedule(state.myRecord)) {
      state.mode = 'request';
      await submitRescheduleRequest();
      return;
    }

    showAlert('');
    try {
      await commitCloud((data) => {
        const record = data.records.find((r) => r.id === state.myRecord.id);
        if (!record || record.publicToken !== state.myRecord.publicToken) {
          throw new Error('Запись не найдена');
        }
        const excludeId = record.id;
        if (
          FocusStorage.hasConflict(data.records, {
            date: state.selectedDate,
            time: state.selectedTime,
            duration: record.duration || duration(),
            excludeId,
          })
        ) {
          throw new Error('Это время уже занято');
        }
        record.date = state.selectedDate;
        record.time = state.selectedTime;
        record.clientRescheduleCount = Number(record.clientRescheduleCount || 0) + 1;
        record.updatedAt = new Date().toISOString();
        record.status = record.status === 'cancelled' ? 'pending' : record.status;
        delete record.proposedDate;
        delete record.proposedTime;
        if (record.status === 'reschedule_requested') record.status = 'pending';
        return data;
      });
      state.mode = 'book';
      renderMyBooking();
      renderCalendar();
      showPanel('my');
      showAlert('Запись перенесена', true);
    } catch (err) {
      showAlert(err.message || 'Не удалось перенести');
      renderSlots();
    }
  }

  async function submitRescheduleRequest() {
    if (!state.myRecord || !state.selectedDate || !state.selectedTime) return;
    try {
      await commitCloud((data) => {
        const record = data.records.find((r) => r.id === state.myRecord.id);
        if (!record || record.publicToken !== state.myRecord.publicToken) {
          throw new Error('Запись не найдена');
        }
        if (
          FocusStorage.hasConflict(data.records, {
            date: state.selectedDate,
            time: state.selectedTime,
            duration: record.duration || duration(),
            excludeId: record.id,
          })
        ) {
          throw new Error('Это время уже занято');
        }
        record.status = 'reschedule_requested';
        record.proposedDate = state.selectedDate;
        record.proposedTime = state.selectedTime;
        record.updatedAt = new Date().toISOString();
        return data;
      });
      state.mode = 'book';
      renderMyBooking();
      showPanel('my');
      showAlert('Запрос на перенос отправлен фотографу', true);
    } catch (err) {
      showAlert(err.message || 'Не удалось отправить запрос');
    }
  }

  function bind() {
    $('#bookPrevMonth')?.addEventListener('click', () => {
      state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() - 1, 1);
      renderCalendar();
    });
    $('#bookNextMonth')?.addEventListener('click', () => {
      state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + 1, 1);
      renderCalendar();
    });

    $('#bookForm')?.addEventListener('submit', submitBooking);
    $('#backToSlotsBtn')?.addEventListener('click', () => {
      showPanel('slots');
      renderSlots();
    });

    $('#rescheduleBtn')?.addEventListener('click', () => {
      if (!state.myRecord) return;
      state.mode = canSelfReschedule(state.myRecord) ? 'reschedule' : 'request';
      state.selectedDate = state.myRecord.date;
      state.selectedTime = null;
      state.cursor = FocusCalendar.parseISODate(state.myRecord.date);
      state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth(), 1);
      renderCalendar();
      renderSlots();
      showPanel('slots');
      showAlert(
        state.mode === 'reschedule'
          ? 'Выберите новую дату и время'
          : 'Выберите слот — фотограф подтвердит перенос'
      );
    });

    $('#newBookingBtn')?.addEventListener('click', () => {
      state.mode = 'book';
      state.selectedDate = null;
      state.selectedTime = null;
      showAlert('');
      renderCalendar();
      showPanel(state.myRecord ? 'myAndDate' : 'date');
      renderMyBooking();
    });

    $('#copyManageLinkBtn')?.addEventListener('click', async () => {
      const link = $('#manageLink')?.value;
      if (!link) return;
      try {
        await navigator.clipboard.writeText(link);
        showAlert('Ссылка скопирована', true);
      } catch {
        $('#manageLink')?.select();
        showAlert('Скопируйте ссылку вручную');
      }
    });

    $('#successDoneBtn')?.addEventListener('click', async () => {
      await refreshCloud();
      state.mode = 'book';
      renderMyBooking();
      renderCalendar();
      showPanel(state.myRecord ? 'myAndDate' : 'date');
      showAlert('');
    });
  }

  async function init() {
    bind();
    $('#datePanel')?.classList.add('hidden');

    if (!cloudCode) {
      showAlert(
        'Это страница записи для клиентов. Откройте полную ссылку из Настроек фотографа (кнопка «Копировать ссылку»).'
      );
      return;
    }

    if (!state.databaseURL) {
      showAlert(
        'В ссылке нет адреса облака. В кабинете: Настройки → сохранить Firebase → заново «Копировать ссылку».'
      );
      return;
    }

    if (!FocusSync.isOnline()) {
      showAlert('Нужен интернет, чтобы увидеть свободные слоты.');
      return;
    }

    try {
      showAlert('Загружаем свободные слоты…', true);
      await refreshCloud();
      if (!state.data) state.data = FocusStorage.migrate({});
      showAlert('');
      renderMyBooking();
      renderCalendar();
      if (state.myRecord && manageToken) {
        showPanel('myAndDate');
      } else {
        showPanel(state.myRecord ? 'myAndDate' : 'date');
      }
    } catch (err) {
      showAlert(err.message || 'Не удалось загрузить календарь. Проверьте ссылку и Firebase Rules.');
      $('#datePanel')?.classList.add('hidden');
    }
  }

  init();
})();
