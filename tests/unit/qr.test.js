import assert from 'node:assert/strict';
import { test } from 'node:test';

import { qrSvgFor } from '../../src/host/qr.js';

test('qrSvgFor 生成合法 SVG', () => {
  const svg = qrSvgFor('http://192.168.0.2:63004/');
  assert.equal(typeof svg, 'string');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('</svg>'));
  assert.ok(!svg.includes('<script'));
});

test('空内容返回 null', () => {
  assert.equal(qrSvgFor(''), null);
  assert.equal(qrSvgFor(null), null);
  assert.equal(qrSvgFor(undefined), null);
});
