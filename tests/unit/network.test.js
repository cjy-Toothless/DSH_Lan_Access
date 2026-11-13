import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isBindableListenHost,
  isIPv4Literal,
  isLinkLocalIPv4,
  isPrivateIPv4,
  listLanAddresses,
  shouldRebindListener,
} from '../../src/host/network.js';

test('isIPv4Literal 接受合法字面量并拒绝非法输入', () => {
  assert.equal(isIPv4Literal('192.168.0.2'), true);
  assert.equal(isIPv4Literal('10.0.0.1'), true);
  assert.equal(isIPv4Literal('203.0.113.7'), true);
  assert.equal(isIPv4Literal(''), false);
  assert.equal(isIPv4Literal('192.168.0'), false);
  assert.equal(isIPv4Literal('192.168.0.256'), false);
  assert.equal(isIPv4Literal('abc.def.ghi.jkl'), false);
  assert.equal(isIPv4Literal(undefined), false);
});

test('isPrivateIPv4 只认可 RFC1918 网段', () => {
  assert.equal(isPrivateIPv4('192.168.1.20'), true);
  assert.equal(isPrivateIPv4('10.10.10.10'), true);
  assert.equal(isPrivateIPv4('172.16.5.5'), true);
  assert.equal(isPrivateIPv4('172.32.5.5'), false);
  assert.equal(isPrivateIPv4('8.8.8.8'), false);
});

test('isLinkLocalIPv4 识别 169.254/16', () => {
  assert.equal(isLinkLocalIPv4('169.254.1.1'), true);
  assert.equal(isLinkLocalIPv4('192.168.1.1'), false);
});

test('isBindableListenHost 拒绝通配/广播/链路本地/组播，接受具体网卡与回环', () => {
  assert.equal(isBindableListenHost('192.168.0.2'), true);
  assert.equal(isBindableListenHost('10.0.0.5'), true);
  assert.equal(isBindableListenHost('127.0.0.1'), true);
  assert.equal(isBindableListenHost('0.0.0.0'), false);
  assert.equal(isBindableListenHost('255.255.255.255'), false);
  assert.equal(isBindableListenHost('169.254.10.20'), false);
  assert.equal(isBindableListenHost('239.1.2.3'), false);
  assert.equal(isBindableListenHost('not-an-ip'), false);
});

test('listLanAddresses 返回字符串数组且不含回环/link-local', () => {
  const addresses = listLanAddresses();
  assert.ok(Array.isArray(addresses));
  for (const address of addresses) {
    assert.equal(typeof address, 'string');
    assert.equal(isIPv4Literal(address), true);
    assert.ok(!address.startsWith('127.'));
    assert.ok(!isLinkLocalIPv4(address));
  }
});

test('shouldRebindListener 识别监听地址失效（DHCP 换 IP 后自动重绑）', () => {
  // 地址仍在：无需重绑
  assert.equal(shouldRebindListener('192.168.0.2', ['192.168.0.2', '10.0.0.5']), false);
  // 地址已不属于本机：需要重绑
  assert.equal(shouldRebindListener('192.168.0.2', ['192.168.0.3']), true);
  // 完全断网：需要重绑（由上层等网络恢复）
  assert.equal(shouldRebindListener('192.168.0.2', []), true);
  // 首尾空白容错
  assert.equal(shouldRebindListener(' 192.168.0.3 ', ['192.168.0.3']), false);
  // 非法地址不做判断，避免误触发
  assert.equal(shouldRebindListener('not-an-ip', []), false);
  assert.equal(shouldRebindListener('', ['192.168.0.3']), false);
});
