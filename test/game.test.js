'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../server/game');
const cards = require('../server/defaultCards');

// Детерминированный генератор: возвращает значения по очереди.
const seq = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};
// Значение rng, при котором pick() выберет элемент с индексом idx из списка длины len.
const at = (idx, len) => (idx + 0.5) / len;

function setup(teamCount = 2) {
  const game = G.createGame('Тест');
  for (let i = 0; i < teamCount; i += 1) {
    const team = G.createTeam(game, `Команда ${i + 1}`);
    const a = G.addPlayer(game, `Игрок ${i}a`);
    const b = G.addPlayer(game, `Игрок ${i}b`);
    G.joinTeam(game, a.id, team.id);
    G.joinTeam(game, b.id, team.id);
  }
  G.startGame(game);
  return game;
}

function playTurn(game, face, result, { doubled = false } = {}) {
  const faceIdx = G.DIE_FACES.indexOf(face);
  G.roll(game, cards, seq(at(faceIdx, G.DIE_FACES.length), 0.1, 0.1));
  if (doubled) G.setDouble(game, true);
  G.startTimer(game);
  G.stopTimer(game);
  return G.resolve(game, result);
}

test('команды получают разные цвета и не больше 2 игроков', () => {
  const game = G.createGame('x');
  const t1 = G.createTeam(game, '');
  const t2 = G.createTeam(game, '');
  assert.notEqual(t1.color, t2.color);
  assert.equal(t1.name, 'Красные');
  const players = ['А', 'Б', 'В'].map((n) => G.addPlayer(game, n));
  G.joinTeam(game, players[0].id, t1.id);
  G.joinTeam(game, players[1].id, t1.id);
  assert.throws(() => G.joinTeam(game, players[2].id, t1.id), /2 игрока/);
  G.joinTeam(game, players[1].id, t2.id);
  assert.deepEqual(t1.players, [players[0].id]);
  assert.deepEqual(t2.players, [players[1].id]);
});

test('пустое имя не принимается', () => {
  const game = G.createGame('x');
  assert.throws(() => G.addPlayer(game, '   '), G.GameError);
});

test('успешное задание двигает фишку на количество баллов', () => {
  const game = setup();
  const res = playTurn(game, 'yesno', { success: true });
  assert.equal(res.delta, 3);
  assert.equal(game.teams[0].position, 4);
  assert.equal(game.currentTeamIdx, 1);
});

test('провал без удвоения — фишка стоит на месте', () => {
  const game = setup();
  playTurn(game, 'gestures', { success: false });
  assert.equal(game.teams[0].position, 1);
});

test('удвоение: успех — двойные баллы, провал — назад на двойные баллы', () => {
  const game = setup(1);
  playTurn(game, 'drawing', { success: true }, { doubled: true });
  assert.equal(game.teams[0].position, 5);
  assert.equal(game.teams[0].doubles, 2);
  playTurn(game, 'talk', { success: false }, { doubled: true });
  assert.equal(game.teams[0].position, 3);
  assert.equal(game.teams[0].doubles, 1);
});

test('назад не дальше старта', () => {
  const game = setup(1);
  playTurn(game, 'yesno', { success: false }, { doubled: true });
  assert.equal(game.teams[0].position, 1);
});

test('фишки удвоения заканчиваются', () => {
  const game = setup(1);
  game.teams[0].doubles = 0;
  G.roll(game, cards, seq(at(1, 6), 0.1));
  assert.throws(() => G.setDouble(game, true), /закончились/);
});

test('грань «?» выбирает одно из трёх заданий: словами, жестами, рисование', () => {
  const game = setup();
  G.roll(game, cards, seq(at(5, 6), at(1, 3), 0.2));
  assert.equal(game.turn.face, 'random');
  assert.equal(game.turn.category, 'gestures');
  assert.equal(game.turn.seconds, 60);
  assert.deepEqual(G.RANDOM_TASKS, ['talk', 'gestures', 'drawing']);
  G.adminCancelTurn(game);
  G.roll(game, cards, seq(at(5, 6), at(2, 3), 0.2));
  assert.equal(game.turn.category, 'drawing');
  assert.equal(game.turn.seconds, 60);
});

