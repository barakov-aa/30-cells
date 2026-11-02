'use strict';

/** Музыка победы: один MP3-файл в папке данных (data/media/victory.mp3) и сведения о нём. */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 25 * 1024 * 1024;

class MediaError extends Error {}

// MP3 начинается с тега ID3 или сразу с кадра (11 единичных бит синхронизации).
function isMp3(buf) {
  if (!buf || buf.length < 4) return false;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // «ID3»
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
}

function createVictoryMusic(dataDir) {
  const dir = path.join(dataDir, 'media');
  const file = path.join(dir, 'victory.mp3');
  const metaFile = path.join(dir, 'victory.json');

  function info() {
    try {
      const stat = fs.statSync(file);
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* без сведений */ }
      return { exists: true, name: meta.name || 'victory.mp3', size: stat.size, updatedAt: Math.round(stat.mtimeMs) };
    } catch {
      return { exists: false };
    }
  }

  function save(buf, originalName) {
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw new MediaError('Файл пустой — выберите MP3');
    if (buf.length > MAX_BYTES) throw new MediaError(`Файл больше ${MAX_BYTES / 1024 / 1024} МБ — выберите поменьше`);
    if (!isMp3(buf)) throw new MediaError('Это не MP3 — загрузите файл в формате MP3');
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
    const name = String(originalName || '').replace(/[\\/]/g, '').slice(0, 120) || 'victory.mp3';
    fs.writeFileSync(metaFile, JSON.stringify({ name }));
    return info();
  }

  function remove() {
    fs.rmSync(file, { force: true });
    fs.rmSync(metaFile, { force: true });
  }

  return { file, info, save, remove };
}

module.exports = { createVictoryMusic, isMp3, MediaError, MAX_BYTES };
