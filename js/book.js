/* Фокус+ — публичная запись клиентов */
(() => {
  const MY_KEY = 'focusplus_my_bookings';
  const params = new URLSearchParams(location.search);
  const cloudCode = (params.get('c') || params.get('code') || '').trim();
  const manageToken = (params.get('m') || params.get('token') || '').trim();
  const dbFromLink = (params.get('db') || '').trim();

  const state = {
    data: null,
    public: null,
    cursor: new Date(),
    selectedDate: null,
    selectedTime: null,
    selectedDuration: 1,
    mode: 'book',
    myRecord: null,
    databaseURL: dbFromLink || FocusSync.getDatabaseURL(),
  };

  function applyPublic(pub) {
    const p = pub && typeof pub === 'object' ? pub : FocusSync.emptyPublic();
    state.public = p;
    state.data = {
      settings: { ...FocusStorage.defaultSettings(), ...(p.settings || {}) },
      records: FocusSync.recordsFromPublic(p),
    };
    state.myRecord = findMyRecord();
  }

  const $ = (sel, root = document) => root.querySelector(sel);

  function todayISO() {
    return FocusCalendar.toISODate(new Date());
  }

  function settings() {
    return state.data?.settings || FocusStorage.defaultSettings();
  }

  function duration() {
    const fromUi = Number($('#bDuration')?.value);
    if (fromUi > 0) {
      state.selectedDuration = fromUi;
      return fromUi;
    }
    return Number(state.selectedDuration) || Number(settings().bookingDuration) || 1;
  }

  function syncDurationSelect() {
    const el = $('#bDuration');
    if (!el) return;
    const val = String(state.selectedDuration || settings().bookingDuration || 1);
    if ([...el.options].some((o) => o.value === val)) el.value = val;
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
      minDate: today,
      maxDate: max,
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
  }

  function renderSlots() {
    const list = $('#slotsList');
    const label = $('#slotsDayLabel');
    const durHint = $('#slotsDurationHint');
    if (!list || !state.selectedDate) return;

    const d = FocusCalendar.parseISODate(state.selectedDate);
    if (label) {
      label.textContent = `· ${d.getDate()} ${FocusCalendar.MONTHS[d.getMonth()].toLowerCase()}`;
    }
    if (durHint) {
      durHint.textContent = `Длительность: ${formatDuration(duration())}. Слоты подобраны под это время.`;
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

    // При переносе своей записи текущий слот тоже доступен (если ещё не в прошлом)
    if (state.mode !== 'book' && state.myRecord && state.myRecord.date === state.selectedDate) {
      const own = state.myRecord.time;
      if (
        own &&
        !free.includes(own) &&
        !FocusStorage.isSlotInPast(state.selectedDate, own)
      ) {
        free = [...free, own].sort();
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
    $('#formSummary').textContent = `${formatDate(state.selectedDate)} · ${state.selectedTime} · ${formatDuration(duration())}`;
    $('#bookSubmitBtn').textContent = 'Записаться';
    showPanel('form');
  }

  function formatDate(iso) {
    return FocusCalendar.formatRuDate(iso);
  }

  function formatDuration(h) {
    const n = Number(h);
    if (n === 0.5) return '30 мин';
    if (n === 1) return '1 ч';
    if (n === 1.5) return '1,5 ч';
    if (n === 10) return '10 ч (весь день)';
    return `${n} ч`;
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
    const { data: pub } = await FocusSync.cloudGetPublic(cloudCode, state.databaseURL);
    applyPublic(pub);
  }

  async function commitPublic(mutator) {
    const saved = await FocusSync.withPublicLock(
      cloudCode,
      mutator,
      5,
      state.databaseURL
    );
    applyPublic(saved);
    return saved;
  }

  async function submitBooking(e) {
    e.preventDefault();
    if (!state.selectedDate || !state.selectedTime) return;

    if (FocusStorage.isSlotInPast(state.selectedDate, state.selectedTime)) {
      showAlert('Нельзя записаться на прошедшую дату или время');
      renderSlots();
      showPanel('slots');
      return;
    }

    const name = $('#bName').value.trim();
    const phone = $('#bPhone').value.trim();
    const vk = $('#bVk').value.trim();
    const type = $('#bType').value;
    const comment = $('#bComment').value.trim();
    const consent = $('#bConsent')?.checked;
    const dur = duration();

    if (!name) {
      showAlert('Укажите имя');
      return;
    }
    if (!phone && !vk) {
      showAlert('Укажите телефон или ссылку на VK');
      return;
    }
    if (!consent) {
      showAlert('Нужно согласие на обработку персональных данных');
      return;
    }

    const btn = $('#bookSubmitBtn');
    btn.disabled = true;
    btn.textContent = 'Сохраняем…';
    showAlert('');

    try {
      let created = null;
      await commitPublic((pub) => {
        if (FocusStorage.isSlotInPast(state.selectedDate, state.selectedTime)) {
          throw new Error('Нельзя записаться на прошедшую дату или время');
        }
        const records = FocusSync.recordsFromPublic(pub);
        const { workStart, workEnd } = pub.settings || {};
        const free = FocusStorage.getFreeSlots(
          records,
          state.selectedDate,
          workStart,
          workEnd,
          dur,
          slotStep()
        );
        if (!free.includes(state.selectedTime)) {
          throw new Error('Это время только что заняли. Выберите другой слот.');
        }

        const id = FocusStorage.uid();
        const publicToken = FocusStorage.uid().replace(/-/g, '').slice(0, 16);
        const now = new Date().toISOString();
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
          duration: dur,
          location: '',
          price: 0,
          prepaid: 0,
          comment,
          clientRescheduleCount: 0,
          publicToken,
          source: 'public',
          consentAt: now,
          createdAt: now,
          updatedAt: now,
        };
        pub.inbox = { ...(pub.inbox || {}), [id]: created };
        pub.mine = {
          ...(pub.mine || {}),
          [publicToken]: {
            id,
            publicToken,
            date: created.date,
            time: created.time,
            duration: created.duration,
            type: created.type,
            status: created.status,
            name,
            phone,
            vk,
            comment,
            clientRescheduleCount: 0,
            updatedAt: now,
          },
        };
        pub.blocks = [
          ...(pub.blocks || []).filter((b) => b.id !== id),
          {
            id,
            date: created.date,
            time: created.time,
            duration: created.duration,
            status: created.status,
          },
        ];
        return pub;
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
    if (FocusStorage.isSlotInPast(state.selectedDate, state.selectedTime)) {
      showAlert('Нельзя перенести на прошедшую дату или время');
      return;
    }
    if (!canSelfReschedule(state.myRecord)) {
      state.mode = 'request';
      await submitRescheduleRequest();
      return;
    }

    showAlert('');
    try {
      await commitPublic((pub) => {
        const token = state.myRecord.publicToken;
        const record =
          (pub.mine && pub.mine[token]) ||
          (pub.inbox && pub.inbox[state.myRecord.id]) ||
          null;
        if (!record || record.id !== state.myRecord.id) {
          throw new Error('Запись не найдена');
        }
        if (FocusStorage.isSlotInPast(state.selectedDate, state.selectedTime)) {
          throw new Error('Нельзя перенести на прошедшую дату или время');
        }
        const excludeId = record.id;
        const records = FocusSync.recordsFromPublic(pub).filter((r) => r.id !== excludeId);
        const { workStart, workEnd } = pub.settings || {};
        const free = FocusStorage.getFreeSlots(
          records,
          state.selectedDate,
          workStart,
          workEnd,
          record.duration || duration(),
          slotStep()
        );
        if (!free.includes(state.selectedTime)) {
          throw new Error('Это время уже занято или недоступно');
        }
        const now = new Date().toISOString();
        const next = {
          ...record,
          date: state.selectedDate,
          time: state.selectedTime,
          clientRescheduleCount: Number(record.clientRescheduleCount || 0) + 1,
          updatedAt: now,
          status: record.status === 'reschedule_requested' ? 'pending' : record.status || 'pending',
        };
        delete next.proposedDate;
        delete next.proposedTime;
        pub.mine = { ...(pub.mine || {}), [token]: next };
        pub.inbox = { ...(pub.inbox || {}), [next.id]: { ...next, kind: 'client', source: 'public' } };
        pub.blocks = [
          ...(pub.blocks || []).filter((b) => b.id !== next.id),
          {
            id: next.id,
            date: next.date,
            time: next.time,
            duration: next.duration || duration(),
            status: next.status,
          },
        ];
        return pub;
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
    if (FocusStorage.isSlotInPast(state.selectedDate, state.selectedTime)) {
      showAlert('Нельзя перенести на прошедшую дату или время');
      return;
    }
    try {
      await commitPublic((pub) => {
        const token = state.myRecord.publicToken;
        const record =
          (pub.mine && pub.mine[token]) ||
          (pub.inbox && pub.inbox[state.myRecord.id]) ||
          null;
        if (!record || record.id !== state.myRecord.id) {
          throw new Error('Запись не найдена');
        }
        if (FocusStorage.isSlotInPast(state.selectedDate, state.selectedTime)) {
          throw new Error('Нельзя перенести на прошедшую дату или время');
        }
        const records = FocusSync.recordsFromPublic(pub);
        if (
          FocusStorage.hasConflict(records, {
            date: state.selectedDate,
            time: state.selectedTime,
            duration: record.duration || duration(),
            excludeId: record.id,
          })
        ) {
          throw new Error('Это время уже занято');
        }
        const now = new Date().toISOString();
        const next = {
          ...record,
          status: 'reschedule_requested',
          proposedDate: state.selectedDate,
          proposedTime: state.selectedTime,
          updatedAt: now,
        };
        pub.mine = { ...(pub.mine || {}), [token]: next };
        pub.inbox = { ...(pub.inbox || {}), [next.id]: { ...next, kind: 'client', source: 'public' } };
        return pub;
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

    $('#bDuration')?.addEventListener('change', () => {
      state.selectedDuration = Number($('#bDuration').value) || 1;
      state.selectedTime = null;
      renderCalendar();
      if (state.selectedDate) {
        renderSlots();
        showPanel('slots');
      }
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
      // Запасной путь, если редирект в HTML не сработал
      const cabinet =
        location.protocol === 'file:'
          ? 'https://ninaisupova.github.io/Fokus-/'
          : 'index.html';
      location.replace(cabinet);
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
      if (!state.data) applyPublic(FocusSync.emptyPublic());
      if (!state.public?.publishedAt && !(state.public?.blocks || []).length) {
        showAlert(
          'Календарь ещё не опубликован. Фотографу нужно войти в кабинет и нажать «Синхронизировать сейчас».',
          false
        );
      } else {
        showAlert('');
      }
      state.selectedDuration = Number(settings().bookingDuration) || 1;
      syncDurationSelect();
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
