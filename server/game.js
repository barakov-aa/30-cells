'use strict';

/**
 * Чистая игровая логика. Функции меняют объект игры и бросают GameError
 * с понятным пользователю сообщением, если действие недопустимо.
 * Сервер отвечает только за авторизацию, рассылку состояния и таймеры.
 */

const crypto = require('crypto');

const BOARD_SIZE = 30;
const START_CELL = 1;
const MOVIE_CELLS = [10, 21];
const MAX_TEAM_SIZE = 2;
const DOUBLES_PER_TEAM = 3;
const MOVIE_TITLES_PER_CARD = 5;
const TRAP_MIN_CELL = 10;
const TRAP_MAX_CELL = 29;
const DEFAULT_TRAPS_PER_TEAM = 3;
const HISTORY_LIMIT = 50;
const LOG_LIMIT = 200;

const CATEGORIES = {
  yesno: {
    title: 'Да / Нет',
    icon: '±',
    seconds: 90,
    points: 3,
    rules: 'Угадайте персонажа, задавая вопросы. Загадывающий отвечает только «Да» или «Нет».',
  },
  talk: {
    title: 'Объяснить словами',
    icon: '🗣️',
    seconds: 30,
    points: 1,
    rules: 'Объясните слово на карточке словами, не называя его и однокоренные слова.',
  },
  gestures: {
    title: 'Жестами',
    icon: '👐',
    seconds: 60,
    points: 2,
    rules: 'Покажите слово жестами. Говорить и издавать звуки нельзя.',
  },
  music: {
    title: 'Песни',
    icon: '🎵',
    seconds: 30,
    points: 1,
    rules: 'Объясните оба слова на карточке, напевая песни, в которых они встречаются.',
  },
  drawing: {
    title: 'Рисование',
    icon: '✏️',
    seconds: 60,
    points: 2,
    rules: 'Нарисуйте слово или выражение. Буквы и цифры рисовать нельзя.',
  },
  movies: {
    title: 'Кино',
    icon: '🎬',
    seconds: 60,
    points: 1,
    rules: 'На карточке 5 фильмов, сериалов или мультфильмов. 1 балл за каждый угаданный. Удвоение не действует.',
  },
};

const TASK_CATEGORIES = ['yesno', 'talk', 'gestures', 'music', 'drawing'];
// На грани «?» играют только эти задания (время и баллы — как в соответствующей категории).
const RANDOM_TASKS = ['yesno', 'talk', 'gestures'];

// Отдельный пул слов для грани «?» (про гостей игры). Случайно выбирается только задание.
const GUEST_POOL = 'random';
const GUEST_POOL_INFO = {
  title: '«?» — про гостей',
  icon: '?',
  rules: 'Слова и выражения про гостей игры. Выпадают только на грани «?»; задание к ним (Да / Нет, словами или жестами) выбирается случайно.',
};

const DIE_FACES = ['yesno', 'talk', 'gestures', 'music', 'drawing', 'random'];

const TEAM_COLORS = [
  { hex: '#e53935', name: 'Красные' },
  { hex: '#1e88e5', name: 'Синие' },
  { hex: '#43a047', name: 'Зелёные' },
  { hex: '#fdd835', name: 'Жёлтые' },
  { hex: '#8e24aa', name: 'Фиолетовые' },
  { hex: '#fb8c00', name: 'Оранжевые' },
  { hex: '#00acc1', name: 'Бирюзовые' },
  { hex: '#d81b60', name: 'Розовые' },
  { hex: '#6d4c41', name: 'Коричневые' },
  { hex: '#546e7a', name: 'Серые' },
];

class GameError extends Error {}

function fail(message) {
  throw new GameError(message);
}

function newId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

function newCode() {
  // Короткий код приглашения без похожих символов.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  const bytes = crypto.randomBytes(8);
  for (const b of bytes) code += alphabet[b % alphabet.length];
  return code;
}

function clampCell(n) {
  return Math.max(START_CELL, Math.min(BOARD_SIZE, Math.round(n)));
}

