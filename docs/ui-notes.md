# 设置页（Client）实现说明

> 范围：`src/client/client.js`、`locale/*.json`、`assets/icon.svg`。接口以 [`docs/contract.md`](contract.md) 为唯一来源。
> 状态：已落盘并通过静态校验；页面最终渲染需安装后在浏览器实测（见「未验证项」）。

## 1. 文件职责

| 文件 | 作用 |
|---|---|
| `src/client/client.js` | 浏览器 module-loader bundle：注册 `settings.section`（id `lan-access`，order 60）、双语 UI 字典、React 设置页组件；无构建步骤、无第三方运行时依赖 |
| `locale/zh.json` / `locale/en.json` | 仅插件管理展示元数据 `meta.title` / `meta.description`（UI 文案字典在 client.js 内） |
| `assets/icon.svg` | 原创图标（手机 + Wi-Fi 波），`viewBox="0 0 24 24"`，`currentColor`，随插件管理主题变色 |

## 2. 契约映射

- 包装：`window.__ModuleLoader__.load({ id: '@local/dsh-lan-access', factory: (require) => { ... return module.exports; } })`。
- 导出：`inject = ['slots', 'locale', 'connection']` 与 `apply(ctx)`。
- 字典：`ctx.effect(() => ctx.locale.register('lan-access', { zh, en }), ...)`，再 `ctx.locale.bind('lan-access')`；zh/en 键集完全一致（44 个键）。
- 注册（与 contract.md §5 逐字一致）：
  `ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'lan-access', order: 60, label: () => t('nav'), locale: 'lan-access', inject: () => ({ rpc }) }, SettingsSection)), ...)`。
- RPC：`rpc.call('/dsh-lan-access', 'status' | 'update' | 'restart', payload)`；按 `{ ok, value } | { ok, error }` 信封解包，`error.message` 原样展示，未知异常用本地化兜底文案。

## 3. 状态机与轮询

- 三态：`loading` → `ready` / `error`；`ready` 后后台轮询失败只显示「后台刷新失败」提示，不清空已有数据。
- 挂载立即 `status`，之后 `setInterval` 每 5 秒轮询；卸载清理定时器与复制提示定时器（组件内 `useEffect` cleanup）。
- `update` / `restart` 的回包直接当作最新状态刷新界面并回填表单；若回包不是状态对象则退化为再拉一次 `status`。
- 表单草稿只在「首次加载成功」与「写操作成功」时用 Host 状态回填，轮询不会覆盖用户正在输入的内容。

## 4. 错误处理

- 状态徽标：`enabled:false` → 已停用（灰点）；`enabled && running` → 运行中（绿点）；`enabled && !running` → 启动失败（红点），并展示 `status.error`。
- `update` 返回 `ok:true` 但 `running:false` 且有 `error` 时，显示「已保存，但监听器未能启动」+ 原因（warn 样式）。
- 保存校验：端口必须是 1024–65535 的整数（前端先校验，再交 Host 校验）。
- 复制：安全上下文用 `navigator.clipboard`，局域网 HTTP（非安全上下文）回退 `textarea + execCommand('copy')`；失败显示可读提示，不静默吞异常（均 `console.warn`）。

## 5. 主题变量

全部配色取自主题 token（无硬编码深浅色），阴影仅用半透明 `rgba(0,0,0,.28)`：

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
| 圆角/字号 | `--dsw-radius-sm|md|lg`、`--dsw-font-xs-13-*` / `-s-14-*` / `-m-18-*` / `-xxs-12-*` |

样式以组件内 `<style>` 字符串渲染，随组件卸载自动移除；类名统一 `lan-access-` 前缀避免污染。

## 6. 集成确认点（与 Host 现状对齐）

- Host `status` 已返回 `candidates`、`qrSvg`、`urls`、`warning`、`error`、`upstreamOrigin`；`qrSvg` 自带 `fill="white"` 背景矩形，深色主题下可扫描，Client 不覆盖二维码颜色。
- 待确认：`status` 没有单独暴露「配置的监听地址」（只有实际绑定值），因此 Client 回填下拉框时默认按「自动」处理；若用户在 Host 侧显式指定过网卡地址，再次打开设置页下拉框会显示「自动」。建议契约补一个可选字段 `configuredListenHost`（空串 = 自动），Client 已兼容读取该字段，Host 补上即可。
- `applied` 后建议实测：插件管理里的标题/描述/图标、设置页状态圆点、二维码、URL 复制、开关/端口/地址保存反馈、免认证提示。

## 7. 静态校验

```text
node --check dsh-lan-access/src/client/client.js   → OK (exit 0)
JSON.parse(locale/zh.json, locale/en.json)         → OK，meta 字段齐全
zh/en 字典键集一致性                                → 44 / 44，无缺失
BOM / CRLF / 绝对路径                               → 均为 0 / false
icon.svg XML 解析                                   → OK，root=svg，viewBox="0 0 24 24"
```

## 8. 未验证项

- 浏览器实际渲染（布局、窄屏、深浅主题观感）无法在未安装状态下验证。
- `ctx.slots.register` 的 `inject` 回调与 `locale` 选项按参考实现（`@smanx/dsh-proxy` 的 client.js）与官方设置页 bundle 的写法实现，语义以安装后的 slot 注入结果为准。

## 9. 许可

图标为原创，随项目 MIT 许可发布；二维码生成在 Host 侧（vendored `qrcode-generator`，MIT），Client 不引入第三方代码。
