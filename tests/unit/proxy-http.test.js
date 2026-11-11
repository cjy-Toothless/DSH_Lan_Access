import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { test } from 'node:test';

import { startLanProxy } from '../../src/host/proxy.js';

/**
 * 启动一个一次性上游 HTTP 服务。
 * @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler - 请求处理器。
 * @returns {Promise<{ server: http.Server, port: number }>} 服务句柄。
 */
function startUpstream(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 });
    });
  });
}

/**
 * 向反代发一个 HTTP 请求。
 * @param {number} port - 反代端口。
 * @param {string} path - 请求路径。
 * @param {{ method?: string, headers?: object, body?: string }} [options] - 选项。
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>} 响应。
 */
function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { connection: 'close', ...options.headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/**
 * 通过反代建立一次原始 WebSocket 握手并读取响应头。
 * @param {number} port - 反代端口。
 * @param {string} path - 路径。
 * @returns {Promise<string>} 上游返回的原始响应文本开头。
 */
function rawUpgrade(port, path) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          'Host: 192.168.0.2:63004\r\n' +
          'Origin: http://192.168.0.2:63004\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(buffer);
      }
    });
    socket.on('error', reject);
    socket.on('close', () => {
      if (!buffer.includes('\r\n\r\n')) reject(new Error('upgrade 未收到完整响应头'));
    });
  });
}

test('普通 HTTP 转发：改写 Host/Origin/Referer 与 Cookie 透传', async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        url: req.url,
        host: req.headers.host,
        origin: req.headers.origin,
        referer: req.headers.referer,
        cookie: req.headers.cookie,
      }),
    );
  });
  const proxy = await startLanProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort: upstream.port,
  });
  const browserOrigin = `http://127.0.0.1:${proxy.port}`;
  try {
    const response = await request(proxy.port, '/api/session/list?limit=5', {
      headers: {
        origin: browserOrigin,
        referer: `${browserOrigin}/`,
        cookie: 'dsh=browser-cookie',
      },
    });
    assert.equal(response.status, 200);
    const payload = JSON.parse(response.body);
    assert.equal(payload.url, '/api/session/list?limit=5');
    assert.equal(payload.host, '127.0.0.1:3080');
    assert.equal(payload.origin, 'http://127.0.0.1:3080');
    assert.equal(payload.referer, 'http://127.0.0.1:3080/');
    assert.equal(payload.cookie, 'dsh=browser-cookie');
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.server.close(resolve));
  }
});

test('POST 请求体原样透传', async () => {
  const upstream = await startUpstream((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(Buffer.concat(chunks).toString('utf8'));
    });
  });
  const proxy = await startLanProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort: upstream.port,
  });
  try {
    const body = '{"prompt":"你好，DSH"}';
    const response = await request(proxy.port, '/api/remote.mux', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      body,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body, body);
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.server.close(resolve));
  }
});

test('上游 401 时用 launch token 自动登录并回写 Location', async () => {
  let upstreamPort = 0;
  const upstream = await startUpstream((req, res) => {
    if (req.url?.includes('token=test-token')) {
      res.writeHead(302, {
        location: `http://127.0.0.1:${upstreamPort}/`,
        'set-cookie': 'dsh-browser=ok; Path=/; HttpOnly; SameSite=Strict',
      });
      res.end();
      return;
    }
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('authentication required');
  });
  upstreamPort = upstream.port;
  const proxy = await startLanProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort: upstream.port,
    getLaunchToken: () => 'test-token',
  });
  try {
    const response = await request(proxy.port, '/');
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, `http://127.0.0.1:${proxy.port}/`);
    assert.ok(String(response.headers['set-cookie']).includes('dsh-browser=ok'));
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.server.close(resolve));
  }
});

test('401 但已有 token 或缺少 launch token 时不重复兑换', async () => {
  let hits = 0;
  const upstream = await startUpstream((req, res) => {
    hits += 1;
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end(req.url ?? '');
  });
  const proxy = await startLanProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort: upstream.port,
    getLaunchToken: () => undefined,
  });
  try {
    const response = await request(proxy.port, '/');
    assert.equal(response.status, 401);
    assert.equal(hits, 1);
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.server.close(resolve));
  }
});

test('WebSocket 升级握手透传并改写 Host', async () => {
  const upstream = await startUpstream(() => {
    // 普通请求不会走到这里；升级由下面的 upgrade 事件处理。
  });
  upstream.server.on('upgrade', (req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `X-Upstream-Host: ${req.headers.host}\r\n` +
        '\r\n',
    );
    socket.destroy();
  });
  const proxy = await startLanProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort: upstream.port,
  });
  try {
    const raw = await rawUpgrade(proxy.port, '/api/remote.mux');
    assert.match(raw, /HTTP\/1\.1 101/);
    assert.match(raw, /X-Upstream-Host: 127\.0\.0\.1:3080/);
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.server.close(resolve));
  }
});

test('上游不可达时返回 502', async () => {
  const proxy = await startLanProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort: 9,
  });
  try {
    const response = await request(proxy.port, '/');
    assert.equal(response.status, 502);
  } finally {
    await proxy.close();
  }
});