function pick(list, rng) {
  return list[Math.floor(rng() * list.length)];
}

function log(game, text) {
  game.log.push({ ts: Date.now(), text });
  if (game.log.length > LOG_LIMIT) game.log.splice(0, game.log.length - LOG_LIMIT);
}

function createGame(name) {
  const title = String(name || '').trim().slice(0, 60) || 'Новая игра';
  return {
    id: newId(),
    code: newCode(),
    screenCode: newCode(),
    name: title,
    createdAt: Date.now(),
    status: 'lobby', // lobby | playing | finished
    teams: [],
    players: {},
    currentTeamIdx: 0,
    turnNumber: 0,
    turn: null,
    winnerTeamId: null,
    usedCardKeys: [],
    trapsPerTeam: DEFAULT_TRAPS_PER_TEAM,
    usedComplications: [],
    history: [],
    log: [],
  };
}

// ---------- Игроки и команды ----------

function findTeam(game, teamId) {
  const team = game.teams.find((t) => t.id === teamId);
  if (!team) fail('Команда не найдена');
  return team;
}

function findPlayer(game, playerId) {
  const player = game.players[playerId];
  if (!player) fail('Игрок не найден');
  return player;
}

function cleanName(name, what, max = 30) {
  const value = String(name || '').replace(/\s+/g, ' ').trim().slice(0, max);
  if (!value) fail(`Укажите ${what}`);
  return value;
}

function addPlayer(game, name) {
  const player = {
    id: newId(),
    token: newId(16),
    name: cleanName(name, 'имя'),
    teamId: null,
    joinedAt: Date.now(),
  };
  game.players[player.id] = player;
  log(game, `${player.name} присоединился(-ась) к игре`);
  return player;
}

function renamePlayer(game, playerId, name) {
  const player = findPlayer(game, playerId);
  player.name = cleanName(name, 'имя');
}

function nextColor(game) {
  const used = new Set(game.teams.map((t) => t.color));
  return TEAM_COLORS.find((c) => !used.has(c.hex)) || TEAM_COLORS[game.teams.length % TEAM_COLORS.length];
}

function createTeam(game, name) {
  if (game.teams.length >= TEAM_COLORS.length) fail(`Максимум ${TEAM_COLORS.length} команд`);
  const color = nextColor(game);
  const team = {
    id: newId(),
    name: String(name || '').replace(/\s+/g, ' ').trim().slice(0, 30) || color.name,
    color: color.hex,
    colorName: color.name,
    players: [],
    position: START_CELL,
    doubles: DOUBLES_PER_TEAM,
    turnsTaken: 0,
    traps: [],
    triggeredTraps: [],
  };
  team.traps = randomTraps(trapsPerTeam(game));
  game.teams.push(team);
  log(game, `Создана команда «${team.name}»`);
  return team;
}

function renameTeam(game, teamId, name) {
  const team = findTeam(game, teamId);
  team.name = cleanName(name, 'название команды');
}

function detachPlayer(game, player) {
  if (!player.teamId) return;
  const team = game.teams.find((t) => t.id === player.teamId);
  if (team) team.players = team.players.filter((id) => id !== player.id);
  player.teamId = null;
}

function joinTeam(game, playerId, teamId) {
  const player = findPlayer(game, playerId);
  const team = findTeam(game, teamId);
  if (player.teamId === team.id) return team;
  if (team.players.length >= MAX_TEAM_SIZE) fail('В команде уже 2 игрока');
  if (game.turn && player.teamId && game.teams[game.currentTeamIdx]?.id === player.teamId) {
    fail('Нельзя сменить команду во время её хода');
  }
  detachPlayer(game, player);
  team.players.push(player.id);
  player.teamId = team.id;
  log(game, `${player.name} в команде «${team.name}»`);
  return team;
}

function leaveTeam(game, playerId) {
  const player = findPlayer(game, playerId);
  detachPlayer(game, player);
}

