/**
 * 用真实 Cordis 4.1.0 + Loader 1.1.0 验证插件行的加载语义：
 * - apply 不返回 thenable，入口 fiber 立即 active（不会卡住 Profile 启动）
 * - 依赖服务就绪后异步启动局域网监听器
 * - connection.register(owner, ...) 在 owner 上注册 effect 并访问 owner.webServer 不抛错
 * - 卸载时释放监听器
 */
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PROJECT = path.resolve(import.meta.dirname, '..');
const moduleUrl = pathToFileURL(`${PROJECT}/src/host/index.js`).href;
const baseUrl = pathToFileURL(`${PROJECT}/cordis.patch.yml`).href;

const temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-lan-access-verify-'));
process.env.DSH_HOME = temporaryHome;

const failures = [];
function check(name, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` :: ${detail}`}`);
  if (!condition) failures.push(name);
}

// 模拟 DSH 自身监听器（上游）
const upstreamRequests = [];
const upstream = http.createServer((request, response) => {
  upstreamRequests.push({ url: request.url, host: request.headers.host, origin: request.headers.origin });
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html><head></head><body>upstream</body></html>');
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamPort = upstream.address().port;

const root = new Context();
await root.plugin(Loader, { baseUrl });

// 模拟 webServer 服务
let registeredRoutes = [];
await root.plugin({
  name: 'fake-web-server',
  apply(ctx) {
    ctx.provide('webServer', {
      getOrigin: () => `http://127.0.0.1:${upstreamPort}`,
      port: upstreamPort,
      tapIndex: () => () => {},
      register(route) {
        registeredRoutes.push(route);
        return () => {
          registeredRoutes = registeredRoutes.filter((item) => item !== route);
        };
      },
    });
  },
});

// 模拟 connection 服务：真实实现内部使用 owner.effect(() => owner.webServer.register(...))
await root.plugin({
  name: 'fake-connection',
  apply(ctx) {
    ctx.provide('connection', {
      authenticatedUrl: (base) => `${base}?token=verify-token`,
      register(owner, channel, handler) {
        return owner.effect(
          () => owner.webServer.register({
            kind: 'prefix',
            path: channel,
            handler: async () => {},
          }),
          `verify: ${channel}`,
        );
      },
      rpc: {
        handle() {
          throw new Error('rpc.handle 不应被调用');
        },
      },
    });
  },
});

// 找一个空闲端口给反代
const probe = http.createServer();
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const listenPort = probe.address().port;
await new Promise((resolve) => probe.close(resolve));

const started = Date.now();
const id = await root.loader.create({
  id: 'lan-access',
  name: moduleUrl,
  config: { enabled: true, listenHost: '127.0.0.1', listenPort },
});
await root.loader.await();
const elapsed = Date.now() - started;
const entry = root.loader.resolve(id);

check('Loader 启动在 2 秒内完成（不阻塞）', elapsed < 2000, `${elapsed}ms`);
check('插件行 fiber 为 ACTIVE', entry.fiber?.state === 2, `state=${entry.fiber?.state} error=${entry.fiber?._error?.message}`);

// 等监听器就绪后请求一次，验证代理链路与 Host 改写
let proxied = null;
const deadline = Date.now() + 3000;
while (Date.now() < deadline) {
  try {
    proxied = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: listenPort, path: '/', headers: { connection: 'close' } }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', reject);
      request.end();
    });
    break;
  } catch (error) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
check('局域网监听器已启动并可访问', proxied?.status === 200, `status=${proxied?.status}`);
const routeDeadline = Date.now() + 2000;
while (!registeredRoutes.some((route) => route.path === '/dsh-lan-access') && Date.now() < routeDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
check('Connection RPC 路由已注册', registeredRoutes.some((route) => route.path === '/dsh-lan-access'));
check('上游收到改写后的 Host', upstreamRequests[0]?.host === '127.0.0.1:3080', upstreamRequests[0]?.host);
check('上游收到改写后的 Origin', upstreamRequests[0]?.origin === 'http://127.0.0.1:3080', upstreamRequests[0]?.origin);

// 卸载：监听器应关闭
await root.fiber.dispose();
let closed = false;
try {
  await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: listenPort, path: '/', headers: { connection: 'close' } }, resolve);
    request.on('error', reject);
    request.end();
  });
} catch (error) {
  closed = true;
}
check('卸载后监听器已关闭', closed);

await new Promise((resolve) => upstream.close(resolve));
await rm(temporaryHome, { recursive: true, force: true });

console.log(failures.length === 0 ? 'ALL PASS' : `FAILURES: ${failures.join(', ')}`);
process.exitCode = failures.length === 0 ? 0 : 1;
