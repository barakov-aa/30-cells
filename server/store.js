'use strict';

/** Хранение игр и карточек в JSON-файлах (без внешней БД). */

const fs = require('fs');
const path = require('path');
const defaultCards = require('./defaultCards');
const defaultComplications = require('./defaultComplications');
const {
  CATEGORIES, MOVIE_TITLES_PER_CARD, GUEST_POOL, newCode, newJoinCode, isJoinCode, normalizeJoinCode, ensureTraps,
} = require('./game');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const GAMES_FILE = path.join(DATA_DIR, 'games.json');
const CARDS_FILE = path.join(DATA_DIR, 'cards.json');
const COMPLICATIONS_FILE = path.join(DATA_DIR, 'complications.json');

const games = new Map();
let cards = null;
let complications = null;
let saveTimer = null;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function writeAtomic(file, data) {
  ensureDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Не удалось прочитать ${file}:`, err.message);
    return fallback;
  }
}

function isCodeTaken(code) {
  for (const g of games.values()) {
    if (g.code === code || (g.legacyCodes || []).includes(code)) return true;
  }
  return false;
}

function load() {
  const list = readJson(GAMES_FILE, []);
  for (const game of list) {
    if (!game.screenCode) game.screenCode = newCode();
    ensureTraps(game);
    games.set(game.id, game);
  }
  // До 1.4.0 коды приглашений были буквенно-цифровыми. Игра получает числовой код,
  // а старый остаётся рабочим, чтобы уже разосланные ссылки не перестали открываться.
  for (const game of games.values()) {
    if (isJoinCode(game.code)) continue;
    game.legacyCodes = [...new Set([...(game.legacyCodes || []), game.code])];
    game.code = newJoinCode(isCodeTaken);
    scheduleSave();
  }
  cards = normalizeCards(readJson(CARDS_FILE, defaultCards));
  complications = normalizeComplications(readJson(COMPLICATIONS_FILE, defaultComplications));
}

function normalizeComplications(input) {
  const result = {};
  for (const category of Object.keys(CATEGORIES)) {
    const list = Array.isArray(input?.[category]) ? input[category] : defaultComplications[category] || [];
    result[category] = [...new Set(list.map((s) => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean))];
  }
  return result;
}

function getComplications() {
  return complications;
}

function setComplications(input) {
  complications = normalizeComplications(input);
  writeAtomic(COMPLICATIONS_FILE, complications);
  return complications;
}

function resetComplications() {
  return setComplications(defaultComplications);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  writeAtomic(GAMES_FILE, [...games.values()]);
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    try {
      saveNow();
    } catch (err) {
      console.error('Ошибка сохранения игр:', err);
    }
  }, 300);
}

function normalizeCards(input) {
  const result = {};
  for (const category of Object.keys(CATEGORIES)) {
    const list = Array.isArray(input?.[category]) ? input[category] : defaultCards[category];
    if (category === 'movies') {
      result.movies = list
        .map((card) => (Array.isArray(card) ? card : String(card).split(';')))
        .map((card) => card.map((s) => String(s).trim()).filter(Boolean).slice(0, MOVIE_TITLES_PER_CARD))
        .filter((card) => card.length > 0);
    } else {
      result[category] = list.map((s) => String(s).trim()).filter(Boolean);
    }
  }
  // Пул «?» про гостей может быть пустым — тогда «?» берёт слова из обычных колод.
  const pool = Array.isArray(input?.[GUEST_POOL]) ? input[GUEST_POOL] : defaultCards[GUEST_POOL] || [];
  result[GUEST_POOL] = pool.map((s) => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean);
  return result;
}

function getCards() {
  return cards;
}

function setCards(input) {
  const next = normalizeCards(input);
  for (const [category, list] of Object.entries(next)) {
    if (list.length === 0 && category !== GUEST_POOL) throw new Error(`Колода «${CATEGORIES[category].title}» не может быть пустой`);
  }
  cards = next;
  writeAtomic(CARDS_FILE, cards);
  return cards;
}

function resetCards() {
  return setCards(defaultCards);
}

module.exports = {
  games,
  load,
  saveNow,
  scheduleSave,
  getCards,
  setCards,
  resetCards,
  getComplications,
  setComplications,
  resetComplications,
  getGame: (id) => games.get(id),
  findByCode(input) {
    const code = normalizeJoinCode(input);
    if (!code) return undefined;
    return [...games.values()].find((g) => g.code === code || (g.legacyCodes || []).includes(code));
  },
  isCodeTaken,
  findByScreenCode: (code) => [...games.values()].find((g) => g.screenCode === code),
  addGame(game) {
    if (isCodeTaken(game.code)) game.code = newJoinCode(isCodeTaken);
    games.set(game.id, game);
    scheduleSave();
  },
  deleteGame(id) {
    games.delete(id);
    scheduleSave();
  },
};