test('на «?» выпадает и рисование, но никогда не выпадают «Да / Нет» и «Песни»', () => {
  const game = setup(1);
  const seen = new Set();
  for (let i = 0; i < 30; i += 1) {
    G.roll(game, cards, seq(at(5, 6), i / 30, Math.random()));
    seen.add(game.turn.category);
    G.adminCancelTurn(game);
  }
  assert.deepEqual([...seen].sort(), ['drawing', 'gestures', 'talk']);
});

test('клетки 10 и 21 — карточка «Кино» без кубика и без удвоения', () => {
  const game = setup();
  game.teams[0].position = 10;
  G.roll(game, cards);
  assert.equal(game.turn.kind, 'movie');
  assert.equal(game.turn.card.length, 5);
  assert.equal(game.turn.seconds, 60);
  assert.throws(() => G.setDouble(game, true), /не действует/);
  G.startTimer(game);
  G.stopTimer(game);
  G.resolve(game, { guessed: 4 });
  assert.equal(game.teams[0].position, 14);
  assert.equal(game.teams[0].doubles, 3);
});

test('первая команда на клетке 30 побеждает', () => {
  const game = setup();
  game.teams[1].position = 28;
  playTurn(game, 'talk', { success: false });
  playTurn(game, 'yesno', { success: true });
  assert.equal(game.status, 'finished');
  assert.equal(game.winnerTeamId, game.teams[1].id);
  assert.equal(game.teams[1].position, 30);
  assert.throws(() => G.roll(game, cards), /окончена/);
});

test('объясняющий чередуется внутри команды', () => {
  const game = setup(1);
  const [a, b] = game.teams[0].players;
  G.roll(game, cards, seq(at(1, 6), 0.1));
  assert.equal(game.turn.explainerId, a);
  assert.equal(game.turn.guesserId, b);
  G.startTimer(game);
  G.stopTimer(game);
  G.resolve(game, { success: false });
  G.roll(game, cards, seq(at(1, 6), 0.1));
  assert.equal(game.turn.explainerId, b);
});

test('таймер истекает только по времени', () => {
  const game = setup();
  G.roll(game, cards, seq(at(1, 6), 0.1));
  G.startTimer(game, 1000);
  assert.equal(G.expireTimer(game, 1000 + 29_000), false);
  assert.equal(G.expireTimer(game, 1000 + 30_000), true);
  assert.equal(game.turn.phase, 'result');
});

test('карточки не повторяются, пока колода не закончится', () => {
  const game = setup(1);
  const deck = { ...cards, talk: ['a', 'b', 'c'] };
  const seen = new Set();
  for (let i = 0; i < 3; i += 1) {
    G.roll(game, deck, seq(at(1, 6), Math.random()));
    seen.add(game.turn.card);
    G.adminCancelTurn(game);
  }
  assert.equal(seen.size, 3);
});

test('администратор правит клетку и удвоения, отмена возвращает как было', () => {
  const game = setup();
  playTurn(game, 'yesno', { success: true });
  const team = game.teams[0];
  G.adminSetTeam(game, team.id, { position: 12, doubles: 1 });
  assert.deepEqual([team.position, team.doubles], [12, 1]);
  G.undo(game);
  assert.deepEqual([team.position, team.doubles], [4, 3]);
  G.undo(game);
  assert.equal(team.position, 1);
  assert.equal(game.currentTeamIdx, 0);
});

test('администратор может поставить команду на финиш — это победа', () => {
  const game = setup();
  G.adminSetTeam(game, game.teams[1].id, { position: 30 });
  assert.equal(game.status, 'finished');
  G.adminSetTeam(game, game.teams[1].id, { position: 25 });
  assert.equal(game.status, 'playing');
});

test('пропуск и передача хода', () => {
  const game = setup(3);
  G.adminSkipTurn(game);
  assert.equal(game.currentTeamIdx, 1);
  G.adminSetCurrentTeam(game, game.teams[0].id);
  assert.equal(game.currentTeamIdx, 0);
});

test('отмена броска возвращает потраченную фишку удвоения', () => {
  const game = setup();
  G.roll(game, cards, seq(at(0, 6), 0.1));
  G.setDouble(game, true);
  G.startTimer(game);
  assert.equal(game.teams[0].doubles, 2);
  G.adminCancelTurn(game);
  assert.equal(game.teams[0].doubles, 3);
  assert.equal(game.turn, null);
});

