'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const G = require('./game');
const store = require('./store');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_STROKES = 3000;
const { version: VERSION } = require('../package.json');
const RELEASES = loadChangelog(path.join(__dirname, '..', 'CHANGELOG.md'));

/** История версий из CHANGELOG.md: заголовки «## 1.0.0 — 2026-09-30», под ними текст и пункты «- …». */
function loadChangelog(file) {
  let text = '';
  try {
    text = require('fs').readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const releases = [];
  for (const line of text.split('\n')) {
    const head = line.match(/^##\s+(\S+)\s*(?:[—–-]\s*(.+))?$/);
    if (head) {
      releases.push({ version: head[1], date: (head[2] || '').trim(), summary: [], changes: [] });
    } else if (releases.length && line.startsWith('- ')) {
      releases[releases.length - 1].changes.push(line.slice(2).trim());
    } else if (releases.length && line.trim()) {
      releases[releases.length - 1].summary.push(line.trim());
    }
  }
  return releases;
}

if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_PASSWORD не задан — используется пароль по умолчанию «admin». Задайте его в переменных окружения!');
}

store.load();

// ---------- Сессии администратора ----------

const sessions = new Map(); // token -> expiresAt
const loginAttempts = new Map(); // ip -> { count, resetAt }

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isAdminCookie(cookieHeader) {
  const token = parseCookies(cookieHeader).adm;
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Логин сравнивается без учёта регистра и пробелов по краям (телефоны часто пишут первую букву заглавной).
function normalizeLogin(value) {
  return String(value ?? '').trim().toLocaleLowerCase('ru-RU');
}

function requireAdmin(req, res, next) {
  if (isAdminCookie(req.headers.cookie)) return next();
  res.status(401).json({ error: 'Требуется вход администратора' });
}

// ---------- HTTP ----------

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  const attempt = loginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (attempt.resetAt < now) Object.assign(attempt, { count: 0, resetAt: now + 15 * 60 * 1000 });
  if (attempt.count >= 10) {
    return res.status(429).json({ error: 'Слишком много попыток. Попробуйте через 15 минут.' });
  }
  const { login, password } = req.body || {};
  const ok = safeEqual(normalizeLogin(login), normalizeLogin(ADMIN_LOGIN)) & safeEqual(password || '', ADMIN_PASSWORD);
  if (!ok) {
    attempt.count += 1;
    loginAttempts.set(ip, attempt);
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, now + SESSION_TTL_MS);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `adm=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).adm;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'adm=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/admin/me', (req, res) => {
  res.json({ admin: isAdminCookie(req.headers.cookie) });
});

function gameSummary(game) {
  const winner = game.teams.find((t) => t.id === game.winnerTeamId);
  return {
    id: game.id,
    code: game.code,
    screenCode: game.screenCode,
    name: game.name,
    status: game.status,
    createdAt: game.createdAt,
    teams: game.teams.map((t) => ({ name: t.name, color: t.color, position: t.position, players: t.players.length })),
    players: Object.keys(game.players).length,
    winner: winner ? winner.name : null,
  };
}

app.get('/api/admin/games', requireAdmin, (req, res) => {
  const list = [...store.games.values()].sort((a, b) => b.createdAt - a.createdAt).map(gameSummary);
  res.json({ games: list });
});

app.post('/api/admin/games', requireAdmin, (req, res) => {
  const game = G.createGame(req.body?.name);
  const teamCount = Math.max(0, Math.min(G.TEAM_COLORS.length, Number(req.body?.teams) || 0));
  for (let i = 0; i < teamCount; i += 1) G.createTeam(game, '');
  store.addGame(game);
  res.json({ game: gameSummary(game) });
});

app.delete('/api/admin/games/:id', requireAdmin, async (req, res) => {
  const game = store.getGame(req.params.id);
  if (!game) return res.status(404).json({ error: 'Игра не найдена' });
  clearTimeout(timers.get(game.id));
  timers.delete(game.id);
  store.deleteGame(game.id);
  io.in(`game:${game.id}`).emit('gone', { message: 'Игра удалена администратором' });
  io.in(`game:${game.id}`).disconnectSockets(true);
  res.json({ ok: true });
});

app.get('/api/admin/cards', requireAdmin, (req, res) => {
  res.json({ cards: store.getCards(), categories: { ...G.CATEGORIES, [G.GUEST_POOL]: G.GUEST_POOL_INFO } });
});

app.put('/api/admin/cards', requireAdmin, (req, res) => {
  try {
    const cards = store.setCards(req.body?.cards);
    // Повторы слов разрешены; список нужен только для подсказок.
    res.json({ cards, duplicates: G.duplicateWords(cards) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/cards/reset', requireAdmin, (req, res) => {
  res.json({ cards: store.resetCards() });
});

app.get('/api/admin/complications', requireAdmin, (req, res) => {
  res.json({ complications: store.getComplications(), categories: G.CATEGORIES });
});

app.put('/api/admin/complications', requireAdmin, (req, res) => {
  res.json({ complications: store.setComplications(req.body?.complications) });
});

app.post('/api/admin/complications/reset', requireAdmin, (req, res) => {
  res.json({ complications: store.resetComplications() });
});

app.get('/api/join/:code', (req, res) => {
  const game = store.findByCode(req.params.code);
  if (!game) return res.status(404).json({ error: 'Игра не найдена. Проверьте ссылку.' });
  res.json({ name: game.name, status: game.status });
});

app.get('/api/screen/:code', (req, res) => {
  const game = store.findByScreenCode(req.params.code);
  if (!game) return res.status(404).json({ error: 'Экран не найден. Проверьте ссылку.' });
  res.json({ name: game.name, status: game.status });
});

// QR-код ссылки-приглашения для общего экрана. Адрес берётся из запроса,
// поэтому экран нужно открывать по тому же адресу, по которому зайдут игроки.
app.get('/api/screen/:code/qr.svg', async (req, res) => {
  const game = store.findByScreenCode(req.params.code);
  if (!game) return res.status(404).end();
  const url = `${req.protocol}://${req.get('host')}/join/${game.code}`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
});

