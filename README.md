# dsh-lan-access

> 让手机浏览器在局域网内直接打开并使用**电脑上的 DSH**（DeepSeek Harness 桌面版）——扫码即用，无需改 DSH 源码、无需单独进程。

**项目状态**：v0.1 已实现、安装并完成端到端验证（2026-11-11，DSH 0.2.2-rc.1 桌面版）。本插件为本地 DSH bundle，按仓库内 `docs/contract.md` 契约实现；开发中曾因插件加载方式错误导致宿主崩溃，根因与修复约束见 [`docs/adr/0002-safe-plugin-loading.md`](docs/adr/0002-safe-plugin-loading.md)，**修改 `src/host/index.js` 的加载逻辑前务必先读**。

---

## 为什么需要它

DSH 桌面版出于安全考虑，把浏览器入口硬编码在 `127.0.0.1` 的随机端口上：

- 手机和电脑不在同一个网络命名空间，手机连不上 `127.0.0.1`；
- DSH 官方拒绝 `--host 0.0.0.0`；
- 浏览器访问还有 **Host/Origin 同源围栏 + 进程启动 token + 30 天签名 Cookie** 三层认证，裸端口转发会被 403/401 拒绝。

本插件在 DSH 进程内额外监听一个**局域网 IPv4 端口**，把 HTTP 与 WebSocket 全量转发到 DSH 自身回环监听器，并复用 DSH 原生认证：手机首次打开时由插件代浏览器完成 `launch token → Cookie` 兑换，之后即可正常使用完整界面（含流式输出、上传、终端页等）。

## 功能

- **HTTP + WebSocket 全协议透传**：`/api` RPC、事件流、插件静态资源、文件上传/下载、SSE 均走同一入口，不缓冲、支持背压。
- **扫码即用**：设置页显示二维码与可复制地址；自动探测本机局域网 IPv4（并可从下拉框手动选择）。
- **原生认证复用**：不实现第二套登录，直接把 DSH 的 launch token 换成签名 Cookie；桌面版重启后端口变化也不影响已登录设备（固定回环权威，见架构文档）。
- **非安全上下文 polyfill**：局域网 HTTP 下浏览器缺少 `crypto.randomUUID`、`navigator.clipboard`，插件会向页面注入幂等 polyfill，避免实时功能报错。
- **入站 Host/Origin 校验**：代理只接受指向自身监听 authority（`<监听IP>:<端口>`、`127.0.0.1:<端口>`、`localhost:<端口>`）的请求，阻断 DNS rebinding 类攻击；监听地址拒绝 `0.0.0.0`/广播/链路本地，只绑定具体网卡。
- **零第三方运行时依赖**（仅 vendored MIT 二维码生成器），Host 代码可审计。
- **生命周期托管**：随 DSH 启停，插件卸载即关闭监听与全部连接；监听失败只影响本插件，不阻塞 DSH 启动。

## 已验证（2026-11-11，真实 DSH 0.2.2-rc.1 桌面版）

- 局域网 `GET http://<LAN-IP>:63004/` → **303 + Set-Cookie**（HttpOnly / SameSite=Strict，audience 固定 `127.0.0.1:3080`，30 天）；
- 携带 Cookie 再访问 → 200 HTML（完整 DSH 外壳），并注入 `__DSH_LAN_ACCESS_POLYFILL__`；
- WebSocket `/api/remote.mux` 升级 → `101 Switching Protocols`；
- 静态资源与设置页 client bundle 经反代可访问；设置页 `lan-access` 已在运行中的 DSH 页面注册为 active；
- 桌面端自身回环监听不受影响；
- 卸载/停用后监听器关闭（`node --test` 30 用例 + 真实 Cordis/Loader 加载验证全绿）。

## ⚠️ 安全模型（必读）

**当前版本为「免认证」模式**：插件只做网络转发，不额外要求密码/配对码。后果是：

> 同一局域网内**任何设备**（含访客 Wi-Fi、被入侵的 IoT 设备）只要知道端口，就能打开并完整操作你的 DSH——而 DSH 可以执行本机代码、读写文件。

因此：

1. 只在**完全可信的家庭/个人局域网**启用；
2. 不用时在设置页关闭总开关，或直接停用插件；
3. 不要在公司网络、公共 Wi-Fi、访客网络启用；
4. 后续版本计划加入「访问密码/扫码配对」与 TLS，贡献欢迎。

插件监听一个**具体网卡 IPv4**（不是 `0.0.0.0`），不会暴露到其他网络接口。

## 安装

### 方式 A：插件管理器（推荐）

本项目是标准 DSH bundle，在 DSH 插件管理器中安装本目录即可：

- 桌面版：插件面板 →「添加插件」→ 选择本地绝对路径 `...\default-workspace\dsh-lan-access`；
- 或在 DSH 内由 Agent 调用 `plugin_manager` 的 `install_bundle`，target 传本目录绝对路径。

安装后**重启 DSH**（或等待 HMR 生效），设置 → **局域网访问** 即出现入口。

### 方式 B：开发期本地联调

修改本项目源码后，重新执行安装/重载即可；Host 代码变化需要重启 DSH 才会加载新模块。

## 使用

