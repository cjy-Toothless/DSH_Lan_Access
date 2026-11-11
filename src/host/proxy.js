/**
 * 局域网反向代理（Host 侧）。
 *
 * 监听一个局域网 IPv4 端口，把 HTTP 与 WebSocket 全量转发到 DSH 的回环监听器：
 * - 改写 `Host` / `Origin` / `Referer` 为固定回环权威，通过 DSH 的浏览器请求信任围栏；
 * - 回写上游绝对 `Location`，避免手机被重定向到它自己的 127.0.0.1；
 * - 上游对首次根路径返回 401 时，自动用进程 launch token 完成「token → Cookie」兑换；
 * - 不缓冲请求/响应体：上传、SSE、流式下载都按背压透传。
 */
import http from 'node:http';
import net from 'node:net';

import { UPSTREAM_HOST_HEADER, UPSTREAM_ORIGIN_HEADER } from './contract.js';

/** 逐跳请求头：普通 HTTP 转发时应移除（由 Node 重新生成）。 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** 只有根路径的 GET/HEAD 才值得做 launch-token 自动登录。 */
const TOKEN_EXCHANGE_PATHS = new Set(['/', '']);

/** JSON 请求体上限（DSH 自身有更严格限制，这里只防御异常输入）。 */
const DEFAULT_MAX_BODY_BYTES = 512 * 1024 * 1024;

/**
 * 去掉 URL.hostname 对 IPv6 的方括号。
 * @param {string} host - 主机名。
 * @returns {string} 可直接传给 net/http 的主机名。
 */
export function stripIpv6Brackets(host) {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

/**
 * 生成 URL 中的主机部分（IPv6 需要方括号）。
 * @param {string} host - 主机名或 IPv4。
 * @returns {string} URL 主机段。
 */
export function urlHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * 解析请求路径。
 * @param {string | undefined} url - `req.url`。
 * @returns {URL | null} 解析结果；非法时为 null。
 */
function parseRequestUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('/')) return null;
  try {
    return new URL(url, 'http://dsh-lan-access.invalid');
  } catch (error) {
    return null;
  }
}

/**
 * 判断某个请求是否是 launch-token 自动登录的候选。
 * @param {string | undefined} method - HTTP 方法。
 * @param {string} pathname - URL 路径。
 * @returns {boolean} 是否候选。
 */
function isTokenExchangeCandidate(method, pathname) {
  return (method === 'GET' || method === 'HEAD') && TOKEN_EXCHANGE_PATHS.has(pathname);
}

/**
 * 给 URL 追加 token 查询参数。
 * @param {string} url - 原始 `req.url`。
 * @param {string} token - 进程 launch token。
 * @returns {string} 新的 `req.url`。
 */
function appendToken(url, token) {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

/**
 * 构造发往上游的请求头：固定回环权威，改写来源头。
 * @param {http.IncomingHttpHeaders} headers - 客户端请求头。
 * @param {string} browserOrigin - 反代对浏览器暴露的 origin，例如 `http://192.168.0.2:63004`。
 * @param {{ upgrade?: boolean }} [options] - 是否为 WebSocket 升级请求。
 * @returns {Record<string, string | string[]>} 上游请求头。
 */
export function rewriteRequestHeaders(headers, browserOrigin, options = {}) {
  const upgrading = options.upgrade === true;
  /** @type {Record<string, string | string[]>} */
  const rewritten = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === 'origin' || lower === 'referer') continue;
    if (lower === 'proxy-connection') continue;
    if (upgrading === false && (HOP_BY_HOP_HEADERS.has(lower) || lower === 'expect')) continue;
    rewritten[lower] = value;
  }
  rewritten.host = UPSTREAM_HOST_HEADER;
  rewritten.origin = UPSTREAM_ORIGIN_HEADER;
  const referer = headers.referer;
  if (typeof referer === 'string' && browserOrigin !== '' && referer.startsWith(browserOrigin)) {
    rewritten.referer = `${UPSTREAM_ORIGIN_HEADER}${referer.slice(browserOrigin.length)}`;
  }
  if (upgrading) {
    rewritten.connection = 'Upgrade';
    rewritten.upgrade = typeof headers.upgrade === 'string' ? headers.upgrade : 'websocket';
  }
  return rewritten;
}

