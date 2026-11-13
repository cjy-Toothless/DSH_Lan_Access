# 变更日志

记录 `dsh-lan-access` 的版本变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [未发布]

## [0.1.1] - 2026-11-13

### 修复

- **DHCP 换 IP 后监听器变僵尸、手机永久连不上**：监听器绑定的是启动时的具体网卡 IPv4，电脑换 IP（路由器重启、Wi-Fi 断线重连、开关 Clash TUN/系统代理触发的网络重置等）后旧地址不再属于本机，监听器看起来还在跑，却收不到任何入站包，手机访问被拒绝或超时，而 DSH 本体一切正常。
  - 现在每 5 秒巡检本机局域网地址，发现监听地址已失效就自动重绑到当前首选地址，并同步刷新设置页的地址与二维码；
  - 仅对「自动选择监听地址」生效；用户手动指定 `listenHost` 时不自动漂移，避免违背用户意图。
- 监听器缺失时（首次启动失败、端口被占用后又释放等）每 30 秒自动重试启动，不再需要手动点「重启监听」。

### 测试

- 新增 `shouldRebindListener` 单元用例（地址仍有效 / 已失效 / 完全断网 / 首尾空白 / 非法输入）。
- `npm test` 通过 33 个用例（原 32 个）。

## [0.1.0] - 2026-11-12

首个版本：在 DSH 进程内提供局域网 HTTP + WebSocket 反向代理，复用 DSH 原生 launch token → Cookie 认证，扫码即用；含 Host/Origin 入站校验、非安全上下文 polyfill、设置页与二维码。

[未发布]: https://github.com/cjy-Toothless/DSH_Lan_Access/compare/v0.1.0...HEAD
[0.1.1]: https://github.com/cjy-Toothless/DSH_Lan_Access/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/cjy-Toothless/DSH_Lan_Access/releases/tag/v0.1.0