test('удаление текущей команды не ломает очередь', () => {
  const game = setup(3);
  G.adminSkipTurn(game);
  G.removeTeam(game, game.teams[0].id);
  assert.equal(game.teams[game.currentTeamIdx].name, 'Команда 2');
  G.removeTeam(game, game.teams[game.currentTeamIdx].id);
  assert.equal(game.teams[game.currentTeamIdx].name, 'Команда 3');
});

// ---------- Уникальность слов в рамках игры ----------

function drawTurn(game, deck, faceIdx) {
  G.roll(game, deck, seq(at(faceIdx, 6), Math.random()));
  const turn = game.turn;
  G.adminCancelTurn(game);
  return turn;
}

test('стандартные колоды не содержат повторяющихся слов', () => {
  assert.deepEqual(G.duplicateWords(cards), []);
});

test('за всю игру ни одна карточка не выпадает дважды', () => {
  const game = setup(1);
  const seen = new Set();
  for (let i = 0; i < cards.talk.length; i += 1) {
    const turn = drawTurn(game, cards, 1);
    assert.equal(turn.category, 'talk');
    assert.ok(!seen.has(turn.card), `повтор: ${turn.card}`);
    seen.add(turn.card);
  }
  assert.equal(seen.size, cards.talk.length);
});

test('когда категория закончилась, задание заменяется другой категорией', () => {
  const game = setup(1);
  const deck = { ...cards, talk: ['Один'] };
  assert.equal(drawTurn(game, deck, 1).card, 'Один');
  const turn = drawTurn(game, deck, 1);
  assert.notEqual(turn.category, 'talk');
  assert.equal(turn.substitutedFrom, 'talk');
  assert.ok(game.log.some((e) => e.text.includes('закончились карточки')));
});

test('когда закончились все карточки заданий — понятная ошибка', () => {
  const game = setup(1);
  const deck = { yesno: ['а'], talk: ['б'], gestures: ['в'], music: ['г / д'], drawing: ['е'], movies: [['1', '2', '3', '4', '5']] };
  for (let i = 0; i < 5; i += 1) drawTurn(game, deck, i);
  assert.throws(() => G.roll(game, deck, seq(0.1, 0.1)), /уже использованы/);
  assert.equal(game.turn, null);
});

test('одинаковое слово в разных категориях разрешено — выпадает каждая карточка', () => {
  const game = setup(1);
  const deck = { ...cards, talk: ['Самолёт'], drawing: ['самолет'], music: ['Небо / САМОЛЁТ'] };
  assert.equal(drawTurn(game, deck, 1).card, 'Самолёт');
  // Карточки других категорий с тем же словом по-прежнему доступны.
  assert.equal(drawTurn(game, deck, 4).card, 'самолет');
  assert.equal(drawTurn(game, deck, 3).card, 'Небо / САМОЛЁТ');
  assert.equal(G.remainingCards(game, deck).talk, 0);
  assert.equal(G.remainingCards(game, deck).drawing, 0);
  assert.equal(G.remainingCards(game, deck).music, 0);
});

test('слово из пула «?» не мешает такой же карточке в обычной колоде', () => {
  const game = setup(1);
  const deck = { ...cards, talk: ['Кот Аси'], random: ['Кот Аси'] };
  G.roll(game, deck, seq(at(5, 6), at(0, 3), 0.1));
  assert.equal(game.turn.fromPool, true);
  G.adminCancelTurn(game);
  assert.equal(drawTurn(game, deck, 1).card, 'Кот Аси');
});

test('одинаковые строки в колоде считаются одной карточкой', () => {
  const game = setup(1);
  const deck = { ...cards, talk: ['Кот', 'кот', 'Пёс'] };
  const got = [drawTurn(game, deck, 1).card, drawTurn(game, deck, 1).card];
  assert.deepEqual(got.map(G.normalizeWord).sort(), ['кот', 'пес']);
  assert.equal(drawTurn(game, deck, 1).substitutedFrom, 'talk');
});

