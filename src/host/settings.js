/**
 * 插件设置持久化。
 *
 * 只保存运行参数（开关 / 监听地址 / 端口），写入 `$DSH_HOME/lan-access/settings.json`；
 * 不读写 profile 的 cordis.patch.yml（那是用户与插件管理器共同拥有的文件）。
 * 写入使用「临时文件 + rename」保证原子性，避免断电/崩溃留下半截 JSON。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_LISTEN_PORT,
  MAX_LISTEN_PORT,
  MIN_LISTEN_PORT,
  SETTINGS_DIR,
  SETTINGS_FILE_NAME,
} from './contract.js';
import { isIPv4Literal } from './network.js';

/**
 * 解析 DSH 主目录。
 * 插件进程未必继承 `DSH_HOME`，因此提供 `~/.dsh` 兜底（DSH 默认位置）。
 * @returns {string} 绝对路径。
 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv);
  return path.join(os.homedir(), '.dsh');
}

/**
 * 设置文件绝对路径。
 * @returns {string} 绝对路径。
 */
export function settingsPath() {
  return path.join(resolveDshHome(), SETTINGS_DIR, SETTINGS_FILE_NAME);
}

/**
 * 设置默认值。
 * @returns {{ enabled: boolean, listenHost: string, listenPort: number }} 默认设置。
 */
export function defaultSettings() {
  return { enabled: true, listenHost: '', listenPort: DEFAULT_LISTEN_PORT };
}

/**
 * 校验并归一化设置对象（用于加载旧文件或合并用户修改）。
 * 非法字段退回默认值；`enabled` 保持严格布尔。
 * @param {unknown} raw - 原始对象。
 * @param {{ enabled: boolean, listenHost: string, listenPort: number }} fallback - 兜底值。
 * @returns {{ enabled: boolean, listenHost: string, listenPort: number }} 归一化结果。
 */
export function normalizeSettings(raw, fallback = defaultSettings()) {
  const source = typeof raw === 'object' && raw !== null ? raw : {};
  const enabled = typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled;
  const listenHost =
    typeof source.listenHost === 'string' && (source.listenHost === '' || isIPv4Literal(source.listenHost))
      ? source.listenHost
      : fallback.listenHost;
  const listenPort =
    Number.isInteger(source.listenPort) &&
    source.listenPort >= MIN_LISTEN_PORT &&
    source.listenPort <= MAX_LISTEN_PORT
      ? source.listenPort
      : fallback.listenPort;
  return { enabled, listenHost, listenPort };
}

/**
 * 加载设置；文件不存在时返回兜底值。
 * @param {object} [options] - 调用选项。
 * @param {{ enabled: boolean, listenHost: string, listenPort: number }} [options.fallback] - 文件缺失时的兜底设置。
 * @param {(level: string, message: string) => void} [options.log] - 日志函数。
 * @returns {Promise<{ enabled: boolean, listenHost: string, listenPort: number }>} 设置。
 */
export async function loadSettings(options = {}) {
  const fallback = options.fallback ?? defaultSettings();
  const file = settingsPath();
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
  try {
    return normalizeSettings(JSON.parse(text), fallback);
  } catch (error) {
    options.log?.('warn', `设置文件无法解析，已回退兜底值：${file}（${error.message}）`);
    return fallback;
  }
}

/**
 * 原子保存设置。
 * @param {{ enabled: boolean, listenHost: string, listenPort: number }} settings - 待保存设置。
 * @returns {Promise<void>} 保存完成。
 */
export async function saveSettings(settings) {
  const file = settingsPath();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(settings, null, 2)}\n`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, file);
}

/**
 * 校验来自设置页的更新补丁。
 * @param {unknown} patch - 客户端提交的对象。
 * @param {{ enabled: boolean, listenHost: string, listenPort: number }} current - 当前设置。
 * @returns {{ ok: true, value: object } | { ok: false, message: string }} 校验结果。
 */
export function validateSettingsPatch(patch, current) {
  if (typeof patch !== 'object' || patch === null) {
    return { ok: false, message: '更新参数必须是对象' };
  }
  const next = { ...current };
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') return { ok: false, message: 'enabled 必须是布尔值' };
    next.enabled = patch.enabled;
  }
  if (patch.listenHost !== undefined) {
    if (typeof patch.listenHost !== 'string') return { ok: false, message: 'listenHost 必须是字符串' };
    if (patch.listenHost !== '' && !isIPv4Literal(patch.listenHost)) {
      return { ok: false, message: 'listenHost 必须是本机 IPv4 地址或空字符串（自动选择）' };
    }
    next.listenHost = patch.listenHost;
  }
  if (patch.listenPort !== undefined) {
    const port = patch.listenPort;
    if (!Number.isInteger(port) || port < MIN_LISTEN_PORT || port > MAX_LISTEN_PORT) {
      return { ok: false, message: `listenPort 必须是 ${MIN_LISTEN_PORT}-${MAX_LISTEN_PORT} 的整数` };
    }
    next.listenPort = port;
  }
  return { ok: true, value: next };
}