app.get('/api/version', (req, res) => {
  res.json({ version: VERSION, releases: RELEASES });
});

app.get('/api/config', (req, res) => {
  res.json({
    version: VERSION,
    boardSize: G.BOARD_SIZE,
    trapCells: [G.TRAP_MIN_CELL, G.TRAP_MAX_CELL],
    movieCells: G.MOVIE_CELLS,
    maxTeamSize: G.MAX_TEAM_SIZE,
    doublesPerTeam: G.DOUBLES_PER_TEAM,
    categories: G.CATEGORIES,
    guestPool: G.GUEST_POOL_INFO,
    dieFaces: G.DIE_FACES,
  });
});

const sendPage = (file) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, file));
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'icons', 'favicon-32.png')));
app.get('/', sendPage('index.html'));
app.get('/admin', sendPage('admin.html'));
app.get('/admin/game/:id', sendPage('game.html'));
app.get('/join/:code', sendPage('game.html'));
app.get('/screen/:code', sendPage('screen.html'));
app.use(express.static(PUBLIC_DIR, { index: false }));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 256 * 1024 });

// ---------- Таймеры ходов ----------

const timers = new Map();

function syncTimer(game) {
  clearTimeout(timers.get(game.id));
  timers.delete(game.id);
  const turn = game.turn;
  if (game.status !== 'playing' || !turn || turn.phase !== 'timer') return;
  const delay = Math.max(0, turn.endsAt - Date.now());
  timers.set(
    game.id,
    setTimeout(() => {
      timers.delete(game.id);
      if (store.getGame(game.id) !== game) return;
      if (G.expireTimer(game)) {
        G.log(game, '⏰ Время вышло');
        publish(game);
      } else {
        syncTimer(game);
      }
    }, delay + 50),
  );
}

