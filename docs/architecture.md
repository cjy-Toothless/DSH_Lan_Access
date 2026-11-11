# 架构说明

## 1. 目标与约束

目标：在**不改 DSH 源码、不破坏桌面版自身窗口**的前提下，让局域网手机浏览器使用完整 DSH Web GUI。

硬约束（来自 DSH 0.2.2-rc.1 安装包文档与源码）：

1. 桌面宿主 `dsh-desktop-host` 启动时硬编码 `--host 127.0.0.1 --port 0`，且把带 token 的 URL 交给 Electron 窗口；改核心监听会破坏桌面窗口。
2. DSH 拒绝通配监听地址（`0.0.0.0`）。
3. `/api` 与 WebSocket 要求浏览器会话：进程级 launch token → `GET /?token=...` 兑换绑定 `hostname:port` 的签名 Cookie。
4. 请求信任围栏校验 `Host`（loopback / 绑定 IP / trustedHosts）与 `Origin`（同源）。

## 2. 总体结构

```text
手机浏览器  http://192.168.0.2:63004/
   │  HTTP + WebSocket（免认证）
   ▼
[lan-access Host 插件：node:http 反代]   ← 本插件（与 DSH 同进程）
   │  改写 Host/Origin/Referer 为 http://127.0.0.1:3080
   │  首次 401 时追加 ?token=<launch token>
   ▼
DSH 自身监听器  127.0.0.1:<随机端口> （dsh-host-webserver + frontend-static + /api）
   └── 认证：token → 签名 Cookie（audience 固定为 127.0.0.1:3080）
```

## 3. 模块边界

| 模块 | 职责 | 关键约束 |
|---|---|---|
| `src/host/index.js` | 插件入口：设置加载、监听器生命周期、Connection RPC、index polyfill 注入 | 不抛异常阻塞 DSH 启动；卸载释放端口与连接 |
| `src/host/proxy.js` | HTTP/WS 反代、头改写、token 自动登录、Location 回写 | 只连回环上游（不接收用户指定上游，避免 SSRF）；流式转发不缓冲 |
| `src/host/settings.js` | 设置持久化与校验 | 原子写；不读写 profile 的 `cordis.patch.yml` |
| `src/host/network.js` | 局域网 IPv4 探测/排序 | 跳过回环、link-local；物理网卡优先于虚拟网卡 |
| `src/host/polyfills.js` | 非安全上下文 polyfill 注入 | 幂等；安全上下文 no-op |
| `src/host/qr.js` + `src/vendor/` | 二维码 SVG 生成 | vendored MIT 代码，保留声明 |
| `src/client/client.js` | 设置页 UI、状态轮询、表单 | 仅通过 Connection RPC 与 Host 交互 |

依赖方向：`client → (RPC) → index → proxy/settings/network/qr`，单向，无循环依赖。

## 4. 关键机制

### 4.1 固定回环权威与 Cookie 跨重启

桌面版每次启动 DSH 监听 `127.0.0.1` 的**随机端口**。DSH 的签名 Cookie 绑定 `hostname:port`；若反代按真实上游端口改写 `Host`，DSH 每次重启后手机都要重新登录。

因此反代固定发送 `Host: 127.0.0.1:3080`、`Origin: http://127.0.0.1:3080`：

- DSH 信任围栏接受任意 loopback 权威（端口不参与判定），请求被接受；
- Cookie audience 恒为 `127.0.0.1:3080`，桌面版重启后旧 Cookie 仍匹配（已端到端验证：DSH 重启换端口后携带旧 Cookie 仍 200）；
- 浏览器侧始终看到自己的局域网 origin，相对跳转不受影响；上游绝对 `Location` 会被回写为浏览器 origin。

### 4.2 首次登录（launch token 自动兑换）

1. 手机 `GET /` → 反代转发 → 上游 401；
2. 反代检测到「根路径 GET/HEAD + 无 token 参数 + 有 launch token」，丢弃 401 响应；
3. 用 `?token=<launch token>` 重新请求 → 上游校验 token、写签名 Cookie、302 到 `./`；
4. 反代回写 `Location` 为手机 origin，浏览器存 Cookie 后正常进入；
5. launch token 只存在 Host 进程内存，不写日志/磁盘。

非根路径请求不做 token 兑换（静态资源公开、API 已有 Cookie 或返回 401 交给页面处理）。

### 4.3 WebSocket 透传

`server.on('upgrade')` 中建立到上游的原始 TCP 连接，手工写回请求行与（改写后的）握手头，`head` 随首包发送，之后双向 `pipe`。这样不依赖任何第三方 ws 库，也保留所有扩展协商头。断开时两端 socket 一并销毁，插件卸载时统一关闭。

### 4.4 非安全上下文 polyfill

`ctx.webServer.tapIndex()` 在每次渲染 `index.html` 时注入幂等脚本：

