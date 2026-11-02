'use strict';

/**
 * Планшет для рисования: общий большой холст для задания «Рисование».
 * Рисующий запускает таймер, рисует и отмечает, угадала ли команда. В остальные ходы — заставка.
 * Слово приходит только в ходы с рисованием и спрятано за кнопкой: планшет могут видеть и угадывающие.
 */
(() => {
  const { esc, api, toast } = window.App;
  const $ = (sel) => document.querySelector(sel);
  const tabletCode = decodeURIComponent(location.pathname.split('/')[2] || '');

  let config = null;
  let state = null;
  let clockOffset = 0;
  let wordShownFor = null; // id хода, в котором рисующий открыл слово
  let lastKey = null;

  const now = () => Date.now() + clockOffset;
  const playerName = (id) => (id && state.players[id] ? state.players[id].name : '');
  const plural = (n, one, few, many) => {
    const m10 = n % 10;
    const m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  };
  const cells = (n) => `${n} ${plural(Math.abs(n), 'клетка', 'клетки', 'клеток')}`;

  function fatal(message) {
    $('#fatal-text').textContent = message;
    $('#fatal').classList.remove('hidden');
    $('#layout').classList.add('hidden');
  }

  const drawingTurn = () => (state?.status === 'playing' && state.turn?.category === 'drawing' ? state.turn : null);

  // ---------- Соединение ----------

  const socket = io({ autoConnect: false, auth: { tablet: tabletCode } });
  socket.on('connect', () => {
    $('#conn').className = 'conn on';
    $('#conn').textContent = '● онлайн';
  });
  socket.on('disconnect', () => {
    $('#conn').className = 'conn off';
    $('#conn').textContent = '● нет связи';
  });
  socket.on('fatal', ({ message }) => {
    socket.disconnect();
    fatal(message);
  });
  socket.on('gone', ({ message }) => {
    socket.disconnect();
    fatal(message);
  });
  socket.on('state', (s) => {
    clockOffset = s.serverNow - Date.now();
    state = s;
    render();
  });

  function send(type, payload = {}) {
    socket.emit('action', { type, ...payload }, (res) => {
      if (res?.error) toast(res.error, true);
    });
  }

  // ---------- Холст ----------

  const { COLORS, WIDTHS } = window.DrawCanvas;
  const canDraw = () => drawingTurn()?.phase === 'timer';
  const drawing = window.DrawCanvas.create($('#canvas'), socket, { canDraw });
  const pen = drawing.pen;
  pen.width = 14; // на большом экране рисуют пальцем — линия потолще

  // Холст 4:3 — самый большой, который помещается в свободное место (и в альбомной, и в книжной ориентации).
  function fitCanvas() {
    const box = $('#canvas-box');
    const w = Math.min(box.clientWidth, (box.clientHeight * 4) / 3);
    $('#canvas-wrap').style.width = `${Math.floor(w)}px`;
    $('#canvas-wrap').style.height = `${Math.floor((w * 3) / 4)}px`;
  }
  new ResizeObserver(fitCanvas).observe($('#canvas-box'));

  function renderTools() {
    const turn = drawingTurn();
    $('#tools').innerHTML = turn?.phase === 'timer'
      ? `<div class="tb-swatches">${COLORS.map((c) => `<button type="button" class="swatch ${pen.color === c ? 'active' : ''}" style="background:${c}"
          data-color="${c}" title="${c === '#ffffff' ? 'Ластик' : 'Цвет'}">${c === '#ffffff' ? '🧽' : ''}</button>`).join('')}</div>
        <div class="tb-widths">${WIDTHS.map(([w, label]) => `<button type="button" class="${pen.width === w ? 'active' : ''}" data-width="${w}"
          title="${label}"><span style="width:${Math.round(3 + w * 0.7)}px;height:${Math.round(3 + w * 0.7)}px"></span></button>`).join('')}</div>
        <button type="button" data-act="clear">🗑 Очистить</button>`
      : '';
  }
  $('#tools').addEventListener('click', (e) => {
    const sw = e.target.closest('[data-color]');
    const wd = e.target.closest('[data-width]');
    if (sw) pen.color = sw.dataset.color;
    if (wd) pen.width = Number(wd.dataset.width);
    if (e.target.closest('[data-act="clear"]') && confirm('Очистить рисунок?')) drawing.clear();
    if (sw || wd) renderTools();
  });

  // ---------- Отрисовка ----------

  function render() {
    const turn = drawingTurn();
    document.title = `Планшет — ${state.name}`;
    $('#title').textContent = `✏️ ${state.name}`;
    $('#idle').classList.toggle('hidden', Boolean(turn));
    $('#main').classList.toggle('hidden', !turn);
    if (!turn) {
      $('#timer').classList.add('hidden');
      const team = state.teams[state.currentTeamIdx];
      $('#idle-text').textContent = state.status === 'lobby' ? 'Игра ещё не началась. Когда выпадет задание «Рисование», здесь появится холст.'
        : state.status === 'finished' ? 'Игра окончена. Спасибо за игру!'
          : `Сейчас ходят «${team?.name || ''}». Когда выпадет задание «Рисование», здесь появится холст.`;
      lastKey = null;
      return;
    }
    fitCanvas();
    drawing.setTurn(turn.id);
    const team = state.teams.find((t) => t.id === turn.teamId);
    $('#who').innerHTML = `<div class="tb-team"><span class="dot" style="background:${esc(team?.color || '#999')}"></span>${esc(team?.name || '')}</div>
      <div>Рисует: <b>${esc(playerName(turn.explainerId) || 'объясняющий')}</b></div>
      ${turn.guesserId ? `<div class="muted">Угадывает: ${esc(playerName(turn.guesserId))}</div>` : ''}
      ${turn.trap?.text ? `<div class="trap-banner small"><b>⚠️ Ловушка:</b> ${esc(turn.trap.text)}</div>` : ''}`;

    // Слово: прячется в начале каждого хода, рисующий открывает его сам.
    const shown = wordShownFor === turn.id && turn.card;
    $('#word-btn').textContent = shown ? '🙈 Спрятать слово' : '👁 Показать слово';
    $('#word-btn').classList.toggle('hidden', !turn.card);
    $('#word').classList.toggle('hidden', !shown);
    $('#word').textContent = shown ? turn.card : '';

    const c = config.categories[turn.category];
    const boost = state.boost ? config.boostMultiplier : 1;
    const win = (turn.doubled ? c.points * 2 : c.points) * boost;
    const lose = turn.doubled ? c.points * 2 : 0;
    const resultButtons = `<button type="button" class="ok big" data-act="success">✓ Угадали <small>+${cells(win)}</small></button>
      <button type="button" class="bad big" data-act="fail">✗ Не угадали <small>${lose ? `−${cells(lose)}` : 'стоим'}</small></button>`;
    const overlay = $('#overlay');
    if (turn.phase === 'prepare') {
      overlay.textContent = 'Нажмите «▶ Старт», когда будете готовы рисовать';
      $('#actions').innerHTML = `<button type="button" class="primary big" data-act="start">▶ Старт · ${turn.seconds} сек</button>
        <div class="muted small">${turn.doubled ? '✖2 Команда играет с «Удвоением»' : '«Удвоение» выбирают на телефоне до старта'}</div>`;
    } else if (turn.phase === 'timer') {
      $('#actions').innerHTML = resultButtons;
    } else {
      overlay.textContent = '⏰ Время вышло — угадали?';
      $('#actions').innerHTML = resultButtons;
    }
    overlay.classList.toggle('hidden', turn.phase === 'timer');
    const key = `${turn.id}:${turn.phase}`;
    if (key !== lastKey) renderTools();
    lastKey = key;
    tick();
  }

  $('#word-btn').addEventListener('click', () => {
    const id = drawingTurn()?.id;
    wordShownFor = wordShownFor === id ? null : id;
    render();
  });

  $('#actions').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'start') send('startTimer');
    if (btn.dataset.act === 'success') send('finishTurn', { success: true });
    if (btn.dataset.act === 'fail') send('finishTurn', { success: false });
  });

  function tick() {
    const turn = drawingTurn();
    const el = $('#timer');
    if (!turn || turn.phase === 'prepare') {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    const left = turn.phase === 'timer' ? Math.max(0, Math.ceil((turn.endsAt - now()) / 1000)) : 0;
    el.textContent = `⏱ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    el.classList.toggle('low', left <= 10);
  }
  setInterval(tick, 250);

  // ---------- Экран планшета ----------

  const full = $('#btn-full');
  if (!document.documentElement.requestFullscreen) full.classList.add('hidden');
  full.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  });

  // Планшет не гаснет, пока страница открыта.
  let wakeLock = null;
  async function keepAwake() {
    try {
      if (navigator.wakeLock && document.visibilityState === 'visible' && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch { /* не поддерживается */ }
  }
  document.addEventListener('visibilitychange', keepAwake);
  document.addEventListener('pointerdown', keepAwake);

  // ---------- Старт ----------

  (async () => {
    try {
      config = await api('GET', '/api/config');
      await api('GET', `/api/tablet/${encodeURIComponent(tabletCode)}`);
    } catch (err) {
      fatal(err.message);
      return;
    }
    keepAwake();
    socket.connect();
  })();
})();
