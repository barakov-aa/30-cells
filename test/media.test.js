'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVictoryMusic, isMp3, MediaError } = require('../server/media');

const ID3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(100, 1)]);
const FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(100)]);

test('MP3 узнаётся по тегу ID3 или кадру, остальное — нет', () => {
  assert.equal(isMp3(ID3), true);
  assert.equal(isMp3(FRAME), true);
  assert.equal(isMp3(Buffer.from('RIFF....WAVE')), false);
  assert.equal(isMp3(Buffer.from('<html>')), false);
  assert.equal(isMp3(Buffer.alloc(0)), false);
});

test('музыку победы можно сохранить, узнать о ней и удалить', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-media-'));
  try {
    const music = createVictoryMusic(dir);
    assert.deepEqual(music.info(), { exists: false });
    const info = music.save(ID3, 'Победа/песня.mp3');
    assert.equal(info.exists, true);
    assert.equal(info.name, 'Победапесня.mp3');
    assert.equal(info.size, ID3.length);
    assert.deepEqual(fs.readFileSync(music.file), ID3);
    assert.throws(() => music.save(Buffer.from('not audio'), 'x.mp3'), MediaError);
    assert.throws(() => music.save(Buffer.alloc(0), 'x.mp3'), /пустой/);
    assert.equal(music.info().size, ID3.length, 'неудачная загрузка не портит прежний файл');
    music.remove();
    assert.deepEqual(music.info(), { exists: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
