/**
 * dsh-lan-access Host 插件入口。
 *
 * 职责：读取/持久化运行设置，在局域网 IPv4 上启动反向代理（HTTP + WebSocket），
 * 通过 Connection RPC 暴露状态与设置更新接口，并向 DSH 页面注入非安全上下文 polyfill。
 * 监听器的创建/销毁全部挂在 Cordis effect 上，插件卸载即释放端口与全部连接。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  AUTH_MODE,
  DEFAULT_LISTEN_PORT,
  OPEN_MODE_WARNING,
  RPC_CHANNEL,
  RPC_RESTART,
  RPC_STATUS,
  RPC_UPDATE,
} from './contract.js';
import { isIPv4Literal, listLanAddresses, pickLanAddress } from './network.js';
import { injectInsecureContextPolyfills } from './polyfills.js';
import { startLanProxy, stripIpv6Brackets } from './proxy.js';
import { qrSvgFor } from './qr.js';
import {
  defaultSettings,
  loadSettings,
  normalizeSettings,
  resolveDshHome,
  saveSettings,
  validateSettingsPatch,
} from './settings.js';
import { readLaunchToken } from './token.js';

/** Cordis 插件稳定名称（Loader 行与包名一致）。 */
export const name = '@local/dsh-lan-access';

/** 依赖服务：Web 服务（上游地址 + index 注入点）与 Connection（RPC 通道 + launch token）。 */
export const inject = ['webServer', 'connection'];

/**
 * 创建分级日志函数；优先使用 Cordis 上下文 logger，缺失时退回控制台。
 * @param {object} ctx - Cordis 上下文。
 * @returns {(level: 'info' | 'warn' | 'error', message: string) => void} 日志函数。
 */
function createLogger(ctx) {
  return (level, message) => {
    const line = `[dsh-lan-access] ${message}`;
    const logger = ctx.logger;
    if (logger !== undefined && typeof logger[level] === 'function') {
      logger[level](line);
      return;
    }
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
}

/**
 * 解析 DSH 自身监听器地址（上游）。
 * @param {{ getOrigin?: () => string, port?: number }} webServer - Web 服务。
 * @param {(level: string, message: string) => void} log - 日志函数。
 * @returns {{ origin: string, host: string, port: number } | null} 上游信息；不可用时为 null。
 */
function resolveUpstream(webServer, log) {
  try {
    if (typeof webServer.getOrigin === 'function') {
      const origin = new URL(webServer.getOrigin());
      const port = Number(origin.port || (origin.protocol === 'https:' ? 443 : 80));
      if (!Number.isInteger(port) || port <= 0) throw new Error(`无法解析上游端口：${origin.href}`);
      return {
        origin: origin.origin,
        host: stripIpv6Brackets(origin.hostname),
        port,
      };
    }
  } catch (error) {
    log('warn', `读取 DSH 监听地址失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const fallbackPort = typeof webServer.port === 'number' ? webServer.port : 0;
  if (fallbackPort > 0) {
    return { origin: `http://127.0.0.1:${fallbackPort}`, host: '127.0.0.1', port: fallbackPort };
  }
  return null;
}

/**
 * 把状态封装成 Connection RPC 成功信封。
 * @param {object} value - 状态值。
 * @returns {{ ok: true, value: object }} 信封。
 */
function success(value) {
  return { ok: true, value };
}

/**
 * 把错误封装成 Connection RPC 失败信封。
 * @param {'bad-request' | 'internal'} code - 失败类别。
 * @param {string} message - 可读原因。
 * @returns {{ ok: false, error: { code: string, message: string, details: { issues: string[] } } }} 信封。
 */
function failure(code, message) {
  return { ok: false, error: { code, message, details: { issues: [] } } };
}

/**
 * Host 插件入口。
 *
 * 设计红线（此前的崩溃就是违反它们造成的，勿改回）：
 * 1. `apply` 不能返回 Fiber / thenable —— Cordis 会把插件返回值当作 effect 解析，
 *    Fiber 会被当作非法 effect，导致宿主启动致命失败。
 * 2. `apply` 不能把初始化 Promise 交给宿主等待 —— 依赖服务尚未就绪时会让整个
 *    Profile 启动挂起，进而触发宿主退出。
 * 3. 任何初始化异常都必须在插件内部记录并降级，绝不能让宿主看到未处理的 rejection。
 *
 * 因此这里只做两件事：用 `ctx.inject` 声明依赖，然后 fire-and-forget 地执行 setup
 * 并兜住所有异常。插件行本身立即处于 active，代理服务异步就绪。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [config] - bundle patch 行里的初始配置（仅首次运行时作为默认值）。
 */
export function apply(ctx, config) {
  ctx.inject(['webServer', 'connection'], (scope) => {
    setup(scope, config).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      // 只记录，不抛出：插件初始化失败只应让「局域网访问」不可用，不能让宿主崩溃。
      try {
        scope.logger?.error?.(`[dsh-lan-access] 初始化失败：${message}`);
      } catch (logError) {
        console.error('[dsh-lan-access] 初始化失败（日志写入也失败）', logError);
      }
    });
  });
}