/**
 * 回写上游响应头：把指向上游回环权威的绝对 `Location` 改回浏览器可见 origin。
 * @param {http.IncomingHttpHeaders} headers - 上游响应头。
 * @param {{ browserOrigin: string, upstreamOrigin: string }} state - 代理状态。
 * @returns {http.OutgoingHttpHeaders} 可写给浏览器的响应头。
 */
export function rewriteResponseHeaders(headers, state) {
  /** @type {http.OutgoingHttpHeaders} */
  const rewritten = { ...headers };
  delete rewritten.connection;
  delete rewritten['keep-alive'];
  delete rewritten['proxy-connection'];
  delete rewritten.upgrade;
  const location = rewritten.location;
  if (typeof location === 'string' && /^https?:\/\//i.test(location)) {
    try {
      const target = new URL(location);
      if (target.origin === state.upstreamOrigin || target.origin === UPSTREAM_ORIGIN_HEADER) {
        rewritten.location = `${state.browserOrigin}${target.pathname}${target.search}${target.hash}`;
      }
    } catch (error) {
      // 非法 Location 原样保留，交给浏览器处理。
    }
  }
  return rewritten;
}

/**
 * 发送一个普通 HTTP 请求到上游。
 * @param {object} state - 代理状态。
 * @param {http.IncomingMessage} request - 客户端请求。
 * @param {string} path - 上游请求路径。
 * @param {Record<string, string | string[]>} headers - 上游请求头。
 * @returns {Promise<{ upstreamRes?: http.IncomingMessage, upstreamReq?: http.ClientRequest, error?: Error }>} 上游响应或错误。
 */
function sendUpstream(state, request, path, headers) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const upstreamRequest = http.request(
      {
        host: state.upstreamHost,
        port: state.upstreamPort,
        method: request.method,
        path,
        headers,
        agent: state.agent,
        maxHeaderSize: 128 * 1024,
      },
      (upstreamResponse) => settle({ upstreamResponse, upstreamRequest }),
    );
    upstreamRequest.on('error', (error) => settle({ error }));
    if (request.method === 'GET' || request.method === 'HEAD') {
      upstreamRequest.end();
    } else {
      request.pipe(upstreamRequest);
      request.on('error', (error) => upstreamRequest.destroy(error));
    }
  });
}

/**
 * 校验入站请求的 Host/Origin 是否属于本代理自己的 authority。
 *
 * 目的：阻断 DNS rebinding —— 恶意网页把自己的域名解析到本机 LAN IP 后，
 * 浏览器发出的请求 Host/Origin 仍是攻击者域名；若不校验，代理会把它当作
 * 本机可信客户端并自动完成 launch-token 登录。只接受：
 * - `<listenHost>:<port>`（手机实际访问地址）
 * - `127.0.0.1:<port>` / `localhost:<port>`（本机自测）
 * @param {http.IncomingMessage} request - 入站请求。
 * @param {object} state - 代理状态。
 * @returns {boolean} 是否允许转发。
 */
function isInboundAuthorityAllowed(request, state) {
  const host = request.headers.host;
  if (typeof host !== 'string' || host === '') return false;
  if (!state.allowedAuthorities.has(host.toLowerCase())) return false;
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    try {
      const url = new URL(origin);
      const defaultPort = url.protocol === 'https:' ? '443' : '80';
      const authority = `${url.hostname.toLowerCase()}:${url.port === '' ? defaultPort : url.port}`;
      if (!state.allowedAuthorities.has(authority)) return false;
    } catch (error) {
      return false;
    }
  }
  return true;
}

