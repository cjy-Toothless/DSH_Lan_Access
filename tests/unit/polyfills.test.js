import assert from 'node:assert/strict';
import { test } from 'node:test';

import { POLYFILL_MARKER, injectInsecureContextPolyfills } from '../../src/host/polyfills.js';

test('polyfill 注入到 head 之后且只注入一次', () => {
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><script>app()</script></body></html>';
  const injected = injectInsecureContextPolyfills(html);
  assert.ok(injected.includes(POLYFILL_MARKER));
  assert.ok(injected.indexOf(POLYFILL_MARKER) > injected.indexOf('<head>'));
  assert.ok(injected.indexOf(POLYFILL_MARKER) < injected.indexOf('<meta'));
  assert.equal(injectInsecureContextPolyfills(injected), injected);
});

test('没有 head 时前置注入', () => {
  const injected = injectInsecureContextPolyfills('<body>hi</body>');
  assert.ok(injected.startsWith('<script'));
  assert.ok(injected.endsWith('<body>hi</body>'));
});

test('非字符串输入原样返回', () => {
  assert.equal(injectInsecureContextPolyfills(undefined), undefined);
  assert.equal(injectInsecureContextPolyfills(''), '');
});