// ---------- Рассылка состояния ----------

function viewFor(game, viewer) {
  const players = {};
  for (const p of Object.values(game.players)) {
    players[p.id] = { id: p.id, name: p.name, teamId: p.teamId, online: onlineCount(game.id, p.id) > 0 };
  }
  let turn = null;
  if (game.turn) {
    const { strokes, ...rest } = game.turn;
    turn = { ...rest, strokeCount: strokes.length };
    // Общий экран видят все, в том числе угадывающие, поэтому карточку на нём не показываем.
    const hideCard = viewer.screen || (!viewer.admin && viewer.playerId && viewer.playerId === game.turn.guesserId);
    if (hideCard) {
      turn.card = null;
      turn.cardHidden = true;
    }
  }
  const lastUndo = game.history[game.history.length - 1];
  return {
    serverNow: Date.now(),
    id: game.id,
    code: game.code,
    screenCode: viewer.admin ? game.screenCode : undefined,
    name: game.name,
    status: game.status,
    // Ловушки видит только администратор.
    teams: viewer.admin ? game.teams : game.teams.map(({ traps, ...team }) => team),
    trapsPerTeam: viewer.admin ? game.trapsPerTeam : undefined,
    players,
    currentTeamIdx: game.currentTeamIdx,
    turnNumber: game.turnNumber,
    turn,
    lastTurn: game.lastTurn || null,
    winnerTeamId: game.winnerTeamId,
    log: game.log.slice(-60),
    cardsLeft: viewer.admin ? G.remainingCards(game, store.getCards()) : undefined,
    undo: viewer.admin && lastUndo ? { label: lastUndo.label, count: game.history.length } : null,
    me: viewer.admin ? { admin: true } : viewer.screen ? { screen: true } : viewer.playerId ? { playerId: viewer.playerId } : null,
  };
}

// gameId -> Map(playerId -> количество подключений)
const online = new Map();
function onlineCount(gameId, playerId) {
  return online.get(gameId)?.get(playerId) || 0;
}
function trackOnline(gameId, playerId, delta) {
  if (!playerId) return;
  if (!online.has(gameId)) online.set(gameId, new Map());
  const map = online.get(gameId);
  const next = (map.get(playerId) || 0) + delta;
  if (next <= 0) map.delete(playerId);
  else map.set(playerId, next);
}

async function publish(game) {
  syncTimer(game);
  store.scheduleSave();
  const sockets = await io.in(`game:${game.id}`).fetchSockets();
  for (const s of sockets) s.emit('state', viewFor(game, s.data));
}

// ---------- Действия ----------

function isActivePlayer(game, playerId) {
  const team = G.currentTeam(game);
  return Boolean(playerId && team && team.players.includes(playerId));
}

const PLAYER_ACTIONS = {
  rename(game, ctx, p) {
    G.renamePlayer(game, ctx.playerId, p.name);
  },
  // Гости только вступают в команды, созданные администратором (addTeam).
  joinTeam(game, ctx, p) {
    const player = game.players[ctx.playerId];
    if (game.status !== 'lobby' && player.teamId) throw new G.GameError('Во время игры команду меняет только администратор');
    G.joinTeam(game, ctx.playerId, p.teamId);
  },
  leaveTeam(game, ctx) {
    if (game.status !== 'lobby') throw new G.GameError('Во время игры команду меняет только администратор');
    G.leaveTeam(game, ctx.playerId);
  },
};

const TURN_ACTIONS = {
  roll(game) {
    G.roll(game, store.getCards(), Math.random, store.getComplications());
  },
  setDouble(game, ctx, p) {
    G.setDouble(game, p.on);
  },
  startTimer(game) {
    G.startTimer(game);
  },
  stopTimer(game) {
    G.stopTimer(game);
  },
  resolve(game, ctx, p) {
    G.resolve(game, { success: p.success, guessed: p.guessed });
  },
};

