/**
 * 共享契约常量（Host 侧）。
 * Client 侧（src/client/client.js）必须在自己的 bundle 内同步维护同一组值；
 * 修改任何一项都要同步更新 docs/contract.md。
 */

/** Connection generic RPC 通道名。 */
export const RPC_CHANNEL = '/dsh-lan-access';

/** `status`：读取运行状态（无入参）。 */
export const RPC_STATUS = 'status';

/** `update`：持久化并应用设置变更。 */
export const RPC_UPDATE = 'update';

/** `restart`：按当前持久化配置重启监听器（无入参）。 */
export const RPC_RESTART = 'restart';

/** 设置持久化目录（相对 $DSH_HOME）。 */
export const SETTINGS_DIR = 'lan-access';

/** 设置文件名。 */
export const SETTINGS_FILE_NAME = 'settings.json';

/** 默认监听端口：避开 DSH 自身常用端口与 Web 开发常用端口。 */
export const DEFAULT_LISTEN_PORT = 63004;

/** 端口允许范围（避免绑定特权端口）。 */
export const MIN_LISTEN_PORT = 1024;
export const MAX_LISTEN_PORT = 65535;

/**
 * 发往上游的固定 Host 头。
 *
 * DSH 的签名 Cookie 绑定 `hostname:port`，而桌面版每次启动监听 `127.0.0.1` 的随机端口；
 * 转发时固定为一个回环权威，Cookie 即可跨桌面版重启继续有效。
 * DSH 的请求信任围栏接受任意回环地址（回环地址本身即受信），端口不参与判断。
 */
export const UPSTREAM_HOST_HEADER = '127.0.0.1:3080';

/** 与 {@link UPSTREAM_HOST_HEADER} 配套的 Origin 头。 */
export const UPSTREAM_ORIGIN_HEADER = `http://${UPSTREAM_HOST_HEADER}`;

/** 状态里固定返回的认证模式（v1 仅支持免认证）。 */
export const AUTH_MODE = 'open';

/** 免认证模式风险提示文案。 */
export const OPEN_MODE_WARNING =
  '免认证模式：同一局域网内任何设备都能打开并操作 DSH，请仅在可信网络中启用。';
