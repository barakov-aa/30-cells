'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Хранилище читает папку данных при подключении, поэтому DATA_DIR задаётся заранее.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-store-'));
process.env.DATA_DIR = dir;
const G = require('../server/game');

const legacy = G.createGame('Старая игра');
legacy.code = 'b4xw2t5m';
const fresh = G.createGame('Новая игра');
fs.writeFileSync(path.join(dir, 'games.json'), JSON.stringify([legacy, fresh]));

const store = require('../server/store');
store.load();

test.after(() => {
  store.saveNow();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('старая игра получает числовой код, а старая ссылка продолжает работать', () => {
  const game = store.getGame(legacy.id);
  assert.match(game.code, /^[1-9]\d{5}$/);
  assert.deepEqual(game.legacyCodes, ['b4xw2t5m']);
  assert.equal(store.findByCode('b4xw2t5m'), game);
  assert.equal(store.findByCode('B4XW2T5M'), game);
  assert.equal(store.findByCode(game.code), game);
  assert.equal(store.findByCode(`${game.code.slice(0, 3)} ${game.code.slice(3)}`), game);
  assert.equal(store.isCodeTaken('b4xw2t5m'), true);
});

test('игра с числовым кодом не меняется, неизвестный код не находится', () => {
  const game = store.getGame(fresh.id);
  assert.equal(game.code, fresh.code);
  assert.equal(game.legacyCodes, undefined);
  assert.equal(store.findByCode('000000'), undefined);
  assert.equal(store.findByCode(''), undefined);
});

test('новая игра с занятым кодом получает другой код', () => {
  const clash = G.createGame('Дубль');
  clash.code = fresh.code;
  store.addGame(clash);
  assert.notEqual(clash.code, fresh.code);
  assert.match(clash.code, /^[1-9]\d{5}$/);
});
