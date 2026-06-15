/**
 * 工具函数模块 — 提取自 server.js，方便单独测试
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ── 文件名清理 ──────────────────────────────────────
function sanitizeFilename(filename, enableSanitization = true) {
  if (!enableSanitization) return filename;

  const ext = path.extname(filename);
  const name = path.basename(filename, ext);

  const cleanName = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '_')
    .substring(0, 50);

  if (!cleanName) {
    return 'unnamed' + ext;
  }

  return cleanName + ext;
}

// ── 生成唯一文件夹名 ────────────────────────────────
function generateUniqueFolderName(customName = null) {
  if (customName && customName.trim()) {
    return sanitizeFilename(customName.trim());
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const hash = crypto.randomBytes(4).toString('hex');
  return `upload-${timestamp}-${hash}`;
}

// ── 路径安全校验（仅文件，拒绝目录）────────────────
function resolveSafePath(uploadDir, relativePath) {
  const fullPath = path.resolve(uploadDir, relativePath);
  const root = path.resolve(uploadDir);

  // Windows 不区分大小写，需归一化比较
  const normFullPath = path.normalize(fullPath).toLowerCase();
  const normRoot = path.normalize(root).toLowerCase();
  if (!normFullPath.startsWith(normRoot + path.sep) && normFullPath !== normRoot) {
    return { error: '非法路径', status: 403 };
  }

  // 检查 NTFS 保留名
  const segments = relativePath.replace(/\\/g, '/').split('/');
  const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  for (const seg of segments) {
    if (reservedNames.test(seg) || reservedNames.test(seg.replace(/\..*$/, ''))) {
      return { error: '非法路径', status: 403 };
    }
  }

  if (!fs.existsSync(fullPath)) {
    return { error: '文件不存在', status: 404 };
  }
  const stats = fs.statSync(fullPath);
  if (stats.isDirectory()) {
    return { error: '不能操作目录', status: 400 };
  }
  return { fullPath, stats };
}

// ── 路径安全校验（允许目录）────────────────────────
function resolvePath(uploadDir, relativePath) {
  const fs = require('fs');

  if (!relativePath || relativePath === '/') {
    return { fullPath: uploadDir, stats: fs.statSync(uploadDir) };
  }
  const fullPath = path.resolve(uploadDir, relativePath);
  const root = path.resolve(uploadDir);

  const normFullPath = path.normalize(fullPath).toLowerCase();
  const normRoot = path.normalize(root).toLowerCase();
  if (!normFullPath.startsWith(normRoot + path.sep) && normFullPath !== normRoot) {
    return { error: '非法路径', status: 403 };
  }

  // 检查 NTFS 保留名（Windows 特有问题）
  const segments = relativePath.replace(/\\/g, '/').split('/');
  const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  for (const seg of segments) {
    if (reservedNames.test(seg) || reservedNames.test(seg.replace(/\..*$/, ''))) {
      return { error: '非法路径', status: 403 };
    }
  }

  if (!fs.existsSync(fullPath)) {
    return { error: '路径不存在', status: 404 };
  }
  return { fullPath, stats: fs.statSync(fullPath) };
}

// ── 格式化字节数 ────────────────────────────────────
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

// ── MIME 类型检测 ──────────────────────────────────
function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = {
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
    '.zip': 'application/zip',
    '.rar': 'application/x-rar-compressed'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

module.exports = {
  sanitizeFilename,
  generateUniqueFolderName,
  resolveSafePath,
  resolvePath,
  formatBytes,
  getMimeType
};
