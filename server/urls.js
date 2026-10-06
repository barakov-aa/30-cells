'use strict';

/** Адрес сайта для ссылок-приглашений и QR-кода. */

// «https://zagzak.ru/» → «https://zagzak.ru»; всё, что не http(s)-адрес, отбрасывается.
function parseOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return { origin: url.origin, host: url.host };
  } catch {
    return null;
  }
}

/**
 * Откуда игроки открывают сайт:
 * 1) PUBLIC_URL из настроек сервера, если задан;
 * 2) адрес страницы, с которой запрошен QR-код (экран присылает свой location.origin), —
 *    только если он совпадает с адресом запроса, чтобы в QR нельзя было подставить чужой сайт;
 * 3) адрес самого запроса.
 */
function inviteOrigin({ publicUrl, pageOrigin, host, protocol }) {
  const configured = parseOrigin(publicUrl);
  if (configured) return configured.origin;
  const page = parseOrigin(pageOrigin);
  if (page && host && page.host === host) return page.origin;
  return `${protocol}://${host}`;
}

module.exports = { parseOrigin, inviteOrigin };
