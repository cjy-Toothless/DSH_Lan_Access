/**
 * 非安全上下文（局域网 http://）polyfill 注入。
 *
 * 浏览器只在「安全上下文」（https 或 localhost）暴露 `crypto.randomUUID`、
 * `navigator.clipboard` 等 API；手机通过 `http://192.168.x.x:端口` 访问 DSH 时
 * 这些 API 不存在，DSH 前端可能因此报错（实时连接、复制按钮等）。
 *
 * 注入方式：借助 `ctx.webServer.tapIndex` 在每次渲染 index.html 时插入一段
 * 幂等脚本；在安全上下文里所有分支都是 no-op。
 */

export const POLYFILL_MARKER = '__DSH_LAN_ACCESS_POLYFILL__';

const INLINE_SCRIPT = `
(function () {
  if (window.${POLYFILL_MARKER}) return;
  window.${POLYFILL_MARKER} = true;

  try {
    var cryptoObject = window.crypto;
    if (cryptoObject && typeof cryptoObject.randomUUID !== 'function' && typeof cryptoObject.getRandomValues === 'function') {
      Object.defineProperty(cryptoObject, 'randomUUID', {
        configurable: true,
        value: function randomUUID() {
          var bytes = new Uint8Array(16);
          cryptoObject.getRandomValues(bytes);
          bytes[6] = (bytes[6] & 0x0f) | 0x40;
          bytes[8] = (bytes[8] & 0x3f) | 0x80;
          var hex = '';
          for (var index = 0; index < bytes.length; index += 1) {
            hex += (bytes[index] + 0x100).toString(16).slice(1);
          }
          return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
        }
      });
    }
  } catch (polyfillError) {
    // 定义失败不影响页面其余部分。
  }

  try {
    if (navigator && typeof navigator.clipboard === 'undefined') {
      var copyFallback = function (text) {
        return new Promise(function (resolve, reject) {
          try {
            var area = document.createElement('textarea');
            area.value = String(text);
            area.setAttribute('readonly', '');
            area.style.position = 'fixed';
            area.style.top = '-1000px';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            var copied = document.execCommand('copy');
            document.body.removeChild(area);
            if (copied) resolve();
            else reject(new Error('clipboard copy was rejected'));
          } catch (copyError) {
            reject(copyError);
          }
        });
      };
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: copyFallback,
          readText: function readText() {
            return Promise.reject(new Error('clipboard read is unavailable over plain HTTP'));
          }
        }
      });
    }
  } catch (polyfillError) {
    // 同上：polyfill 只是尽力而为。
  }
})();
`.trim();

/**
 * 把 polyfill 脚本注入 index.html（在 `<head>` 打开标签之后，确保先于应用脚本执行）。
 * @param {string} html - 原始 index.html。
 * @returns {string} 注入后的 HTML；已注入或非字符串时原样返回。
 */
export function injectInsecureContextPolyfills(html) {
  if (typeof html !== 'string' || html === '') return html;
  if (html.includes(POLYFILL_MARKER)) return html;
  const tag = `<script data-dsh-lan-access="polyfill">\n${INLINE_SCRIPT}\n</script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (head !== null) {
    const insertAt = head.index + head[0].length;
    return html.slice(0, insertAt) + tag + html.slice(insertAt);
  }
  return tag + html;
}