test('если карточки «Кино» закончились, на клетке 10 бросают кубик', () => {
  const game = setup(1);
  const deck = { ...cards, movies: [['A', 'B', 'C', 'D', 'E']] };
  game.teams[0].position = 10;
  assert.equal(drawTurn(game, deck, 0).kind, 'movie');
  const turn = drawTurn(game, deck, 0);
  assert.equal(turn.kind, 'die');
  assert.equal(turn.movieFallback, true);
});

test('сброс игры возвращает все карточки', () => {
  const game = setup(1);
  drawTurn(game, cards, 1);
  assert.equal(G.remainingCards(game, cards).talk, cards.talk.length - 1);
  G.resetGame(game);
  assert.equal(G.remainingCards(game, cards).talk, cards.talk.length);
});

test('старые игры с номерами карточек переводятся на новый учёт', () => {
  const game = setup(1);
  delete game.usedCardKeys;
  game.usedCards = { talk: [0, 1] };
  assert.equal(G.remainingCards(game, cards).talk, cards.talk.length - 2);
});

test('старые игры со списком использованных слов переводятся на новый учёт', () => {
  const game = setup(1);
  delete game.usedCardKeys;
  game.usedWords = [G.normalizeWord(cards.talk[0]), G.normalizeWord(cards.yesno[3])];
  const left = G.remainingCards(game, cards);
  assert.equal(left.talk, cards.talk.length - 1);
  assert.equal(left.yesno, cards.yesno.length - 1);
  assert.equal(game.usedWords, undefined);
});

// ---------- Ловушки и усложнения ----------

const COMPLICATIONS = {
  yesno: ['Вопросы одним словом'],
  talk: ['Без глаголов', 'Шёпотом'],
  gestures: ['Одной рукой'],
  music: ['Только детские песни'],
  drawing: ['Одной линией'],
  movies: ['Только жестами'],
};

test('у каждой команды свои ловушки на клетках 10–29', () => {
  const game = setup(3);
  for (const team of game.teams) {
    assert.equal(team.traps.length, G.DEFAULT_TRAPS_PER_TEAM);
    assert.equal(new Set(team.traps).size, team.traps.length);
    for (const c of team.traps) assert.ok(c >= 10 && c <= 29, `клетка ${c}`);
  }
});

test('ловушка срабатывает в начале хода и даёт усложнение выпавшей категории', () => {
  const game = setup(2);
  const [a, b] = game.teams;
  a.traps = [12];
  a.position = 12;
  b.traps = [];
  G.roll(game, cards, seq(at(2, 6), 0.1, 0.1), COMPLICATIONS);
  assert.equal(game.turn.category, 'gestures');
  assert.deepEqual(game.turn.trap, { cell: 12, text: 'Одной рукой' });
  assert.ok(game.log.some((e) => e.text.includes('ловушку на клетке 12')));
});

test('ловушки другой команды не действуют, как и клетки без ловушек', () => {
  const game = setup(2);
  const [a, b] = game.teams;
  a.traps = [15];
  b.traps = [12];
  a.position = 12;
  G.roll(game, cards, seq(at(1, 6), 0.1, 0.1), COMPLICATIONS);
  assert.equal(game.turn.trap, null);
});

test('усложнение не меняет очки', () => {
  const game = setup(1);
  const team = game.teams[0];
  team.traps = [14];
  team.position = 14;
  G.roll(game, cards, seq(at(0, 6), 0.1, 0.1), COMPLICATIONS);
  assert.ok(game.turn.trap);
  G.startTimer(game);
  G.stopTimer(game);
  G.resolve(game, { success: true });
  assert.equal(team.position, 17);
});

test('усложнения сначала выбираются из ещё не выпадавших', () => {
  const game = setup(1);
  const team = game.teams[0];
  team.traps = [11];
  const seen = new Set();
  for (let i = 0; i < 2; i += 1) {
    team.position = 11;
    G.roll(game, cards, seq(at(1, 6), 0.1, 0.1), COMPLICATIONS);
    seen.add(game.turn.trap.text);
    G.adminCancelTurn(game);
  }
  assert.deepEqual([...seen].sort(), ['Без глаголов', 'Шёпотом']);
});

