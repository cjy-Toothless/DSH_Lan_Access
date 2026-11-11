/**
 * 读取当前进程的 DSH launch token。
 *
 * DSH 每个进程生成一个随机启动 token；`ctx.connection.authenticatedUrl(baseUrl)`
 * 会把该 token 以 `?token=` 的形式附加到任意应用 URL 上。反代在收到上游 401 时
 * 用它代替浏览器完成「token → 签名 Cookie」兑换，这样手机首次打开即登录。
 *
 * 安全约定：token 是进程级凭据，只在内存中使用，绝不写入日志/设置文件/内存之外的存储。
 */

/**
 * 从 Connection 服务提取 launch token。
 * @param {{ authenticatedUrl?: (baseUrl: string) => string } | undefined} connection - Host Connection 服务。
 * @returns {string | undefined} token；不可用时返回 undefined。
 */
export function readLaunchToken(connection) {
  if (connection === undefined || connection === null) return undefined;
  if (typeof connection.authenticatedUrl !== 'function') return undefined;
  try {
    const raw = connection.authenticatedUrl('http://dsh-lan-access.invalid/');
    const token = new URL(raw).searchParams.get('token');
    return typeof token === 'string' && token !== '' ? token : undefined;
  } catch (error) {
    // 只可能是 DSH 内部实现变化；不输出 token 本身。
    return undefined;
  }
}
