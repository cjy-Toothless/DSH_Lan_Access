/**
 * Host 插件入口的集成测试：用最小化的假 Cordis 上下文驱动 apply()。
 *
 * 不依赖真实 DSH 进程即可验证：设置加载、监听器启动、RPC 端点、polyfill 注册、
 * token 自动登录、卸载清理。真实 DSH 内的端到端验证见 tests/e2e。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { apply } from '../../src/host/index.js';

const TOKEN = 'integration-token';

/**
 * 选择 20000-40000 间一个空闲端口（避免固定端口冲突）。
 * @returns {number} 端口号。
 */
function randomPort() {
  return 20000 + Math.floor(Math.random() * 20000);
}

/**
 * 启动模拟 DSH 上游：要求 token 兑换后携带 Cookie。
 * @returns {Promise<{ server: http.Server, port: number }>} 服务句柄。
 */
function startFakeDsh() {
  return new Promise((resolve, reject) => {
    let fakePort = 0;
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const authenticated = String(request.headers.cookie ?? '').includes('dsh=browser');
      if (url.searchParams.get('token') === TOKEN) {
        // 故意返回绝对 Location，用于验证反代会把它改写成浏览器可见 origin。
        response.writeHead(302, {
          location: `http://127.0.0.1:${fakePort}/`,
          'set-cookie': 'dsh=browser; Path=/; HttpOnly; SameSite=Strict',
        });
        response.end();
        return;
      }
      if (!authenticated) {
        response.writeHead(401, { 'content-type': 'text/plain' });
        response.end('authentication required');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><meta charset="utf-8"></head><body>fake dsh</body></html>');
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      fakePort = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ server, port: fakePort });
    });
  });
}

/**
 * 发起一次 HTTP 请求。
 * @param {number} port - 目标端口。
 * @param {string} requestPath - 路径。
 * @param {{ headers?: object }} [options] - 额外请求头。
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>} 响应。
 */
function fetchOnce(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: requestPath, headers: { connection: 'close', ...options.headers } },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

test('apply() 可启动监听、完成 token 登录、响应 RPC 并在卸载时释放端口', async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-lan-access-integration-'));
  const savedHome = process.env.DSH_HOME;
  process.env.DSH_HOME = temporaryHome;

  const fakeDsh = await startFakeDsh();
  const listenPort = randomPort();
  const disposers = [];
  const taps = [];
  let rpcHandler = null;
  const logs = [];

  const webServer = {
    getOrigin: () => `http://127.0.0.1:${fakeDsh.port}`,
    tapIndex: (transform) => {
      taps.push(transform);
      return () => {
        const index = taps.indexOf(transform);
        if (index >= 0) taps.splice(index, 1);
      };
    },
  };
  const connection = {
    authenticatedUrl: (baseUrl) => `${baseUrl}?token=${TOKEN}`,
    /**
     * 模拟真实 Connection 的公开 register(owner, channel, handler)：
     * 在 owner 上注册 effect，并访问 owner.webServer 注册路由。
     * 如果 owner 没注入 webServer，这里会抛错——正是宿主崩溃的根因。
     */
    register(owner, _channel, handler) {
      rpcHandler = handler;
      return owner.effect(() => {
        assert.equal(typeof owner.webServer, 'object');
        return () => {
          rpcHandler = null;
        };
      });
    },
    rpc: {
      handle: (_channel, handler) => {
        rpcHandler = handler;
        return async () => {
          rpcHandler = null;
        };
      },
    },
  };
  let injectPromise = null;
  const ctx = {
    webServer,
    connection,
    logger: {
      info: (line) => logs.push(['info', line]),
      warn: (line) => logs.push(['warn', line]),
      error: (line) => logs.push(['error', line]),
    },
    get: (name) => {
      if (name === 'webServer') return webServer;
      if (name === 'connection') return connection;
      return undefined;
    },
    inject: (_deps, callback) => {
      injectPromise = Promise.resolve(callback(ctx));
      return injectPromise;
    },
    effect: (callback) => {
      const dispose = callback();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
  };

  try {
    const returned = apply(ctx, { enabled: true, listenHost: '127.0.0.1', listenPort });
    // 回归保护：apply 绝不能返回 thenable/fiber，否则 Cordis 会把它当非法 effect。
    assert.equal(returned, undefined);

    // setup 是 fire-and-forget：轮询等待 RPC 注册与监听器就绪（最多 3 秒）。
    const deadline = Date.now() + 3000;
    while (rpcHandler === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(typeof rpcHandler, 'function');
    assert.equal(taps.length, 1);

    const statusEnvelope = await rpcHandler('status', {});
    assert.equal(statusEnvelope.ok, true);
    const status = statusEnvelope.value;
    assert.equal(status.running, true);
    assert.equal(status.enabled, true);
    assert.equal(status.listenPort, listenPort);
    assert.deepEqual(status.urls, [`http://127.0.0.1:${listenPort}/`]);
    assert.ok(typeof status.qrSvg === 'string' && status.qrSvg.startsWith('<svg'));
    assert.equal(status.upstreamOrigin, `http://127.0.0.1:${fakeDsh.port}`);
    assert.equal(status.authMode, 'open');
    assert.ok(typeof status.warning === 'string' && status.warning.length > 0);

    // polyfill 已注册且幂等
    const injected = taps[0]('<!doctype html><html><head></head><body></body></html>');
    assert.ok(injected.includes('__DSH_LAN_ACCESS_POLYFILL__'));

    // 首次访问：代理自动用 launch token 兑换 Cookie
    const first = await fetchOnce(listenPort, '/');
    assert.equal(first.status, 302);
    assert.match(String(first.headers.location), new RegExp(`^http://127\\.0\\.0\\.1:${listenPort}/`));
    assert.ok(String(first.headers['set-cookie']).includes('dsh=browser'));

    // 再次访问：带 Cookie 直接 200
    const second = await fetchOnce(listenPort, '/', { headers: { cookie: 'dsh=browser' } });
    assert.equal(second.status, 200);
    assert.ok(second.body.includes('fake dsh'));

    // 更新端口：持久化并立即生效
    const nextPort = randomPort();
    const updated = await rpcHandler('update', { listenPort: nextPort });
    assert.equal(updated.ok, true);
    assert.equal(updated.value.listenPort, nextPort);
    const viaNewPort = await fetchOnce(nextPort, '/');
    assert.equal(viaNewPort.status, 302);

    // 非法参数：返回错误信封且旧监听器保持可用
    const rejected = await rpcHandler('update', { listenPort: 80 });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'bad-request');

    // 卸载：关闭监听器
    for (const dispose of disposers.reverse()) await dispose();
    await assert.rejects(fetchOnce(nextPort, '/'));
    assert.ok(logs.some(([level]) => level === 'warn'));
  } finally {
    for (const dispose of disposers) {
      try {
        await dispose();
      } catch (error) {
        // 已释放的清理函数允许失败。
      }
    }
    process.env.DSH_HOME = savedHome;
    await rm(temporaryHome, { recursive: true, force: true });
    await new Promise((resolve) => fakeDsh.server.close(resolve));
  }
});