test('если усложнений для категории нет, ловушка срабатывает без усложнения', () => {
  const game = setup(1);
  const team = game.teams[0];
  team.traps = [13];
  team.position = 13;
  G.roll(game, cards, seq(at(1, 6), 0.1, 0.1), { ...COMPLICATIONS, talk: [] });
  assert.deepEqual(game.turn.trap, { cell: 13, text: null });
});

test('администратор задаёт и перегенерирует ловушки', () => {
  const game = setup(2);
  const [a, b] = game.teams;
  G.adminSetTraps(game, a.id, '25, 12 12; 19');
  assert.deepEqual(a.traps, [12, 19, 25]);
  assert.throws(() => G.adminSetTraps(game, a.id, '5, 12'), /10–29/);
  assert.throws(() => G.adminSetTraps(game, a.id, '30'), /10–29/);
  G.adminSetTraps(game, a.id, '');
  assert.deepEqual(a.traps, []);
  G.adminRegenerateTraps(game, { count: 5 });
  assert.equal(game.trapsPerTeam, 5);
  assert.equal(a.traps.length, 5);
  assert.equal(b.traps.length, 5);
  G.adminRegenerateTraps(game, { teamId: a.id, count: 0 });
  assert.deepEqual(a.traps, []);
  assert.equal(b.traps.length, 5);
});

test('старые игры получают ловушки при загрузке', () => {
  const game = setup(1);
  delete game.trapsPerTeam;
  delete game.teams[0].traps;
  G.ensureTraps(game);
  assert.equal(game.teams[0].traps.length, G.DEFAULT_TRAPS_PER_TEAM);
});

test('у команд нет отдельных очков: старые очки убираются при загрузке и не возвращаются отменой', () => {
  const game = setup();
  const team = game.teams[0];
  assert.equal('score' in team, false);
  G.adminSetTeam(game, team.id, { position: 7 });
  team.score = 5;
  game.history.at(-1).state.teams[0].score = 5;
  G.ensureTraps(game);
  assert.equal('score' in team, false);
  G.undo(game);
  assert.equal(team.position, 1);
  assert.equal('score' in team, false);
});

test('ловушка срабатывает один раз и снимается с поля при любом результате', () => {
  for (const success of [true, false]) {
    const game = setup(1);
    const team = game.teams[0];
    team.traps = [12, 20];
    team.position = 12;
    G.roll(game, cards, seq(at(1, 6), 0.1, 0.1), COMPLICATIONS);
    assert.ok(game.turn.trap);
    assert.deepEqual(team.traps, [20]);
    assert.deepEqual(team.triggeredTraps, [12]);
    G.startTimer(game);
    G.stopTimer(game);
    G.resolve(game, { success });
    // Снова начинаем ход с клетки 12 — ловушки там больше нет.
    team.position = 12;
    G.roll(game, cards, seq(at(1, 6), 0.1, 0.1), COMPLICATIONS);
    assert.equal(game.turn.trap, null);
    assert.deepEqual(team.traps, [20]);
  }
});

test('отмена броска администратором возвращает сработавшую ловушку', () => {
  const game = setup(1);
  const team = game.teams[0];
  team.traps = [15];
  team.position = 15;
  G.roll(game, cards, seq(at(1, 6), 0.1, 0.1), COMPLICATIONS);
  assert.deepEqual(team.traps, []);
  G.adminCancelTurn(game);
  assert.deepEqual(team.traps, [15]);
  assert.deepEqual(team.triggeredTraps, []);
  G.roll(game, cards, seq(at(1, 6), 0.1, 0.1), COMPLICATIONS);
  assert.equal(game.turn.trap.cell, 15);
  assert.deepEqual(team.traps, []);
});

test('перерасстановка и сброс игры очищают список сработавших ловушек', () => {
  const game = setup(1);
  const team = game.teams[0];
  team.traps = [16];
  team.position = 16;
  G.roll(game, cards, seq(at(1, 6), 0.1, 0.1), COMPLICATIONS);
  assert.deepEqual(team.triggeredTraps, [16]);
  G.adminRegenerateTraps(game, { teamId: team.id });
  assert.deepEqual(team.triggeredTraps, []);
  assert.equal(team.traps.length, G.DEFAULT_TRAPS_PER_TEAM);
});

