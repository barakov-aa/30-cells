'use strict';

/**
 * Игровое поле с анимацией фишек. Фишки лежат в отдельном слое поверх клеток
 * и сохраняются между обновлениями, поэтому их перемещение можно анимировать.
 * Любое изменение позиции команды (ход, правка администратора, отмена)
 * проигрывается шаг за шагом с подписью «откуда → куда, на сколько клеток».
 */
window.Board = (() => {
  const { esc } = window.App;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  const cellsWord = (n) => `${n} ${plural(n, 'клетку', 'клетки', 'клеток')}`;

  // Поле — извилистый путь к финишу. Координаты центров клеток в системе W×H и наклон в градусах.
  // Пары клеток на поворотах (4|5, 10|11, 20|21, 27|28) стоят на одной высоте.
  const W = 880;
  const H = 900;
  const CELL_W = 92;
  const CELL_H = 80;
  const FINISH_SIZE = 220;
  const PATH = {
    1: [90, 670, -3], 2: [93, 585, -2], 3: [96, 500, -2], 4: [98, 415, -3],
    5: [205, 415, 3], 6: [207, 500, 2], 7: [209, 585, 2], 8: [211, 670, 2], 9: [213, 755, 2],
    10: [215, 840, -2], 11: [323, 840, 2],
    12: [325, 755, -1], 13: [324, 670, -1], 14: [323, 585, -1], 15: [322, 500, -1],
    16: [321, 415, -1], 17: [320, 330, -1], 18: [319, 245, -1], 19: [318, 160, -2],
    20: [317, 75, -3], 21: [425, 75, 3],
    22: [427, 160, 2], 23: [429, 245, 1], 24: [431, 330, 1], 25: [433, 415, 1], 26: [435, 500, 1],
    27: [437, 585, 2], 28: [545, 585, -2], 29: [547, 500, -2],
    30: [725, 440, 0],
  };

  function create(root, config) {
    const size = config.boardSize;
    root.classList.add('board', 'path-board');
    root.innerHTML = '';

    // Перемычки между соседними клетками показывают направление пути.
    const route = Object.keys(PATH).map(Number).sort((a, b) => a - b)
      .map((n) => `${(PATH[n][0] / W) * 100},${(PATH[n][1] / H) * 100}`).join(' ');
    root.insertAdjacentHTML('beforeend', `<svg class="route" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${route}"/></svg>`);

    for (let n = 1; n <= size; n += 1) {
      const movie = config.movieCells.includes(n);
      const kind = n === 1 ? 'start' : n === size ? 'finish' : movie ? 'special' : '';
      const label = n === 1 ? 'Старт' : n === size ? 'Финиш' : movie ? 'Кино' : '';
      const icon = n === 1 ? '🚩' : n === size ? '🏁' : movie ? '🎬' : '';
      const [cx, cy, angle] = PATH[n] || [W / 2, H / 2, 0];
      const w = n === size ? FINISH_SIZE : CELL_W;
      const h = n === size ? FINISH_SIZE : CELL_H;
      const cell = document.createElement('div');
      cell.className = `cell ${kind}`;
      cell.dataset.cell = n;
      // Левый верхний угол без translate: тогда offsetLeft/offsetTop совпадают с рамкой клетки.
      cell.style.left = `${((cx - w / 2) / W) * 100}%`;
      cell.style.top = `${((cy - h / 2) / H) * 100}%`;
      cell.style.width = `${(w / W) * 100}%`;
      cell.style.height = `${(h / H) * 100}%`;
      cell.style.setProperty('--r', `${angle}deg`);
      cell.innerHTML = `<span class="num">${n}</span><span class="label">${label}</span>${icon ? `<span class="icon-big">${icon}</span>` : ''}<span class="trap-marks"></span>`;
      root.appendChild(cell);
    }

    const layer = document.createElement('div');
    layer.className = 'pieces-layer';
    root.appendChild(layer);

    const banner = document.createElement('div');
    banner.className = 'move-banner hidden';
    root.appendChild(banner);

    const cellEl = (n) => root.querySelector(`[data-cell="${n}"]`);
    const pieces = new Map(); // teamId -> { el, team }
    const shown = new Map(); // teamId -> клетка, на которой фишка нарисована сейчас
    const target = new Map(); // teamId -> клетка, куда фишка должна прийти
    const queue = [];
    let running = false;
    let currentTeamId = null;
    let lastTurn = null;

    function layout() {
      const groups = new Map();
      for (const [teamId, cell] of shown) {
        if (!groups.has(cell)) groups.set(cell, []);
        groups.get(cell).push(teamId);
      }
      for (const [cell, teamIds] of groups) {
        const el = cellEl(cell);
        if (!el) continue;
        const cw = el.offsetWidth;
        const ch = el.offsetHeight;
        const pad = Math.max(3, cw * 0.06);
        let piece = Math.max(12, Math.min(cw * 0.3, ch * 0.42, 64));
        let gap;
        let perRow;
        // Если фишек много, уменьшаем их, чтобы они уместились в нижней части клетки.
        for (;;) {
          gap = Math.max(2, piece * 0.12);
          perRow = Math.max(1, Math.floor((cw - pad * 2 + gap) / (piece + gap)));
          const rows = Math.ceil(teamIds.length / perRow);
          if (piece <= 12 || rows * (piece + gap) <= ch * 0.62) break;
          piece *= 0.88;
        }
        teamIds.forEach((teamId, i) => {
          const p = pieces.get(teamId);
          if (!p) return;
          const x = el.offsetLeft + pad + (i % perRow) * (piece + gap);
          const y = el.offsetTop + ch - pad - piece - Math.floor(i / perRow) * (piece + gap);
          p.el.style.width = `${piece}px`;
          p.el.style.height = `${piece}px`;
          p.el.style.fontSize = `${piece * 0.45}px`;
          p.el.style.transform = `translate(${x}px, ${y}px)`;
        });
      }
    }

    function ensurePiece(team) {
      let p = pieces.get(team.id);
      if (!p) {
        const el = document.createElement('div');
        // Первая расстановка без перехода, иначе фишка «прилетает» из угла поля.
        el.className = 'piece no-anim';
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('no-anim')));
        el.innerHTML = '<span class="piece-inner"></span>';
        layer.appendChild(el);
        p = { el, team };
        pieces.set(team.id, p);
      }
      p.team = team;
      p.el.title = team.name;
      p.el.style.setProperty('--team', team.color);
      p.el.querySelector('.piece-inner').textContent = (team.name.trim()[0] || '?').toUpperCase();
      p.el.classList.toggle('active', team.id === currentTeamId);
      return p;
    }

    function reasonText(move) {
      const t = lastTurn;
      if (!t || t.teamId !== move.teamId || t.from !== move.from || t.to !== move.to) return '';
      if (t.kind === 'movie') return `🎬 Угадано фильмов: ${t.guessed}`;
      if (t.doubled) return t.success ? '✖2 Удвоение сработало!' : '✖2 Удвоение не удалось — назад';
      return t.success ? '✓ Задание выполнено' : '';
    }

    function showBanner(move, team) {
      const steps = Math.abs(move.to - move.from);
      const forward = move.to > move.from;
      const reason = reasonText(move);
      // Подпись стоит в свободном правом нижнем углу поля и не закрывает путь.
      banner.style.setProperty('--team', team.color);
      banner.innerHTML = `
        <div class="mb-team"><span class="dot" style="background:${esc(team.color)}"></span>${esc(team.name)}</div>
        <div class="mb-route"><span>${move.from}</span><span class="mb-arrow">${forward ? '→' : '←'}</span><span>${move.to}</span></div>
        <div class="mb-delta ${forward ? 'fwd' : 'back'}">${forward ? 'Вперёд' : 'Назад'} на ${cellsWord(steps)}</div>
        ${reason ? `<div class="mb-reason">${esc(reason)}</div>` : ''}`;
      banner.classList.remove('hidden');
    }

    function markTrail(move, on) {
      const lo = Math.min(move.from, move.to);
      const hi = Math.max(move.from, move.to);
      for (let n = lo; n <= hi; n += 1) {
        const el = cellEl(n);
        if (!el) continue;
        el.classList.toggle('trail', on);
        el.classList.toggle('trail-from', on && n === move.from);
        el.classList.toggle('trail-to', on && n === move.to);
        if (on) el.style.setProperty('--team', move.color);
        else el.style.removeProperty('--team');
      }
    }

    async function play(move) {
      const p = pieces.get(move.teamId);
      if (!p || document.hidden) {
        shown.set(move.teamId, move.to);
        layout();
        return;
      }
      move.color = p.team.color;
      const steps = Math.abs(move.to - move.from);
      const dir = move.to > move.from ? 1 : -1;
      // Длинные перемещения (правки администратора) проигрываются быстрее.
      const stepMs = Math.max(90, Math.min(420, 3200 / steps)) / (queue.length > 2 ? 2 : 1);
      showBanner(move, p.team);
      markTrail(move, true);
      p.el.classList.add('moving');
      await wait(500);
      for (let i = 1; i <= steps; i += 1) {
        shown.set(move.teamId, move.from + dir * i);
        layout();
        p.el.classList.remove('hop');
        void p.el.offsetWidth; // перезапуск анимации прыжка
        p.el.classList.add('hop');
        await wait(stepMs);
      }
      p.el.classList.remove('moving', 'hop');
      cellEl(move.to)?.classList.add('landed');
      await wait(1600);
      cellEl(move.to)?.classList.remove('landed');
      markTrail(move, false);
      banner.classList.add('hidden');
    }

    async function run() {
      if (running) return;
      running = true;
      while (queue.length) {
        const move = queue.shift();
        if (!pieces.has(move.teamId)) continue;
        await play(move); // eslint-disable-line no-await-in-loop
      }
      for (const [teamId, cell] of target) shown.set(teamId, cell);
      layout();
      running = false;
    }

    // Ловушки команд: цветные треугольники в углу клетки (только у администратора).
    function renderTraps(traps) {
      root.querySelectorAll('.trap-marks').forEach((el) => { el.innerHTML = ''; });
      for (const team of traps || []) {
        for (const n of team.cells || []) {
          const marks = cellEl(n)?.querySelector('.trap-marks');
          if (marks) marks.insertAdjacentHTML('beforeend', `<span class="trap-mark" style="--team:${esc(team.color)}" title="Ловушка команды «${esc(team.name)}»"></span>`);
        }
      }
    }

    function update(teams, opts = {}) {
      currentTeamId = opts.currentTeamId || null;
      renderTraps(opts.traps);
      if (opts.lastTurn) lastTurn = opts.lastTurn;
      const alive = new Set(teams.map((t) => t.id));
      for (const [teamId, p] of pieces) {
        if (!alive.has(teamId)) {
          p.el.remove();
          pieces.delete(teamId);
          shown.delete(teamId);
          target.delete(teamId);
        }
      }
      for (const team of teams) {
        ensurePiece(team);
        if (!target.has(team.id)) {
          target.set(team.id, team.position);
          shown.set(team.id, team.position);
        } else if (target.get(team.id) !== team.position) {
          queue.push({ teamId: team.id, from: target.get(team.id), to: team.position });
          target.set(team.id, team.position);
        }
      }
      layout();
      run();
    }

    const isAnimating = () => running;

    new ResizeObserver(() => layout()).observe(root);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      // Вернулись на вкладку: догоняем без анимации.
      queue.length = 0;
      for (const [teamId, cell] of target) shown.set(teamId, cell);
      layout();
    });

    return { update, layout, isAnimating };
  }

  return { create };
})();
