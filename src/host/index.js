/**
 * dsh-lan-access Host 插件入口。
 *
 * 职责：读取/持久化运行设置，在局域网 IPv4 上启动反向代理（HTTP + WebSocket），
 * 通过 Connection RPC 暴露状态与设置更新接口，并向 DSH 页面注入非安全上下文 polyfill。
 * 监听器的创建/销毁全部挂在 Cordis effect 上，插件卸载即释放端口与全部连接。
 */
import { appendFile, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
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
import { isBindableListenHost, listLanAddresses, pickLanAddress, shouldRebindListener } from './network.js';
import { injectInsecureContextPolyfills } from './polyfills.js';
import { startLanProxy, stripIpv6Brackets, closeOrphanedListeners } from './proxy.js';
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
 * 探测某个 host:port 当前是否可绑定（用于保存设置前阻止占用端口）。
 * @param {string} host - 监听地址。
 * @param {number} port - 端口。
 * @returns {Promise<boolean>} 可绑定返回 true。
 */
function canBindAddress(host, port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        probe.close(() => resolve(result));
      } catch (error) {
        resolve(result);
      }
    };
    probe.once('error', () => finish(false));
    probe.once('listening', () => finish(true));
    try {
      probe.listen(port, host);
    } catch (error) {
      finish(false);
    }
  });
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

  /**
   * 请求诊断日志：记录入站连接 / 请求 / 响应 / 客户端错误，便于排查"手机连不上、空响应"。
   * 写入 `$DSH_HOME/lan-access/requests.log`，超过 512KB 轮换为 `.1`；失败绝不影响代理。
   * @param {object} entry - 事件条目。
   */
  let requestLogQueue = Promise.resolve();
  function writeRequestLog(entry) {
    requestLogQueue = requestLogQueue
      .then(async () => {
        const directory = path.join(resolveDshHome(), 'lan-access');
        await mkdir(directory, { recursive: true });
        const file = path.join(directory, 'requests.log');
        try {
          const info = await stat(file);
          if (info.size > 512 * 1024) await rename(file, path.join(directory, 'requests.log.1'));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await appendFile(file, `${new Date().toISOString()} ${JSON.stringify(entry)}\n`, 'utf8');
      })
      .catch(() => {
        // 诊断日志失败不能影响代理。
      });
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
    // 先回收同一模块实例内可能遗留的监听器（异常/HMR 路径的自愈），避免端口自占用。
    await closeOrphanedListeners();
    if (upstream === null) {
      lastError = '无法确定 DSH 自身监听地址，局域网访问未启动';
      log('error', lastError);
      await writeDiagnostics('start-failed');
      return;
    }
    const listenHost = settings.listenHost !== '' ? settings.listenHost : pickLanAddress();
    if (listenHost === '') {
      lastError = '未发现可用的局域网 IPv4 地址，请先把电脑接入 Wi-Fi 或网线';
      log('warn', lastError);
      await writeDiagnostics('start-failed');
      return;
    }
    if (!isBindableListenHost(listenHost)) {
      lastError = `监听地址不是可绑定的具体 IPv4：${listenHost}`;
      log('error', lastError);
      await writeDiagnostics('start-failed');
      return;
    }
    try {
      listener = await startLanProxy({
        listenHost,
        listenPort: settings.listenPort,
        upstreamHost: upstream.host,
        upstreamPort: upstream.port,
        getLaunchToken: () => readLaunchToken(connection),
        onEvent: writeRequestLog,
        log,
      });
      const url = `http://${listener.host}:${listener.port}/`;
      log('info', `局域网访问已启动：${url} → ${upstream.origin}`);
      log('warn', '当前为免认证模式：同一局域网内任何设备都可访问并操作 DSH');
      await writeDiagnostics('started');
    } catch (error) {
      listener = null;
      const reason = error instanceof Error ? error.message : String(error);
      lastError = `监听 ${listenHost}:${settings.listenPort} 失败：${reason}`;
      log('error', lastError);
      await writeDiagnostics('start-failed');
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

  /**
   * 串行化重启请求：多个页面并发点「保存/重启」时不会交叉 stop/start 泄漏旧监听器。
   * @returns {Promise<void>} 本次重启完成。
   */
  let restartChain = Promise.resolve();
  function queueRestart() {
    const task = restartChain.then(
      () => restartListener(),
      () => restartListener(),
    );
    restartChain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** 待执行的延迟重启定时器。 */
  let pendingRestartTimer = null;

  /**
   * 延迟重启监听器（默认 300ms），让当前 RPC 的 HTTP 响应先写回浏览器。
   *
   * 为什么必须延迟：设置页从局域网地址访问时，`update` / `restart` 的响应本身
   * 也要经过这个监听器；若在 handler 返回前关闭监听器，浏览器会收到空响应
   * （Chromium 报 `ERR_EMPTY_RESPONSE`，页面显示设置失败）。
   * @param {object} [options] - 选项。
   * @param {{ enabled: boolean, listenHost: string, listenPort: number }} [options.fallback] - 启动失败时回滚到的配置。
   * @param {number} [options.delayMs] - 延迟毫秒数。
   */
  function scheduleRestart(options = {}) {
    const delayMs = options.delayMs ?? 300;
    if (pendingRestartTimer !== null) return;
    pendingRestartTimer = setTimeout(() => {
      pendingRestartTimer = null;
      void queueRestart()
        .then(async () => {
          if (options.fallback === undefined) return;
          if (settings.enabled === true && listener === null) {
            // 延迟启动失败：回滚到上一份可用配置并恢复监听，避免“已保存但不可用”。
            const reason = lastError ?? '未知原因';
            settings = options.fallback;
            try {
              await saveSettings(settings);
            } catch (error) {
              log('warn', `回滚设置写入失败：${error instanceof Error ? error.message : String(error)}`);
            }
            await queueRestart();
            lastError = `设置未生效，已回滚：${reason}`;
            log('warn', lastError);
            await writeDiagnostics('rolled-back');
          }
        })
        .catch((error) => {
          log('error', `延迟重启失败：${error instanceof Error ? error.message : String(error)}`);
        });
    }, delayMs);
    pendingRestartTimer.unref?.();
  }

  /** 监听地址巡检间隔（毫秒）：网卡换 IP 后自动恢复监听。 */
  const ADDRESS_WATCH_INTERVAL_MS = 5000;
  /** 监听器缺失时的最小重试间隔（毫秒）：避免持续失败时反复刷日志。 */
  const LISTENER_RETRY_INTERVAL_MS = 30000;

  /** 上次尝试启动监听器的时间戳（毫秒），用于失败退避。 */
  let lastStartAttemptAt = Date.now();
  /** 地址巡检定时器句柄。 */
  let addressWatchTimer = null;

  /**
   * 巡检本机局域网地址，必要时重新绑定监听器。
   *
   * 为什么需要：监听器绑定的是具体网卡 IPv4，而 DHCP 会换地址（路由器重启、
   * Wi-Fi 断线重连、开关 Clash TUN/系统代理触发的网络重置等）。旧地址失效后
   * 监听器变成「看起来在跑、实际收不到包」的僵尸状态——手机连不上，但 DSH 一切正常，
   * 用户只能手动点「重启监听」。这里发现漂移即自动重绑。
   * @returns {Promise<void>} 巡检完成。
   */
  async function checkListenAddress() {
    if (!settings.enabled) return;
    const candidates = listLanAddresses();
    if (listener === null) {
      const target = settings.listenHost !== '' ? settings.listenHost : candidates[0] ?? '';
      // 目标地址尚未就绪（例如 Wi-Fi 还在重连）时不空转重试。
      if (target === '' || candidates.includes(target) === false) return;
      const now = Date.now();
      if (now - lastStartAttemptAt < LISTENER_RETRY_INTERVAL_MS) return;
      lastStartAttemptAt = now;
      await startListener();
      return;
    }
    if (settings.listenHost !== '') return; // 手动指定的地址由用户负责，不自动漂移
    if (shouldRebindListener(listener.host, candidates) === false) return;
    const target = candidates[0] ?? '';
    if (target === '') {
      log('warn', `本机已没有可用的局域网地址（原监听 ${listener.host}:${listener.port}），等待网络恢复`);
      return;
    }
    log('warn', `本机局域网地址已变化（${listener.host} → ${target}），正在自动重新监听`);
    await queueRestart();
  }

  /** 先注册卸载清理：即使后续注册失败，监听器也会在插件卸载时释放。 */
  ctx.effect(() => () => stopListener(), 'dsh-lan-access.listener');

  /** 网络地址巡检：随插件卸载停止。 */
  ctx.effect(() => {
    addressWatchTimer = setInterval(() => {
      void checkListenAddress().catch((error) => {
        log('warn', `局域网地址巡检失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }, ADDRESS_WATCH_INTERVAL_MS);
    addressWatchTimer.unref?.();
    return () => {
      if (addressWatchTimer !== null) clearInterval(addressWatchTimer);
      addressWatchTimer = null;
    };
  }, 'dsh-lan-access.address-watch');

  /** 向所有 index.html 注入非安全上下文 polyfill（失败不影响反向代理）。 */
  try {
    ctx.effect(() => webServer.tapIndex(injectInsecureContextPolyfills), 'dsh-lan-access.polyfill');
  } catch (error) {
    log('warn', `polyfill 注入注册失败（不影响反代）：${error instanceof Error ? error.message : String(error)}`);
  }

  /** 首次启动：startListener 内部会写诊断快照。 */
  await startListener();
  lastStartAttemptAt = Date.now();

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
        scheduleRestart();
        return success({ ...buildStatus(), restarting: true });
      }
      if (endpoint === RPC_UPDATE) {
        const validation = validateSettingsPatch(payload, settings);
        if (validation.ok === false) return failure('bad-request', validation.message);
        const next = validation.value;
        const targetHost = next.listenHost !== '' ? next.listenHost : pickLanAddress();
        const sameAuthority = listener !== null && listener.host === targetHost && listener.port === next.listenPort;
        if (next.enabled) {
          if (targetHost === '') return failure('bad-request', '未发现可用的局域网 IPv4 地址');
          if (sameAuthority === false && (await canBindAddress(targetHost, next.listenPort)) === false) {
            return failure('bad-request', `端口 ${targetHost}:${next.listenPort} 已被占用，请换一个端口`);
          }
        }
        const previous = settings;
        await saveSettings(next);
        settings = next;
        log('info', '设置已保存，监听器将在响应返回后重启');
        // 先返回响应，再在 300ms 后重启监听器（否则经局域网页保存会得到空响应）。
        scheduleRestart({ fallback: previous });
        return success({ ...buildStatus(), restarting: true });
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