/**
 * 给浏览器写一个纯文本错误响应。
 * @param {http.ServerResponse} response - 响应对象。
 * @param {number} status - 状态码。
 * @param {string} message - 文本。
 */
function writeText(response, status, message) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  response.end(message);
}

/**
 * 把上游响应转给浏览器。
 * @param {http.ServerResponse} response - 浏览器响应。
 * @param {http.IncomingMessage} upstreamResponse - 上游响应。
 * @param {object} state - 代理状态。
 */
function relayResponse(response, upstreamResponse, state) {
  response.writeHead(upstreamResponse.statusCode ?? 502, rewriteResponseHeaders(upstreamResponse.headers, state));
  upstreamResponse.pipe(response);
  upstreamResponse.on('error', () => response.destroy());
  response.on('error', () => upstreamResponse.destroy());
  response.on('close', () => upstreamResponse.destroy());
}

/**
 * 处理一个 HTTP 请求：转发 → (可选) launch-token 自动登录 → 回写。
 * @param {http.IncomingMessage} request - 客户端请求。
 * @param {http.ServerResponse} response - 客户端响应。
 * @param {object} state - 代理状态。
 * @returns {Promise<void>} 处理完成。
 */
async function handleHttpRequest(request, response, state) {
  if (!isInboundAuthorityAllowed(request, state)) {
    state.log?.('warn', `拒绝 Host/Origin 不匹配的入站请求：Host=${String(request.headers.host)}`);
    writeText(response, 403, 'Forbidden: untrusted Host/Origin');
    return;
  }
  const parsed = parseRequestUrl(request.url);
  if (parsed === null) {
    writeText(response, 400, 'Bad Request');
    return;
  }
  const headers = rewriteRequestHeaders(request.headers, state.browserOrigin);
  let attempt = await sendUpstream(state, request, request.url ?? '/', headers);

  if (
    attempt.upstreamResponse !== undefined &&
    attempt.upstreamResponse.statusCode === 401 &&
    isTokenExchangeCandidate(request.method, parsed.pathname) &&
    !parsed.searchParams.has('token')
  ) {
    const token = typeof state.getLaunchToken === 'function' ? state.getLaunchToken() : undefined;
    if (typeof token === 'string' && token !== '') {
      state.log?.('info', '上游要求认证，使用进程 launch token 代替浏览器完成首次登录');
      attempt.upstreamResponse.resume();
      attempt = await sendUpstream(state, request, appendToken(request.url ?? '/', token), headers);
    }
  }

  if (attempt.upstreamResponse === undefined) {
    writeText(response, 502, '502 Bad Gateway: upstream is unreachable');
    state.log?.('warn', `上游请求失败：${attempt.error?.message ?? 'unknown error'}`);
    return;
  }
  relayResponse(response, attempt.upstreamResponse, state);
}

/**
 * 处理 WebSocket / 其他协议升级：原样透传握手与后续字节流。
 * @param {http.IncomingMessage} request - 升级请求。
 * @param {import('node:stream').Duplex} socket - 客户端 socket。
 * @param {Buffer} head - 已读取的额外字节。
 * @param {object} state - 代理状态。
 */
