'use strict';

/**
 * Общий холст для задания «Рисование»: страница игрока, общий экран и планшет.
 * Координаты точек — доли ширины и высоты (0…1), поэтому рисунок одинаков на холстах любого размера.
 * Кто может рисовать, решает страница (canDraw), сервер проверяет это ещё раз.
 */
window.DrawCanvas = (() => {
  const COLORS = ['#222222', '#e03131', '#1971c2', '#2f9e44', '#f08c00', '#9c36b5', '#ffffff'];
  const WIDTHS = [[3, 'Тонко'], [6, 'Средне'], [14, 'Толсто'], [30, 'Очень толсто']];

  function create(canvas, socket, { canDraw = () => false } = {}) {
    const ctx2d = canvas.getContext('2d');
    const pen = { color: COLORS[0], width: 6 };
    let strokes = [];
    let turnId = null;
    let currentStroke = null;

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

    // Новый ход с рисованием: чистый холст и рисунок, уже сохранённый на сервере.
    function setTurn(id) {
      if (turnId === id) return;
      turnId = id;
      strokes = [];
      redraw();
      socket.emit('draw:sync', (res) => {
        if (res.turnId === turnId) {
          strokes = res.strokes;
          redraw();
        }
      });
    }

    function point(e) {
      const r = canvas.getBoundingClientRect();
      return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
    }
    function flush(final) {
      if (!currentStroke || currentStroke.points.length === 0) return;
      socket.emit('draw:stroke', currentStroke);
      // Длинные линии отправляем частями, чтобы зрители видели рисунок сразу.
      const last = currentStroke.points[currentStroke.points.length - 1];
      currentStroke = final ? null : { ...currentStroke, points: [last] };
    }
    canvas.addEventListener('pointerdown', (e) => {
      if (!canDraw()) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      currentStroke = { color: pen.color, width: pen.width, points: [point(e)] };
      strokes.push({ ...currentStroke, points: currentStroke.points.slice() });
      drawStroke(strokes[strokes.length - 1]);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!currentStroke) return;
      const pt = point(e);
      currentStroke.points.push(pt);
      const local = strokes[strokes.length - 1];
      local.points.push(pt);
      drawStroke({ ...local, points: local.points.slice(-2) });
      if (currentStroke.points.length >= 40) flush(false);
    });
    const endStroke = () => flush(true);
    canvas.addEventListener('pointerup', endStroke);
    canvas.addEventListener('pointercancel', endStroke);

    socket.on('draw:stroke', ({ turnId: id, stroke }) => {
      if (id !== turnId) return;
      strokes.push(stroke);
      drawStroke(stroke);
    });
    socket.on('draw:clear', ({ turnId: id }) => {
      if (id !== turnId) return;
      strokes = [];
      redraw();
    });

    return { pen, setTurn, redraw, clear: () => socket.emit('draw:clear') };
  }

  return { create, COLORS, WIDTHS };
})();
