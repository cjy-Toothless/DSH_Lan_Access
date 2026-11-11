/**
 * 局域网 IPv4 地址探测与排序。
 *
 * 目标：在桌面版常见的多网卡环境（Wi-Fi/有线 + Hyper-V/WSL/VMware 虚拟网卡）里
 * 优先选中物理网卡的 RFC1918 地址，并把全部候选交给设置页让用户手动选择。
 */
import os from 'node:os';

/** 常见虚拟/隧道网卡名称片段：排序时降权。 */
const VIRTUAL_INTERFACE_HINTS = [
  'vethernet',
  'hyper-v',
  'vmware',
  'virtualbox',
  'loopback',
  'tailscale',
  'zerotier',
  'wsl',
  'npcap',
  'tap',
  'tun',
  'bluetooth',
];

/** 物理网卡名称片段：排序时加权。 */
const PHYSICAL_INTERFACE_HINTS = ['wlan', 'wi-fi', 'wifi', 'ethernet', '以太网', '无线'];

/**
 * 判断一个 IPv4 字面量是否属于 RFC1918 私有网段。
 * @param {string} address - 例如 `192.168.0.2`。
 * @returns {boolean} 是否私有地址。
 */
export function isPrivateIPv4(address) {
  const parts = address.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * 判断是否链路本地地址（169.254/16，Windows 上通常是未拿到 DHCP 的残留网卡）。
 * @param {string} address - IPv4 字面量。
 * @returns {boolean} 是否链路本地地址。
 */
export function isLinkLocalIPv4(address) {
  return address.startsWith('169.254.');
}

/**
 * 为一个候选地址打分，分数越高越优先。
 * @param {{ address: string, iface: string }} candidate - 候选。
 * @returns {number} 分值。
 */
function scoreCandidate(candidate) {
  let score = 0;
  if (candidate.address.startsWith('192.168.')) score += 40;
  else if (candidate.address.startsWith('10.')) score += 30;
  else if (isPrivateIPv4(candidate.address)) score += 20;

  const iface = candidate.iface.toLowerCase();
  if (PHYSICAL_INTERFACE_HINTS.some((hint) => iface.includes(hint))) score += 25;
  if (VIRTUAL_INTERFACE_HINTS.some((hint) => iface.includes(hint))) score -= 30;
  return score;
}

/**
 * 列出本机所有可用的局域网 IPv4 候选地址（已按推荐顺序排序）。
 * @returns {string[]} 地址列表（去重）。
 */
export function listLanAddresses() {
  const seen = new Set();
  const candidates = [];
  for (const [iface, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (isLinkLocalIPv4(entry.address)) continue;
      if (seen.has(entry.address)) continue;
      seen.add(entry.address);
      candidates.push({ address: entry.address, iface });
    }
  }
  candidates.sort((left, right) => scoreCandidate(right) - scoreCandidate(left));
  return candidates.map((candidate) => candidate.address);
}

/**
 * 按推荐顺序挑选第一个局域网地址。
 * @returns {string} 地址；没有任何候选时返回空字符串。
 */
export function pickLanAddress() {
  return listLanAddresses()[0] ?? '';
}

/**
 * 校验一个字符串是否是合法的 IPv4 字面量。
 * @param {unknown} value - 待校验值。
 * @returns {boolean} 是否合法。
 */
export function isIPv4Literal(value) {
  if (typeof value !== 'string') return false;
  const parts = value.trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}
