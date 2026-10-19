'use strict';

/**
 * 3D-кубик с гранями-заданиями (вариант «Бросок по столу»): влетает сбоку, подпрыгивает
 * с тенью и останавливается на грани, которую выбросил сервер.
 * Кубик — один элемент на страницу: при перерисовке панели его переставляют в новое место,
 * и анимация не обрывается.
 */
window.Dice = (() => {
  const ROLL_MS = 1800;
  // Поворот кубика, при котором грань i смотрит на зрителя (порядок граней — DIE_FACES сервера).
  const FRONT = [[0, 0], [0, -90], [0, 180], [0, 90], [-90, 0], [90, 0]];
  const REST = 'rotateX(-24deg) rotateY(32deg)'; // кубик в ожидании броска: видно три грани
  const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function create(icons) {
    const el = document.createElement('div');
    el.className = 'dice3d';
    el.innerHTML = `<div class="dice-shadow"></div><div class="dice-thrower"><div class="dice-cube">${
      icons.map((icon, i) => `<div class="dice-f dice-f${i + 1}"><span class="dice-tile">${icon}</span></div>`).join('')
    }</div></div>`;
    const cube = el.querySelector('.dice-cube');
    const thrower = el.querySelector('.dice-thrower');
    const shadow = el.querySelector('.dice-shadow');
    let rollingUntil = 0;
    let anims = [];

    const stop = () => { anims.forEach((a) => a.cancel()); anims = []; };
    const faceTransform = (face) => `rotateX(${FRONT[face][0]}deg) rotateY(${FRONT[face][1]}deg)`;

    function show(face) {
      if (Date.now() < rollingUntil) return; // не прерываем идущий бросок
      stop();
      cube.style.transform = face === null || face === undefined ? REST : faceTransform(face);
      thrower.style.transform = '';
    }

    function roll(face) {
      stop();
      const end = faceTransform(face);
      cube.style.transform = end;
      thrower.style.transform = '';
      if (reduced() || !el.animate) return;
      rollingUntil = Date.now() + ROLL_MS;
      const [x, y] = FRONT[face];
      const timing = { duration: ROLL_MS, easing: 'ease-out' };
      anims = [
        thrower.animate([
          { transform: 'translate(-170%, -60%)' },
          { transform: 'translate(-60%, 0)', offset: 0.35 },
          { transform: 'translate(-20%, -35%)', offset: 0.55 },
          { transform: 'translate(0, 0)', offset: 0.72 },
          { transform: 'translate(0, -9%)', offset: 0.84 },
          { transform: 'translate(0, 0)' },
        ], timing),
        shadow.animate([
          { transform: 'translateX(-170%) scale(0.4)', opacity: 0.3 },
          { transform: 'translateX(-60%) scale(1)', opacity: 1, offset: 0.35 },
          { transform: 'translateX(-20%) scale(0.6)', opacity: 0.6, offset: 0.55 },
          { transform: 'translateX(0) scale(1)', opacity: 1, offset: 0.72 },
          { transform: 'translateX(0) scale(0.85)', offset: 0.84 },
          { transform: 'translateX(0) scale(1)', opacity: 1 },
        ], timing),
        cube.animate([
          { transform: `rotateX(${x + 1440}deg) rotateY(${y + 1080}deg) rotateZ(40deg)` },
          { transform: `rotateX(${x + 20}deg) rotateY(${y - 15}deg)`, offset: 0.85 },
          { transform: end },
        ], { duration: ROLL_MS, easing: 'cubic-bezier(.2,.7,.2,1)' }),
      ];
    }

    // Ставит кубик внутрь slot (заглушки в свежей разметке панели).
    function mount(slot) {
      if (slot && el.parentNode !== slot) slot.appendChild(el);
    }

    return { el, roll, show, mount, get rolling() { return Date.now() < rollingUntil; } };
  }

  return { create, ROLL_MS };
})();