function removePlayer(game, playerId) {
  const player = findPlayer(game, playerId);
  detachPlayer(game, player);
  delete game.players[playerId];
  log(game, `${player.name} удалён(а) из игры`);
}

function removeTeam(game, teamId) {
  const idx = game.teams.findIndex((t) => t.id === teamId);
  if (idx === -1) fail('Команда не найдена');
  const [team] = game.teams.splice(idx, 1);
  for (const pid of team.players) {
    if (game.players[pid]) game.players[pid].teamId = null;
  }
  if (game.teams.length === 0) {
    game.currentTeamIdx = 0;
    game.turn = null;
  } else if (idx < game.currentTeamIdx) {
    game.currentTeamIdx -= 1;
  } else if (idx === game.currentTeamIdx) {
    game.turn = null;
    game.currentTeamIdx %= game.teams.length;
  }
  log(game, `Команда «${team.name}» удалена`);
}

// ---------- История (отмена) ----------

// В снимок попадают только игровые показатели: состав команд и игроки
// не откатываются, чтобы отмена не «выкидывала» только что подключившихся.
function snapshot(game, label) {
  const state = {
    status: game.status,
    teams: game.teams.map((t) => ({ id: t.id, position: t.position, doubles: t.doubles, turnsTaken: t.turnsTaken })),
    currentTeamId: currentTeam(game)?.id || null,
    turnNumber: game.turnNumber,
    turn: game.turn,
    winnerTeamId: game.winnerTeamId,
  };
  game.history.push({ label, ts: Date.now(), state: JSON.parse(JSON.stringify(state)) });
  if (game.history.length > HISTORY_LIMIT) game.history.splice(0, game.history.length - HISTORY_LIMIT);
}

function undo(game) {
  const entry = game.history.pop();
  if (!entry) fail('Нечего отменять');
  const { state } = entry;
  for (const saved of state.teams) {
    const team = game.teams.find((t) => t.id === saved.id);
    if (team) Object.assign(team, saved);
  }
  const idx = game.teams.findIndex((t) => t.id === state.currentTeamId);
  game.currentTeamIdx = idx === -1 ? 0 : idx;
  game.status = state.status;
  game.turnNumber = state.turnNumber;
  game.turn = state.turn && game.teams.some((t) => t.id === state.turn.teamId) ? state.turn : null;
  game.winnerTeamId = state.winnerTeamId;
  game.lastTurn = null;
  log(game, `Администратор отменил: ${entry.label}`);
  return entry;
}

// ---------- Ход игры ----------

function currentTeam(game) {
  return game.teams[game.currentTeamIdx] || null;
}

function isMovieCell(cell) {
  return MOVIE_CELLS.includes(cell);
}

function startGame(game) {
  if (game.status === 'playing') fail('Игра уже идёт');
  if (game.teams.length === 0) fail('Нужна хотя бы одна команда');
  snapshot(game, 'старт игры');
  game.status = 'playing';
  game.winnerTeamId = null;
  game.currentTeamIdx = 0;
  game.turn = null;
  game.turnNumber = 0;
  ensureTraps(game);
  const incomplete = game.teams.filter((t) => t.players.length < MAX_TEAM_SIZE);
  log(game, 'Игра началась!');
  if (incomplete.length) {
    log(game, `Внимание: неполные команды — ${incomplete.map((t) => t.name).join(', ')}`);
  }
}

function resetGame(game) {
  snapshot(game, 'сброс игры');
  for (const team of game.teams) {
    team.position = START_CELL;
    team.doubles = DOUBLES_PER_TEAM;
    team.turnsTaken = 0;
    team.traps = randomTraps(trapsPerTeam(game));
    team.triggeredTraps = [];
  }
  game.status = 'lobby';
  game.turn = null;
  game.currentTeamIdx = 0;
  game.turnNumber = 0;
  game.winnerTeamId = null;
  delete game.usedCards;
  delete game.usedWords;
  game.usedCardKeys = [];
  game.usedComplications = [];
  log(game, 'Игра сброшена, все фишки на старте, ловушки расставлены заново');
}

