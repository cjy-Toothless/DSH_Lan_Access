# dsh-lan-access

> 让手机浏览器在局域网内直接打开并使用**电脑上的 DSH**（DeepSeek Harness 桌面版）——扫码即用，无需改 DSH 源码、无需单独进程。

**仓库**：<https://github.com/cjy-Toothless/DSH_Lan_Access>

**项目状态**：v0.1.1 已实现、安装，并在真实 DSH 0.2.2-rc.1 桌面版与 Android 手机上完成端到端验证（2026-11-12）；2026-11-13 修复「DHCP 换 IP 后监听器失效、手机连不上」，改为自动跟随网卡地址。本插件为本地 DSH bundle，按仓库内 `docs/contract.md` 契约实现；开发中曾因插件加载方式错误导致宿主崩溃，根因与修复约束见 [`docs/adr/0002-safe-plugin-loading.md`](docs/adr/0002-safe-plugin-loading.md)，**修改 `src/host/index.js` 的加载逻辑前务必先读**。

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
- **监听地址自动跟随网卡变化**：DHCP 换 IP（路由器重启、Wi-Fi 断线重连、开关 Clash TUN/系统代理触发的网络重置等）后，5 秒内自动重新监听新地址，不需要手动点「重启监听」或重启 DSH；地址变化时二维码与地址同步刷新。
- **原生认证复用**：不实现第二套登录，直接把 DSH 的 launch token 换成签名 Cookie；桌面版重启后端口变化也不影响已登录设备（固定回环权威，见架构文档）。
- **非安全上下文 polyfill**：局域网 HTTP 下浏览器缺少 `crypto.randomUUID`、`navigator.clipboard`，插件会向页面注入幂等 polyfill，避免实时功能报错。
- **入站 Host/Origin 校验**：代理只接受指向自身监听 authority（`<监听IP>:<端口>`、`127.0.0.1:<端口>`、`localhost:<端口>`）的请求，阻断 DNS rebinding 类攻击；监听地址拒绝 `0.0.0.0`/广播/链路本地，只绑定具体网卡。
- **零第三方运行时依赖**（仅 vendored MIT 二维码生成器），Host 代码可审计。
- **完整的插件展示信息**：插件管理器读取导出的 `locale/*.json`（标题/描述）与 `assets/icon.svg`（显式彩色图标），深浅主题下均清晰可辨。
- **生命周期托管**：随 DSH 启停，插件卸载即关闭监听与全部连接；监听失败只影响本插件，不阻塞 DSH 启动。

## 已验证（2026-11-12，真实 DSH 0.2.2-rc.1 桌面版）

- 局域网 `GET http://<LAN-IP>:63004/` → **303 + Set-Cookie**（HttpOnly / SameSite=Strict，audience 固定 `127.0.0.1:3080`，30 天）；
- 携带 Cookie 再访问 → 200 HTML（完整 DSH 外壳），并注入 `__DSH_LAN_ACCESS_POLYFILL__`；
- WebSocket `/api/remote.mux` 升级 → `101 Switching Protocols`；
- 静态资源与设置页 client bundle 经反代可访问；设置页 `lan-access` 已在运行中的 DSH 页面注册为 active；
- **真实手机验证**：Android 17 / Chrome 156 经 `http://192.168.0.2:63004/` 打开完整界面，`/api` 请求全部 200、设置页可正常读写；
- 插件管理器展示标题、描述与图标（`data:` URL，卡片 36px / 行 30px）；
- 桌面端自身回环监听不受影响；
- 卸载/停用后监听器关闭（`node --test tests/unit tests/integration` 32 用例 + 真实 Cordis/Loader 加载验证全绿）。

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

### 方式 A：从 GitHub 克隆后安装（推荐）

```powershell
git clone https://github.com/cjy-Toothless/DSH_Lan_Access.git
```

本项目是标准 DSH bundle，在 DSH 插件管理器中安装克隆下来的目录即可：

- 桌面版：插件面板 →「添加插件」→ 选择该目录的绝对路径；
- 或在 DSH 内由 Agent 调用 `plugin_manager` 的 `install_bundle`，target 传该目录绝对路径。

安装后**重启 DSH**（或等待 HMR 生效），设置 → **局域网访问** 即出现入口。

### 方式 B：本地目录 / 开发期联调

