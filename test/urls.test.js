'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inviteOrigin } = require('../server/urls');

test('QR ведёт на адрес, по которому открыт экран (https за nginx)', () => {
  assert.equal(inviteOrigin({ pageOrigin: 'https://zagzak.ru', host: 'zagzak.ru', protocol: 'http' }), 'https://zagzak.ru');
  assert.equal(inviteOrigin({ pageOrigin: 'https://zagzak.ru:8443', host: 'zagzak.ru:8443', protocol: 'http' }), 'https://zagzak.ru:8443');
});

test('PUBLIC_URL важнее адреса страницы, лишний слеш убирается', () => {
  assert.equal(inviteOrigin({ publicUrl: 'https://zagzak.ru/', pageOrigin: 'http://212.193.4.183', host: '212.193.4.183', protocol: 'http' }), 'https://zagzak.ru');
});

test('чужой адрес страницы не подставляется в QR', () => {
  assert.equal(inviteOrigin({ pageOrigin: 'https://evil.example', host: 'zagzak.ru', protocol: 'https' }), 'https://zagzak.ru');
  assert.equal(inviteOrigin({ pageOrigin: 'javascript:alert(1)', host: 'zagzak.ru', protocol: 'https' }), 'https://zagzak.ru');
  assert.equal(inviteOrigin({ publicUrl: 'не адрес', host: 'localhost:3000', protocol: 'http' }), 'http://localhost:3000');
});