function handleUpgrade(request, socket, head, state) {
  if (!isInboundAuthorityAllowed(request, state)) {
    state.log?.('warn', `拒绝 Host/Origin 不匹配的 WebSocket 升级：Host=${String(request.headers.host)}`);
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  const parsed = parseRequestUrl(request.url);
  if (parsed === null) {
    socket.destroy();
    return;
  }
  const headers = rewriteRequestHeaders(request.headers, state.browserOrigin, { upgrade: true });
  const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`);
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  lines.push('', '');
  const handshake = lines.join('\r\n');

  const upstream = net.connect({ host: state.upstreamHost, port: state.upstreamPort });
  state.upgradedSockets.add(socket);
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    state.upgradedSockets.delete(socket);
    socket.destroy();
    upstream.destroy();
  };
  socket.on('error', cleanup);
  socket.on('close', cleanup);
  upstream.on('error', cleanup);
  upstream.on('close', cleanup);
  upstream.on('connect', () => {
    upstream.write(handshake);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
}

/**
 * 创建代理服务器（尚未 listen）。
 * @param {object} options - 代理选项。
 * @param {string} options.listenHost - 监听地址（用于计算浏览器 origin）。
 * @param {string} options.upstreamHost - 上游主机（DSH 回环地址）。
 * @param {number} options.upstreamPort - 上游端口。
 * @param {(level: string, message: string) => void} [options.log] - 日志函数。
 * @returns {{ server: http.Server, state: object }} 服务器与状态。
 */
export function createProxyServer(options) {
  const state = {
    upstreamHost: stripIpv6Brackets(options.upstreamHost),
    upstreamPort: options.upstreamPort,
    upstreamOrigin: `http://${urlHost(stripIpv6Brackets(options.upstreamHost))}:${options.upstreamPort}`,
    browserOrigin: '',
    getLaunchToken: options.getLaunchToken,
    log: options.log,
    agent: new http.Agent({ keepAlive: true }),
    upgradedSockets: new Set(),
    listeningSockets: new Set(),
    allowedAuthorities: new Set(),
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    baseListenHost: options.listenHost,
  };

  const server = http.createServer((request, response) => {
    handleHttpRequest(request, response, state).catch((error) => {
      state.log?.('error', `请求处理失败：${error instanceof Error ? error.message : String(error)}`);
      writeText(response, 502, '502 Bad Gateway');
    });
  });

  server.on('checkContinue', (request, response) => {
    response.writeContinue();
    handleHttpRequest(request, response, state).catch((error) => {
      state.log?.('error', `请求处理失败：${error instanceof Error ? error.message : String(error)}`);
      writeText(response, 502, '502 Bad Gateway');
    });
  });

  server.on('upgrade', (request, socket, head) => {
    try {
      handleUpgrade(request, socket, head, state);
    } catch (error) {
      state.log?.('warn', `WebSocket 升级失败：${error instanceof Error ? error.message : String(error)}`);
      socket.destroy();
    }
  });

  server.on('connection', (socket) => {
    state.listeningSockets.add(socket);
    socket.on('close', () => state.listeningSockets.delete(socket));
  });

  server.on('clientError', (error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } else {
      socket.destroy();
    }
    state.log?.('warn', `客户端连接错误：${error.message}`);
  });

  return { server, state };
}

/**
 * 启动局域网反代并等待端口绑定完成。
 * @param {object} options - 启动选项。
 * @param {string} options.listenHost - 局域网 IPv4。
 * @param {number} options.listenPort - 端口；0 表示由系统分配。
 * @param {string} options.upstreamHost - DSH 回环主机。
 * @param {number} options.upstreamPort - DSH 回环端口。
 * @param {() => (string | undefined)} [options.getLaunchToken] - 读取进程 launch token。
 * @param {(level: string, message: string) => void} [options.log] - 日志函数。
 * @returns {Promise<{ host: string, port: number, close: () => Promise<void> }>} 代理句柄。
 */
export async function startLanProxy(options) {
  const { server, state } = createProxyServer(options);
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.listenPort, options.listenHost);
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : options.listenPort;
  const boundHost = options.listenHost;
  state.browserOrigin = `http://${urlHost(boundHost)}:${boundPort}`;
  state.allowedAuthorities.clear();
  for (const host of [boundHost, '127.0.0.1', 'localhost']) {
    state.allowedAuthorities.add(`${urlHost(host)}:${boundPort}`.toLowerCase());
  }

  return {
    host: boundHost,
    port: boundPort,
    close: async () => {
      for (const socket of state.upgradedSockets) socket.destroy();
      state.upgradedSockets.clear();
      for (const socket of state.listeningSockets) socket.destroy();
      state.listeningSockets.clear();
      state.agent.destroy();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        timer.unref?.();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        server.closeAllConnections?.();
      });
    },
  };
}