const ADMIN_ACTIONS = {
  startGame: (game) => G.startGame(game),
  resetGame: (game) => G.resetGame(game),
  undo: (game) => G.undo(game),
  skipTurn: (game) => G.adminSkipTurn(game),
  cancelTurn: (game) => G.adminCancelTurn(game),
  setCurrentTeam: (game, ctx, p) => G.adminSetCurrentTeam(game, p.teamId),
  setTeam: (game, ctx, p) => G.adminSetTeam(game, p.teamId, p),
  moveTeam: (game, ctx, p) => G.adminMoveTeam(game, p.teamId, p.direction),
  setTraps: (game, ctx, p) => G.adminSetTraps(game, p.teamId, p.cells),
  regenerateTraps: (game, ctx, p) => G.adminRegenerateTraps(game, { teamId: p.teamId || null, count: p.count }),
  addTeam: (game, ctx, p) => G.createTeam(game, p.name),
  renameTeam: (game, ctx, p) => G.renameTeam(game, p.teamId, p.name),
  removeTeam: (game, ctx, p) => G.removeTeam(game, p.teamId),
  renamePlayer: (game, ctx, p) => G.renamePlayer(game, p.playerId, p.name),
  removePlayer: (game, ctx, p) => {
    G.removePlayer(game, p.playerId);
    kickPlayer(game, p.playerId);
  },
  assignPlayer: (game, ctx, p) => {
    if (p.teamId) G.joinTeam(game, p.playerId, p.teamId);
    else G.leaveTeam(game, p.playerId);
  },
  renameGame: (game, ctx, p) => {
    const name = String(p.name || '').trim().slice(0, 60);
    if (!name) throw new G.GameError('Укажите название игры');
    game.name = name;
  },
  newInvite: (game) => {
    game.code = G.createGame().code;
  },
  finishGame: (game) => {
    game.status = 'finished';
    game.turn = null;
    G.log(game, 'Администратор завершил игру');
  },
};

async function kickPlayer(game, playerId) {
  const sockets = await io.in(`game:${game.id}`).fetchSockets();
  for (const s of sockets) {
    if (s.data.playerId === playerId) {
      s.emit('gone', { message: 'Администратор удалил вас из игры' });
      s.disconnect(true);
    }
  }
}

function handleAction(game, ctx, payload) {
  const type = payload?.type;
  if (ctx.admin && ADMIN_ACTIONS[type]) return ADMIN_ACTIONS[type](game, ctx, payload);
  if (TURN_ACTIONS[type]) {
    if (!ctx.admin && !isActivePlayer(game, ctx.playerId)) throw new G.GameError('Сейчас ход другой команды');
    return TURN_ACTIONS[type](game, ctx, payload);
  }
  if (PLAYER_ACTIONS[type]) {
    if (!ctx.playerId || !game.players[ctx.playerId]) throw new G.GameError('Сначала введите имя');
    return PLAYER_ACTIONS[type](game, ctx, payload);
  }
  throw new G.GameError('Недоступное действие');
}

// ---------- Сокеты ----------

