/**
 * dsh-lan-access 设置页（浏览器 module-loader bundle，手写、无构建步骤）。
 *
 * 契约见 docs/contract.md：
 * - 包名 / module id：@local/dsh-lan-access
 * - RPC channel：/dsh-lan-access，端点：status / update / restart
 * - 设置 slot：settings.section，注册 id：lan-access
 * - locale 命名空间：lan-access（zh / en 两套完整字典）
 *
 * 只允许在浏览器端使用 React（模块表 require('react')）与原生 DOM API，
 * 不引入任何第三方运行时依赖；所有用户可见文案都经过 t()。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-lan-access',
  factory: (require) => {
    'use strict';

    const module = { exports: {} };
    const React = require('react');
    const h = React.createElement;

    // ---------------------------------------------------------------------
    // 常量
    // ---------------------------------------------------------------------

    /** locale 命名空间，与 contract.md 第 1 节一致。 */
    const NS = 'lan-access';
    /** Host 注册的 Connection RPC channel。 */
    const RPC_CHANNEL = '/dsh-lan-access';
    const ENDPOINT_STATUS = 'status';
    const ENDPOINT_UPDATE = 'update';
    const ENDPOINT_RESTART = 'restart';
    /** 契约要求：首次挂载立即拉取，之后每 5 秒轮询一次。 */
    const POLL_INTERVAL_MS = 5000;
    /** 「已复制」提示的展示时长。 */
    const COPY_FEEDBACK_MS = 2000;
    /** 端口合法范围（contract.md §2.4）。 */
    const MIN_PORT = 1024;
    const MAX_PORT = 65535;

    // ---------------------------------------------------------------------
    // 字典（zh / en 必须键集完全一致）
    // ---------------------------------------------------------------------

    const zh = {
      nav: '局域网访问',
      title: '局域网访问',
      subtitle: '在手机或平板的浏览器里直接打开同一局域网内的 DSH 界面。',

      'status.title': '运行状态',
      'status.loading': '正在读取运行状态…',
      'status.failed': '暂时无法读取运行状态',
      'status.retry': '重试',
      'status.running': '运行中',
      'status.stopped': '已停用',
      'status.startFailed': '启动失败',
      'status.upstream': '上游地址',
      'status.listen': '当前监听',
      'status.notListening': '未监听',
      'status.lastError': '最近一次错误',
      'status.refreshFailed': '后台刷新失败',
      'status.noRpc': '设置通道不可用，请刷新页面后重试。',
      'status.autoRefresh': '状态每 5 秒自动刷新。',

      'access.title': '扫码访问',
      'access.hint': '用手机相机扫描二维码，或在手机浏览器中打开下面的地址。',
      'access.guide': '还没有可用的局域网地址。请先连接 Wi-Fi 或有线网络，然后刷新状态。',
      'access.copy': '复制地址',
      'access.copied': '已复制',
      'access.copyFailed': '复制失败，请手动选择地址复制。',

      'form.title': '设置',
      'form.enabled': '启用局域网访问',
      'form.enabledHint': '关闭后立即停止监听，已连接的设备会断开。',
      'form.port': '监听端口',
      'form.portHint': '1024–65535',
      'form.host': '局域网地址',
      'form.hostAuto': '自动（推荐）',
      'form.hostHint': '选择手机能访问到的本机网卡地址；不确定时保持自动。',
      'form.invalidPort': '端口必须是 1024–65535 之间的整数。',
      'form.save': '保存',
      'form.saving': '保存中…',
      'form.saved': '已保存，监听器已重启。',
      'form.savedStartFailed': '已保存，但监听器未能启动',
      'form.failed': '保存失败',

      'restart.button': '重启监听',
      'restart.running': '重启中…',
      'restart.done': '已重启监听。',
      'restart.failed': '重启失败',

      'warning.title': '安全提示',
      'warning.body':
        '当前为免认证模式：同一局域网内的任何设备都能打开此界面。请只在可信网络中使用，避免在公共 Wi-Fi 下开启。',

      'error.unknown': '未知错误',
    };

    const en = {
      nav: 'LAN access',
      title: 'LAN access',
      subtitle: 'Open this DSH interface from a phone or tablet on the same network.',

      'status.title': 'Status',
      'status.loading': 'Loading status…',
      'status.failed': 'Could not load the status',
      'status.retry': 'Retry',
      'status.running': 'Running',
      'status.stopped': 'Disabled',
      'status.startFailed': 'Failed to start',
      'status.upstream': 'Upstream',
      'status.listen': 'Listening on',
      'status.notListening': 'not listening',
      'status.lastError': 'Last error',
      'status.refreshFailed': 'Background refresh failed',
      'status.noRpc': 'The settings channel is unavailable. Reload the page and try again.',
      'status.autoRefresh': 'Refreshes every 5 seconds.',

      'access.title': 'Scan to open',
      'access.hint': 'Scan the QR code with a phone camera, or open one of the URLs below in a mobile browser.',
      'access.guide': 'No LAN address is available yet. Connect to Wi-Fi or Ethernet first, then refresh the status.',
      'access.copy': 'Copy URL',
      'access.copied': 'Copied',
      'access.copyFailed': 'Copy failed — select the URL and copy it manually.',

      'form.title': 'Settings',
      'form.enabled': 'Enable LAN access',
      'form.enabledHint': 'Turning it off stops the listener immediately and disconnects connected devices.',
      'form.port': 'Listen port',
      'form.portHint': '1024–65535',
      'form.host': 'LAN address',
      'form.hostAuto': 'Auto (recommended)',
      'form.hostHint': 'Pick the network interface address your phone can reach; leave it on Auto when unsure.',
      'form.invalidPort': 'Port must be an integer between 1024 and 65535.',
      'form.save': 'Save',
      'form.saving': 'Saving…',
      'form.saved': 'Saved — the listener restarted.',
      'form.savedStartFailed': 'Saved, but the listener failed to start',
      'form.failed': 'Save failed',

      'restart.button': 'Restart listener',
      'restart.running': 'Restarting…',
      'restart.done': 'Listener restarted.',
      'restart.failed': 'Restart failed',

      'warning.title': 'Security notice',
      'warning.body':
        'Authentication is off: any device on this LAN can open this interface. Use it only on trusted networks and avoid public Wi-Fi.',

      'error.unknown': 'Unknown error',
    };

    // ---------------------------------------------------------------------
    // 纯函数 / DOM 辅助
    // ---------------------------------------------------------------------

    function isNonEmptyString(value) {
      return typeof value === 'string' && value.trim() !== '';
    }

    /**
     * 解包 Host 统一错误信封（contract.md §2.2）：{ ok: true, value } / { ok: false, error }。
     * 失败时抛出一个 message 为 Host 可读原因的 Error（可能为空串，由调用方兜底）。
     */
    function readEnvelope(result) {
      if (result === null || typeof result !== 'object') {
        throw new Error('');
      }
      if (result.ok === true) {
        return result.value;
      }
      const error = result.error;
      if (error !== null && typeof error === 'object' && isNonEmptyString(error.message)) {
        throw new Error(error.message);
      }
      throw new Error('');
    }

    /** 从异常中提取可展示的细节；未知/空值返回 null，由调用方补本地化兜底文案。 */
    function errorDetail(err) {
      if (err === null || err === undefined) return null;
      if (typeof err === 'string') return err === '' ? null : err;
      if (typeof err.message === 'string' && err.message !== '') return err.message;
      return null;
    }

    /** status 返回的 value 是否长得像契约里的状态对象（用于容错 update/restart 的回包形状）。 */
    function isStatusValue(value) {
      return (
        value !== null &&
        typeof value === 'object' &&
        ('enabled' in value || 'running' in value || 'listenPort' in value)
      );
    }

    /** 把 number | numeric string 的端口转成输入框字符串，异常值回落为空串。 */
    function portText(value) {
      if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
      if (typeof value === 'string' && /^[0-9]+$/.test(value)) return value;
      return '';
    }

    /** 监听地址展示：host:port，缺一返回 '—'。 */
    function formatEndpoint(host, port) {
      const hasHost = isNonEmptyString(host);
      const hasPort = typeof port === 'number' && Number.isFinite(port);
      if (hasHost && hasPort) return host + ':' + String(port);
      if (hasPort) return ':' + String(port);
      if (hasHost) return host;
      return '—';
    }

    /**
     * 复制文本。局域网 HTTP 属于非安全上下文，navigator.clipboard 可能不存在，
     * 因此优先 Clipboard API，失败后退回隐藏 textarea + execCommand('copy')。
     */
    async function copyText(text) {
      if (
        window.isSecureContext === true &&
        navigator.clipboard !== undefined &&
        typeof navigator.clipboard.writeText === 'function'
      ) {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch (err) {
          console.warn('[lan-access] Clipboard API failed, falling back to execCommand:', err);
        }
      }
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(area);
        return copied === true;
      } catch (err) {
        console.warn('[lan-access] copy fallback failed:', err);
        return false;
      }
    }

    // ---------------------------------------------------------------------
    // 内联图标（原创，随组件渲染；不依赖外部资源）
    // ---------------------------------------------------------------------

    function WarningIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M12 3.5 21 19.5H3L12 3.5Z' }),
        h('path', { d: 'M12 10v4' }),
        h('circle', { cx: 12, cy: 17, r: 0.6, fill: 'currentColor', stroke: 'none' }),
      );
    }

    /** 空状态占位图：手机 + Wi-Fi 波（与 assets/icon.svg 同一意象）。 */
    function PhoneWavesIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 2.5, y: 4, width: 8, height: 16, rx: 1.8 }),
        h('path', { d: 'M5.2 6.6h2.6' }),
        h('circle', { cx: 6.5, cy: 17.4, r: 0.7, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 17.5, cy: 17.5, r: 0.9, fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M14.95 14.95a3.6 3.6 0 0 1 5.1 0' }),
        h('path', { d: 'M13.12 13.12a6.2 6.2 0 0 1 8.76 0' }),
        h('path', { d: 'M11.28 11.28a8.8 8.8 0 0 1 12.44 0' }),
      );
    }

    // ---------------------------------------------------------------------
    // 样式：组件内 <style> 字符串，卸载随组件移除；颜色全部走主题 token
    // ---------------------------------------------------------------------

    const CSS_TEXT = `
.lan-access-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: var(--dsw-font-xs-13-font-size);
  line-height: var(--dsw-font-xs-13-line-height);
}
.lan-access-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.lan-access-title {
  margin: 0;
  font-size: var(--dsw-font-m-18-font-size);
  line-height: var(--dsw-font-m-18-line-height);
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.lan-access-subtitle {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
}
.lan-access-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-settings-card-fill);
}
.lan-access-cardHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  min-width: 0;
}
.lan-access-cardHeaderRight {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.lan-access-cardTitle {
  font-size: var(--dsw-font-s-14-font-size);
  line-height: var(--dsw-font-s-14-line-height);
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.lan-access-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}
.lan-access-rowLabel {
  flex: none;
  color: var(--dsw-alias-label-secondary);
}
.lan-access-rowValue {
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  text-align: right;
  word-break: break-all;
  font-variant-numeric: tabular-nums;
}
.lan-access-muted {
  color: var(--dsw-alias-label-tertiary);
}
.lan-access-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary);
  font-size: var(--dsw-font-xxs-12-font-size);
  line-height: var(--dsw-font-xxs-12-line-height);
  white-space: nowrap;
}
.lan-access-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary);
}
.lan-access-dot--on {
  background: var(--dsw-alias-state-success-primary);
}
.lan-access-dot--error {
  background: var(--dsw-alias-state-error-primary);
}
.lan-access-hint {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: var(--dsw-font-xxs-12-font-size);
  line-height: var(--dsw-font-xxs-12-line-height);
}
.lan-access-errorText {
  margin: 0;
  color: var(--dsw-alias-state-error-primary);
  word-break: break-word;
}
.lan-access-errorLabel {
  font-weight: 600;
}
.lan-access-warnText {
  margin: 0;
  color: var(--dsw-alias-state-warn-label);
  word-break: break-word;
}
.lan-access-accessBody {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
  align-items: flex-start;
  min-width: 0;
}
.lan-access-qrColumn {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}
.lan-access-qr {
  box-sizing: border-box;
  width: 180px;
  height: 180px;
  padding: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
}
.lan-access-qr svg {
  display: block;
  width: 100%;
  height: 100%;
}
.lan-access-qrPlaceholder {
  box-sizing: border-box;
  width: 180px;
  height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  color: var(--dsw-alias-label-tertiary);
}
.lan-access-qrPlaceholder svg {
  width: 64px;
  height: 64px;
}
.lan-access-accessGuide {
  flex: 1 1 200px;
  align-self: center;
}
.lan-access-urlColumn {
  flex: 1 1 240px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.lan-access-urlRow {
  display: flex;
  align-items: stretch;
  gap: 8px;
  min-width: 0;
}
.lan-access-url {
  flex: 1 1 auto;
  min-width: 0;
  display: block;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-specific-selector);
  color: var(--dsw-alias-label-primary);
  font-size: var(--dsw-font-xxs-12-font-size);
  line-height: var(--dsw-font-xxs-12-line-height);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-decoration: none;
}
.lan-access-url:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.lan-access-url:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.lan-access-form {
  gap: 16px;
}
.lan-access-switchRow {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  min-width: 0;
}
.lan-access-switchText {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.lan-access-fieldGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 14px;
}
.lan-access-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.lan-access-fieldLabel {
  color: var(--dsw-alias-label-secondary);
  font-size: var(--dsw-font-xs-13-font-size);
  line-height: var(--dsw-font-xs-13-line-height);
}
.lan-access-fieldHint {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: var(--dsw-font-xxs-12-font-size);
  line-height: var(--dsw-font-xxs-12-line-height);
}
.lan-access-input,
.lan-access-select {
  box-sizing: border-box;
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-specific-input-major);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: var(--dsw-font-xs-13-font-size);
  line-height: var(--dsw-font-xs-13-line-height);
}
.lan-access-input:focus-visible,
.lan-access-select:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.lan-access-switch {
  position: relative;
  flex: none;
  display: inline-flex;
  width: 36px;
  height: 20px;
  margin-top: 2px;
  cursor: pointer;
}
.lan-access-switchInput {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.lan-access-switchTrack {
  box-sizing: border-box;
  width: 36px;
  height: 20px;
  border-radius: 999px;
  background: var(--dsw-alias-border-l3);
  transition: background-color 0.15s ease;
  pointer-events: none;
}
.lan-access-switchThumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-switch-thumb);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.28);
  transition: transform 0.15s ease;
  pointer-events: none;
}
.lan-access-switchInput:checked + .lan-access-switchTrack {
  background: var(--dsw-alias-button-primary-fill);
}
.lan-access-switchInput:checked ~ .lan-access-switchThumb {
  transform: translateX(16px);
}
.lan-access-switchInput:focus-visible ~ .lan-access-switchTrack {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.lan-access-switchInput:disabled ~ .lan-access-switchTrack {
  opacity: 0.5;
}
.lan-access-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 6px 14px;
  border: 1px solid var(--dsw-alias-button-primary-fill);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
  font: inherit;
  font-weight: 500;
  line-height: 20px;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
}
.lan-access-button:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover);
  border-color: var(--dsw-alias-button-primary-hover);
}
.lan-access-button:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.lan-access-button:disabled {
  opacity: 0.5;
  cursor: default;
}
.lan-access-buttonSecondary {
  background: var(--dsw-alias-button-elevated-fill);
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
}
.lan-access-buttonSecondary:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  border-color: var(--dsw-alias-border-l3);
}
.lan-access-buttonSmall {
  padding: 4px 10px;
  font-size: var(--dsw-font-xxs-12-font-size);
  line-height: var(--dsw-font-xxs-12-line-height);
}
.lan-access-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
.lan-access-feedback {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  font-size: var(--dsw-font-xxs-12-font-size);
  line-height: var(--dsw-font-xxs-12-line-height);
}
.lan-access-feedback--success {
  color: var(--dsw-alias-state-success-primary);
}
.lan-access-feedback--warn {
  color: var(--dsw-alias-state-warn-label);
}
.lan-access-feedback--error {
  color: var(--dsw-alias-state-error-primary);
}
.lan-access-feedbackDetail {
  color: var(--dsw-alias-label-secondary);
  word-break: break-word;
}
.lan-access-warning {
  display: flex;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-state-warn-secondary);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-state-warn-tertiary);
}
.lan-access-warningIcon {
  flex: none;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  color: var(--dsw-alias-state-warn-label);
}
.lan-access-warningIcon svg {
  display: block;
  width: 100%;
  height: 100%;
}
.lan-access-warningText {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.lan-access-warningTitle {
  margin: 0;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.lan-access-warningBody {
  margin: 0;
  color: var(--dsw-alias-label-primary);
}
`;

    // ---------------------------------------------------------------------
    // 设置页组件
    // ---------------------------------------------------------------------

    function SettingsSection(props) {
      const injected = props !== null && props !== undefined ? props : {};
      const rpc = injected.rpc !== null && injected.rpc !== undefined ? injected.rpc : null;
      const t = typeof injected.t === 'function' ? injected.t : (key) => key;

      // loading / ready / error 三态；ready 时 status 一定非空。
      const [phase, setPhase] = React.useState('loading');
      const [status, setStatus] = React.useState(null);
      const [loadError, setLoadError] = React.useState(null);
      const [refreshError, setRefreshError] = React.useState(null);

      // 表单草稿；监听地址空串 = 自动探测（contract.md §2.4）。
      const [form, setForm] = React.useState({ enabled: true, listenPort: '', listenHost: '' });
      const [saving, setSaving] = React.useState(false);
      const [restarting, setRestarting] = React.useState(false);
      const [feedback, setFeedback] = React.useState(null);
      const [copyNotice, setCopyNotice] = React.useState(null);

      const aliveRef = React.useRef(true);
      const hasDataRef = React.useRef(false);
      const seededRef = React.useRef(false);
      const copyTimerRef = React.useRef(null);

      React.useEffect(
        function () {
          aliveRef.current = true;
          return function () {
            aliveRef.current = false;
            if (copyTimerRef.current !== null) {
              window.clearTimeout(copyTimerRef.current);
              copyTimerRef.current = null;
            }
          };
        },
        [],
      );

      /** 用 Host 返回的状态重新填充表单；只在首次加载与写操作成功后调用，避免轮询覆盖用户输入。 */
      const seedForm = React.useCallback(function (value) {
        if (value === null || typeof value !== 'object') return;
        // 契约未单独暴露「配置的监听地址」，只有实际绑定值；为保持默认的自动模式，
        // 优先读取可选的 configuredListenHost，缺失时按自动（空串）回填。
        const configuredHost = isNonEmptyString(value.configuredListenHost) ? value.configuredListenHost : '';
        setForm({
          enabled: value.enabled !== false,
          listenPort: portText(value.listenPort),
          listenHost: configuredHost,
        });
      }, []);

      /** 首次/重试拉取；失败时保留已有数据，只提示后台刷新失败。 */
      const loadStatus = React.useCallback(
        async function () {
          if (rpc === null || typeof rpc.call !== 'function') {
            if (!hasDataRef.current) {
              setPhase('error');
              setLoadError(null);
            }
            return;
          }
          try {
            const result = await rpc.call(RPC_CHANNEL, ENDPOINT_STATUS, {});
            const value = readEnvelope(result);
            if (!isStatusValue(value)) throw new Error('');
            if (!aliveRef.current) return;
            hasDataRef.current = true;
            setStatus(value);
            setPhase('ready');
            setLoadError(null);
            setRefreshError(null);
            if (!seededRef.current) {
              seededRef.current = true;
              seedForm(value);
            }
          } catch (err) {
            if (!aliveRef.current) return;
            const detail = errorDetail(err);
            console.warn('[lan-access] status request failed:', err);
            if (hasDataRef.current) {
              setRefreshError(detail);
            } else {
              setLoadError(detail);
              setPhase('error');
            }
          }
        },
        [rpc, seedForm],
      );

      // 挂载即拉取，之后每 5 秒轮询；失败后下一轮自动重试。
      React.useEffect(
        function () {
          void loadStatus();
          const timer = window.setInterval(function () {
            void loadStatus();
          }, POLL_INTERVAL_MS);
          return function () {
            window.clearInterval(timer);
          };
        },
        [loadStatus],
      );

      /** update / restart 的回包直接视为最新状态；不是状态对象时退化为重新拉取。 */
      const applyStatusResult = React.useCallback(
        function (result) {
          const value = readEnvelope(result);
          if (!isStatusValue(value)) {
            void loadStatus();
            return null;
          }
          if (aliveRef.current) {
            hasDataRef.current = true;
            seededRef.current = true;
            setStatus(value);
            setPhase('ready');
            setLoadError(null);
            setRefreshError(null);
            seedForm(value);
          }
          return value;
        },
        [loadStatus, seedForm],
      );

      async function handleSave(event) {
        if (event !== null && event !== undefined && typeof event.preventDefault === 'function') {
          event.preventDefault();
        }
        if (saving || restarting) return;
        const text = String(form.listenPort === null || form.listenPort === undefined ? '' : form.listenPort).trim();
        const port = Number(text);
        if (text === '' || !/^[0-9]+$/.test(text) || !Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
          setFeedback({ kind: 'error', text: t('form.invalidPort'), detail: null });
          return;
        }
        if (rpc === null || typeof rpc.call !== 'function') {
          setFeedback({ kind: 'error', text: t('status.noRpc'), detail: null });
          return;
        }
        setSaving(true);
        setFeedback(null);
        try {
          const result = await rpc.call(RPC_CHANNEL, ENDPOINT_UPDATE, {
            enabled: form.enabled === true,
            listenHost: form.listenHost === '' ? '' : form.listenHost,
            listenPort: port,
          });
          const value = applyStatusResult(result);
          const startFailure =
            value !== null && value.running !== true && isNonEmptyString(value.error) ? value.error : '';
          if (startFailure !== '') {
            setFeedback({ kind: 'warn', text: t('form.savedStartFailed'), detail: startFailure });
          } else {
            setFeedback({ kind: 'success', text: t('form.saved'), detail: null });
          }
        } catch (err) {
          const detail = errorDetail(err);
          console.warn('[lan-access] update request failed:', err);
          if (aliveRef.current) {
            setFeedback(
              detail === null
                ? { kind: 'error', text: t('form.failed'), detail: null }
                : { kind: 'error', text: detail, detail: null },
            );
          }
        } finally {
          if (aliveRef.current) setSaving(false);
        }
      }

      async function handleRestart() {
        if (saving || restarting) return;
        if (rpc === null || typeof rpc.call !== 'function') {
          setFeedback({ kind: 'error', text: t('status.noRpc'), detail: null });
          return;
        }
        setRestarting(true);
        setFeedback(null);
        try {
          const result = await rpc.call(RPC_CHANNEL, ENDPOINT_RESTART, {});
          const value = applyStatusResult(result);
          const startFailure =
            value !== null && value.running !== true && isNonEmptyString(value.error) ? value.error : '';
          if (startFailure !== '') {
            setFeedback({ kind: 'warn', text: t('restart.failed'), detail: startFailure });
          } else {
            setFeedback({ kind: 'success', text: t('restart.done'), detail: null });
          }
        } catch (err) {
          const detail = errorDetail(err);
          console.warn('[lan-access] restart request failed:', err);
          if (aliveRef.current) {
            setFeedback(
              detail === null
                ? { kind: 'error', text: t('restart.failed'), detail: null }
                : { kind: 'error', text: detail, detail: null },
            );
          }
        } finally {
          if (aliveRef.current) setRestarting(false);
        }
      }

      async function handleCopy(url) {
        const ok = await copyText(url);
        if (!aliveRef.current) return;
        if (copyTimerRef.current !== null) {
          window.clearTimeout(copyTimerRef.current);
        }
        setCopyNotice({ url: url, ok: ok });
        copyTimerRef.current = window.setTimeout(function () {
          copyTimerRef.current = null;
          if (aliveRef.current) setCopyNotice(null);
        }, COPY_FEEDBACK_MS);
      }

      // ---------------- 派生展示数据 ----------------

      const candidates =
        status !== null && Array.isArray(status.candidates)
          ? status.candidates.filter(function (item) {
              return isNonEmptyString(item);
            })
          : [];
      const hostOptions = candidates.slice();
      if (form.listenHost !== '' && hostOptions.indexOf(form.listenHost) === -1) {
        hostOptions.unshift(form.listenHost);
      }
      const urls =
        status !== null && Array.isArray(status.urls)
          ? status.urls.filter(function (item) {
              return isNonEmptyString(item);
            })
          : [];
      const qrSvg =
        status !== null && typeof status.qrSvg === 'string' && status.qrSvg.trim() !== '' ? status.qrSvg : null;
      const upstream = status !== null && isNonEmptyString(status.upstreamOrigin) ? status.upstreamOrigin : '—';
      const endpoint = status !== null ? formatEndpoint(status.listenHost, status.listenPort) : '—';
      const running = status !== null && status.running === true;
      const enabled = status !== null && status.enabled === true;
      const statusTone = status === null ? 'idle' : !enabled ? 'idle' : running ? 'on' : 'error';
      const statusLabel =
        status === null ? '' : !enabled ? t('status.stopped') : running ? t('status.running') : t('status.startFailed');
      const warningText =
        status === null
          ? null
          : isNonEmptyString(status.warning)
            ? status.warning
            : running && status.authMode === 'open'
              ? t('warning.body')
              : null;
      const busy = saving || restarting;

      // ---------------- 区块渲染 ----------------

      function renderStatusRows() {
        const rows = [
          h(
            'div',
            { className: 'lan-access-row', key: 'upstream' },
            h('span', { className: 'lan-access-rowLabel' }, t('status.upstream')),
            h('span', { className: 'lan-access-rowValue' }, upstream),
          ),
          h(
            'div',
            { className: 'lan-access-row', key: 'listen' },
            h('span', { className: 'lan-access-rowLabel' }, t('status.listen')),
            h(
              'span',
              { className: 'lan-access-rowValue' },
              endpoint,
              running
                ? null
                : h('span', { className: 'lan-access-muted' }, ' ' + t('status.notListening')),
            ),
          ),
        ];
        if (status !== null && !running && isNonEmptyString(status.error)) {
          rows.push(
            h(
              'p',
              { className: 'lan-access-errorText', key: 'start-error' },
              h('span', { className: 'lan-access-errorLabel' }, t('status.lastError')),
              ' ',
              status.error,
            ),
          );
        }
        if (refreshError !== null) {
          rows.push(
            h(
              'p',
              { className: 'lan-access-warnText', key: 'refresh-error' },
              h('span', { className: 'lan-access-errorLabel' }, t('status.refreshFailed')),
              ' ',
              refreshError,
            ),
          );
        }
        rows.push(
          h(
            'p',
            { className: 'lan-access-hint', key: 'auto-refresh' },
            t('status.autoRefresh'),
          ),
        );
        return rows;
      }

      function renderStatusCard() {
        if (phase !== 'ready' || status === null) {
          const failed = phase === 'error';
          let detail = t('status.loading');
          if (failed) {
            detail = rpc === null ? t('status.noRpc') : loadError !== null ? loadError : t('error.unknown');
          }
          return h(
            'div',
            { className: 'lan-access-card' },
            h('div', { className: 'lan-access-cardTitle' }, failed ? t('status.failed') : t('status.title')),
            h('p', { className: 'lan-access-hint' }, detail),
            failed
              ? h(
                  'div',
                  { className: 'lan-access-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'lan-access-button lan-access-buttonSecondary',
                      disabled: rpc === null,
                      onClick: function () {
                        void loadStatus();
                      },
                    },
                    t('status.retry'),
                  ),
                )
              : null,
          );
        }
        return h(
          'div',
          { className: 'lan-access-card' },
          h(
            'div',
            { className: 'lan-access-cardHeader' },
            h('div', { className: 'lan-access-cardTitle' }, t('status.title')),
            h(
              'div',
              { className: 'lan-access-cardHeaderRight' },
              h(
                'span',
                { className: 'lan-access-badge' },
                h('span', { className: 'lan-access-dot lan-access-dot--' + statusTone, 'aria-hidden': 'true' }),
                h('span', null, statusLabel),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'lan-access-button lan-access-buttonSecondary',
                  disabled: busy,
                  onClick: function () {
                    void handleRestart();
                  },
                },
                restarting ? t('restart.running') : t('restart.button'),
              ),
            ),
          ),
          renderStatusRows(),
        );
      }

      function renderAccessCard() {
        const children = [h('div', { className: 'lan-access-cardTitle', key: 'title' }, t('access.title'))];

        if (urls.length === 0) {
          children.push(
            h(
              'div',
              { className: 'lan-access-accessBody', key: 'empty' },
              h('div', { className: 'lan-access-qrPlaceholder' }, h(PhoneWavesIcon, null)),
              h('p', { className: 'lan-access-hint lan-access-accessGuide' }, t('access.guide')),
            ),
          );
          return h('div', { className: 'lan-access-card' }, children);
        }

        const qrNode =
          qrSvg !== null
            ? h('div', {
                className: 'lan-access-qr',
                role: 'img',
                'aria-label': t('access.title'),
                dangerouslySetInnerHTML: { __html: qrSvg },
              })
            : h('div', { className: 'lan-access-qrPlaceholder' }, h(PhoneWavesIcon, null));

        const urlRows = urls.map(function (url, index) {
          const notice = copyNotice !== null && copyNotice.url === url ? copyNotice : null;
          const label = notice !== null && notice.ok ? t('access.copied') : t('access.copy');
          return h(
            'div',
            { className: 'lan-access-urlRow', key: url + '#' + index },
            h(
              'a',
              {
                className: 'lan-access-url',
                href: url,
                target: '_blank',
                rel: 'noopener noreferrer',
                title: url,
              },
              url,
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'lan-access-button lan-access-buttonSecondary lan-access-buttonSmall',
                onClick: function () {
                  void handleCopy(url);
                },
              },
              label,
            ),
          );
        });

        children.push(
          h(
            'div',
            { className: 'lan-access-accessBody', key: 'body' },
            h('div', { className: 'lan-access-qrColumn' }, qrNode),
            h(
              'div',
              { className: 'lan-access-urlColumn' },
              h('p', { className: 'lan-access-hint' }, t('access.hint')),
              urlRows,
              copyNotice !== null && !copyNotice.ok
                ? h('p', { className: 'lan-access-warnText' }, t('access.copyFailed'))
                : null,
            ),
          ),
        );
        return h('div', { className: 'lan-access-card' }, children);
      }

      function renderFormCard() {
        const enabledId = 'lan-access-enabled';
        const portId = 'lan-access-listen-port';
        const hostId = 'lan-access-listen-host';

        const feedbackNode =
          feedback === null
            ? null
            : h(
                'p',
                {
                  className: 'lan-access-feedback lan-access-feedback--' + feedback.kind,
                  role: feedback.kind === 'error' ? 'alert' : 'status',
                },
                h('span', null, feedback.text),
                feedback.detail !== null && feedback.detail !== undefined
                  ? h('span', { className: 'lan-access-feedbackDetail' }, feedback.detail)
                  : null,
              );

        return h(
          'form',
          {
            className: 'lan-access-card lan-access-form',
            onSubmit: function (event) {
              void handleSave(event);
            },
          },
          h('div', { className: 'lan-access-cardTitle' }, t('form.title')),
          h(
            'div',
            { className: 'lan-access-switchRow' },
            h(
              'div',
              { className: 'lan-access-switchText' },
              h('label', { className: 'lan-access-fieldLabel', htmlFor: enabledId }, t('form.enabled')),
              h('p', { className: 'lan-access-fieldHint' }, t('form.enabledHint')),
            ),
            h(
              'label',
              { className: 'lan-access-switch' },
              h('input', {
                id: enabledId,
                type: 'checkbox',
                role: 'switch',
                className: 'lan-access-switchInput',
                checked: form.enabled === true,
                disabled: busy,
                onChange: function (event) {
                  const checked = event.target.checked === true;
                  setForm(function (prev) {
                    return { enabled: checked, listenPort: prev.listenPort, listenHost: prev.listenHost };
                  });
                },
              }),
              h('span', { className: 'lan-access-switchTrack', 'aria-hidden': 'true' }),
              h('span', { className: 'lan-access-switchThumb', 'aria-hidden': 'true' }),
            ),
          ),
          h(
            'div',
            { className: 'lan-access-fieldGrid' },
            h(
              'div',
              { className: 'lan-access-field' },
              h('label', { className: 'lan-access-fieldLabel', htmlFor: portId }, t('form.port')),
              h('input', {
                id: portId,
                className: 'lan-access-input',
                type: 'number',
                inputMode: 'numeric',
                min: MIN_PORT,
                max: MAX_PORT,
                step: 1,
                placeholder: t('form.portHint'),
                value: form.listenPort,
                disabled: busy,
                onChange: function (event) {
                  const next = event.target.value;
                  setForm(function (prev) {
                    return { enabled: prev.enabled, listenPort: next, listenHost: prev.listenHost };
                  });
                },
              }),
              h('p', { className: 'lan-access-fieldHint' }, t('form.portHint')),
            ),
            h(
              'div',
              { className: 'lan-access-field' },
              h('label', { className: 'lan-access-fieldLabel', htmlFor: hostId }, t('form.host')),
              h(
                'select',
                {
                  id: hostId,
                  className: 'lan-access-select',
                  value: form.listenHost,
                  disabled: busy,
                  onChange: function (event) {
                    const next = event.target.value;
                    setForm(function (prev) {
                      return { enabled: prev.enabled, listenPort: prev.listenPort, listenHost: next };
                    });
                  },
                },
                h('option', { value: '' }, t('form.hostAuto')),
                hostOptions.map(function (host) {
                  return h('option', { value: host, key: host }, host);
                }),
              ),
              h('p', { className: 'lan-access-fieldHint' }, t('form.hostHint')),
            ),
          ),
          h(
            'div',
            { className: 'lan-access-actions' },
            h(
              'button',
              {
                type: 'submit',
                className: 'lan-access-button',
                disabled: busy || rpc === null,
              },
              saving ? t('form.saving') : t('form.save'),
            ),
            feedbackNode,
          ),
        );
      }

      function renderWarning() {
        if (warningText === null) return null;
        return h(
          'div',
          { className: 'lan-access-warning', role: 'note' },
          h('span', { className: 'lan-access-warningIcon' }, h(WarningIcon, null)),
          h(
            'div',
            { className: 'lan-access-warningText' },
            h('p', { className: 'lan-access-warningTitle' }, t('warning.title')),
            h('p', { className: 'lan-access-warningBody' }, warningText),
          ),
        );
      }

      const body =
        phase === 'ready' && status !== null
          ? [renderStatusCard(), renderAccessCard(), renderFormCard(), renderWarning()]
          : [renderStatusCard()];

      return h(
        'section',
        { className: 'lan-access-section', 'aria-labelledby': 'lan-access-title' },
        h('style', null, CSS_TEXT),
        h(
          'div',
          { className: 'lan-access-heading' },
          h('h2', { className: 'lan-access-title', id: 'lan-access-title' }, t('title')),
          h('p', { className: 'lan-access-subtitle' }, t('subtitle')),
        ),
        ...body,
      );
    }

    // ---------------------------------------------------------------------
    // 插件入口
    // ---------------------------------------------------------------------

    const inject = ['slots', 'locale', 'connection'];

    function apply(ctx) {
      // 字典是本插件拥有的资源：用 ctx.effect 管理，卸载时自动注销。
      ctx.effect(
        function () {
          return ctx.locale.register(NS, { zh: zh, en: en });
        },
        'lan-access: dictionaries',
      );

      const t = ctx.locale.bind(NS);
      const connection = ctx.get('connection');
      const rpc =
        connection !== null && connection !== undefined && connection.rpc !== null && connection.rpc !== undefined
          ? connection.rpc
          : null;

      // 契约要求的注册方式：settings.section / id = lan-access / order = 60。
      ctx.effect(
        function () {
          return ctx.slots.inject('settings.section', function () {
            return ctx.slots.register(
              {
                name: 'settings.section',
                id: 'lan-access',
                order: 60,
                label: function () {
                  return t('nav');
                },
                locale: NS,
                inject: function () {
                  return { rpc: rpc };
                },
              },
              SettingsSection,
            );
          });
        },
        'lan-access: settings section',
      );
    }

    module.exports.inject = inject;
    module.exports.apply = apply;
    return module.exports;
  },
});
