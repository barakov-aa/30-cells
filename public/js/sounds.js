'use strict';

/**
 * Звуки игры, синтезируются в браузере (без звуковых файлов).
 * Выбраны на согласовании: отсчёт «часы с нарастанием», конец времени — механический будильник (ре, D7),
 * шаг фишки — «пузырьки», победа — фанфары.
 * Браузер разрешает звук только после действия пользователя, поэтому контекст создаётся при первом клике.
 */
window.Sounds = (() => {
  let ctx = null;
  let master = null;
  let enabled = true;

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.8;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // Нота: частота f (или скольжение до f2), начало через t сек, длина d, громкость g.
  function tone({ f, f2, t = 0, d = 0.2, type = 'sine', g = 0.3, a = 0.005, cutoff }) {
    const c = ac();
    if (!c) return;
    const t0 = c.currentTime + t;
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f, t0);
    if (f2) osc.frequency.exponentialRampToValueAtTime(f2, t0 + d);
    const amp = c.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(g, t0 + a);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    let node = osc;
    if (cutoff) {
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = cutoff;
      osc.connect(lp);
      node = lp;
    }
    node.connect(amp).connect(master);
    osc.start(t0);
    osc.stop(t0 + d + 0.05);
  }

  // Короткий шумовой щелчок (тиканье часов, удар молоточка).
  function click({ t = 0, freq = 2000, d = 0.06, g = 0.4, q = 6 }) {
    const c = ac();
    if (!c) return;
    const t0 = c.currentTime + t;
    const len = Math.ceil(c.sampleRate * d);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    const src = c.createBufferSource();
    src.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const amp = c.createGain();
    amp.gain.value = g;
    src.connect(bp).connect(amp).connect(master);
    src.start(t0);
  }

  function brass({ f, t = 0, d = 0.3, g = 0.12 }) {
    tone({ f, t, d, type: 'sawtooth', g, a: 0.02, cutoff: 2200 });
    tone({ f: f * 1.004, t, d, type: 'sawtooth', g: g * 0.6, a: 0.02, cutoff: 2200 });
  }

  const guard = (fn) => (...args) => {
    if (!enabled) return;
    try { fn(...args); } catch { /* звук недоступен */ }
  };

  return {
    /** Разрешить звук: вызывать из обработчика клика. */
    unlock() { try { ac(); } catch { /* звук недоступен */ } },
    /** Звук включён, но браузер ещё не разрешил его (страницу ни разу не кликали). */
    get blocked() { return Boolean(enabled && (!ctx || ctx.state !== 'running')); },
    get enabled() { return enabled; },
    set enabled(value) { enabled = Boolean(value); if (enabled) this.unlock(); },

    // Последние секунды таймера (s = 5…1): тиканье и сигнал, который с каждой секундой выше и громче.
    countdown: guard((s) => {
      const k = Math.max(0, Math.min(4, 5 - s));
      click({ freq: 2600, d: 0.04, g: 0.45 });
      tone({ f: 880 + k * 110, t: 0.02, d: 0.12 + k * 0.02, type: 'square', g: 0.03 + k * 0.025, cutoff: 3000 });
    }),

    // Время вышло: механический будильник, одна трель около секунды (ре седьмой октавы, D7).
    timeUp: guard(() => {
      const f = 2349;
      for (let k = 0; k < 22; k += 1) {
        const t = k * 0.045;
        [[1, 1], [2.76, 0.35], [5.4, 0.15]].forEach(([r, w]) => tone({ f: (k % 2 ? f * 1.03 : f) * r, t, d: 0.11, g: 0.07 * w }));
        click({ t, freq: f * 1.75, d: 0.02, g: 0.12 });
      }
    }),

    // Фишка проходит клетку: i — номер шага в ходе, dir = 1 вперёд («блип» вверх) или −1 назад («блоп» вниз).
    step: guard((i, dir) => {
      if (dir > 0) tone({ f: 320 + i * 40, f2: 900 + i * 60, d: 0.1, g: 0.3 });
      else tone({ f: Math.max(300, 600 - i * 30), f2: 180, d: 0.16, g: 0.32 });
    }),

    // Победа: фанфары «та-та-та-тааа» и аккорд.
    win: guard(() => {
      [0, 0.14, 0.28].forEach((t) => brass({ f: 392, t, d: 0.12, g: 0.13 }));
      [523.25, 659.25, 783.99, 1046.5].forEach((f) => brass({ f, t: 0.46, d: 1.5, g: 0.09 }));
    }),
  };
})();
