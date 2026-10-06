'use strict';

(() => {
  const { esc, api, toast, copy, storage, formatCode, STATUS } = window.App;
  const $ = (sel) => document.querySelector(sel);

  const adminMatch = location.pathname.match(/^\/admin\/game\/([^/]+)/);
  const joinMatch = location.pathname.match(/^\/join\/([^/]+)/);
  const isAdmin = Boolean(adminMatch);
  // Код игры из ссылки /join/<код>; на странице /join без кода игрок вводит его сам.
  let code = joinMatch ? decodeURIComponent(joinMatch[1]) : null;
  let tokenKey = code ? `token:${code}` : null;
  if (!isAdmin) document.body.classList.add('player');

  let config = null;
  let state = null;
  let clockOffset = 0;
  let lastTurnId = null;
  let lastRenderedPhase = null;
  let beeped = null;

  const view = { game: $('#game'), join: $('#join'), code: $('#code'), fatal: $('#fatal') };
  function show(name) {
    for (const [key, el] of Object.entries(view)) el.classList.toggle('hidden', key !== name);
  }

  function fatal(message) {
    $('#fatal-text').textContent = message;
    show('fatal');
  }

  // ---------- Соединение ----------

  const socket = io({
    autoConnect: false,
    auth: (cb) => cb(isAdmin ? { gameId: adminMatch[1] } : { code, token: storage(tokenKey) }),
  });

  socket.on('connect', () => setConn(true));
  socket.on('disconnect', () => setConn(false));
  socket.on('fatal', ({ message, login }) => {
    socket.disconnect();
    if (login) location.href = '/admin';
    else if (!isAdmin) showCodeForm(message);
    else fatal(message);
  });
  socket.on('gone', ({ message }) => {
    socket.disconnect();
    if (tokenKey) storage(tokenKey, null);
    fatal(message);
  });
  socket.on('state', (s) => {
    clockOffset = s.serverNow - Date.now();
    state = s;
    render();
  });

  function setConn(on) {
    const el = $('#conn');
    el.className = `conn ${on ? 'on' : 'off'}`;
    el.textContent = on ? '● онлайн' : '● нет связи';
  }

  function send(type, payload = {}) {
    return new Promise((resolve) => {
      socket.emit('action', { type, ...payload }, (res) => {
        if (res?.error) toast(res.error, true);
        resolve(res);
      });
    });
  }

  // ---------- Вспомогательное ----------

  const now = () => Date.now() + clockOffset;
  const me = () => (state?.me?.playerId ? state.players[state.me.playerId] : null);
  const myTeam = () => {
    const p = me();
    return p?.teamId ? state.teams.find((t) => t.id === p.teamId) : null;
  };
  const currentTeam = () => (state.status === 'playing' ? state.teams[state.currentTeamIdx] : null);
  const canAct = () => {
    const team = currentTeam();
    return Boolean(team && (isAdmin || myTeam()?.id === team.id));
  };
  const playerName = (id) => (id && state.players[id] ? state.players[id].name : '—');
  const teamLabel = (t) => `<span class="row" style="gap: 6px; display: inline-flex"><span class="dot" style="background:${esc(t.color)}"></span><b>${esc(t.name)}</b></span>`;
  const cat = (key) => config.categories[key] || (key === 'random' ? config.guestPool : null);
  const plural = (n, one, few, many) => {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  };
  const cells = (n) => `${n} ${plural(Math.abs(n), 'клетка', 'клетки', 'клеток')}`;

  function focusedInside(el) {
    const a = document.activeElement;
    return a && el.contains(a) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName);
  }

  function beep(freq = 880, duration = 0.5) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch { /* звук недоступен */ }
  }

  // ---------- Отрисовка ----------

  function render() {
    if (!state) return;
    document.title = `${state.name} — 30 клеток`;
    $('#game-name').textContent = state.name;
    const status = $('#game-status');
    status.textContent = STATUS[state.status];
    status.className = `badge ${state.status}`;
    if (isAdmin) $('#brand').href = '/admin';

    if (!isAdmin && !state.me) {
      if (tokenKey) storage(tokenKey, null);
      $('#join-game').textContent = `Игра «${state.name}». Введите имя, чтобы присоединиться.`;
      show('join');
      if (!focusedInside(view.join)) $('#join-name').focus();
      return;
    }
    show('game');
    const p = me();
    const team = myTeam();
    $('#me').innerHTML = isAdmin
      ? '👑 Администратор'
      : `${esc(p.name)}${team ? ` · <span class="dot" style="background:${esc(team.color)}"></span> ${esc(team.name)}` : ''}`;

    renderBoard();
    renderWinner();
    renderTurn();
    renderTeamPick();
    renderTeams();
    renderAdmin();
    renderLog();
    renderDrawPanel();
    renderMinimap();
  }

  let board = null;
  function renderBoard() {
    if (!board) board = window.Board.create($('#board'), config);
    board.update(state.teams, {
      currentTeamId: currentTeam()?.id,
      lastTurn: state.lastTurn,
      traps: isAdmin ? state.teams.map((t) => ({ color: t.color, name: t.name, cells: t.traps || [] })) : null,
    });
  }

  // ---------- Компактная шкала для смартфонов ----------

  const mmDots = new Map(); // teamId -> элемент фишки
  const mmPositions = new Map(); // teamId -> последняя известная клетка
  let mmMoveTimer = null;

  function renderMinimap() {
    const track = $('#mm-track');
    if (!track.childElementCount) {
      track.innerHTML = Array.from({ length: config.boardSize }, (_, i) => {
        const n = i + 1;
        const kind = n === 1 ? 'start' : n === config.boardSize ? 'finish' : config.movieCells.includes(n) ? 'movie' : '';
        return `<span class="mm-cell ${kind}"></span>`;
      }).join('') + '<div class="mm-dots"></div>';
    }
    const layer = track.querySelector('.mm-dots');
    const current = currentTeam();
    const alive = new Set(state.teams.map((t) => t.id));
    for (const [id, el] of mmDots) {
      if (!alive.has(id)) {
        el.remove();
        mmDots.delete(id);
        mmPositions.delete(id);
      }
    }

    // Команды на одной клетке ставим друг над другом.
    const stackIndex = new Map();
    const moves = [];
    for (const t of state.teams) {
      let el = mmDots.get(t.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'mm-dot';
        layer.appendChild(el);
        mmDots.set(t.id, el);
      }
      const level = stackIndex.get(t.position) || 0;
      stackIndex.set(t.position, level + 1);
      el.textContent = (t.name.trim()[0] || '?').toUpperCase();
      el.title = `${t.name}: клетка ${t.position}`;
      el.style.background = t.color;
      el.style.left = `calc(${(t.position - 1) / (config.boardSize - 1)} * 100%)`;
      el.style.bottom = `${level * 14}px`;
      el.classList.toggle('current', current?.id === t.id);
      el.classList.toggle('mine', myTeam()?.id === t.id);
      const prev = mmPositions.get(t.id);
      if (prev !== undefined && prev !== t.position) moves.push({ team: t, from: prev, to: t.position });
      mmPositions.set(t.id, t.position);
    }
    const maxStack = Math.max(1, ...stackIndex.values());
    track.style.marginTop = `${10 + (maxStack - 1) * 14}px`;

    const mine = myTeam();
    if (mine) {
      const toFinish = config.boardSize - mine.position;
      const nextMovie = config.movieCells.find((c) => c > mine.position);
      const place = state.teams.filter((t) => t.position > mine.position).length + 1;
      $('#mm-me').innerHTML = `<div class="mm-me-main"><span class="dot" style="background:${esc(mine.color)}"></span>
          <b>${esc(mine.name)}</b><span class="mm-cellno">клетка <b>${mine.position}</b> из ${config.boardSize}</span></div>
        <div class="small muted">${place} место · до финиша ${cells(toFinish)}${nextMovie ? ` · 🎬 «Кино» на ${nextMovie}` : ''} · удвоений ${mine.doubles}</div>`;
    } else {
      $('#mm-me').innerHTML = '<div class="small muted">Позиции команд на поле</div>';
    }

    if (moves.length) {
      const box = $('#mm-move');
      box.innerHTML = moves.map(({ team, from, to }) => {
        const d = to - from;
        return `<div><span class="dot" style="background:${esc(team.color)}"></span> <b>${esc(team.name)}</b>:
          ${from} → ${to} <span class="${d > 0 ? 'fwd' : 'back'}">${d > 0 ? 'вперёд' : 'назад'} на ${Math.abs(d)} ${plural(Math.abs(d), 'клетку', 'клетки', 'клеток')}</span></div>`;
      }).join('');
      box.classList.remove('hidden');
      clearTimeout(mmMoveTimer);
      mmMoveTimer = setTimeout(() => box.classList.add('hidden'), 6000);
    }
  }

  function renderWinner() {
    const winner = state.teams.find((t) => t.id === state.winnerTeamId);
    $('#winner').innerHTML = winner
      ? `<div class="winner-banner"><div class="big">🏆 ${esc(winner.name)}</div>Команда первой дошла до финиша!</div>`
      : '';
  }

  function dieFace(turn) {
    if (turn.kind === 'movie') return '🎬';
    if (turn.face === 'random') return '?';
    return cat(turn.category).icon;
  }

  function cardHtml(turn) {
    if (turn.cardHidden) {
      return '<div class="secret hidden-card">🙈 Карточку видит только объясняющий — угадывайте!</div>';
    }
    if (turn.kind === 'movie') {
      return `<div class="secret"><ol>${turn.card.map((t) => `<li>${esc(t)}</li>`).join('')}</ol></div>`;
    }
    if (turn.category === 'music') {
      return `<div class="secret"><div class="word">${turn.card.split('/').map((w) => esc(w.trim())).join(' <span class="muted">и</span> ')}</div></div>`;
    }
    return `<div class="secret"><div class="word">${esc(turn.card)}</div></div>`;
  }

  function turnHeader(team, turn) {
    const c = cat(turn.category);
    let faceNote = '';
    if (turn.face === 'random') {
      faceNote = turn.fromPool
        ? '<div class="muted small">Выпал «?» — случайное задание, слово про гостей 🎉</div>'
        : '<div class="muted small">Выпал «?» — случайное задание</div>';
      if (turn.poolFallback) faceNote += '<div class="muted small">Слова про гостей закончились — карточка из обычной колоды</div>';
    }
    if (turn.movieFallback) faceNote += '<div class="muted small">Карточки «Кино» закончились — бросили кубик</div>';
    if (turn.substitutedFrom) {
      faceNote += `<div class="muted small">В категории «${esc(cat(turn.substitutedFrom).title)}» закончились карточки — задание заменено</div>`;
    }
    const pts = turn.kind === 'movie' ? '1 балл за каждый фильм' : `${c.points} ${plural(c.points, 'балл', 'балла', 'баллов')}`;
    const roles = turn.explainerId
      ? `<div class="small">Объясняет: <b>${esc(playerName(turn.explainerId))}</b>${turn.guesserId ? ` · угадывает: <b>${esc(playerName(turn.guesserId))}</b>` : ''}</div>`
      : '';
    return `<div>${teamLabel(team)}</div>
      <div class="die ${lastTurnId !== turn.id ? 'rolling' : ''}">${esc(dieFace(turn))}</div>
      ${faceNote}
      <div class="task-title">${esc(c.icon)} ${esc(c.title)}${turn.doubled ? ' <span class="badge" style="background:#fff3bf;color:#5c3d00">✖2 удвоение</span>' : ''}</div>
      <div class="task-meta">${turn.seconds} сек · ${pts}</div>
      <div class="task-rules">${esc(c.rules)}</div>
      ${trapHtml(turn)}
      ${roles}`;
  }

  function trapHtml(turn) {
    if (!turn.trap) return '';
    return `<div class="trap-banner">
      <div class="trap-title">⚠️ Ловушка на клетке ${turn.trap.cell}!</div>
      ${turn.trap.text ? `<div class="trap-text">${esc(turn.trap.text)}</div>` : '<div class="small">Усложнений для этой категории нет — играем как обычно</div>'}
      <div class="small muted">Очки за задание — как обычно</div>
    </div>`;
  }

  function renderTurn() {
    const el = $('#turn');
    const team = currentTeam();
    const turn = state.turn;

    if (state.status === 'lobby') {
      el.innerHTML = `<h2>Ожидаем начала игры</h2>
        <p class="muted">${isAdmin ? 'Когда команды соберутся, нажмите «Начать игру» в панели управления.' : 'Выберите команду. Администратор начнёт игру, когда все будут готовы.'}</p>`;
      lastRenderedPhase = 'lobby';
      return;
    }
    if (state.status === 'finished' || !team) {
      el.innerHTML = '<h2>Игра окончена</h2><p class="muted">Спасибо за игру!</p>';
      lastRenderedPhase = 'finished';
      return;
    }

    const active = canAct();
    let html = '';
    if (!turn) {
      const movie = config.movieCells.includes(team.position);
      const last = state.lastTurn;
      const lastNote = last && last.teamId !== team.id
        ? `<p class="small muted">Прошлый ход: ${esc(state.teams.find((t) => t.id === last.teamId)?.name || '')} ${last.delta >= 0 ? '+' : ''}${last.delta} (клетка ${last.from} → ${last.to})</p>`
        : '';
      html = `<div class="muted small">Ход ${state.turnNumber + 1}</div>
        <h2 style="margin-top: 4px">Ходит ${teamLabel(team)}</h2>
        <div class="die">${movie ? '🎬' : '🎲'}</div>
        ${movie ? '<p>Команда стоит на клетке «Кино» — вместо кубика тянет карточку с 5 фильмами.</p>' : ''}
        ${lastNote}
        ${active
          ? `<button class="primary big" data-act="roll">${movie ? '🎬 Вытянуть карточку' : '🎲 Бросить кубик'}</button>`
          : `<p class="muted">Ждём, пока команда ${movie ? 'вытянет карточку' : 'бросит кубик'}…</p>`}`;
    } else if (turn.phase === 'prepare') {
      const c = cat(turn.category);
      let doubleHtml = '';
      if (turn.kind !== 'movie') {
        if (active && team.doubles > 0) {
          doubleHtml = `<label class="double-toggle ${turn.doubled ? 'on' : ''}">
              <input type="checkbox" data-act="double" ${turn.doubled ? 'checked' : ''}>
              <span>Использовать «Удвоение» (осталось ${team.doubles}): успех +${c.points * 2}, провал −${c.points * 2}</span>
            </label>`;
        } else if (team.doubles <= 0) {
          doubleHtml = '<p class="muted small">Фишки «Удвоение» закончились</p>';
        } else if (turn.doubled) {
          doubleHtml = '<p class="small"><b>Команда ставит «Удвоение»!</b></p>';
        }
      } else {
        doubleHtml = '<p class="muted small">Удвоение на карточках «Кино» не действует</p>';
      }
      html = `${turnHeader(team, turn)}
        ${cardHtml(turn)}
        ${doubleHtml}
        ${active ? '<button class="primary big" data-act="start">▶ Старт таймера</button>' : '<p class="muted">Команда готовится…</p>'}`;
    } else if (turn.phase === 'timer') {
      html = `${turnHeader(team, turn)}
        <div class="timer" id="timer"></div>
        <div class="progress"><div id="timer-bar"></div></div>
        ${cardHtml(turn)}
        ${active ? '<button class="big" data-act="stop">⏹ Готово, остановить</button>' : ''}`;
    } else if (turn.phase === 'result') {
      let buttons;
      if (turn.kind === 'movie') {
        buttons = active
          ? `<p><b>Сколько фильмов угадали?</b></p><div class="row" style="justify-content:center">${[0, 1, 2, 3, 4, 5]
            .map((n) => `<button class="${n ? 'ok' : ''} big" data-act="guessed" data-n="${n}">${n}</button>`).join('')}</div>`
          : '<p class="muted">Команда подсчитывает угаданные фильмы…</p>';
      } else {
        const c = cat(turn.category);
        const win = turn.doubled ? c.points * 2 : c.points;
        const lose = turn.doubled ? -c.points * 2 : 0;
        buttons = active
          ? `<p><b>Задание выполнено?</b></p>
            <div class="row" style="justify-content:center">
              <button class="ok big" data-act="success">✓ Да (+${cells(win)})</button>
              <button class="bad big" data-act="fail">✗ Нет (${lose ? `−${cells(-lose)}` : 'стоим'})</button>
            </div>`
          : '<p class="muted">Команда подтверждает результат…</p>';
      }
      html = `${turnHeader(team, turn)}
        <div class="timer">⏰</div>
        ${cardHtml(turn)}
        ${buttons}`;
    }
    el.innerHTML = html;
    lastTurnId = turn?.id || null;
    const phase = turn ? `${turn.id}:${turn.phase}` : 'idle';
    if (phase !== lastRenderedPhase && turn?.phase === 'result' && lastRenderedPhase?.endsWith(':timer')) beep(660, 0.8);
    lastRenderedPhase = phase;
    tick();
  }

  function tick() {
    const turn = state?.turn;
    const timerEl = document.getElementById('timer');
    if (!turn || turn.phase !== 'timer' || !timerEl) return;
    const left = Math.max(0, turn.endsAt - now());
    const sec = Math.ceil(left / 1000);
    timerEl.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    timerEl.classList.toggle('warn', sec <= 10);
    const bar = document.getElementById('timer-bar');
    if (bar) bar.style.width = `${(left / (turn.seconds * 1000)) * 100}%`;
    if (sec <= 3 && sec > 0 && beeped !== `${turn.id}:${sec}`) {
      beeped = `${turn.id}:${sec}`;
      beep(520, 0.15);
    }
  }
  setInterval(tick, 200);

  function renderTeamPick() {
    const el = $('#team-pick');
    const p = me();
    const lobby = state.status === 'lobby';
    const visible = !isAdmin && p && (lobby || !p.teamId);
    el.classList.toggle('hidden', !visible);
    if (!visible || focusedInside(el)) return;
    const team = myTeam();
    const options = state.teams.map((t) => {
      const members = t.players.map((id) => esc(playerName(id))).join(', ') || '<span class="muted">пока никого</span>';
      const mine = team?.id === t.id;
      const full = t.players.length >= config.maxTeamSize;
      let btn = '';
      if (mine) btn = lobby ? '<button data-act="leave">Выйти</button>' : '<span class="badge">ваша</span>';
      else if (!full && (lobby || !p.teamId)) btn = `<button class="primary" data-act="join" data-team="${esc(t.id)}">Вступить</button>`;
      else if (full) btn = '<span class="badge">заполнена</span>';
      return `<div class="team-option ${mine ? 'mine' : ''}">
        <span class="dot" style="background:${esc(t.color)};width:18px;height:18px"></span>
        <div style="flex:1;min-width:0"><b>${esc(t.name)}</b><div class="small muted">${members} · ${t.players.length}/${config.maxTeamSize}</div></div>
        ${btn}</div>`;
    }).join('');
    const allFull = state.teams.length > 0 && !team && state.teams.every((t) => t.players.length >= config.maxTeamSize);
    el.innerHTML = `<h2>${team ? 'Ваша команда' : 'Выберите команду'}</h2>
      <p class="muted small">В команде ${config.maxTeamSize} человека. Команды создаёт ведущий.</p>
      <div class="team-pick">${options || '<p class="muted">Команд пока нет — ведущий скоро их создаст, страница обновится сама.</p>'}</div>
      ${allFull ? '<p class="muted small">Все команды заполнены — попросите ведущего добавить команду.</p>' : ''}
      <div class="row" style="margin-top:10px"><button class="link small" data-act="rename-me">✎ Изменить имя</button></div>`;
  }

  function renderTeams() {
    const current = currentTeam();
    $('#teams').innerHTML = state.teams.map((t) => {
      const chips = Array.from({ length: Math.max(config.doublesPerTeam, t.doubles) }, (_, i) => `<span class="chip ${i < t.doubles ? '' : 'used'}">×2</span>`).join('');
      const members = t.players.map((id) => {
        const pl = state.players[id];
        return pl ? `${pl.online ? '<span class="online">●</span>' : '<span class="muted">○</span>'} ${esc(pl.name)}` : '';
      }).join(', ');
      return `<tr class="${current?.id === t.id ? 'current' : ''}">
        <td>${teamLabel(t)}${state.winnerTeamId === t.id ? ' 🏆' : ''}<div class="players">${members || 'нет игроков'}</div></td>
        <td><b>${t.position}</b></td>
        <td><span class="doubles">${chips}</span></td></tr>`;
    }).join('') || '<tr><td colspan="3" class="muted">Команд пока нет</td></tr>';
  }

  function renderLog() {
    $('#log').innerHTML = state.log.slice().reverse().map((e) =>
      `<li><time>${new Date(e.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</time>${esc(e.text)}</li>`).join('');
  }

  // ---------- Панель администратора ----------

  let adminDirty = false;
  function renderAdmin() {
    const el = $('#admin');
    el.classList.toggle('hidden', !isAdmin);
    if (!isAdmin) return;
    if (focusedInside(el)) {
      adminDirty = true;
      return;
    }
    adminDirty = false;
    const invite = `${location.origin}/join/${state.code}`;
    const playing = state.status === 'playing';
    const unassigned = Object.values(state.players).filter((p) => !p.teamId);
    const teamOptions = (selected) => `<option value="">— без команды —</option>${state.teams.map((t) =>
      `<option value="${esc(t.id)}" ${t.id === selected ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}`;
    const member = (p) => `<div class="member">
        ${p.online ? '<span class="online">●</span>' : '<span class="muted">○</span>'}
        <span style="flex:1;min-width:0">${esc(p.name)}</span>
        <select data-assign="${esc(p.id)}">${teamOptions(p.teamId)}</select>
        <button class="icon" data-act="rename-player" data-player="${esc(p.id)}" title="Переименовать">✎</button>
        <button class="icon" data-act="remove-player" data-player="${esc(p.id)}" title="Удалить из игры">✕</button>
      </div>`;

    el.innerHTML = `<h2>👑 Управление</h2>
      <label>Код игры и ссылка для гостей</label>
      <div class="row"><span class="join-code">${esc(formatCode(state.code))}</span>
        <span class="muted small">— вводится на ${esc(location.host)}/join</span></div>
      <div class="row" style="margin-top:4px"><div class="invite" style="flex:1">${esc(invite)}</div></div>
      <div class="row" style="margin-top:6px">
        <button data-act="copy-invite">📋 Копировать</button>
        <a class="btn" href="/screen/${esc(state.screenCode)}" target="_blank" rel="noopener" title="Поле для общего экрана без лишних элементов">📺 Экран</a>
        <button data-act="new-invite" title="Старые ссылка и код перестанут работать для новых гостей">🔄 Новый код</button>
        <button data-act="rename-game">✎ Название</button>
      </div>
      <hr style="border:none;border-top:1px solid var(--border);margin:14px 0">
      <div class="row">
        ${state.status !== 'playing' ? `<button class="primary" data-act="start-game">▶ ${state.status === 'finished' ? 'Продолжить игру' : 'Начать игру'}</button>` : ''}
        ${playing ? '<button data-act="skip">⏭ Пропустить ход</button>' : ''}
        ${playing && state.turn ? '<button data-act="cancel-turn">↩ Отменить бросок</button>' : ''}
        <button data-act="undo" ${state.undo ? '' : 'disabled'} title="${esc(state.undo ? `Отменить: ${state.undo.label}` : '')}">⎌ Отменить${state.undo ? ` (${state.undo.count})` : ''}</button>
      </div>
      ${state.undo ? `<div class="muted small" style="margin-top:4px">Последнее действие: ${esc(state.undo.label)}</div>` : ''}
      ${state.cardsLeft ? `<div class="small" style="margin-top:8px" title="Каждая карточка выпадает в игре один раз. «Сбросить игру» возвращает все карточки.">
        <span class="muted">Осталось карточек:</span>
        ${Object.entries(state.cardsLeft).map(([key, n]) =>
          `<span class="badge" style="${n < 3 ? 'background:#ffe3e3;color:#c92a2a;border-color:#ffa8a8' : ''}" title="${esc(cat(key).title)}">${esc(cat(key).icon)} ${n}</span>`).join(' ')}
      </div>` : ''}
      <div class="row" style="margin-top:8px">
        ${playing ? '<button data-act="finish-game">🏁 Завершить</button>' : ''}
        <button class="bad" data-act="reset-game">⟲ Сбросить игру</button>
      </div>
      <hr style="border:none;border-top:1px solid var(--border);margin:14px 0">
      <h3>Команды</h3>
      <div class="row small" style="margin-bottom:8px">
        <span class="muted">Ловушек на команду:</span>
        <input type="number" id="traps-count" min="0" max="${config.trapCells[1] - config.trapCells[0] + 1}" value="${state.trapsPerTeam ?? 3}" style="width:64px">
        <button data-act="random-traps-all" title="Заново расставить ловушки всем командам">🎲 Расставить всем</button>
      </div>
      ${state.teams.map((t, i) => `<div class="admin-team" data-team="${esc(t.id)}">
        <div class="row">
          <span class="dot" style="background:${esc(t.color)}"></span><b style="flex:1;min-width:0">${esc(t.name)}</b>
          <button class="icon" data-act="team-up" ${i === 0 ? 'disabled' : ''} title="Выше в очереди">↑</button>
          <button class="icon" data-act="team-down" ${i === state.teams.length - 1 ? 'disabled' : ''} title="Ниже в очереди">↓</button>
          <button class="icon" data-act="rename-team" title="Переименовать">✎</button>
          <button class="icon" data-act="remove-team" title="Удалить команду">🗑️</button>
        </div>
        <div class="fields">
          <div><label>Клетка</label><input type="number" min="1" max="${config.boardSize}" name="position" value="${t.position}"></div>
          <div><label>Удвоения</label><input type="number" min="0" max="9" name="doubles" value="${t.doubles}"></div>
        </div>
        <div class="trap-edit">
          <label>⚠️ Ловушки (клетки ${config.trapCells[0]}–${config.trapCells[1]}, видны только вам)</label>
          <div class="row">
            <input name="traps" value="${esc((t.traps || []).join(', '))}" placeholder="нет" style="flex:1">
            <button class="icon" data-act="random-traps" title="Расставить заново случайно">🎲</button>
          </div>
          ${(t.triggeredTraps || []).length ? `<div class="small muted" style="margin-top:4px">Уже сработали и сняты: ${t.triggeredTraps.join(', ')}</div>` : ''}
        </div>
        <div class="row" style="margin-top:6px">
          <button data-act="save-team">💾 Применить</button>
          ${playing && currentTeam()?.id !== t.id ? '<button data-act="give-turn">🎯 Передать ход</button>' : ''}
        </div>
        <div style="margin-top:6px">${t.players.map((id) => state.players[id]).filter(Boolean).map(member).join('') || '<span class="muted small">Нет игроков</span>'}</div>
      </div>`).join('') || '<p class="muted">Команд нет</p>'}
      <form class="row" id="add-team" style="margin-top:10px">
        <input id="add-team-name" placeholder="Название (необязательно)" maxlength="30" style="flex:1">
        <button type="submit">＋ Команда</button>
      </form>
      ${unassigned.length ? `<h3 style="margin-top:14px">Без команды</h3>${unassigned.map(member).join('')}` : ''}`;
  }

  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!state) return; // игра ещё не загружена (например, открыта форма ввода кода)
      if (adminDirty && !focusedInside($('#admin'))) renderAdmin();
      if (!focusedInside($('#team-pick'))) renderTeamPick();
    }, 0);
  });

  // ---------- Обработчики ----------

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.tagName === 'INPUT') return;
    const act = btn.dataset.act;
    const teamEl = btn.closest('[data-team]');
    const teamId = btn.dataset.team || teamEl?.dataset.team;
    const team = state?.teams.find((t) => t.id === teamId);
    const playerId = btn.dataset.player;

    switch (act) {
      case 'roll': return send('roll');
      case 'start': return send('startTimer');
      case 'stop': return send('stopTimer');
      case 'success': return send('resolve', { success: true });
      case 'fail': return send('resolve', { success: false });
      case 'guessed': return send('resolve', { guessed: Number(btn.dataset.n) });
      case 'join': return send('joinTeam', { teamId });
      case 'leave': return send('leaveTeam');
      case 'toggle-board': {
        const on = document.body.classList.toggle('show-board');
        btn.textContent = on ? '🗺️ Скрыть поле' : '🗺️ Показать всё поле';
        if (on) setTimeout(() => $('#board').scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
        return undefined;
      }
      case 'rename-me': {
        const name = prompt('Ваше имя', me()?.name || '');
        if (name) send('rename', { name });
        return undefined;
      }
      // администратор
      case 'copy-invite': return copy(`${location.origin}/join/${state.code}`);
      case 'new-invite':
        if (confirm('Создать новую ссылку? По старой ссылке больше нельзя будет войти.')) send('newInvite');
        return undefined;
      case 'rename-game': {
        const name = prompt('Название игры', state.name);
        if (name) send('renameGame', { name });
        return undefined;
      }
      case 'start-game': return send('startGame');
      case 'skip':
        if (confirm(`Пропустить ход команды «${currentTeam()?.name}»?`)) send('skipTurn');
        return undefined;
      case 'cancel-turn': return send('cancelTurn');
      case 'undo': return send('undo');
      case 'finish-game':
        if (confirm('Завершить игру без победителя?')) send('finishGame');
        return undefined;
      case 'reset-game':
        if (confirm('Сбросить игру? Все фишки вернутся на старт, удвоения восстановятся.')) send('resetGame');
        return undefined;
      case 'team-up': return send('moveTeam', { teamId, direction: -1 });
      case 'team-down': return send('moveTeam', { teamId, direction: 1 });
      case 'rename-team': {
        const name = prompt('Название команды', team?.name || '');
        if (name) send('renameTeam', { teamId, name });
        return undefined;
      }
      case 'remove-team':
        if (confirm(`Удалить команду «${team?.name}»? Игроки останутся без команды.`)) send('removeTeam', { teamId });
        return undefined;
      case 'give-turn': return send('setCurrentTeam', { teamId });
      case 'random-traps': return send('regenerateTraps', { teamId });
      case 'random-traps-all':
        if (confirm('Заново расставить ловушки всем командам?')) send('regenerateTraps', { count: $('#traps-count').value });
        return undefined;
      case 'save-team': {
        const get = (name) => teamEl.querySelector(`[name="${name}"]`).value;
        const res = await send('setTeam', { teamId, position: get('position'), doubles: get('doubles') });
        if (res?.ok) {
          const trapRes = await send('setTraps', { teamId, cells: get('traps') });
          if (!trapRes?.ok) return undefined;
        }
        if (res?.ok) {
          document.activeElement?.blur();
          toast('Сохранено');
        }
        return undefined;
      }
      case 'rename-player': {
        const name = prompt('Имя игрока', state.players[playerId]?.name || '');
        if (name) send('renamePlayer', { playerId, name });
        return undefined;
      }
      case 'remove-player':
        if (confirm(`Удалить игрока «${state.players[playerId]?.name}» из игры?`)) send('removePlayer', { playerId });
        return undefined;
      default: return undefined;
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.dataset.act === 'double') send('setDouble', { on: e.target.checked });
    if (e.target.dataset.assign) {
      send('assignPlayer', { playerId: e.target.dataset.assign, teamId: e.target.value || null }).then(() => e.target.blur());
    }
  });

  document.addEventListener('submit', (e) => {
    if (e.target.id === 'add-team') {
      e.preventDefault();
      send('addTeam', { name: $('#add-team-name').value }).then(() => document.activeElement?.blur());
    }
  });

  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    $('#join-error').textContent = '';
    socket.emit('register', { name: $('#join-name').value }, (res) => {
      if (res?.error) {
        $('#join-error').textContent = res.error;
        return;
      }
      storage(tokenKey, res.token);
      document.activeElement?.blur();
    });
  });

  // ---------- Рисование ----------

  const canvas = $('#canvas');
  const ctx2d = canvas.getContext('2d');
  const COLORS = ['#222222', '#e03131', '#1971c2', '#2f9e44', '#f08c00', '#9c36b5', '#ffffff'];
  let strokes = [];
  let drawTurnId = null;
  let pen = { color: COLORS[0], width: 6 };
  let currentStroke = null;

  function canDraw() {
    const turn = state?.turn;
    if (!turn || turn.category !== 'drawing' || turn.phase === 'result') return false;
    return isAdmin || state.me?.playerId === turn.explainerId;
  }

  function drawStroke(s) {
    if (!s.points.length) return;
    ctx2d.strokeStyle = s.color;
    ctx2d.lineWidth = s.width * (canvas.width / 600);
    ctx2d.lineCap = 'round';
    ctx2d.lineJoin = 'round';
    ctx2d.beginPath();
    const [x0, y0] = s.points[0];
    ctx2d.moveTo(x0 * canvas.width, y0 * canvas.height);
    if (s.points.length === 1) ctx2d.lineTo(x0 * canvas.width + 0.1, y0 * canvas.height);
    for (const [x, y] of s.points.slice(1)) ctx2d.lineTo(x * canvas.width, y * canvas.height);
    ctx2d.stroke();
  }

  function redraw() {
    ctx2d.fillStyle = '#fff';
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    strokes.forEach(drawStroke);
  }

  function renderDrawPanel() {
    const turn = state.turn;
    const visible = Boolean(turn && turn.category === 'drawing' && turn.phase !== 'prepare');
    $('#draw-panel').classList.toggle('hidden', !visible);
    if (!visible) return;
    if (drawTurnId !== turn.id) {
      drawTurnId = turn.id;
      strokes = [];
      redraw();
      socket.emit('draw:sync', (res) => {
        if (res.turnId === drawTurnId) {
          strokes = res.strokes;
          redraw();
        }
      });
    }
    const drawer = canDraw();
    $('#draw-hint').textContent = drawer ? 'Рисуйте! Буквы и цифры нельзя.' : `Рисует ${playerName(turn.explainerId)}`;
    $('#draw-tools').innerHTML = drawer
      ? `${COLORS.map((c) => `<button class="swatch ${pen.color === c ? 'active' : ''}" style="background:${c}" data-color="${c}" title="${c === '#ffffff' ? 'Ластик' : ''}"></button>`).join('')}
        <select id="pen-width"><option value="3">Тонко</option><option value="6">Средне</option><option value="14">Толсто</option><option value="30">Очень толсто</option></select>
        <div class="spacer"></div><button data-draw="clear">🧽 Очистить</button>`
      : '';
    const sel = $('#pen-width');
    if (sel) sel.value = String(pen.width);
  }

  $('#draw-tools').addEventListener('click', (e) => {
    const sw = e.target.closest('[data-color]');
    if (sw) {
      pen.color = sw.dataset.color;
      renderDrawPanel();
    }
    if (e.target.closest('[data-draw="clear"]') && confirm('Очистить рисунок?')) socket.emit('draw:clear');
  });
  $('#draw-tools').addEventListener('change', (e) => {
    if (e.target.id === 'pen-width') pen.width = Number(e.target.value);
  });

  function point(e) {
    const r = canvas.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  }
  function flush(final) {
    if (!currentStroke || currentStroke.points.length === 0) return;
    socket.emit('draw:stroke', currentStroke);
    // Длинные линии отправляем частями, чтобы зрители видели рисунок сразу.
    const last = currentStroke.points[currentStroke.points.length - 1];
    currentStroke = final ? null : { ...currentStroke, points: [last] };
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (!canDraw()) return;
    canvas.setPointerCapture(e.pointerId);
    currentStroke = { color: pen.color, width: pen.width, points: [point(e)] };
    strokes.push({ ...currentStroke, points: currentStroke.points.slice() });
    drawStroke(strokes[strokes.length - 1]);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!currentStroke) return;
    const pt = point(e);
    currentStroke.points.push(pt);
    const local = strokes[strokes.length - 1];
    local.points.push(pt);
    drawStroke({ ...local, points: local.points.slice(-2) });
    if (currentStroke.points.length >= 40) flush(false);
  });
  const endStroke = () => flush(true);
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);

  socket.on('draw:stroke', ({ turnId, stroke }) => {
    if (turnId !== drawTurnId) return;
    strokes.push(stroke);
    drawStroke(stroke);
  });
  socket.on('draw:clear', ({ turnId }) => {
    if (turnId !== drawTurnId) return;
    strokes = [];
    redraw();
  });

  // ---------- Вход по коду ----------

  function showCodeForm(message = '', value = '') {
    document.title = 'Вход в игру — 30 клеток';
    $('#conn').classList.add('hidden'); // к игре ещё не подключаемся — «нет связи» только сбивало бы с толку
    $('#code-error').textContent = message;
    if (value) $('#code-input').value = value;
    show('code');
    $('#code-input').focus();
  }

  // По старой буквенной ссылке переходим на числовой код и переносим сохранённый вход игрока.
  function adoptCode(canonical) {
    const newKey = `token:${canonical}`;
    const saved = storage(tokenKey);
    if (saved && !storage(newKey)) storage(newKey, saved);
    code = canonical;
    tokenKey = newKey;
    history.replaceState(null, '', `/join/${encodeURIComponent(canonical)}`);
  }

  $('#code-input').addEventListener('input', (e) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
    if (digits !== e.target.value) e.target.value = digits;
    $('#code-error').textContent = '';
  });

  $('#code-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = $('#code-input').value.replace(/\D/g, '');
    if (value.length !== 6) {
      $('#code-error').textContent = 'Код игры — 6 цифр';
      return;
    }
    const button = e.target.querySelector('button');
    button.disabled = true;
    try {
      const info = await api('GET', `/api/join/${value}`);
      location.assign(`/join/${encodeURIComponent(info.code)}`);
    } catch (err) {
      $('#code-error').textContent = err.message;
      button.disabled = false;
    }
  });

  // ---------- Старт ----------

  (async () => {
    try {
      config = await api('GET', '/api/config');
    } catch (err) {
      return fatal(err.message);
    }
    if (!isAdmin && !code) return showCodeForm();
    if (code) {
      try {
        const info = await api('GET', `/api/join/${encodeURIComponent(code)}`);
        if (info.code && info.code !== code) adoptCode(info.code);
      } catch (err) {
        return showCodeForm(err.message, /^\d+$/.test(code) ? code : '');
      }
    }
    socket.connect();
    return undefined;
  })();
})();