/**
 * 实际插件主体（在完成依赖注入的子上下文中运行）。
 * @param {object} ctx - 已注入 `webServer` / `connection` 的 Cordis 上下文。
 * @param {object} [config] - 初始配置。
 * @returns {Promise<void>} 初始化完成。
 */
async function setup(ctx, config) {
  const log = createLogger(ctx);
  const webServer = ctx.get('webServer');
  const connection = ctx.get('connection');
  if (webServer === undefined || connection === undefined) {
    log('warn', '依赖服务不可用（webServer / connection），局域网访问未启动');
    return;
  }

  const upstream = resolveUpstream(webServer, log);
  const configDefaults = normalizeSettings(config ?? {}, { ...defaultSettings(), listenPort: DEFAULT_LISTEN_PORT });

  /** @type {{ enabled: boolean, listenHost: string, listenPort: number }} */
  let settings = configDefaults;
  try {
    settings = await loadSettings({ fallback: configDefaults, log });
  } catch (error) {
    log('warn', `读取设置失败，使用默认值：${error instanceof Error ? error.message : String(error)}`);
  }

  /** @type {{ host: string, port: number, close: () => Promise<void> } | null} */
  let listener = null;
  /** @type {string | null} */
  let lastError = null;

  /**
   * 写入诊断快照（仅用于排障；不包含 launch token 等敏感值）。
   * @param {string} stage - 阶段标识。
   * @returns {Promise<void>} 写入完成。
   */
  async function writeDiagnostics(stage) {
    const file = path.join(resolveDshHome(), 'lan-access', 'diagnostics.json');
    const snapshot = {
      stage,
      time: new Date().toISOString(),
      settings,
      candidates: listLanAddresses(),
      listener: listener === null ? null : { host: listener.host, port: listener.port },
      upstream: upstream === null ? null : { origin: upstream.origin, host: upstream.host, port: upstream.port },
      lastError,
    };
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    } catch (error) {
      log('warn', `写入诊断快照失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 生成当前状态快照（供 RPC 与日志使用）。
   * @returns {object} 契约见 docs/contract.md §2.3。
   */
  function buildStatus() {
    const candidates = listLanAddresses();
    const running = listener !== null;
    const listenHost = listener?.host ?? (settings.listenHost !== '' ? settings.listenHost : candidates[0] ?? '');
    const listenPort = listener?.port ?? settings.listenPort;
    const urls = running && listener !== null ? [`http://${listener.host}:${listener.port}/`] : [];
    return {
      enabled: settings.enabled,
      running,
      listenHost,
      configuredListenHost: settings.listenHost,
      listenPort,
      candidates,
      urls,
      qrSvg: urls.length > 0 ? qrSvgFor(urls[0]) : null,
      upstreamOrigin: upstream?.origin ?? '',
      authMode: AUTH_MODE,
      warning: settings.enabled ? OPEN_MODE_WARNING : null,
      error: lastError,
    };
  }

  /**
   * 关闭当前监听器（幂等）。
   * @returns {Promise<void>} 关闭完成。
   */
  async function stopListener() {
    const active = listener;
    listener = null;
    if (active === null) return;
    try {
      await active.close();
      log('info', '局域网访问已停止');
      await writeDiagnostics('stopped');
    } catch (error) {
      log('warn', `停止局域网访问时出错：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 按当前设置启动监听器（幂等；失败只记录状态，不抛出到插件生命周期）。
   * @returns {Promise<void>} 启动尝试完成。
   */
  async function startListener() {
    lastError = null;
    if (!settings.enabled) return;
    if (upstream === null) {
      lastError = '无法确定 DSH 自身监听地址，局域网访问未启动';
      log('error', lastError);
      return;
    }
    const listenHost = settings.listenHost !== '' ? settings.listenHost : pickLanAddress();
    if (listenHost === '') {
      lastError = '未发现可用的局域网 IPv4 地址，请先把电脑接入 Wi-Fi 或网线';
      log('warn', lastError);
      return;
    }
    if (!isIPv4Literal(listenHost)) {
      lastError = `监听地址不是合法的 IPv4：${listenHost}`;
      log('error', lastError);
      return;
    }
    try {
      listener = await startLanProxy({
        listenHost,
        listenPort: settings.listenPort,
        upstreamHost: upstream.host,
        upstreamPort: upstream.port,
        getLaunchToken: () => readLaunchToken(connection),
        log,
      });
      const url = `http://${listener.host}:${listener.port}/`;
      log('info', `局域网访问已启动：${url} → ${upstream.origin}`);
      log('warn', '当前为免认证模式：同一局域网内任何设备都可访问并操作 DSH');
    } catch (error) {
      listener = null;
      const reason = error instanceof Error ? error.message : String(error);
      lastError = `监听 ${listenHost}:${settings.listenPort} 失败：${reason}`;
      log('error', lastError);
    }
  }

  /**
   * 重启监听器（先停后起）。
   * @returns {Promise<void>} 重启完成。
   */
  async function restartListener() {
    await stopListener();
    await startListener();
  }

  /** 先注册卸载清理：即使后续注册失败，监听器也会在插件卸载时释放。 */
  ctx.effect(() => () => stopListener(), 'dsh-lan-access.listener');

  /** 向所有 index.html 注入非安全上下文 polyfill（失败不影响反向代理）。 */
  try {
    ctx.effect(() => webServer.tapIndex(injectInsecureContextPolyfills), 'dsh-lan-access.polyfill');
  } catch (error) {
    log('warn', `polyfill 注入注册失败（不影响反代）：${error instanceof Error ? error.message : String(error)}`);
  }

  /** 首次启动：先完成一次监听尝试，再写诊断快照。 */
  await startListener();
  await writeDiagnostics('started');

  /**
   * Connection RPC 处理器。
   * @param {string} endpoint - `status` / `update` / `restart`。
   * @param {unknown} payload - 入参。
   * @returns {Promise<object>} RPC 信封。
   */
  async function handleRpc(endpoint, payload) {
    try {
      if (endpoint === RPC_STATUS) return success(buildStatus());
      if (endpoint === RPC_RESTART) {
        await restartListener();
        return success(buildStatus());
      }
      if (endpoint === RPC_UPDATE) {
        const validation = validateSettingsPatch(payload, settings);
        if (validation.ok === false) return failure('bad-request', validation.message);
        await saveSettings(validation.value);
        settings = validation.value;
        log('info', '设置已保存，正在重启局域网监听器');
        await restartListener();
        return success(buildStatus());
      }
      return failure('bad-request', `未知 RPC 端点：${String(endpoint)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('error', `RPC ${String(endpoint)} 执行失败：${message}`);
      return failure('internal', `执行失败：${message}`);
    }
  }

  /**
   * 注册设置页 RPC 通道。
   *
   * 必须显式把「已注入 webServer 的插件上下文」作为 owner 传给 Connection：
   * Connection 内部会用 owner.effect(...) + owner.webServer 注册路由，若 owner 被
   * 服务代理解析成未注入 webServer 的上下文，会抛 "without inject" 并让宿主致命退出。
   * 因此这里**只走** connection.register(owner, ...) 这条明确 API；旧 API
   * `connection.rpc.handle` 的 owner 解析不可控，直接不用（降级为设置页不可用）。
   */
  try {
    if (typeof connection.register !== 'function') {
      log('warn', 'Connection 服务没有 register(owner, ...) API，设置页不可用（反代仍工作）');
    } else {
      const dispose = connection.register(ctx, RPC_CHANNEL, handleRpc);
      ctx.effect(() => () => {
        void dispose();
      }, 'dsh-lan-access.rpc');
    }
  } catch (error) {
    log('warn', `Connection RPC 注册失败（设置页不可用，反代仍可用）：${error instanceof Error ? error.message : String(error)}`);
  }

  log('info', `插件已加载（${settings.enabled ? '启用' : '停用'}，端口 ${settings.listenPort}）`);
}
