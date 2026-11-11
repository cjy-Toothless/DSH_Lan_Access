import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import {
  defaultSettings,
  loadSettings,
  normalizeSettings,
  saveSettings,
  settingsPath,
  validateSettingsPatch,
} from '../../src/host/settings.js';

let previousHome;
let temporaryHome;

before(async () => {
  previousHome = process.env.DSH_HOME;
  temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-lan-access-settings-'));
  process.env.DSH_HOME = temporaryHome;
});

after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  await rm(temporaryHome, { recursive: true, force: true });
});

test('默认设置符合契约', () => {
  assert.deepEqual(defaultSettings(), { enabled: true, listenHost: '', listenPort: 63004 });
});

test('normalizeSettings 丢弃非法字段', () => {
  const normalized = normalizeSettings({
    enabled: 'yes',
    listenHost: 'not-an-ip',
    listenPort: 70000,
  });
  assert.deepEqual(normalized, defaultSettings());
});

test('normalizeSettings 保留合法字段', () => {
  const normalized = normalizeSettings({ enabled: false, listenHost: '192.168.0.2', listenPort: 64000 });
  assert.deepEqual(normalized, { enabled: false, listenHost: '192.168.0.2', listenPort: 64000 });
});

test('设置可原子保存并重新加载', async () => {
  assert.equal(settingsPath(), path.join(temporaryHome, 'lan-access', 'settings.json'));
  await saveSettings({ enabled: false, listenHost: '10.0.0.5', listenPort: 63010 });
  const loaded = await loadSettings();
  assert.deepEqual(loaded, { enabled: false, listenHost: '10.0.0.5', listenPort: 63010 });
});

test('文件缺失时返回给定兜底值', async () => {
  const isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-lan-access-empty-'));
  const savedHome = process.env.DSH_HOME;
  process.env.DSH_HOME = isolatedHome;
  try {
    const loaded = await loadSettings({ fallback: { enabled: true, listenHost: '192.168.1.9', listenPort: 63011 } });
    assert.deepEqual(loaded, { enabled: true, listenHost: '192.168.1.9', listenPort: 63011 });
  } finally {
    process.env.DSH_HOME = savedHome;
    await rm(isolatedHome, { recursive: true, force: true });
  }
});

test('validateSettingsPatch 接受合法补丁', () => {
  const current = defaultSettings();
  assert.deepEqual(validateSettingsPatch({}, current), { ok: true, value: current });
  assert.deepEqual(validateSettingsPatch({ enabled: false }, current), {
    ok: true,
    value: { ...current, enabled: false },
  });
  assert.deepEqual(validateSettingsPatch({ listenHost: '192.168.1.2', listenPort: 63005 }, current), {
    ok: true,
    value: { ...current, listenHost: '192.168.1.2', listenPort: 63005 },
  });
});

test('validateSettingsPatch 拒绝非法补丁', () => {
  const current = defaultSettings();
  assert.equal(validateSettingsPatch(null, current).ok, false);
  assert.equal(validateSettingsPatch({ enabled: 'yes' }, current).ok, false);
  assert.equal(validateSettingsPatch({ listenPort: 80 }, current).ok, false);
  assert.equal(validateSettingsPatch({ listenPort: 3.14 }, current).ok, false);
  assert.equal(validateSettingsPatch({ listenHost: 'localhost' }, current).ok, false);
});