// ---------- Пул «?» про гостей ----------

const RANDOM_FACE = at(5, 6);
const withPool = (pool) => ({ ...cards, random: pool });

test('на «?» задание случайное, а слово из пула про гостей', () => {
  const game = setup(1);
  const deck = withPool(['Лыжи Миши', 'Кот Аси']);
  // «?» → задание «Жестами» (индекс 1 из 3) → первое свободное слово пула.
  G.roll(game, deck, seq(RANDOM_FACE, at(1, 3), 0.1));
  assert.equal(game.turn.face, 'random');
  assert.equal(game.turn.category, 'gestures');
  assert.equal(game.turn.seconds, 60);
  assert.equal(game.turn.fromPool, true);
  assert.equal(game.turn.card, 'Лыжи Миши');
});

test('слова пула не повторяются, после исчерпания «?» берёт обычную колоду', () => {
  const game = setup(1);
  const deck = withPool(['Раз', 'Два']);
  const got = [];
  for (let i = 0; i < 2; i += 1) {
    G.roll(game, deck, seq(RANDOM_FACE, at(0, 3), Math.random()));
    assert.equal(game.turn.fromPool, true);
    got.push(game.turn.card);
    G.adminCancelTurn(game);
  }
  assert.deepEqual(got.sort(), ['Два', 'Раз']);
  assert.equal(G.remainingCards(game, deck).random, 0);
  G.roll(game, deck, seq(RANDOM_FACE, at(0, 3), 0.1));
  assert.equal(game.turn.fromPool, false);
  assert.equal(game.turn.poolFallback, true);
  assert.ok(cards.talk.includes(game.turn.card));
});

test('пустой пул: «?» работает по-старому, без пометки', () => {
  const game = setup(1);
  G.roll(game, withPool([]), seq(RANDOM_FACE, at(0, 3), 0.1));
  assert.equal(game.turn.fromPool, false);
  assert.equal(game.turn.poolFallback, false);
  assert.ok(cards.talk.includes(game.turn.card));
});

test('обычные грани кубика не берут слова из пула', () => {
  const game = setup(1);
  const deck = withPool(['Только для вопроса']);
  for (let face = 0; face < 5; face += 1) {
    G.roll(game, deck, seq(at(face, 6), 0.1));
    assert.equal(game.turn.fromPool, false);
    assert.notEqual(game.turn.card, 'Только для вопроса');
    G.adminCancelTurn(game);
  }
  assert.equal(G.remainingCards(game, deck).random, 1);
});

test('если колоды «?»-заданий закончились, «?» не переходит на «Да / Нет» и песни', () => {
  const game = setup(1);
  const deck = { ...withPool([]), talk: ['б'], gestures: ['в'], drawing: ['г'] };
  for (let i = 0; i < 3; i += 1) {
    G.roll(game, deck, seq(RANDOM_FACE, at(i, 3), 0.1));
    G.adminCancelTurn(game);
  }
  assert.throws(() => G.roll(game, deck, seq(RANDOM_FACE, 0.1, 0.1)), /уже использованы/);
  // Обычные грани при этом работают.
  G.roll(game, deck, seq(at(3, 6), 0.1));
  assert.equal(game.turn.category, 'music');
});

test('код приглашения — 6 цифр без ведущего нуля, занятые коды пропускаются', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = G.newJoinCode();
    assert.match(code, /^[1-9]\d{5}$/);
    assert.ok(G.isJoinCode(code));
  }
  assert.match(G.createGame('Тест').code, /^[1-9]\d{5}$/);
  const taken = new Set();
  for (let i = 0; i < 50; i += 1) taken.add(G.newJoinCode((c) => taken.has(c)));
  assert.equal(taken.size, 50);
  assert.equal(G.isJoinCode('b4xw2t5m'), false);
  assert.equal(G.isJoinCode('012345'), false);
});

test('введённый код очищается от пробелов и дефисов', () => {
  assert.equal(G.normalizeJoinCode(' 482 913 '), '482913');
  assert.equal(G.normalizeJoinCode('482-913'), '482913');
  assert.equal(G.normalizeJoinCode('B4XW2T5M'), 'b4xw2t5m');
  assert.equal(G.normalizeJoinCode(undefined), '');
});
