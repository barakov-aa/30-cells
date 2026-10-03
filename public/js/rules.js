'use strict';

/**
 * Правила игры — одно место для главной страницы и общего экрана.
 * Время, баллы и номера клеток берутся из /api/config, чтобы текст не расходился с игрой.
 */
window.Rules = (() => {
  const { esc } = window.App;

  function plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  const points = (n) => `${n} ${plural(n, 'балл', 'балла', 'баллов')}`;

  function faces(config) {
    const c = config.categories;
    const meta = (key) => `${c[key].seconds} сек · ${points(c[key].points)}`;
    return [
      { icon: c.yesno.icon, title: c.yesno.title, text: `Угадать персонажа вопросами, на которые отвечают только «да» или «нет» · ${meta('yesno')}` },
      { icon: c.talk.icon, title: c.talk.title, text: `Объяснить слово, не называя его · ${meta('talk')}` },
      { icon: c.gestures.icon, title: c.gestures.title, text: `Показать слово без слов и звуков · ${meta('gestures')}` },
      { icon: c.music.icon, title: c.music.title, text: `Объяснить 2 слова, напевая песни, где они встречаются · ${meta('music')}` },
      { icon: c.drawing.icon, title: c.drawing.title, text: `Нарисовать слово или выражение, без букв и цифр · ${meta('drawing')}` },
      {
        icon: '?',
        title: 'Случайное задание',
        text: `${c.yesno.title}, ${c.talk.title.toLowerCase()} или ${c.gestures.title.toLowerCase()} — слово про гостей игры (время и баллы — как у выпавшего задания)`,
      },
    ];
  }

  function rules(config) {
    const movie = config.movieCells.join(' и ');
    const m = config.categories.movies;
    const [trapFrom, trapTo] = config.trapCells || [10, 29];
    return [
      `👥 Команды по ${config.maxTeamSize} человека. В свой ход команда бросает кубик: один игрок объясняет, второй угадывает, роли меняются каждый ход. Карточку видит только объясняющий.`,
      '👣 Заработанные баллы — это количество клеток, на которое фишка идёт вперёд. Не справились — фишка стоит на месте.',
      `🎬 Клетки ${movie}: вместо кубика команда тянет карточку с 5 фильмами, сериалами или мультфильмами — ${m.seconds} сек, 1 балл за каждый угаданный. Удвоение здесь не действует.`,
      `✖2 У каждой команды ${config.doublesPerTeam} фишки «Удвоение». Её ставят до старта таймера: справились — баллы удваиваются, не справились — команда отступает назад на удвоенные баллы.`,
      `⚠️ Ловушки: у каждой команды на клетках ${trapFrom}–${trapTo} спрятаны свои ловушки — их знает только ведущий. Если команда начинает ход с ловушки, к заданию добавляется усложнение (например, «вопросы только одним словом» или «показывать одной рукой»). Очки не меняются, каждая ловушка срабатывает один раз.`,
      '🔁 Каждая карточка выпадает за игру не больше одного раза.',
      `🏁 Побеждает команда, первой дошедшая до клетки ${config.boardSize}.`,
    ];
  }

  /** Разметка правил: грани кубика и основные правила. */
  function html(config) {
    return `
      <h2>Грани кубика</h2>
      <div class="face-list">${faces(config).map((f) => `
        <div class="face"><div class="die-mini">${esc(f.icon)}</div>
          <div><b>${esc(f.title)}</b><br><span class="muted small">${esc(f.text)}</span></div></div>`).join('')}
      </div>
      <h2>Правила</h2>
      <ul class="rules-list">${rules(config).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
  }

  return { html };
})();
