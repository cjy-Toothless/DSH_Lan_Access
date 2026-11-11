# 共享契约：Host 插件 ↔ 设置页 Client

> 本文件是 Host 与 Client 两个实现之间的唯一契约来源。两端改动接口必须先改本文件。

## 1. 插件标识

| 项 | 值 |
|---|---|
| npm 包名 | `@local/dsh-lan-access` |
| Bundle patch 行 id | `lan-access` |
| Host 插件入口 | `src/host/index.js`（ESM，导出 `name` / `inject` / `apply`） |
| 设置页 Client 入口 | `src/client/client.js`（浏览器 module-loader 格式） |
| 设置页 slot | `settings.section`，注册 id 固定为 `lan-access` |
| Client locale 命名空间 | `lan-access` |
| 持久化文件 | `$DSH_HOME/lan-access/settings.json`（Host 独占读写） |

## 2. Connection RPC

两端通过 DSH 的 generic Connection RPC 通道通信：

- channel：`/dsh-lan-access`
- Client 调用形态（参考 `@smanx/dsh-proxy` 的 client）：`rpc.call(channel, endpoint, payload)`
- Host 注册形态：`ctx.connection.rpc.handle(channel, handler)`

### 2.1 URL 与二维码

`status` 返回的 `urls` 是手机浏览器可直接打开的完整地址列表（`http://<局域网IP>:<端口>/`），`qrSvg` 是已经生成好的 QR 码 **SVG 字符串**（Host 侧生成，Client 直接渲染，不要再引第三方二维码库）。

### 2.2 错误信封

Host handler 统一返回：

```js
{ ok: true, value: <payload> }
{ ok: false, error: { code: 'bad-request' | 'internal', message: '中文可读原因', details: { issues: [] } } }
```

### 2.3 `status`（无入参）

```js
{
  ok: true,
  value: {
    enabled: true,            // 总开关（持久化）
    running: true,            // 监听器是否正在运行
    listenHost: '192.168.0.2',// 实际绑定的局域网 IPv4；未运行时为配置值或自动探测值
    configuredListenHost: '', // 持久化的配置值：'' = 自动选择（用于设置页回填）
    listenPort: 63004,        // 实际端口（若配置端口被占用可能启动失败）
    urls: ['http://192.168.0.2:63004/'],
    qrSvg: '<svg ...>...</svg>',
    upstreamOrigin: 'http://127.0.0.1:63003',
    authMode: 'open',         // 当前仅 open（免认证），保留字段
    warning: '免认证模式：同局域网内任何设备都可用' | null,
    error: null               // 最近一次启动失败的英文/中文原因；成功为 null
  }
}
```

### 2.4 `update`（入参全部可选）

```js
{ enabled?: boolean, listenHost?: string, listenPort?: number }
```

- `listenHost`：空字符串表示自动探测局域网 IPv4；否则必须是本机具体网卡地址。
- `listenPort`：整数 1024–65535。
- Host 先持久化再重启监听；返回最新的 `status` 信封。校验失败返回 `ok:false`，且不改变既有监听器。
- 开关切换过程中允许短暂 `running:false`。

### 2.5 `restart`（无入参）

停止后按当前持久化配置重新监听，返回 `status` 信封。

## 3. 行为约定

1. Client 首次挂载立即调 `status`，之后每 5 秒轮询一次；`update`/`restart` 后立即刷新。
2. 所有用户可见文案走 Client locale（命名空间 `lan-access`，至少 `zh` / `en` 两套字典）。
3. Client 不直接读写文件、不自行探测端口；全部状态以 Host 返回为准。
4. Host 在 `enabled: true` 但监听失败时仍返回 `status`，`running:false` 且 `error` 为可读原因（返回 200，不抛错）。
5. QR 码内容 = `urls[0]`；无可用局域网地址时 `urls: []`，`qrSvg: null`。

## 4. 设置页 UI 要求（Client）

- 标题：`局域网访问`（en: `LAN access`）。
- 区块：
  1. **状态**：运行状态圆点/文案、上游地址、当前监听 `host:port`；
  2. **二维码 + 地址**：有地址时显示 QR 码与可复制的 URL；无地址时显示引导（先接入 Wi‑Fi/有线网）；
  3. **设置表单**：总开关（启用局域网访问）、监听端口输入框、局域网地址下拉框（Host 返回候选地址列表—见下）、保存按钮；
  4. **风险提示**：当前为免认证模式时，用醒目但不喧宾夺主的提示说明风险（借用主题色 `--dsw-alias-*` 变量，禁止硬编码深色）。
- 保存成功后展示"已保存，监听器已重启"之类的反馈；失败展示 `error.message`。
- 不引入任何第三方运行时依赖；React 从模块表 `require('react')`。

### 4.1 候选地址列表

`status` 额外字段 `candidates: string[]`（本机所有可用局域网 IPv4，按推荐顺序）。Client 用其填充"局域网地址"下拉框（空值 = 自动）。

## 5. Client 模块包装格式（必须与示例一致）

参考 `Data Cache/20261111-dsh-lan-access/research/dsh-proxy/package/dsh-proxy/lib/client.js`：

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-lan-access',
  factory: (require) => {
    // ... 定义 inject / apply ...
    return module.exports;
  }
});
```

- `id` 必须等于包名 `@local/dsh-lan-access`。
- 导出 `apply(ctx)` 与 `inject = ['slots', 'locale', 'connection']`。
- 注册：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'lan-access', order: 60, label: () => t('nav'), locale: 'lan-access', inject: () => ({ rpc }) }, SettingsSection))`。
- 字典：`ctx.locale.register('lan-access', { zh: {...}, en: {...} })`，再用 `ctx.locale.bind('lan-access')`。

## 6. Host 加载安全约束（事故后补充，强制）

> 违反任意一条都可能导致 DSH 宿主致命退出；详细事故分析见 `docs/adr/0002-safe-plugin-loading.md`。

1. `apply(ctx, config)` **必须返回 `undefined`**：不返回 Fiber、不返回 thenable、不返回初始化 Promise。
   依赖等待放在 `ctx.inject(deps, callback)` 内；初始化 Promise 用 `.catch()` 兜底，不交给宿主。
2. 初始化/启动/注册异常一律在插件内部记录并降级，禁止冒泡为未处理 rejection。
3. 设置页 RPC 只允许 `connection.register(owner, RPC_CHANNEL, handler)`，`owner` 必须是注入了 `webServer` 的上下文；
   不得使用 `connection.rpc.handle`（owner 解析不可控，会 `without inject`）。
4. 启动期不得阻塞 entry 加载：监听器可以在依赖就绪后异步启动，`status.running` 允许短暂为 false。