function requirePlaying(game) {
  if (game.status !== 'playing') fail(game.status === 'finished' ? 'Игра окончена' : 'Игра ещё не началась');
  if (!currentTeam(game)) fail('Нет команд');
}

// ---------- Ловушки ----------
// У каждой команды свои скрытые клетки-ловушки (видны только администратору).
// Если команда начинает ход с такой клетки, к заданию добавляется усложнение
// для выпавшей категории. На очки усложнение не влияет.

function trapsPerTeam(game) {
  const n = Number(game.trapsPerTeam ?? DEFAULT_TRAPS_PER_TEAM);
  return Math.max(0, Math.min(TRAP_MAX_CELL - TRAP_MIN_CELL + 1, Math.round(n) || 0));
}

function randomTraps(count, rng = Math.random) {
  const cells = [];
  for (let c = TRAP_MIN_CELL; c <= TRAP_MAX_CELL; c += 1) cells.push(c);
  for (let i = cells.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return cells.slice(0, count).sort((a, b) => a - b);
}

/** Для игр и команд, созданных до появления ловушек. */
function ensureTraps(game) {
  if (game.trapsPerTeam === undefined) game.trapsPerTeam = DEFAULT_TRAPS_PER_TEAM;
  if (!game.usedComplications) game.usedComplications = [];
  for (const team of game.teams) {
    if (!Array.isArray(team.traps)) team.traps = randomTraps(trapsPerTeam(game));
    if (!Array.isArray(team.triggeredTraps)) team.triggeredTraps = [];
    delete team.score; // до 1.2.0 у команд были отдельные очки
  }
  for (const entry of game.history || []) {
    for (const saved of entry.state?.teams || []) delete saved.score;
  }
}

function parseTrapCells(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[^0-9]+/);
  const cells = new Set();
  for (const item of list) {
    if (item === '' || item === null || item === undefined) continue;
    const n = Number(item);
    if (!Number.isInteger(n) || n < TRAP_MIN_CELL || n > TRAP_MAX_CELL) {
      fail(`Ловушки можно ставить только на клетки ${TRAP_MIN_CELL}–${TRAP_MAX_CELL}`);
    }
    cells.add(n);
  }
  return [...cells].sort((a, b) => a - b);
}

function adminSetTraps(game, teamId, cells) {
  const team = findTeam(game, teamId);
  team.traps = parseTrapCells(cells);
}

function adminRegenerateTraps(game, { teamId = null, count } = {}, rng = Math.random) {
  if (count !== undefined && count !== null && count !== '') {
    const n = Math.round(Number(count));
    if (Number.isNaN(n) || n < 0 || n > TRAP_MAX_CELL - TRAP_MIN_CELL + 1) {
      fail(`Количество ловушек — от 0 до ${TRAP_MAX_CELL - TRAP_MIN_CELL + 1}`);
    }
    game.trapsPerTeam = n;
  }
  const teams = teamId ? [findTeam(game, teamId)] : game.teams;
  for (const team of teams) {
    team.traps = randomTraps(trapsPerTeam(game), rng);
    team.triggeredTraps = [];
  }
}

/** Усложнение для категории: сначала те, что ещё не выпадали в этой игре. */
function pickComplication(game, category, complications, rng) {
  const list = (complications?.[category] || []).map((s) => String(s).trim()).filter(Boolean);
  if (list.length === 0) return null;
  const used = new Set(game.usedComplications || []);
  const fresh = list.filter((c) => !used.has(`${category}:${normalizeWord(c)}`));
  const text = pick(fresh.length ? fresh : list, rng);
  game.usedComplications = [...(game.usedComplications || []), `${category}:${normalizeWord(text)}`];
  return text;
}

// ---------- Карточки: каждая карточка выпадает в игре не больше одного раза ----------
// Одинаковые слова на разных карточках (в том числе в разных категориях) разрешены.

