import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_LISTEN_PORT,
  MAX_LISTEN_PORT,
  MIN_LISTEN_PORT,
  RPC_CHANNEL,
  UPSTREAM_HOST_HEADER,
  UPSTREAM_ORIGIN_HEADER,
} from '../../src/host/contract.js';

test('RPC 契约常量稳定', () => {
  assert.equal(RPC_CHANNEL, '/dsh-lan-access');
  assert.equal(UPSTREAM_HOST_HEADER, '127.0.0.1:3080');
  assert.equal(UPSTREAM_ORIGIN_HEADER, 'http://127.0.0.1:3080');
});

test('端口默认值落在允许区间内', () => {
  assert.ok(DEFAULT_LISTEN_PORT >= MIN_LISTEN_PORT);
  assert.ok(DEFAULT_LISTEN_PORT <= MAX_LISTEN_PORT);
});
