import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rewriteRequestHeaders, rewriteResponseHeaders } from '../../src/host/proxy.js';

const BROWSER_ORIGIN = 'http://192.168.0.2:63004';

test('改写 Host/Origin/Referer 为固定回环权威', () => {
  const headers = rewriteRequestHeaders(
    {
      host: '192.168.0.2:63004',
      origin: BROWSER_ORIGIN,
      referer: `${BROWSER_ORIGIN}/chat`,
      cookie: 'dsh-session=abc',
      'sec-fetch-site': 'same-origin',
    },
    BROWSER_ORIGIN,
  );
  assert.equal(headers.host, '127.0.0.1:3080');
  assert.equal(headers.origin, 'http://127.0.0.1:3080');
  assert.equal(headers.referer, 'http://127.0.0.1:3080/chat');
  assert.equal(headers.cookie, 'dsh-session=abc');
  assert.equal(headers['sec-fetch-site'], 'same-origin');
});

test('普通请求移除逐跳头与 Expect', () => {
  const headers = rewriteRequestHeaders(
    {
      host: '192.168.0.2:63004',
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
      expect: '100-continue',
      'content-length': '10',
    },
    BROWSER_ORIGIN,
  );
  assert.equal(headers.connection, undefined);
  assert.equal(headers['transfer-encoding'], undefined);
  assert.equal(headers.expect, undefined);
  assert.equal(headers['content-length'], '10');
});

test('升级请求保留连接与升级头', () => {
  const headers = rewriteRequestHeaders(
    {
      host: '192.168.0.2:63004',
      origin: BROWSER_ORIGIN,
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': 'abc',
    },
    BROWSER_ORIGIN,
    { upgrade: true },
  );
  assert.equal(headers.connection, 'Upgrade');
  assert.equal(headers.upgrade, 'websocket');
  assert.equal(headers['sec-websocket-key'], 'abc');
  assert.equal(headers.host, '127.0.0.1:3080');
});

test('绝对 Location 指向上游时改回浏览器 origin', () => {
  const state = { browserOrigin: BROWSER_ORIGIN, upstreamOrigin: 'http://127.0.0.1:63003' };
  const headers = rewriteResponseHeaders({ location: 'http://127.0.0.1:63003/chat?x=1' }, state);
  assert.equal(headers.location, `${BROWSER_ORIGIN}/chat?x=1`);
});

test('相对或第三方 Location 原样保留', () => {
  const state = { browserOrigin: BROWSER_ORIGIN, upstreamOrigin: 'http://127.0.0.1:63003' };
  assert.equal(rewriteResponseHeaders({ location: './' }, state).location, './');
  assert.equal(
    rewriteResponseHeaders({ location: 'https://example.com/x' }, state).location,
    'https://example.com/x',
  );
});