- `crypto.randomUUID`：用 `crypto.getRandomValues` 生成 UUID v4；
- `navigator.clipboard`：`writeText` 用隐藏 textarea + `execCommand('copy')` 兜底。

局域网 HTTP 页面在浏览器里是 non-secure context，上述 API 原生不可用；`https`/localhost 下注入的分支不会执行。

### 4.5 设置与 RPC

- 设置写入 `$DSH_HOME/lan-access/settings.json`（临时文件 + `rename` 原子替换）；
- Host 通过 `connection.register(owner, '/dsh-lan-access', handler)`（owner = 已注入 `webServer` 的上下文）暴露 `status` / `update` / `restart`；
- Client 通过 `ctx.connection.rpc.call(...)` 调用，契约见 `docs/contract.md`；
- 修改端口/开关后 Host 立即重启监听器（无需重启 DSH），返回最新状态。

## 5. 失败与安全

- 监听失败（端口占用、无局域网地址）→ 状态页显示可读原因，不抛出到 DSH 启动流程；
- 上游不可达 → 502；
- 反代只连接 `ctx.webServer.getOrigin()` 给出的回环上游，用户无法改变上游（防 SSRF）；
- 请求路径必须 `/` 开头；请求头由 Node 校验，改写值均为常量或同源 prefix 替换；
- **入站 Host/Origin 校验**：只接受本代理自身 authority（监听 IP:端口 / 127.0.0.1:端口 / localhost:端口），
  其余返回 403（含 WebSocket 升级），用于阻断 DNS rebinding 放大自动 token 登录；监听地址拒绝 `0.0.0.0`/广播/链路本地；
- **重启串行化**：`update`/`restart` 经同一个 Promise 队列串行执行，避免并发 stop/start 泄漏监听器；
- **免认证暴露面**：当前无额外认证，等效于把 DSH 暴露给同局域网；总开关默认开启但可在设置页关闭，风险提示常驻设置页。

## 6. 插件加载安全契约（事故后强制约束）

> 背景：开发中本插件因加载方式错误让 DSH 宿主崩溃 4 次（详见 `docs/adr/0002-safe-plugin-loading.md`）。
> 以下约束是对 Cordis 4.1.0 / DSH 0.2.2 实测得出的硬性规则，修改 `src/host/index.js` 前必须逐条对照。

1. **`apply` 不得返回 Fiber / thenable，也不得返回初始化 Promise。**
   Cordis 会把插件 `apply` 的返回值当 effect 解析：返回函数=disposer、返回 Promise=异步 effect。
   `ctx.inject()` 的 Fiber 是 thenable 且 resolve 出 Fiber 对象，会被判为 `Invalid effect`；
   若把初始化 Promise 交给宿主等待，依赖未就绪时 entry 加载永不结束 → Profile 启动被挂起/销毁 →
   Electron Host 在已销毁 ctx 上创建 effect → `DesktopHostFatalError: cannot create effect on inactive context` 崩溃循环。
   正确形态：`ctx.inject(deps, (scope) => { setup(scope).catch(log); });` 且 `apply` 返回 `undefined`。
2. **所有初始化异常必须在插件内部兜底**：`setup().catch(...)`、`startListener` 内 try/catch、RPC/polyfill 注册 try/catch。
   插件失败只能降级为"局域网访问不可用"，绝不能让宿主看到未处理 rejection。
3. **设置页 RPC 只使用 `connection.register(owner, channel, handler)`**，`owner` 必须是注入了 `webServer` 的插件上下文。
   `connection.rpc.handle` 在注入子上下文中会把 owner 解析成别的上下文，内部 `owner.webServer` 会抛
   `cannot get property "webServer" without inject`；失败必须只降级，不抛出。
4. **启动期不阻塞**：监听器/诊断/注册都在 `setup` 的异步链路里，插件行本身立即 active。
5. **验证方式**：除 `node --test` 外，必须用真实 Cordis 4.1.0 + Loader 1.1.0 的独立 harness 验证
   "apply 返回 undefined、entry 立即 active、监听器异步就绪、卸载释放端口"（脚本在 `Data Cache/.../repro-cordis/`）。

## 7. 验证记录（2026-11-11）

- `node --test tests/unit tests/integration`：30 用例全绿（含代理 HTTP/WS、token 自动登录、设置持久化、Host 插件集成）。
- 真实 DSH 桌面版端到端 10/10：303+Set-Cookie、带 Cookie 200 HTML、polyfill、静态资源、client bundle、WS 101、桌面回环未受影响。
- 设置页 slot：`settings.section` occupants 含 `{ id: 'lan-access', order: 60, active: true }`（运行中的页面已热加载）。
- 稳定性：重新启用后无新增 `crash-*-host.log`，DSH 持续可用。