/** Нормализованная форма слова для сравнения: без регистра, «ё», кавычек и лишних пробелов. */
function normalizeWord(text) {
  return String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'“”„.,!?()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Слова карточки: у «Песен» их два, у «Кино» — пять названий, у остальных — одно. */
function cardWords(category, card) {
  const items = Array.isArray(card) ? card : category === 'music' ? String(card).split('/') : [card];
  return items.map(normalizeWord).filter(Boolean);
}

/** Ключ карточки: категория + её слова без учёта регистра и «ё». Одинаковые строки колоды — одна карточка. */
function cardKey(category, card) {
  return `${category}:${cardWords(category, card).join('|')}`;
}

function usedCardSet(game, cards) {
  if (!game.usedCardKeys) {
    // Игры прошлых версий хранили использованные слова (usedWords) или номера карточек (usedCards).
    // Переводим их в ключи: карточка считается показанной, если все её слова уже были.
    let words = game.usedWords;
    if (!words) {
      words = [];
      for (const [category, indices] of Object.entries(game.usedCards || {})) {
        for (const i of indices) {
          const card = cards[category]?.[i];
          if (card !== undefined) words.push(...cardWords(category, card));
        }
      }
    }
    const wordSet = new Set(words);
    game.usedCardKeys = [];
    for (const [category, list] of Object.entries(cards)) {
      for (const card of list) {
        const w = cardWords(category, card);
        if (w.length && w.every((x) => wordSet.has(x))) game.usedCardKeys.push(cardKey(category, card));
      }
    }
    delete game.usedWords;
  }
  return new Set(game.usedCardKeys);
}

/** Карточки категории, которые ещё не выпадали в этой игре. */
function availableCards(game, category, cards) {
  const used = usedCardSet(game, cards);
  const seen = new Set();
  return (cards[category] || []).filter((card) => {
    if (cardWords(category, card).length === 0) return false;
    const key = cardKey(category, card);
    if (used.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function remainingCards(game, cards) {
  const result = {};
  for (const category of [...Object.keys(CATEGORIES), GUEST_POOL]) result[category] = availableCards(game, category, cards).length;
  return result;
}

/** Слова, которые встречаются больше чем на одной карточке (во всех колодах вместе). */
function duplicateWords(cards) {
  const count = new Map();
  for (const [category, list] of Object.entries(cards)) {
    for (const card of list) {
      for (const word of new Set(cardWords(category, card))) count.set(word, (count.get(word) || 0) + 1);
    }
  }
  return [...count].filter(([, n]) => n > 1).map(([word]) => word);
}

function drawCard(game, category, cards, rng) {
  const free = availableCards(game, category, cards);
  if (free.length === 0) return null;
  const card = pick(free, rng);
  game.usedCardKeys.push(cardKey(category, card));
  return Array.isArray(card) ? card.slice() : card;
}

function teamRoles(game, team) {
  const players = team.players.filter((id) => game.players[id]);
  if (players.length === 0) return { explainerId: null, guesserId: null };
  const explainerId = players[team.turnsTaken % players.length];
  const guesserId = players.find((id) => id !== explainerId) || null;
  return { explainerId, guesserId };
}

/** Бросок кубика или вытягивание карточки «Кино» на клетках 10 и 21. */
function roll(game, cards, rng = Math.random, complications = {}) {
  requirePlaying(game);
  if (game.turn) fail('Ход уже начат');
  ensureTraps(game);
  const team = currentTeam(game);
  const has = (category) => availableCards(game, category, cards).length > 0;
  // На клетке «Кино» без оставшихся карточек команда бросает кубик как обычно.
  const movieFallback = isMovieCell(team.position) && !has('movies');
  const movie = isMovieCell(team.position) && !movieFallback;
  let face = null;
  let category;
  let substitutedFrom = null;
  let fromPool = false;
  let poolFallback = false;
  if (movie) {
    category = 'movies';
  } else {
    face = pick(DIE_FACES, rng);
    category = face === 'random' ? pick(RANDOM_TASKS, rng) : face;
    if (face === 'random' && has(GUEST_POOL)) {
      fromPool = true;
    } else if (face === 'random' && (cards[GUEST_POOL] || []).length > 0) {
      // Пул «?» заполнен, но слова закончились — берём карточку из обычной колоды задания.
      poolFallback = true;
    }
    if (!fromPool && !has(category)) {
      // «?» заменяется только на задания, допустимые для «?».
      const alternatives = (face === 'random' ? RANDOM_TASKS : TASK_CATEGORIES).filter(has);
      if (alternatives.length === 0) {
        fail('Все карточки заданий в этой игре уже использованы. Добавьте новые на вкладке «Карточки» в панели администратора.');
      }
      substitutedFrom = category;
      category = pick(alternatives, rng);
    }
  }
  // Слово из пула «?» — одно, в формате обычной карточки.
  const card = drawCard(game, fromPool ? GUEST_POOL : category, cards, rng);
  const roles = teamRoles(game, team);
  const onTrap = team.traps.includes(team.position);
  const trap = onTrap ? { cell: team.position, text: pickComplication(game, category, complications, rng) } : null;
  if (trap) {
    // Ловушка срабатывает один раз и снимается с поля, чем бы ни закончился ход.
    team.traps = team.traps.filter((c) => c !== trap.cell);
    team.triggeredTraps = [...(team.triggeredTraps || []), trap.cell];
  }
  game.turn = {
    id: newId(),
    teamId: team.id,
    kind: movie ? 'movie' : 'die',
    face,
    category,
    card,
    doubled: false,
    phase: 'prepare', // prepare -> timer -> result
    seconds: CATEGORIES[category].seconds,
    endsAt: null,
    explainerId: roles.explainerId,
    guesserId: roles.guesserId,
    strokes: [],
    substitutedFrom,
    movieFallback,
    fromPool,
    poolFallback,
    trap,
  };
  if (movieFallback) {
    log(game, `Карточки «Кино» закончились — «${team.name}» бросает кубик`);
  }
  if (substitutedFrom) {
    log(game, `В категории «${CATEGORIES[substitutedFrom].title}» закончились карточки — задание заменено на «${CATEGORIES[category].title}»`);
  }
  if (movie) {
    log(game, `«${team.name}» на клетке ${team.position} — тянет карточку «Кино»`);
  } else if (face === 'random') {
    log(game, `«${team.name}» бросает кубик: «?» → ${CATEGORIES[category].title}${fromPool ? ' (слово про гостей)' : ''}`);
  } else {
    log(game, `«${team.name}» бросает кубик: ${CATEGORIES[category].title}`);
  }
  if (trap) {
    log(game, trap.text
      ? `⚠️ «${team.name}» попали в ловушку на клетке ${trap.cell}! Усложнение: ${trap.text}`
      : `⚠️ «${team.name}» попали в ловушку на клетке ${trap.cell}, но усложнений для этой категории нет`);
  }
  return game.turn;
}

function requirePhase(game, phase) {
  requirePlaying(game);
  if (!game.turn) fail('Сначала бросьте кубик');
  if (game.turn.phase !== phase) fail('Сейчас это действие недоступно');
}

function setDouble(game, on) {
  requirePhase(game, 'prepare');
  const turn = game.turn;
  if (turn.kind === 'movie') fail('Удвоение не действует на карточках «Кино»');
  const team = findTeam(game, turn.teamId);
  if (on && team.doubles <= 0) fail('Фишки «Удвоение» закончились');
  turn.doubled = Boolean(on);
}

function startTimer(game, now = Date.now()) {
  requirePhase(game, 'prepare');
  const turn = game.turn;
  const team = findTeam(game, turn.teamId);
  if (turn.doubled) {
    if (team.doubles <= 0) fail('Фишки «Удвоение» закончились');
    team.doubles -= 1;
    log(game, `«${team.name}» использует фишку «Удвоение» (осталось ${team.doubles})`);
  }
  turn.phase = 'timer';
  turn.startedAt = now;
  turn.endsAt = now + turn.seconds * 1000;
}

function stopTimer(game) {
  requirePhase(game, 'timer');
  game.turn.phase = 'result';
  game.turn.stoppedAt = Date.now();
}

function expireTimer(game, now = Date.now()) {
  if (game.status !== 'playing' || !game.turn || game.turn.phase !== 'timer') return false;
  if (game.turn.endsAt > now) return false;
  game.turn.phase = 'result';
  game.turn.stoppedAt = now;
  return true;
}

/** Подсчёт перемещения за ход. Возвращает изменение позиции и счёта. */
function computeDelta(turn, result) {
  const cat = CATEGORIES[turn.category];
  if (turn.kind === 'movie') {
    const guessed = Math.max(0, Math.min(MOVIE_TITLES_PER_CARD, Math.floor(Number(result.guessed) || 0)));
    return { delta: guessed * cat.points, guessed, success: guessed > 0 };
  }
  const success = Boolean(result.success);
  const base = cat.points;
  if (turn.doubled) return { delta: success ? base * 2 : -base * 2, success };
  return { delta: success ? base : 0, success };
}

function advanceTurn(game) {
  const team = currentTeam(game);
  if (team) team.turnsTaken += 1;
  game.turn = null;
  game.turnNumber += 1;
  if (game.teams.length) game.currentTeamIdx = (game.currentTeamIdx + 1) % game.teams.length;
}

function resolve(game, result) {
  requirePhase(game, 'result');
  const turn = game.turn;
  const team = findTeam(game, turn.teamId);
  snapshot(game, `ход команды «${team.name}»`);
  const { delta, success, guessed } = computeDelta(turn, result || {});
  const from = team.position;
  team.position = clampCell(from + delta);

  const cat = CATEGORIES[turn.category];
  let text;
  if (turn.kind === 'movie') {
    text = `«${team.name}» угадали ${guessed} из ${MOVIE_TITLES_PER_CARD}: +${delta}`;
  } else if (success) {
    text = `«${team.name}» справились (${cat.title})${turn.doubled ? ' с удвоением' : ''}: +${delta}`;
  } else if (turn.doubled) {
    text = `«${team.name}» не справились с удвоением: ${delta}`;
  } else {
    text = `«${team.name}» не справились (${cat.title}): 0`;
  }
  log(game, `${text} — клетка ${from} → ${team.position}`);

  const lastTurn = {
    id: turn.id,
    teamId: team.id,
    delta,
    from,
    to: team.position,
    success,
    guessed,
    kind: turn.kind,
    category: turn.category,
    doubled: turn.doubled,
  };
  if (team.position >= BOARD_SIZE) {
    game.status = 'finished';
    game.winnerTeamId = team.id;
    game.turn = null;
    team.turnsTaken += 1;
    log(game, `🏆 Команда «${team.name}» дошла до финиша и победила!`);
  } else {
    advanceTurn(game);
  }
  game.lastTurn = lastTurn;
  return lastTurn;
}

// ---------- Управление администратора ----------

function adminSetTeam(game, teamId, fields) {
  const team = findTeam(game, teamId);
  snapshot(game, `правка команды «${team.name}»`);
  const changes = [];
  if (fields.position !== undefined && fields.position !== null && fields.position !== '') {
    const pos = clampCell(Number(fields.position));
    if (Number.isNaN(pos)) fail('Неверная клетка');
    if (pos !== team.position) changes.push(`клетка ${team.position} → ${pos}`);
    team.position = pos;
  }
  if (fields.doubles !== undefined && fields.doubles !== null && fields.doubles !== '') {
    const doubles = Math.max(0, Math.min(9, Math.round(Number(fields.doubles))));
    if (Number.isNaN(doubles)) fail('Неверное количество фишек');
    if (doubles !== team.doubles) changes.push(`удвоения ${team.doubles} → ${doubles}`);
    team.doubles = doubles;
  }
  if (changes.length === 0) {
    game.history.pop();
    return;
  }
  log(game, `Администратор: «${team.name}» — ${changes.join(', ')}`);
  if (game.status === 'playing' && team.position >= BOARD_SIZE) {
    game.status = 'finished';
    game.winnerTeamId = team.id;
    game.turn = null;
    log(game, `🏆 Команда «${team.name}» дошла до финиша и победила!`);
  } else if (game.status === 'finished' && game.winnerTeamId === team.id && team.position < BOARD_SIZE) {
    game.status = 'playing';
    game.winnerTeamId = null;
    log(game, 'Победа отменена, игра продолжается');
  }
}

function adminSetCurrentTeam(game, teamId) {
  const idx = game.teams.findIndex((t) => t.id === teamId);
  if (idx === -1) fail('Команда не найдена');
  snapshot(game, 'смена очереди хода');
  game.currentTeamIdx = idx;
  game.turn = null;
  log(game, `Администратор передал ход команде «${game.teams[idx].name}»`);
}

function adminSkipTurn(game) {
  requirePlaying(game);
  const team = currentTeam(game);
  snapshot(game, `пропуск хода «${team.name}»`);
  advanceTurn(game);
  log(game, `Администратор пропустил ход команды «${team.name}»`);
}

function adminCancelTurn(game) {
  requirePlaying(game);
  if (!game.turn) fail('Ход ещё не начат');
  snapshot(game, 'отмена броска');
  const team = findTeam(game, game.turn.teamId);
  if (game.turn.doubled && game.turn.phase !== 'prepare') team.doubles += 1;
  // Бросок отменён — снятая этим броском ловушка возвращается на поле.
  const trapCell = game.turn.trap?.cell;
  if (trapCell && !team.traps.includes(trapCell)) {
    team.traps = [...team.traps, trapCell].sort((a, b) => a - b);
    const i = (team.triggeredTraps || []).lastIndexOf(trapCell);
    if (i !== -1) team.triggeredTraps.splice(i, 1);
  }
  game.turn = null;
  log(game, `Администратор отменил бросок команды «${team.name}», можно бросать заново`);
}

function adminMoveTeam(game, teamId, direction) {
  const idx = game.teams.findIndex((t) => t.id === teamId);
  if (idx === -1) fail('Команда не найдена');
  const target = idx + (direction < 0 ? -1 : 1);
  if (target < 0 || target >= game.teams.length) return;
  const current = currentTeam(game);
  [game.teams[idx], game.teams[target]] = [game.teams[target], game.teams[idx]];
  if (current) game.currentTeamIdx = game.teams.indexOf(current);
}

module.exports = {
  BOARD_SIZE,
  TRAP_MIN_CELL,
  TRAP_MAX_CELL,
  DEFAULT_TRAPS_PER_TEAM,
  START_CELL,
  MOVIE_CELLS,
  MAX_TEAM_SIZE,
  DOUBLES_PER_TEAM,
  MOVIE_TITLES_PER_CARD,
  CATEGORIES,
  TASK_CATEGORIES,
  RANDOM_TASKS,
  GUEST_POOL,
  GUEST_POOL_INFO,
  DIE_FACES,
  TEAM_COLORS,
  GameError,
  newId,
  newCode,
  log,
  createGame,
  addPlayer,
  renamePlayer,
  createTeam,
  renameTeam,
  joinTeam,
  leaveTeam,
  removePlayer,
  removeTeam,
  currentTeam,
  teamRoles,
  normalizeWord,
  cardWords,
  availableCards,
  remainingCards,
  duplicateWords,
  startGame,
  resetGame,
  roll,
  setDouble,
  startTimer,
  stopTimer,
  expireTimer,
  computeDelta,
  resolve,
  undo,
  adminSetTeam,
  adminSetCurrentTeam,
  adminSkipTurn,
  adminCancelTurn,
  adminMoveTeam,
  adminSetTraps,
  adminRegenerateTraps,
  ensureTraps,
  randomTraps,
  pickComplication,
};