1. 确保电脑与手机连在**同一个 Wi-Fi/路由器**；
2. 打开 DSH → 设置 → **局域网访问**；
3. 确认状态为「运行中」，用手机相机扫描二维码（或手动输入页面上的地址）；
4. 首次打开会短暂跳转后自动登录，之后 30 天内免登录（除非清除浏览器 Cookie）。

### 配置项

设置持久化在 `$DSH_HOME/lan-access/settings.json`（Windows 默认 `%USERPROFILE%\.dsh\lan-access\settings.json`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭即停止监听 |
| `listenHost` | `""` | 监听的本机 IPv4；空 = 自动选择首选局域网地址 |
| `listenPort` | `63004` | 监听端口（1024–65535） |

### 端口与防火墙（Windows）

- 首次监听时 Windows Defender 防火墙可能弹窗，请勾选「专用网络」并允许；
- 若错过弹窗或手机「连接被拒绝」，以管理员权限执行（端口按需替换）：

```powershell
New-NetFirewallRule -DisplayName "DSH LAN Access 63004" -Direction Inbound -LocalPort 63004 -Protocol TCP -Action Allow
```

- 确认当前 Wi-Fi 网络配置文件类型是「专用网络」；「公用网络」下 Windows 会默认拦截入站。

## 故障与恢复（重要）

- **诊断文件**：`$DSH_HOME/lan-access/diagnostics.json` 记录最近一次启动/停止阶段、实际监听地址、候选网卡与错误原因；排障先看它。
- **设置页不显示 / 无法读取状态**：说明 Connection RPC 注册失败（反代本身仍工作）。查看 DSH 日志中的 `[dsh-lan-access]` 行；重启 DSH 后若仍失败，反馈该行文本。
- **如果 DSH 启动失败或崩溃循环**：先把本插件从 profile 隔离——
  1. 编辑 `$DSH_HOME/profiles/desktop/package.json`，从 `dsh.profile.bundles` 数组移除 `"@local/dsh-lan-access"`（保留 `dependencies` 无妨）；
  2. 若 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 中残留 `id: lan-access` 行，一并删除；
  3. 重启 DSH。
  桌面版崩溃日志位于 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log`。
- **本插件自身初始化失败不会导致宿主崩溃**（apply 返回 undefined、异常全部内部兜底）；若仍出现崩溃，请保留 crash 日志并优先按上面的隔离步骤恢复。

## 排障

| 现象 | 排查 |
|---|---|
| 设置页显示「未发现可用局域网 IPv4」 | 电脑未联网/仅有虚拟网卡；接 Wi-Fi 或网线后点「重启监听」 |
| 「监听 xxx:63004 失败：EADDRINUSE」 | 端口被占用：换端口，或 `netstat -ano | findstr :63004` 找到并结束占用进程 |
| 手机打开空白/一直转圈 | 手机与电脑不同网段/开了独立 VPN；先 `ping 电脑IP` 验证连通，再检查防火墙 |
| 保存设置后页面报 `ERR_EMPTY_RESPONSE`（旧版本问题，已修复） | 原因是响应还没写回浏览器，监听器就被重启了。更新到最新版本后：先返回响应、约 300ms 后再重启；保存成功后保持页面打开数秒即可 |
| 保存时提示「端口已被占用」 | 换一个端口。该端口可能被其它程序或历史残留实例占用；重启 DSH 可清理历史残留监听 |
| 手机提示 401 / 需要重新登录 | 等待自动跳转；若仍失败，刷新页面。DSH 重启后旧 Cookie 通常仍有效（端口固定为回环权威） |
| 页面能开但复制/实时输出异常 | 确认 polyfill 已注入（开发者工具查看 `window.__DSH_LAN_ACCESS_POLYFILL__`） |

## 目录结构

```text
dsh-lan-access/
├── package.json            # bundle 清单（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml        # 插入 Host 插件行（id: lan-access）
├── src/
│   ├── host/               # Host 侧：入口、反代、设置、探测、polyfill、二维码
│   ├── client/             # 浏览器侧：设置页（module-loader bundle）
│   └── vendor/             # 第三方源码（qrcode-generator，MIT，含 NOTICE）
├── locale/                 # 插件管理展示用元数据（zh/en）
├── assets/icon.svg         # 插件图标
├── docs/                   # 契约、架构、ADR
└── tests/                  # node --test 单元/集成测试
```

## 开发与测试

```powershell
node --check src/host/index.js          # 语法检查
node --test tests/unit                  # 单元 + 代理集成测试（29+ 用例）
```

设计与接口见 [`docs/contract.md`](docs/contract.md)、[`docs/architecture.md`](docs/architecture.md)。

## 已知限制 / Roadmap

- v0.1 **无访问认证**（见安全模型）；规划：访问密码 + 扫码配对 + 撤销设备。
- 仅 HTTP（局域网明文，非安全上下文）；规划：可选自签/自有证书 TLS。
- 只监听 IPv4；IPv6-only 局域网暂不支持。
- 桌面版端口变化已通过固定回环权威规避，但若 DSH 未来更改 Host/Cookie 规则需回归测试。

## 许可

MIT。第三方组件许可见 [`src/vendor/NOTICE.md`](src/vendor/NOTICE.md)。

> 本项目与 DeepSeek 官方无关；DSH 本体版权归其作者所有。
