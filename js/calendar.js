/* Фокус+ — календарь */
const FocusCalendar = (() => {
  const MONTHS = [
    'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
  ];

  function toISODate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function parseISODate(str) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function formatRuDate(iso) {
    const d = parseISODate(iso);
    return d.toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      weekday: 'long',
    });
  }

  function startOfMonth(year, month) {
    return new Date(year, month, 1);
  }

  /** Понедельник = 0 … Воскресенье = 6 */
  function mondayIndex(date) {
    return (date.getDay() + 6) % 7;
  }

  function buildMonthCells(year, month) {
    const first = startOfMonth(year, month);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const offset = mondayIndex(first);
    const cells = [];

    for (let i = 0; i < offset; i += 1) {
      const d = new Date(year, month, -offset + i + 1);
      cells.push({ date: toISODate(d), inMonth: false, day: d.getDate() });
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
      const d = new Date(year, month, day);
      cells.push({ date: toISODate(d), inMonth: true, day });
    }

    while (cells.length % 7 !== 0) {
      const last = parseISODate(cells[cells.length - 1].date);
      last.setDate(last.getDate() + 1);
      cells.push({ date: toISODate(last), inMonth: false, day: last.getDate() });
    }

    return cells;
  }

  function render({
    gridEl,
    titleEl,
    year,
    month,
    selectedDate,
    busyDates,
    partialDates,
    todayISO,
    onSelect,
  }) {
    if (titleEl) titleEl.textContent = `${MONTHS[month]} ${year}`;
    if (!gridEl) return;

    const partial = partialDates || new Set();
    const cells = buildMonthCells(year, month);
    gridEl.innerHTML = '';

    cells.forEach((cell) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'day-cell';
      btn.dataset.date = cell.date;
      // Крест только у полностью занятых дней (класс is-busy)
      btn.innerHTML = `<span class="day-num">${cell.day}</span><span class="day-cross" aria-hidden="true"></span><span class="day-dot" aria-hidden="true"></span>`;

      if (!cell.inMonth) btn.classList.add('is-outside');

      const fullyBusy = busyDates.has(cell.date);
      const partlyBusy = partial.has(cell.date);
      const isToday = cell.date === todayISO;
      const isSelected = cell.date === selectedDate;
      const isPast = cell.date < todayISO;

      // Крест — только если день заполнен целиком (нет свободных часов для клиентов)
      if (fullyBusy) btn.classList.add('is-busy');
      else if (cell.inMonth && !isPast) {
        btn.classList.add('is-free');
        if (partlyBusy) btn.classList.add('is-partial');
      }

      if (isToday) btn.classList.add('is-today');
      if (isSelected) btn.classList.add('is-selected');
      if (isPast) btn.classList.add('is-past');

      btn.addEventListener('click', () => onSelect?.(cell.date));
      gridEl.appendChild(btn);
    });
  }

  return {
    MONTHS,
    toISODate,
    parseISODate,
    formatRuDate,
    buildMonthCells,
    render,
  };
})();
