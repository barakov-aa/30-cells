'use strict';

/**
 * Редактор списков по категориям (карточки и усложнения).
 * Слева — категории со счётчиками, справа — список с поиском, добавлением,
 * правкой и удалением. Каждое изменение сразу сохраняется на сервер.
 */
window.ListEditor = (() => {
  const { esc, api, toast } = window.App;

  const normalize = (s) => String(s).toLowerCase().replace(/ё/g, 'е').replace(/[«»"'“”„.,!?()]/g, '').replace(/\s+/g, ' ').trim();

  function create(root, opts) {
    const { title, hint, url, key, schema } = opts;
    let data = {};
    let categories = {};
    let current = null;
    let editing = -1;
    let query = '';
    let loaded = false;
    let saving = Promise.resolve();
    let undoItem = null;
    let undoTimer = null;

    root.innerHTML = `
      <div class="ed-head">
        <h2>${esc(title)}</h2>
        <span class="ed-status muted small"></span>
        <div class="spacer"></div>
        <button data-ed="bulk-toggle">📋 Добавить списком</button>
        <button data-ed="reset">↺ Стандартный набор</button>
      </div>
      <p class="muted small ed-hint">${hint}</p>
      <div class="ed-body">
        <nav class="ed-cats"></nav>
        <section class="ed-main"></section>
      </div>`;
    const $ = (sel) => root.querySelector(sel);

    function setStatus(text) {
      $('.ed-status').textContent = text;
    }

    // ---------- Данные ----------

    const fieldsOf = (cat) => schema.fields(cat);
    const wordsOf = (cat, item) => schema.words(cat, item).map(normalize).filter(Boolean);

    /** Уникальные слова записи в исходном написании и в нормализованном виде. */
    function wordPairs(cat, item) {
      const seen = new Set();
      return schema.words(cat, item)
        .map((orig) => ({ orig: String(orig).trim(), norm: normalize(orig) }))
        .filter(({ norm }) => norm && !seen.has(norm) && seen.add(norm));
    }

    /**
     * Где ещё встречаются слова записи — по всем категориям (карточки) или внутри своей (усложнения).
     * Возвращает функцию (cat, idx, item) → [{ word, places: [{ cat, idx }] }].
     */
    function duplicates() {
      const index = new Map();
      const keyOf = (cat, norm) => (schema.crossCategory ? norm : `${cat}:${norm}`);
      for (const [cat, list] of Object.entries(data)) {
        list.forEach((item, idx) => {
          for (const { norm } of wordPairs(cat, item)) {
            const k = keyOf(cat, norm);
            if (!index.has(k)) index.set(k, []);
            index.get(k).push({ cat, idx });
          }
        });
      }
      return (cat, idx, item) => wordPairs(cat, item)
        .map(({ orig, norm }) => ({
          word: orig,
          places: (index.get(keyOf(cat, norm)) || []).filter((p) => !(p.cat === cat && p.idx === idx)),
        }))
        .filter((d) => d.places.length);
    }

    function dupInfoHtml(cat, dups) {
      const MAX = 4;
      return dups.map(({ word, places }) => {
        const items = places.slice(0, MAX).map((p) => {
          const c = categories[p.cat] || { icon: '', title: p.cat };
          const where = p.cat === cat ? 'в этой же категории' : `${esc(c.icon)} ${esc(c.title)}`;
          return `<button class="link ed-goto" data-goto-cat="${esc(p.cat)}" data-goto-word="${esc(word)}"
            title="Перейти к этой карточке">${where} — «${esc(schema.plain(p.cat, data[p.cat][p.idx]))}»</button>`;
        });
        const more = places.length > MAX ? ` и ещё ${places.length - MAX}` : '';
        return `<div class="ed-dupinfo">🔁 «${esc(word)}» уже есть: ${items.join('; ')}${more}</div>`;
      }).join('');
    }

    /** Короткий текст о повторах для всплывающего сообщения. */
    function dupSummary(cat, dups) {
      return dups.map(({ word, places }) => {
        const where = [...new Set(places.map((p) => (p.cat === cat ? 'эта же категория' : categories[p.cat]?.title || p.cat)))];
        return `«${word}» уже есть: ${where.join(', ')}`;
      }).join('; ');
    }

    function persist() {
      setStatus('Сохранение…');
      saving = saving
        .then(() => api('PUT', url, { [key]: data }))
        .then((res) => {
          data = res[key];
          setStatus('✓ Сохранено');
          renderNav();
          if (editing === -1) renderList();
        })
        .catch(async (err) => {
          toast(err.message, true);
          setStatus('');
          await load();
        });
      return saving;
    }

    async function load() {
      const res = await api('GET', url);
      data = res[key];
      categories = res.categories;
      if (!current || !categories[current]) current = Object.keys(categories)[0];
      loaded = true;
      editing = -1;
      renderNav();
      renderMain();
    }

    // ---------- Отрисовка ----------

    function renderNav() {
      $('.ed-cats').innerHTML = Object.entries(categories).map(([cat, c]) => `
        <button class="ed-cat ${cat === current ? 'active' : ''}" data-cat="${cat}">
          <span class="ed-cat-icon">${esc(c.icon)}</span>
          <span class="ed-cat-title">${esc(c.title)}</span>
          <span class="ed-count">${(data[cat] || []).length}</span>
        </button>`).join('');
    }

    function inputsHtml(cat, values = [], cls = '') {
      const fields = fieldsOf(cat);
      return `<div class="ed-fields ed-fields-${fields.length} ${cls}">${fields.map((f, i) =>
        `<input data-field="${i}" placeholder="${esc(f)}" value="${esc(values[i] ?? '')}" maxlength="120">`).join('')}</div>`;
    }

    function renderMain() {
      const c = categories[current];
      $('.ed-main').innerHTML = `
        <div class="ed-cat-head">
          <span class="ed-cat-big">${esc(c.icon)}</span>
          <div><b>${esc(c.title)}</b><div class="muted small">${esc(schema.meta(current, c))}</div></div>
        </div>
        <form class="ed-add">
          ${inputsHtml(current)}
          <button class="primary" type="submit">＋ Добавить</button>
        </form>
        <div class="ed-bulk hidden">
          <textarea rows="6" placeholder="${esc(schema.bulkHint(current))}"></textarea>
          <button data-ed="bulk-add" class="primary">Добавить все строки</button>
        </div>
        <div class="ed-undo hidden"></div>
        <div class="ed-tools">
          <input class="ed-search" type="search" placeholder="🔍 Поиск" value="${esc(query)}">
          <span class="ed-found muted small"></span>
        </div>
        <ul class="ed-list"></ul>`;
      renderList();
    }

    function itemHtml(cat, item, idx, dups) {
      if (idx === editing) {
        return `<li class="ed-item editing" data-idx="${idx}">
          ${inputsHtml(cat, schema.toFields(cat, item), 'ed-edit')}
          <div class="ed-actions">
            <button class="ok icon" data-ed="save" title="Сохранить (Enter)">✓</button>
            <button class="icon" data-ed="cancel" title="Отмена (Esc)">✕</button>
          </div></li>`;
      }
      return `<li class="ed-item" data-idx="${idx}">
        <div class="ed-text">${schema.display(cat, item)}${dups.length ? dupInfoHtml(cat, dups) : ''}</div>
        <div class="ed-actions">
          <button class="icon" data-ed="edit" title="Изменить">✎</button>
          <button class="icon" data-ed="delete" title="Удалить">🗑️</button>
        </div></li>`;
    }

    function renderList() {
      const list = data[current] || [];
      const dupsOf = duplicates();
      const q = normalize(query);
      const rows = list
        .map((item, idx) => ({ item, idx }))
        .filter(({ item }) => !q || wordsOf(current, item).some((w) => w.includes(q)));
      $('.ed-list').innerHTML = rows.length
        ? rows.map(({ item, idx }) => itemHtml(current, item, idx, dupsOf(current, idx, item))).join('')
        : `<li class="ed-empty muted">${q ? 'Ничего не найдено' : 'Список пуст — добавьте первую запись'}</li>`;
      $('.ed-found').textContent = q ? `найдено: ${rows.length} из ${list.length}` : `всего: ${list.length}`;
      if (editing !== -1) root.querySelector('.ed-item.editing input')?.focus();
    }

    function showUndo(text) {
      const el = $('.ed-undo');
      el.innerHTML = `Удалено: «${esc(text)}» <button class="link" data-ed="undo">Вернуть</button>`;
      el.classList.remove('hidden');
      clearTimeout(undoTimer);
      undoTimer = setTimeout(() => el.classList.add('hidden'), 8000);
    }

    // ---------- Действия ----------

    function readFields(container) {
      return [...container.querySelectorAll('[data-field]')].map((i) => i.value.trim());
    }

    function addItem(values, { quiet = false } = {}) {
      const result = schema.fromFields(current, values);
      if (result.error) {
        if (!quiet) toast(result.error, true);
        return false;
      }
      const exists = (data[current] || []).some((it) => wordsOf(current, it).join('|') === wordsOf(current, result.item).join('|'));
      if (exists) {
        if (!quiet) toast(`Такая запись уже есть в категории «${categories[current]?.title || current}»`, true);
        return false;
      }
      data[current] = [result.item, ...(data[current] || [])];
      if (!quiet) {
        const dups = duplicates()(current, 0, result.item);
        if (dups.length) toast(`Добавлено. ${dupSummary(current, dups)}`);
      }
      return true;
    }

    root.addEventListener('click', async (e) => {
      // Переход к повторяющейся карточке: открываем её категорию с поиском по слову.
      const go = e.target.closest('[data-goto-cat]');
      if (go) {
        current = go.dataset.gotoCat;
        editing = -1;
        query = go.dataset.gotoWord;
        renderNav();
        renderMain();
        return;
      }
      const cat = e.target.closest('[data-cat]');
      if (cat) {
        current = cat.dataset.cat;
        editing = -1;
        query = '';
        renderNav();
        renderMain();
        return;
      }
      const btn = e.target.closest('[data-ed]');
      if (!btn) return;
      const li = btn.closest('.ed-item');
      const idx = li ? Number(li.dataset.idx) : -1;
      switch (btn.dataset.ed) {
        case 'edit':
          editing = idx;
          renderList();
          break;
        case 'cancel':
          editing = -1;
          renderList();
          break;
        case 'save': {
          const result = schema.fromFields(current, readFields(li));
          if (result.error) return toast(result.error, true);
          data[current][idx] = result.item;
          editing = -1;
          renderList();
          persist();
          const dups = duplicates()(current, idx, result.item);
          if (dups.length) toast(`Сохранено. ${dupSummary(current, dups)}`);
          break;
        }
        case 'delete': {
          const list = data[current];
          const minItems = typeof schema.minItems === 'function' ? schema.minItems(current) : schema.minItems;
          if (minItems && list.length <= minItems) {
            return toast('В колоде должна остаться хотя бы одна карточка', true);
          }
          const [removed] = list.splice(idx, 1);
          undoItem = { cat: current, idx, item: removed };
          showUndo(schema.plain(current, removed));
          renderList();
          persist();
          break;
        }
        case 'undo': {
          if (!undoItem) return undefined;
          const { cat: c, idx: i, item } = undoItem;
          data[c].splice(Math.min(i, data[c].length), 0, item);
          undoItem = null;
          $('.ed-undo').classList.add('hidden');
          renderList();
          persist();
          break;
        }
        case 'bulk-toggle': {
          const panel = $('.ed-bulk');
          panel.classList.toggle('hidden');
          if (!panel.classList.contains('hidden')) panel.querySelector('textarea').focus();
          break;
        }
        case 'bulk-add': {
          const ta = $('.ed-bulk textarea');
          const lines = ta.value.split('\n').map((s) => s.trim()).filter(Boolean);
          let added = 0;
          // Добавляем с конца, чтобы порядок в списке совпал с порядком строк.
          for (const line of lines.reverse()) if (addItem(schema.parseLine(current, line), { quiet: true })) added += 1;
          const skipped = lines.length - added;
          ta.value = '';
          renderNav();
          renderList();
          if (added) persist();
          toast(`Добавлено: ${added}${skipped ? `, пропущено (повторы или неполные строки): ${skipped}` : ''}`, !added);
          break;
        }
        case 'reset':
          if (!confirm(`Заменить все списки раздела «${title}» стандартным набором? Ваши изменения пропадут.`)) return undefined;
          try {
            const res = await api('POST', `${url}/reset`);
            data = res[key];
            editing = -1;
            renderNav();
            renderMain();
            setStatus('✓ Стандартный набор восстановлен');
          } catch (err) {
            toast(err.message, true);
          }
          break;
        default:
      }
      return undefined;
    });

    root.addEventListener('submit', (e) => {
      if (!e.target.classList.contains('ed-add')) return;
      e.preventDefault();
      if (!addItem(readFields(e.target))) return;
      e.target.querySelectorAll('[data-field]').forEach((i) => { i.value = ''; });
      e.target.querySelector('[data-field]').focus();
      query = '';
      $('.ed-search').value = '';
      renderNav();
      renderList();
      persist();
    });

    root.addEventListener('input', (e) => {
      if (e.target.classList.contains('ed-search')) {
        query = e.target.value;
        renderList();
      }
    });

    root.addEventListener('keydown', (e) => {
      const li = e.target.closest('.ed-item.editing');
      if (!li) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        li.querySelector('[data-ed="save"]').click();
      } else if (e.key === 'Escape') {
        li.querySelector('[data-ed="cancel"]').click();
      }
    });

    return {
      load: () => (loaded ? Promise.resolve() : load()),
      reload: load,
    };
  }

  // ---------- Схемы данных ----------

  const MOVIE_COUNT = 5;

  const cardsSchema = {
    crossCategory: true,
    // Пул «?» может быть пустым: тогда «?» берёт слова из обычных колод.
    minItems: (cat) => (cat === 'random' ? 0 : 1),
    fields: (cat) => {
      if (cat === 'random') return ['Слово или выражение про гостей, например «Лыжи Миши»'];
      if (cat === 'music') return ['Первое слово', 'Второе слово'];
      if (cat === 'movies') return Array.from({ length: MOVIE_COUNT }, (_, i) => `Название ${i + 1}`);
      if (cat === 'yesno') return ['Персонаж, которого нужно угадать'];
      return ['Слово или выражение'];
    },
    words: (cat, item) => (Array.isArray(item) ? item : cat === 'music' ? String(item).split('/') : [item]),
    toFields: (cat, item) => (Array.isArray(item) ? item : cat === 'music' ? String(item).split('/').map((s) => s.trim()) : [item]),
    fromFields: (cat, values) => {
      const v = values.map((s) => String(s ?? '').replace(/\s+/g, ' ').trim());
      if (cat === 'music') {
        if (!v[0] || !v[1]) return { error: 'Для «Песен» нужны оба слова' };
        if (v.some((s) => s.includes('/'))) return { error: 'Слова не должны содержать «/»' };
        return { item: `${v[0]} / ${v[1]}` };
      }
      if (cat === 'movies') {
        const titles = v.filter(Boolean);
        if (titles.length < MOVIE_COUNT) return { error: `На карточке «Кино» должно быть ${MOVIE_COUNT} названий` };
        if (titles.some((s) => s.includes(';'))) return { error: 'Названия не должны содержать «;»' };
        return { item: titles.slice(0, MOVIE_COUNT) };
      }
      if (!v[0]) return { error: 'Введите текст карточки' };
      return { item: v[0] };
    },
    parseLine: (cat, line) => {
      if (cat === 'music') return line.split('/');
      if (cat === 'movies') return line.split(';');
      return [line];
    },
    bulkHint: (cat) => {
      if (cat === 'music') return 'Одна карточка в строке, слова через «/»\nСолнце / Дорога\nЗима / Ночь';
      if (cat === 'movies') return 'Одна карточка в строке, 5 названий через «;»\nТитаник; Шрек; Друзья; Матрица; Брат';
      return 'Одна карточка в строке\nХолодильник\nСамокат';
    },
    display: (cat, item) => {
      if (Array.isArray(item)) {
        return `<div class="ed-movies">${item.map((t, i) => `<span class="ed-chip"><b>${i + 1}</b> ${esc(t)}</span>`).join('')}</div>`;
      }
      if (cat === 'music') {
        return String(item).split('/').map((w) => `<span class="ed-chip">${esc(w.trim())}</span>`).join('<span class="muted"> + </span>');
      }
      return esc(item);
    },
    plain: (cat, item) => (Array.isArray(item) ? item.join('; ') : String(item)),
    meta: (cat, c) => {
      if (cat === 'random') {
        return 'Только для грани «?»: задание (Да / Нет, словами или жестами) выбирается случайно, '
          + 'слово — отсюда. Пустой пул — «?» берёт слова из обычных колод этих заданий.';
      }
      return cat === 'movies'
        ? `${c.seconds} сек · 1 балл за каждый угаданный · 5 названий на карточке`
        : `${c.seconds} сек · ${c.points} б.`;
    },
  };

  const complicationsSchema = {
    crossCategory: false,
    minItems: 0,
    fields: () => ['Текст усложнения, например «Показывать только одной рукой»'],
    words: (cat, item) => [item],
    toFields: (cat, item) => [item],
    fromFields: (cat, values) => {
      const text = String(values[0] ?? '').replace(/\s+/g, ' ').trim();
      return text ? { item: text } : { error: 'Введите текст усложнения' };
    },
    parseLine: (cat, line) => [line],
    bulkHint: () => 'Одно усложнение в строке\nПоказывать только одной рукой\nНельзя использовать глаголы',
    display: (cat, item) => esc(item),
    plain: (cat, item) => String(item),
    meta: (cat, c) => `Срабатывает, если на ловушке выпала категория «${c.title}»`,
  };

  return { create, cardsSchema, complicationsSchema };
})();
