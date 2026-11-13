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
- 修改端口/开关后 Host 立即重启监听器（无需重启 DSH），返回最新状态。**注意响应优先**：由于设置页
  可能经局域网反代访问，`update`/`restart` 会先返回响应、再由约 300ms 后的延迟任务重启监听器，
  否则关闭监听器会切断正在返回的响应，浏览器得到 `ERR_EMPTY_RESPONSE`；延迟重启失败会自动回滚配置。

### 4.6 插件管理器中的展示元数据与图标

插件卡片/行由 DSH 插件管理器渲染，展示信息全部来自本包导出的静态资源（不激活 Host/Client 也会读取）：

- **标题与描述**：`locale/zh.json`、`locale/en.json` 的 `meta.title` / `meta.description`；缺失字段回退到 `package.json` 的 `name` / `description`。
- **图标**：`package.json` 的 `exports["./icon"]` 指向 `assets/icon.svg`；DSH 读取文件后转成 `data:image/svg+xml;base64,...`，限制 256 KiB，且必须留在包目录内。
- 管理器用 `<img>`（卡片 36px、行 30px，`object-fit: contain`）渲染图标，因此图标**必须是自包含的显式颜色**：`currentColor` 在 `<img>` 中解析为黑色，深色主题下几乎不可见；也不依赖主题 token 切换，这是 `<img>` 展示的固有限制。当前图标为蓝色渐变圆角底 + 白色手机/Wi-Fi 图形，在深浅主题下都有足够对比度。

### 4.7 监听地址跟随网卡变化

监听器绑定的是**具体网卡 IPv4**（不是 `0.0.0.0`，见 §5 安全约束），因此本机地址一旦变化，监听器就不会再收到任何入站包：

- 触发场景：路由器重启/DHCP 租约变更、Wi-Fi 断线重连、笔记本休眠唤醒、开关 Clash TUN 或系统代理引发的网络重置；
- 症状：DSH 本体一切正常，设置页仍显示「运行中」，但手机访问旧地址被拒/超时，且 `requests.log` 里完全没有手机 IP 的入站记录；
- 处理：`index.js` 每 5 秒巡检一次 `listLanAddresses()`，用 `shouldRebindListener()` 判断当前绑定地址是否已不属于本机，失效则 `queueRestart()` 重绑到当前首选地址并刷新诊断快照、设置页地址与二维码；
- 边界：只对「自动选择」模式生效；用户手动指定 `listenHost` 时不自动漂移。监听器缺失时按 30 秒退避重试启动。

## 5. 失败与安全

- 监听失败（端口占用、无局域网地址）→ 状态页显示可读原因，不抛出到 DSH 启动流程；
- 上游不可达 → 502；
- 反代只连接 `ctx.webServer.getOrigin()` 给出的回环上游，用户无法改变上游（防 SSRF）；
- 请求路径必须 `/` 开头；请求头由 Node 校验，改写值均为常量或同源 prefix 替换；
- **入站 Host/Origin 校验**：只接受本代理自身 authority（监听 IP:端口 / 127.0.0.1:端口 / localhost:端口），
  其余返回 403（含 WebSocket 升级），用于阻断 DNS rebinding 放大自动 token 登录；监听地址拒绝 `0.0.0.0`/广播/链路本地；
- **重启串行化 + 响应优先**：`update`/`restart` 经同一个 Promise 队列串行执行，且先返回响应、延迟约 300ms 再重启，
  避免并发 stop/start 泄漏监听器，也避免经反代保存时响应被重启切断（`ERR_EMPTY_RESPONSE`）；
- **端口预检与回滚**：保存前探测目标端口是否可绑定（被占用直接拒绝且不改运行状态）；延迟启动失败自动回滚配置；
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

## 7. 验证记录（2026-11-12）

- `node --test tests/unit tests/integration`：33 用例全绿（含代理 HTTP/WS、token 自动登录、设置持久化、地址失效判定、Host 插件集成）。
- 真实 DSH 桌面版端到端 10/10：303+Set-Cookie、带 Cookie 200 HTML、polyfill、静态资源、client bundle、WS 101、桌面回环未受影响。
- 真实手机（Android 17 / Chrome 156，`192.168.0.3`）经局域网反代访问：入口 303→Cookie→200，`/api` 请求全部 200、WebSocket 正常；证据见 `$DSH_HOME/lan-access/requests.log`（远端 IP、Host、UA、状态码）。
- 设置页 slot：`settings.section` occupants 含 `{ id: 'lan-access', order: 60, active: true }`（运行中的页面已热加载）。
- 展示元数据：插件管理器读取 `locale/*.json` 的 `meta.title` / `meta.description` 与导出的 `assets/icon.svg`（`data:` URL）；图标为 36×36 viewBox 的显式彩色资源，渲染尺寸 36px（卡片）/ 30px（行）。
- 稳定性：重新启用后无新增 `crash-*-host.log`，DSH 持续可用。

## 8. 设置页（Client）实现要点

> 接口契约见 [`contract.md`](contract.md)，本节目的是记录实现层面的约定与主题 token 映射。

- **状态机**：`loading` → `ready` / `error`；`ready` 后每 5 秒轮询 `status`，轮询失败只提示「后台刷新失败」，不清空已有数据；表单草稿只在首次加载成功与写操作成功后回填，轮询不覆盖正在输入的内容。
- **错误处理**：`enabled:false` 灰点「已停用」；`enabled && running` 绿点「运行中」；`enabled && !running` 红点「启动失败」并展示 `status.error`；`ok:true` 但 `running:false` 时提示「已保存，但监听器未能启动」。
- **复制回退**：安全上下文用 `navigator.clipboard`，局域网 HTTP 用隐藏 textarea + `execCommand('copy')`，失败显示可读提示（`console.warn`，不静默吞异常）。
- **图标**：设置页内的空状态/警示图标是内联 SVG，使用 `currentColor` 跟随主题；导出的 `assets/icon.svg` 必须显式彩色（见 §4.6）。
- **样式作用域**：组件内 `<style>` 字符串，类名统一 `lan-access-` 前缀；卸载随组件移除。
- **主题 token 映射**（禁止硬编码深浅色）：

| 用途 | token |
|---|---|
| 卡片面 / 描边 | `--dsw-alias-settings-card-fill` / `--dsw-alias-settings-card-stroke` |
| 文本三级 | `--dsw-alias-label-primary` / `-secondary` / `-tertiary` |
| 主按钮 | `--dsw-alias-button-primary-fill` / `-primary-hover` / `--dsw-alias-label-primary-foreground` |
| 次按钮 | `--dsw-alias-button-elevated-fill` / `--dsw-alias-interactive-bg-hover` |
| 输入框 | `--dsw-specific-input-major` / `--dsw-alias-border-l2` |
| 开关 | `--dsw-alias-switch-thumb` / `--dsw-alias-button-primary-fill` / `--dsw-alias-border-l3` |
| 状态 | `--dsw-alias-state-success-primary` / `-error-primary` / `-idle-primary` / `-warn-primary` / `-warn-secondary` / `-warn-tertiary` / `-warn-label` |
| 焦点环 | `--dsw-focus-ring-color`（回落 `--dsw-alias-state-business-primary`）/ `--dsw-focus-ring-width` |
| 圆角 / 字号 | `--dsw-radius-sm\|md\|lg`、`--dsw-font-xs-13-*` / `-s-14-*` / `-m-18-*` / `-xxs-12-*` |