直接选择本机已 checkout 的 `dsh-lan-access` 目录安装；修改源码后重新执行安装/重载即可，Host 代码变化需要重启 DSH 才会加载新模块。

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

- **诊断文件**：`$DSH_HOME/lan-access/diagnostics.json` 记录最近一次启动/停止阶段、实际监听地址、候选网卡与错误原因；
  `$DSH_HOME/lan-access/requests.log` 记录最近的入站连接/请求/响应（含远端 IP、Host、UA、状态码，超过 512KB 轮换为 `.1`），
  手机连不上时先看它是否出现手机 IP 的 `connection`/`request` 行，以区分“请求没到电脑”还是“到了但响应异常”。
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
| 昨天能连、今天连不上，且手机 `ping` 不通电脑 | 电脑 DHCP 换了 IP（路由器重启、Wi-Fi 重连、开关 Clash 等都会触发），旧地址上已没有监听器。v0.1.1 起会在 5 秒内自动重绑，刷新设置页拿新二维码即可；若设置页手动指定过 `listenHost`，改为「自动」或重新选当前地址 |
| 保存设置后页面报 `ERR_EMPTY_RESPONSE`（旧版本问题，已修复） | 原因是响应还没写回浏览器，监听器就被重启了。更新到最新版本后：先返回响应、约 300ms 后再重启；保存成功后保持页面打开数秒即可 |
| 保存时提示「端口已被占用」 | 换一个端口。该端口可能被其它程序或历史残留实例占用；重启 DSH 可清理历史残留监听 |
| 手机提示 401 / 需要重新登录 | 等待自动跳转；若仍失败，刷新页面。DSH 重启后旧 Cookie 通常仍有效（端口固定为回环权威） |
| 页面能开但复制/实时输出异常 | 确认 polyfill 已注入（开发者工具查看 `window.__DSH_LAN_ACCESS_POLYFILL__`） |

## 目录结构

```text
dsh-lan-access/
├── package.json            # bundle 清单（dsh.bundle.patch + dsh.client + 导出资源）
├── cordis.patch.yml        # 插入 Host 插件行（id: lan-access）
├── src/
│   ├── host/               # Host 侧：入口、反代、设置、探测、polyfill、二维码
│   ├── client/             # 浏览器侧：设置页（module-loader bundle）
│   └── vendor/             # 第三方源码（qrcode-generator，MIT，含 NOTICE）
├── locale/                 # 插件管理器展示元数据（meta.title / meta.description，zh/en）
├── assets/icon.svg         # 插件图标（36×36，显式彩色，供 <img> 渲染）
├── docs/                   # 契约、架构、ADR
└── tests/                  # node --test 单元/集成测试
```

## 开发与测试

```powershell
npm test        # node --test tests/unit tests/integration（32 用例）
npm run check   # node --check：全部 Host/Client 源码语法检查
```

- 修改 Host 源码后需重载插件（或重启 DSH）才生效；只改 Client 代码可通过插件管理器停用/启用 bundle 触发热重载。
- 修改 `assets/icon.svg` 后刷新插件管理器页面即可看到新图标（元数据在每次读取时从磁盘重新生成 `data:` URL）。
- 设计与接口见 [`docs/contract.md`](docs/contract.md)、[`docs/architecture.md`](docs/architecture.md)。

## 已知限制 / Roadmap

- v0.1 **无访问认证**（见安全模型）；规划：访问密码 + 扫码配对 + 撤销设备。
- 仅 HTTP（局域网明文，非安全上下文）；规划：可选自签/自有证书 TLS。
- 只监听 IPv4；IPv6-only 局域网暂不支持。
- 自动跟随网卡地址只对「自动选择」生效；手动指定 `listenHost` 时不自动漂移（避免与用户意图冲突）。
- 桌面版端口变化已通过固定回环权威规避，但若 DSH 未来更改 Host/Cookie 规则需回归测试。

## 许可

本项目以 **GPL-3.0-or-later** 发布，许可证全文见 [`LICENSE`](LICENSE)。

第三方组件：二维码生成器 `qrcode-generator` 以 MIT 许可 vendored，声明见 [`src/vendor/NOTICE.md`](src/vendor/NOTICE.md)；MIT 与 GPL-3.0 兼容，随本项目一并分发。

> 本项目与 DeepSeek 官方无关；DSH 本体版权归其作者所有。
