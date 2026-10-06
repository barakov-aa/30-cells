'use strict';

(() => {
  const { esc, api, formatCode } = window.App;
  const $ = (sel) => document.querySelector(sel);
  const screenCode = decodeURIComponent(location.pathname.split('/')[2] || '');

  let config = null;
  let state = null;
  let board = null;
  let clockOffset = 0;
  let seenTurnId = null;
  let rollingUntil = 0;
  let lastPhaseKey = null;
  let soundOn = false;
  let beeped = null;

  const now = () => Date.now() + clockOffset;
  const cat = (key) => config.categories[key];
  const plural = (n, one, few, many) => {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  };
  const playerName = (id) => (id && state.players[id] ? state.players[id].name : '');
  const teamTitle = (t) => `<div class="st-team"><span class="dot" style="background:${esc(t.color)}"></span>${esc(t.name)}</div>`;

  function fatal(message) {
    $('#fatal-text').textContent = message;
    $('#fatal').classList.remove('hidden');
    $('#layout').classList.add('hidden');
  }

  // ---------- Звук и управление экраном ----------

  let audio = null;
  function beep(freq = 880, duration = 0.5) {
    if (!soundOn || !audio) return;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.25, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + duration);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + duration);
  }

  $('#btn-sound').addEventListener('click', () => {
    soundOn = !soundOn;
    if (soundOn && !audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    audio?.resume();
    $('#btn-sound').textContent = soundOn ? '🔊 Звук включён' : '🔇 Включить звук';
    beep(660, 0.15);
  });

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  }
  $('#btn-full').addEventListener('click', toggleFullscreen);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') toggleFullscreen();
  });

  // Кнопки и курсор прячутся, когда мышью не пользуются.
  let idleTimer;
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
  }
  document.addEventListener('mousemove', wake);
  wake();

  // ---------- Соединение ----------

  const socket = io({ autoConnect: false, auth: { screen: screenCode } });
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
    const firstState = !state;
    state = s;
    const turn = s.turn;
    if (turn && turn.id !== seenTurnId) {
      // Анимация броска только для «живого» броска, не при открытии экрана посреди хода.
      if (!firstState && turn.phase === 'prepare') rollingUntil = Date.now() + 1400;
      seenTurnId = turn.id;
    }
    render();
  });

  // ---------- Отрисовка ----------

  function render() {
    document.title = `${state.name} — экран`;
    $('#title').textContent = state.name;
    if (!board) board = window.Board.create($('#board'), config);
    const current = state.status === 'playing' ? state.teams[state.currentTeamIdx] : null;
    board.update(state.teams, { currentTeamId: current?.id, lastTurn: state.lastTurn });
    renderTurn(current);
    renderTeams(current);
    renderWinner();
    renderCanvas();
    renderRules();
  }

  // ---------- Правила на время сбора команд ----------

  let rulesShown = false;
  function renderRules() {
    const lobby = state.status === 'lobby';
    const el = $('#rules');
    el.classList.toggle('hidden', !lobby);
    if (lobby) $('#board').style.visibility = 'hidden';
    if (lobby && !rulesShown) {
      el.innerHTML = `<div class="screen-rules-inner">${window.Rules.html(config)}</div>`;
      fitRules();
    }
    rulesShown = lobby;
  }

  /** Подбирает размер шрифта, чтобы правила поместились на экран без прокрутки. */
  function fitRules() {
    const el = $('#rules');
    const inner = el.querySelector('.screen-rules-inner');
    if (!inner || el.classList.contains('hidden')) return;
    let size = 100;
    inner.style.fontSize = `${size}%`;
    while (inner.scrollHeight > el.clientHeight && size > 45) {
      size -= 5;
      inner.style.fontSize = `${size}%`;
    }
  }
  window.addEventListener('resize', fitRules);

  function dieIcon(turn) {
    if (turn.kind === 'movie') return '🎬';
    if (turn.face === 'random') return '?';
    return cat(turn.category).icon;
  }

  function trapHtml(turn) {
    if (!turn.trap) return '';
    return `<div class="trap-banner">
      <div class="trap-title">⚠️ Ловушка на клетке ${turn.trap.cell}!</div>
      ${turn.trap.text ? `<div class="trap-text">${esc(turn.trap.text)}</div>` : '<div>Усложнений нет — играем как обычно</div>'}
    </div>`;
  }

  function renderTurn(team) {
    const el = $('#turn');
    const turn = state.turn;
    if (state.status === 'lobby') {
      if (el.dataset.lobby === state.code) return;
      el.dataset.lobby = state.code;
      el.innerHTML = `<div class="st-task">Скоро начнём!</div>
        <div class="st-meta">Наведите камеру телефона на QR-код:</div>
        <img class="st-qr" alt="QR-код для входа в игру"
          src="/api/screen/${encodeURIComponent(screenCode)}/qr.svg?v=${encodeURIComponent(state.code)}&origin=${encodeURIComponent(location.origin)}">
        <div class="st-meta">или откройте <b>${esc(location.host)}/join</b> и введите код:</div>
        <div class="st-code">${esc(formatCode(state.code))}</div>`;
      return;
    }
    delete el.dataset.lobby;
    if (!team || state.status === 'finished') {
      el.innerHTML = '<div class="st-task">Игра окончена</div>';
      return;
    }

    if (!turn) {
      const movie = config.movieCells.includes(team.position);
      el.innerHTML = `<div class="st-small">Ход ${state.turnNumber + 1}</div>
        ${teamTitle(team)}
        <div class="die">${movie ? '🎬' : '🎲'}</div>
        <div class="st-meta">${movie ? 'Клетка «Кино» — тянет карточку с фильмами' : 'Бросает кубик…'}</div>`;
      lastPhaseKey = null;
      return;
    }

    const c = cat(turn.category);
    const rolling = Date.now() < rollingUntil;
    const pts = turn.kind === 'movie' ? '1 балл за каждый фильм' : `${c.points} ${plural(c.points, 'балл', 'балла', 'баллов')}`;
    const roles = turn.explainerId
      ? `<div class="st-roles">Объясняет <b>${esc(playerName(turn.explainerId))}</b>${turn.guesserId ? ` · угадывает <b>${esc(playerName(turn.guesserId))}</b>` : ''}</div>`
      : '';
    const double = turn.doubled ? '<div><span class="st-double">✖2 Удвоение</span></div>' : '';

    let body = '';
    if (rolling) {
      body = '<div class="st-meta">Бросок…</div>';
    } else if (turn.phase === 'prepare') {
      body = `${turn.face === 'random' ? `<div class="st-small">Выпал «?» — случайное задание${turn.fromPool ? ', слово про гостей 🎉' : ''}</div>` : ''}
        ${turn.movieFallback ? '<div class="st-small">Карточки «Кино» закончились — бросили кубик</div>' : ''}
        ${turn.substitutedFrom ? `<div class="st-small">В категории «${esc(cat(turn.substitutedFrom).title)}» закончились карточки — задание заменено</div>` : ''}
        <div class="st-task">${esc(c.title)}</div>
        <div class="st-meta">${turn.seconds} сек · ${pts}</div>
        <div class="st-rules">${esc(c.rules)}</div>
        ${trapHtml(turn)}
        ${roles}${double}
        <div class="st-small">Готовятся…</div>`;
    } else if (turn.phase === 'timer') {
      body = `<div class="st-task">${esc(c.title)}</div>
        <div class="timer" id="timer"></div>
        <div class="progress"><div id="timer-bar"></div></div>
        <div class="st-meta">${pts}</div>
        ${trapHtml(turn)}
        ${roles}${double}`;
    } else {
      body = `<div class="st-task">${esc(c.title)}</div>
        <div class="timer">⏰</div>
        <div class="st-meta">${turn.kind === 'movie' ? 'Считаем угаданные фильмы…' : 'Подводим итог…'}</div>
        ${double}`;
    }
    el.innerHTML = `${teamTitle(team)}
      <div class="die ${rolling ? 'rolling-loop' : ''}" id="die">${rolling ? '🎲' : esc(dieIcon(turn))}</div>
      ${body}`;

    if (rolling) animateRoll();
    const key = `${turn.id}:${turn.phase}`;
    if (lastPhaseKey?.endsWith(':timer') && turn.phase === 'result' && lastPhaseKey.startsWith(turn.id)) beep(660, 0.9);
    lastPhaseKey = key;
    tick();
  }

  let rollTimer = null;
  function animateRoll() {
    if (rollTimer) return;
    const faces = ['±', '🗣️', '👐', '🎵', '✏️', '?'];
    let i = 0;
    rollTimer = setInterval(() => {
      const die = document.getElementById('die');
      if (Date.now() >= rollingUntil || !die) {
        clearInterval(rollTimer);
        rollTimer = null;
        render();
        return;
      }
      die.textContent = faces[i % faces.length];
      i += 1;
    }, 110);
  }

  function tick() {
    const turn = state?.turn;
    const el = document.getElementById('timer');
    if (!turn || turn.phase !== 'timer' || !el) return;
    const left = Math.max(0, turn.endsAt - now());
    const sec = Math.ceil(left / 1000);
    el.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    el.classList.toggle('warn', sec <= 10);
    const bar = document.getElementById('timer-bar');
    if (bar) bar.style.width = `${(left / (turn.seconds * 1000)) * 100}%`;
    if (sec <= 3 && sec > 0 && beeped !== `${turn.id}:${sec}`) {
      beeped = `${turn.id}:${sec}`;
      beep(520, 0.15);
    }
  }
  setInterval(tick, 200);

  function renderTeams(current) {
    const sorted = state.teams.slice().sort((a, b) => b.position - a.position);
    $('#teams').innerHTML = sorted.map((t, i) => {
      const chips = Array.from({ length: Math.max(config.doublesPerTeam, t.doubles) }, (_, k) =>
        `<span class="chip ${k < t.doubles ? '' : 'used'}">×2</span>`).join('');
      const players = t.players.map(playerName).filter(Boolean).join(', ');
      return `<tr class="${current?.id === t.id ? 'current' : ''}">
        <td class="t-place">${i + 1}</td>
        <td class="t-name"><span class="dot" style="background:${esc(t.color)}"></span>${esc(t.name)}${state.winnerTeamId === t.id ? ' 🏆' : ''}
          <div class="t-players">${esc(players)}</div>
          <span class="doubles">${chips}</span></td>
        <td class="t-pos">${t.position}<small>клетка</small></td>
      </tr>`;
    }).join('') || '<tr><td class="muted">Команд пока нет</td></tr>';
  }

  let winnerShownFor = null;
  function renderWinner() {
    const el = $('#winner');
    const winner = state.teams.find((t) => t.id === state.winnerTeamId);
    if (!winner) {
      el.classList.add('hidden');
      winnerShownFor = null;
      return;
    }
    if (winnerShownFor === winner.id) return;
    winnerShownFor = winner.id;
    el.innerHTML = `<div class="winner-banner"><div class="big">🏆 ${esc(winner.name)}</div>Команда первой дошла до финиша!</div>`;
    // Даём досмотреть, как фишка доходит до финиша.
    const show = () => {
      if (state.winnerTeamId !== winner.id) return;
      if (board.isAnimating()) setTimeout(show, 300);
      else {
        el.classList.remove('hidden');
        beep(880, 1.2);
      }
    };
    setTimeout(show, 300);
  }
  $('#winner').addEventListener('click', () => $('#winner').classList.add('hidden'));

  // ---------- Рисунок (только просмотр) ----------

  const canvas = $('#canvas');
  const ctx2d = canvas.getContext('2d');
  let strokes = [];
  let drawTurnId = null;

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

  function renderCanvas() {
    const turn = state.turn;
    const visible = Boolean(turn && turn.category === 'drawing' && turn.phase !== 'prepare');
    $('#canvas-wrap').classList.toggle('hidden', !visible);
    $('#board').style.visibility = visible || state.status === 'lobby' ? 'hidden' : '';
    if (!visible) return;
    $('#canvas-title').textContent = `✏️ Рисует ${playerName(turn.explainerId) || 'объясняющий'}`;
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
  }

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

  // ---------- Старт ----------

  (async () => {
    try {
      config = await api('GET', '/api/config');
      await api('GET', `/api/screen/${encodeURIComponent(screenCode)}`);
    } catch (err) {
      fatal(err.message);
      return;
    }
    socket.connect();
  })();
})();
