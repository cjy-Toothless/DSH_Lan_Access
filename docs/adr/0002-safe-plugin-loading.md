# ADR 0002：插件加载安全契约（宿主崩溃事故复盘）

- 状态：已采纳（事故后强制）
- 日期：2026-11-11
- 关联：ADR 0001（进程内反向代理方案）

## 背景

`dsh-lan-access` v0.1 开发过程中，先后两次错误的插件加载方式导致 **DSH 桌面宿主崩溃 4 次**（用户手动禁用插件后才恢复）：

1. 第一版：`apply` 直接访问 `ctx.webServer` / `ctx.connection`，但 DSH 的 Loader 未把模块级 `inject` 导出传递到 fiber，
   报 `cannot get property "webServer" without inject`。
2. 修复尝试一：`apply` 返回 `ctx.inject(...)` 的 Fiber。Cordis 把 `apply` 返回值当 effect 解析，
   Fiber 是 thenable 且 resolve 出 Fiber 对象，被判为 `Invalid effect`。
3. 修复尝试二：`apply` 返回 `new Promise(...)` 等待依赖与初始化完成。依赖就绪前 entry 加载永不结束，
   Profile 启动被挂起/销毁；Electron Host 随后在已销毁的根 ctx 上调用 `installOperationDiagnostics`，
   抛 `DesktopHostFatalError: cannot create effect on inactive context`，形成启动崩溃循环。
4. 另一处独立错误：设置页 RPC 使用 `connection.rpc.handle(...)`，其 owner 在注入子上下文中被解析为
   不持有 `webServer` 的上下文，内部 `owner.effect(() => owner.webServer.register(...))` 抛
   `cannot get property "webServer" without inject`，在 live recompose 时直接让宿主进程退出。

证据：
- `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-2026-11-11T15-22-03-969Z-host.log`（fatal load failure + 完整栈）
- `crash-2026-11-11T15-22-16/21/27-*-host.log`（启动崩溃循环）
- `plugin-operations/operations.jsonl`（启用/崩溃时间线）

## 决策

1. **`apply` 只做依赖声明，不承载初始化**：
   ```js
   export function apply(ctx, config) {
     ctx.inject(['webServer', 'connection'], (scope) => {
       setup(scope, config).catch((error) => logError(error));
     });
     // 返回 undefined —— 绝不能返回 Fiber / thenable / 初始化 Promise
   }
   ```
   插件行立即 active，反代异步启动；任何失败只降级不冒泡。
2. **设置页 RPC 只走 `connection.register(owner, channel, handler)`**，owner 使用已注入 `webServer` 的上下文；
   不再使用 `connection.rpc.handle`，注册失败只降级为设置页不可用。
3. **验证流程升级**：除单元测试外，新增基于真实 `@deepseek-ai/cordis@4.1.0` + `@deepseek-ai/cordis-plugin-loader@1.1.0`
   的独立 harness（[`scripts/verify-host.mjs`](../scripts/verify-host.mjs)），断言
   "apply 返回 undefined / entry 10ms 内 active / 监听器异步就绪 / 卸载释放端口 / RPC 路由注册成功"。
   在 live profile 启用前必须先跑绿。
4. **恢复预案**：从 profile 的 `dsh.profile.bundles` 移除 `@local/dsh-lan-access` 并重启，即可隔离故障插件。

## 后果

- 正面：插件加载路径与宿主生命周期解耦，初始化失败不会影响 DSH 启动；崩溃根因被固化为可回归的测试与文档。
- 负面：设置页在 RPC 注册失败时不可用（反代仍工作），需要用户查看诊断文件/日志。
- 约束：未来任何 DSH 插件代码都必须遵守 `docs/contract.md` §6 与 `docs/architecture.md` §6；修改加载逻辑前先跑 Loader harness。
