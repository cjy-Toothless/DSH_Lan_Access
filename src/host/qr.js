/**
 * 二维码生成：把手机访问 URL 渲染成 SVG 字符串。
 *
 * 使用 vendored 的 `qrcode-generator`（MIT，见 src/vendor/NOTICE.md）。
 * 生成放在 Host 侧，Client 只负责展示 SVG，避免浏览器端再引入二维码库。
 */
import qrcode from '../vendor/qrcode.mjs';

/**
 * 生成一段二维码 SVG。
 * @param {string | null | undefined} text - 编码内容（通常是手机访问 URL）。
 * @returns {string | null} SVG 字符串；内容为空时返回 null。
 */
export function qrSvgFor(text) {
  if (typeof text !== 'string' || text === '') return null;
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
}
