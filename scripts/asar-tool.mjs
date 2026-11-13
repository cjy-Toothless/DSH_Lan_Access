/**
 * 只读 asar 浏览/提取工具（verifier 自用，不修改 DSH 安装）。
 *
 * 用法：
 *   node asar-tool.mjs list <asar> <prefix>            # 列出前缀下的条目（最多 200 条）
 *   node asar-tool.mjs cat  <asar> <entryPath>         # 输出文件内容到 stdout
 *   node asar-tool.mjs extract <asar> <entryPath> <outFile>
 *   node asar-tool.mjs find <asar> <substring>   # 按路径子串查找（最多 100 条）
 *   node asar-tool.mjs grep <asar> <prefix> <text> [maxBytes]
 */
import fs from 'node:fs';
import path from 'node:path';

const [, , command, asarPath, arg1, arg2] = process.argv;

function loadHeader(archive) {
  const fd = fs.openSync(archive, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const pickleSize = head.readUInt32LE(4);
    const jsonLength = head.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(jsonLength);
    fs.readSync(fd, jsonBuf, 0, jsonLength, 16);
    const header = JSON.parse(jsonBuf.toString('utf8'));
    const baseOffset = 8 + pickleSize;
    return { fd, header, baseOffset };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function getNode(header, entryPath) {
  const parts = entryPath.replaceAll('\\', '/').split('/').filter(Boolean);
  let node = header;
  for (const part of parts) {
    if (node.files === undefined) return null;
    node = node.files[part];
    if (node === undefined) return null;
  }
  return node;
}

function readEntry(fd, baseOffset, node) {
  const size = Number(node.size);
  const offset = Number(node.offset);
  const buffer = Buffer.alloc(size);
  fs.readSync(fd, buffer, 0, size, baseOffset + offset);
  return buffer;
}

if (command === 'list') {
  const { fd, header } = loadHeader(asarPath);
  try {
    const node = getNode(header, arg1 ?? '');
    if (node === null) {
      console.error(`not found: ${arg1}`);
      process.exit(1);
    }
    if (node.files === undefined) {
      console.log(`${arg1} (file, size=${node.size})`);
    } else {
      const names = Object.keys(node.files);
      for (const name of names.slice(0, 500)) {
        const child = node.files[name];
        const kind = child.files === undefined ? 'file' : 'dir';
        console.log(`${kind}\t${name}${kind === 'file' ? `\t${child.size}` : ''}`);
      }
      if (names.length > 500) console.log(`... ${names.length - 500} more`);
    }
  } finally {
    fs.closeSync(fd);
  }
} else if (command === 'cat') {
  const { fd, header, baseOffset } = loadHeader(asarPath);
  try {
    const node = getNode(header, arg1);
    if (node === null || node.files !== undefined) {
      console.error(`not a file: ${arg1}`);
      process.exit(1);
    }
    process.stdout.write(readEntry(fd, baseOffset, node));
  } finally {
    fs.closeSync(fd);
  }
} else if (command === 'extract') {
  const { fd, header, baseOffset } = loadHeader(asarPath);
  try {
    const node = getNode(header, arg1);
    if (node === null || node.files !== undefined) {
      console.error(`not a file: ${arg1}`);
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(arg2), { recursive: true });
    fs.writeFileSync(arg2, readEntry(fd, baseOffset, node));
    console.log(`extracted ${arg1} -> ${arg2} (${node.size} bytes)`);
  } finally {
    fs.closeSync(fd);
  }
} else if (command === 'find') {
  const { fd, header } = loadHeader(asarPath);
  try {
    const needle = (arg1 ?? '').toLowerCase();
    const hits = [];
    const walk = (node, prefix) => {
      if (node.files === undefined) {
        if (prefix.toLowerCase().includes(needle)) hits.push(prefix);
        return;
      }
      for (const [name, child] of Object.entries(node.files)) walk(child, `${prefix}/${name}`);
    };
    walk(header, '');
    for (const hit of hits.slice(0, 100)) console.log(hit);
    console.log(`# total ${hits.length}`);
  } finally {
    fs.closeSync(fd);
  }
} else if (command === 'grep') {
  const { fd, header, baseOffset } = loadHeader(asarPath);
  try {
    const needle = arg2 ?? '';
    const maxBytes = Number(arg2 === undefined ? 8 * 1024 * 1024 : 8 * 1024 * 1024);
    const hits = [];
    const walk = (node, prefix) => {
      if (node.files === undefined) {
        if (needle === '' || prefix === '') return;
        if (node.unpacked === true) return;
        if (Number(node.size) > maxBytes) return;
        const content = readEntry(fd, baseOffset, node).toString('utf8');
        let count = 0;
        let index = content.indexOf(needle);
        while (index !== -1) {
          count += 1;
          index = content.indexOf(needle, index + needle.length);
        }
        if (count > 0) hits.push({ path: prefix, count });
        return;
      }
      for (const [name, child] of Object.entries(node.files)) walk(child, `${prefix}/${name}`);
    };
    const start = arg1 !== undefined && arg1 !== '' ? getNode(header, arg1) : header;
    if (start === null) {
      console.error(`not found: ${arg1}`);
      process.exit(1);
    }
    walk(start, arg1 ?? '');
    for (const hit of hits.slice(0, 100)) console.log(`${hit.count}\t${hit.path}`);
    console.log(`# files with match: ${hits.length}`);
  } finally {
    fs.closeSync(fd);
  }
} else {
  console.error('usage: node asar-tool.mjs list|cat|extract|find|grep <asar> <path> [out]');
  process.exit(2);
}