io.on('connection', (socket) => {
  const auth = socket.handshake.auth || {};
  let game = null;
  const ctx = socket.data;

  if (auth.gameId) {
    if (!isAdminCookie(socket.handshake.headers.cookie)) {
      socket.emit('fatal', { message: 'Требуется вход администратора', login: true });
      return socket.disconnect(true);
    }
    game = store.getGame(auth.gameId);
    ctx.admin = true;
  } else if (auth.screen) {
    game = store.findByScreenCode(String(auth.screen));
    if (game) ctx.screen = true;
  } else if (auth.code) {
    game = store.findByCode(String(auth.code));
    if (game && auth.token) {
      const player = Object.values(game.players).find((p) => p.token === auth.token);
      if (player) ctx.playerId = player.id;
    }
  }
  if (!game) {
    socket.emit('fatal', { message: 'Игра не найдена. Возможно, ссылка устарела.' });
    return socket.disconnect(true);
  }
  const gameId = game.id;
  const currentGame = () => store.getGame(gameId);
  ctx.gameId = gameId;
  socket.join(`game:${gameId}`);
  trackOnline(gameId, ctx.playerId, 1);
  publish(game);

  socket.on('register', (data, ack = () => {}) => {
    const g = currentGame();
    if (!g) return ack({ error: 'Игра не найдена' });
    if (ctx.admin) return ack({ error: 'Администратор уже в игре' });
    try {
      if (ctx.playerId && g.players[ctx.playerId]) {
        G.renamePlayer(g, ctx.playerId, data?.name);
        ack({ ok: true, token: g.players[ctx.playerId].token, playerId: ctx.playerId });
      } else {
        const player = G.addPlayer(g, data?.name);
        ctx.playerId = player.id;
        trackOnline(gameId, player.id, 1);
        ack({ ok: true, token: player.token, playerId: player.id });
      }
      publish(g);
    } catch (err) {
      ack({ error: err instanceof G.GameError ? err.message : 'Ошибка сервера' });
    }
  });

  socket.on('action', (payload, ack = () => {}) => {
    const g = currentGame();
    if (!g) return ack({ error: 'Игра не найдена' });
    try {
      handleAction(g, ctx, payload);
      ack({ ok: true });
      publish(g);
    } catch (err) {
      if (!(err instanceof G.GameError)) console.error(err);
      ack({ error: err instanceof G.GameError ? err.message : 'Ошибка сервера' });
    }
  });

  // Рисование: рисует объясняющий игрок (или администратор), остальные смотрят.
  function canDraw(g) {
    const turn = g?.turn;
    if (!turn || turn.category !== 'drawing' || turn.phase === 'result') return false;
    return ctx.admin || (ctx.playerId && ctx.playerId === turn.explainerId);
  }

  socket.on('draw:stroke', (stroke) => {
    const g = currentGame();
    if (!canDraw(g) || !stroke || !Array.isArray(stroke.points)) return;
    const clean = {
      color: /^#[0-9a-f]{6}$/i.test(stroke.color) ? stroke.color : '#222222',
      width: Math.max(1, Math.min(40, Number(stroke.width) || 4)),
      points: stroke.points
        .slice(0, 500)
        .map((pt) => [Math.max(0, Math.min(1, Number(pt[0]) || 0)), Math.max(0, Math.min(1, Number(pt[1]) || 0))]),
    };
    if (g.turn.strokes.length >= MAX_STROKES) return;
    g.turn.strokes.push(clean);
    socket.to(`game:${gameId}`).emit('draw:stroke', { turnId: g.turn.id, stroke: clean });
    store.scheduleSave();
  });

  socket.on('draw:clear', () => {
    const g = currentGame();
    if (!canDraw(g)) return;
    g.turn.strokes = [];
    io.in(`game:${gameId}`).emit('draw:clear', { turnId: g.turn.id });
    store.scheduleSave();
  });

  socket.on('draw:sync', (ack = () => {}) => {
    const g = currentGame();
    if (typeof ack !== 'function') return;
    ack(g?.turn ? { turnId: g.turn.id, strokes: g.turn.strokes } : { strokes: [] });
  });

  socket.on('disconnect', () => {
    trackOnline(gameId, ctx.playerId, -1);
    const g = currentGame();
    if (g) publish(g);
  });
});

for (const game of store.games.values()) syncTimer(game);

function shutdown() {
  try {
    store.saveNow();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`Сервер запущен (версия ${VERSION}): http://localhost:${PORT}`);
  console.log(`Вход администратора: http://localhost:${PORT}/admin (логин: ${ADMIN_LOGIN})`);
});
