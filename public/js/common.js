'use strict';

window.App = (() => {
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch { /* пустой ответ */ }
    if (!res.ok) {
      const err = new Error(data.error || `Ошибка ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  let toastTimer;
  function toast(text, isError = false) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.toggle('err', isError);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Ссылка скопирована');
    } catch {
      window.prompt('Скопируйте ссылку:', text);
    }
  }

  function storage(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch { /* приватный режим */ }
    return null;
  }

  const STATUS = { lobby: 'Набор команд', playing: 'Идёт игра', finished: 'Завершена' };

  // «482913» → «482 913»: так код легче прочитать вслух и сверить.
  function formatCode(code) {
    const s = String(code ?? '');
    return /^\d{6}$/.test(s) ? `${s.slice(0, 3)} ${s.slice(3)}` : s;
  }

  return { esc, api, toast, copy, storage, formatCode, STATUS };
})();
