'use strict';

(() => {
  const { esc, api, toast, copy, STATUS } = window.App;
  const $ = (sel) => document.querySelector(sel);

  async function init() {
    const { admin } = await api('GET', '/api/admin/me');
    $('#login').classList.toggle('hidden', admin);
    $('#dashboard').classList.toggle('hidden', !admin);
    $('#logout').classList.toggle('hidden', !admin);
    if (admin) loadGames();
    else $('#login-name').focus();
  }

  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      await api('POST', '/api/admin/login', { login: $('#login-name').value, password: $('#login-pass').value });
      // Переход на страницу после отправки формы — сигнал браузеру, что вход удался:
      // так Chrome, Яндекс Браузер, Firefox и Safari предлагают сохранить логин и пароль.
      window.location.replace(window.location.pathname + window.location.search);
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });

  $('#logout').addEventListener('click', async () => {
    await api('POST', '/api/admin/logout');
    init();
  });

  document.querySelectorAll('.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      $('#tab-games').classList.toggle('hidden', btn.dataset.tab !== 'games');
      $('#tab-cards').classList.toggle('hidden', btn.dataset.tab !== 'cards');
      $('#tab-complications').classList.toggle('hidden', btn.dataset.tab !== 'complications');
      if (btn.dataset.tab === 'cards') loadCards();
      if (btn.dataset.tab === 'complications') loadComplications();
    });
  });

  const inviteUrl = (code) => `${location.origin}/join/${code}`;

  async function loadGames() {
    let games;
    try {
      ({ games } = await api('GET', '/api/admin/games'));
    } catch (err) {
      if (err.status === 401) return init();
      throw err;
    }
    const root = $('#games');
    if (games.length === 0) {
      root.innerHTML = '<p class="muted">Пока нет игр. Создайте первую!</p>';
      return;
    }
    root.innerHTML = games.map((g) => `
      <div class="card game-item" data-id="${esc(g.id)}">
        <div style="flex: 1 1 260px; min-width: 0">
          <div class="row"><span class="title">${esc(g.name)}</span><span class="badge ${esc(g.status)}">${STATUS[g.status]}</span></div>
          <div class="muted small">${new Date(g.createdAt).toLocaleString('ru-RU')} · игроков: ${g.players}${g.winner ? ` · 🏆 ${esc(g.winner)}` : ''}</div>
          <div class="row small" style="margin-top: 4px">
            ${g.teams.map((t) => `<span class="row" style="gap: 4px"><span class="dot" style="background:${esc(t.color)}"></span>${esc(t.name)} (${t.players}/2) — ${t.position}</span>`).join('') || '<span class="muted">Команд нет</span>'}
          </div>
          <div class="invite" style="margin-top: 6px">${esc(inviteUrl(g.code))}</div>
        </div>
        <div class="row">
          <button data-copy="${esc(g.code)}">📋 Ссылка для гостей</button>
          <a class="btn" href="/screen/${esc(g.screenCode)}" target="_blank" rel="noopener" title="Поле для общего экрана">📺 Экран</a>
          <a class="btn primary" href="/admin/game/${esc(g.id)}">Открыть</a>
          <button class="icon" data-del="${esc(g.id)}" title="Удалить">🗑️</button>
        </div>
      </div>`).join('');
  }

  $('#games').addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) return copy(inviteUrl(copyBtn.dataset.copy));
    const delBtn = e.target.closest('[data-del]');
    if (delBtn && confirm('Удалить игру безвозвратно?')) {
      await api('DELETE', `/api/admin/games/${delBtn.dataset.del}`);
      loadGames();
    }
  });

  $('#create').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { game } = await api('POST', '/api/admin/games', { name: $('#create-name').value, teams: Number($('#create-teams').value) });
      $('#create-name').value = '';
      await loadGames();
      copy(inviteUrl(game.code));
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---------- Карточки и усложнения ----------
  const cardsEditor = window.ListEditor.create($('#cards-editor'), {
    title: 'Колоды карточек',
    hint: 'Каждая карточка выпадает в игре не больше одного раза. Одинаковые слова на разных карточках и в разных '
      + 'категориях разрешены — редактор только подсказывает 🔁, где такое слово уже есть (нажмите, чтобы перейти). '
      + 'Изменения сохраняются сразу.',
    url: '/api/admin/cards',
    key: 'cards',
    schema: window.ListEditor.cardsSchema,
  });
  const complicationsEditor = window.ListEditor.create($('#complications-editor'), {
    title: '⚠️ Усложнения для клеток-ловушек',
    hint: 'У каждой команды на клетках 10–29 спрятаны свои ловушки (их видит только администратор). Если команда начинает ход '
      + 'с ловушки, к заданию добавляется случайное усложнение для выпавшей категории. Очки не меняются. '
      + 'Пустой список — ловушка в этой категории ничего не меняет. Изменения сохраняются сразу.',
    url: '/api/admin/complications',
    key: 'complications',
    schema: window.ListEditor.complicationsSchema,
  });
  const loadCards = () => cardsEditor.load().catch((err) => toast(err.message, true));
  const loadComplications = () => complicationsEditor.load().catch((err) => toast(err.message, true));

  init().catch((err) => toast(err.message, true));
})();
