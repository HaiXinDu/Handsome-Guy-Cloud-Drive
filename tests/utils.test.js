/**
 * 工具函数单元测试
 * 使用 Node.js 内置 test runner（node --test）
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  sanitizeFilename,
  generateUniqueFolderName,
  resolveSafePath,
  resolvePath,
  formatBytes,
  getMimeType
} = require('../lib/utils');

// ── sanitizeFilename ────────────────────────────────
describe('sanitizeFilename', () => {
  it('普通文件名应保持不变', () => {
    assert.strictEqual(sanitizeFilename('hello.txt'), 'hello.txt');
  });

  it('应移除危险字符', () => {
    assert.strictEqual(sanitizeFilename('test<>.txt'), 'test__.txt');
  });

  it('应替换空格为下划线', () => {
    assert.strictEqual(sanitizeFilename('my file.txt'), 'my_file.txt');
  });

  it('应移除控制字符', () => {
    assert.strictEqual(sanitizeFilename('test\x00.txt'), 'test_.txt');
  });

  it('应限制文件名长度为 50 字符', () => {
    const longName = 'a'.repeat(100) + '.txt';
    const result = sanitizeFilename(longName);
    const baseName = path.basename(result, '.txt');
    assert.ok(baseName.length <= 50);
  });

  it('应保留文件扩展名', () => {
    const result = sanitizeFilename('test.pdf');
    assert.ok(result.endsWith('.pdf'));
  });

  it('应处理开头带点的隐藏文件', () => {
    const result = sanitizeFilename('.hidden.txt');
    assert.ok(!result.startsWith('.'));
  });

  it('dot 文件应去除开头点号', () => {
    // path.extname('.txt') 返回 ''（视为无扩展名的隐藏文件）
    // 开头 . 被 ^\.+ 替换为 _，结果为 _txt
    const result = sanitizeFilename('.txt');
    assert.strictEqual(result, '_txt');
  });

  it('应阻止路径遍历', () => {
    const result = sanitizeFilename('../../../etc/passwd');
    assert.ok(!result.includes('/'));
    assert.ok(!result.includes('\\'));
  });

  it('关闭清理后应返回原文件名', () => {
    assert.strictEqual(sanitizeFilename('test<>.txt', false), 'test<>.txt');
  });
});

// ── generateUniqueFolderName ────────────────────────
describe('generateUniqueFolderName', () => {
  it('自定义名称应被清理后使用', () => {
    const name = generateUniqueFolderName('My Folder');
    assert.ok(name.startsWith('My_Folder'));
  });

  it('空自定义名称应生成时间戳名称', () => {
    const name = generateUniqueFolderName();
    assert.ok(name.startsWith('upload-'));
  });

  it('null 自定义名称应生成时间戳名称', () => {
    const name = generateUniqueFolderName(null);
    assert.ok(name.startsWith('upload-'));
  });

  it('每次生成名称应不同', () => {
    const name1 = generateUniqueFolderName();
    const name2 = generateUniqueFolderName();
    assert.notStrictEqual(name1, name2);
  });
});

// ── resolveSafePath ─────────────────────────────────
describe('resolveSafePath', () => {
  let tmpDir;

  // 在每个测试前创建临时目录和测试文件
  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jyw-test-'));
    const testFile = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(testFile, 'hello');
    return { tmpDir, testFile };
  }

  function teardown() {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it('应解析有效文件路径', () => {
    const { tmpDir } = setup();
    const result = resolveSafePath(tmpDir, 'test.txt');
    assert.ok(result.fullPath);
    assert.ok(result.stats);
    assert.ok(result.stats.isFile());
    teardown();
  });

  it('应拒绝目录遍历攻击 (../)', () => {
    const { tmpDir } = setup();
    const result = resolveSafePath(tmpDir, '../etc/passwd');
    assert.strictEqual(result.error, '非法路径');
    assert.strictEqual(result.status, 403);
    teardown();
  });

  it('应拒绝目录遍历攻击 (../../)', () => {
    const { tmpDir } = setup();
    const result = resolveSafePath(tmpDir, '../../Windows/System32/config/SAM');
    assert.strictEqual(result.error, '非法路径');
    assert.strictEqual(result.status, 403);
    teardown();
  });

  it('应拒绝绝对路径', () => {
    const { tmpDir } = setup();
    const result = resolveSafePath(tmpDir, '/etc/passwd');
    assert.strictEqual(result.error, '非法路径');
    assert.strictEqual(result.status, 403);
    teardown();
  });

  it('不存在的文件应返回 404', () => {
    const { tmpDir } = setup();
    const result = resolveSafePath(tmpDir, 'nonexistent.txt');
    assert.strictEqual(result.status, 404);
    teardown();
  });

  it('应拒绝 NTFS 保留名 CON', () => {
    const { tmpDir } = setup();
    const result = resolveSafePath(tmpDir, 'CON');
    assert.strictEqual(result.error, '非法路径');
    teardown();
  });

  it('应拒绝 NTFS 保留名 NUL', () => {
    const { tmpDir } = setup();
    const result = resolveSafePath(tmpDir, 'NUL');
    assert.strictEqual(result.error, '非法路径');
    teardown();
  });

  it('应拒绝 NTFS 保留名 COM1', () => {
    const { tmpDir } = setup();
    const result = resolveSafePath(tmpDir, 'COM1');
    assert.strictEqual(result.error, '非法路径');
    teardown();
  });

  it('应拒绝 NTFS 保留名 LPT1', () => {
    const { tmpDir } = setup();
    const result = resolveSafePath(tmpDir, 'LPT1');
    assert.strictEqual(result.error, '非法路径');
    teardown();
  });

  it('应拒绝 NTFS 保留名 PRN', () => {
    const { tmpDir } = setup();
    const result = resolveSafePath(tmpDir, 'PRN');
    assert.strictEqual(result.error, '非法路径');
    teardown();
  });
});

// ── resolvePath ─────────────────────────────────────
describe('resolvePath', () => {
  let tmpDir;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jyw-test-'));
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello');
    fs.mkdirSync(path.join(tmpDir, 'subdir'));
    return { tmpDir };
  }

  function teardown() {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it('空路径应返回根目录', () => {
    const { tmpDir } = setup();
    const result = resolvePath(tmpDir, '');
    assert.strictEqual(result.fullPath, tmpDir);
    teardown();
  });

  it('"/" 路径应返回根目录', () => {
    const { tmpDir } = setup();
    const result = resolvePath(tmpDir, '/');
    assert.strictEqual(result.fullPath, tmpDir);
    teardown();
  });

  it('应允许目录路径', () => {
    const { tmpDir } = setup();
    const result = resolvePath(tmpDir, 'subdir');
    assert.ok(result.stats.isDirectory());
    teardown();
  });

  it('应拒绝路径遍历', () => {
    const { tmpDir } = setup();
    const result = resolvePath(tmpDir, '../etc');
    assert.strictEqual(result.error, '非法路径');
    teardown();
  });

  it('应拒绝带 NTFS 保留名的路径', () => {
    const { tmpDir } = setup();
    const result = resolvePath(tmpDir, 'subdir/CON');
    assert.strictEqual(result.error, '非法路径');
    teardown();
  });
});

// ── formatBytes ─────────────────────────────────────
describe('formatBytes', () => {
  it('0 字节', () => {
    assert.strictEqual(formatBytes(0), '0 B');
  });

  it('字节范围', () => {
    assert.ok(formatBytes(500).includes('B'));
  });

  it('KB 范围', () => {
    assert.ok(formatBytes(2048).includes('KB'));
  });

  it('MB 范围', () => {
    assert.ok(formatBytes(5 * 1024 * 1024).includes('MB'));
  });

  it('GB 范围', () => {
    assert.ok(formatBytes(2 * 1024 * 1024 * 1024).includes('GB'));
  });
});

// ── getMimeType ─────────────────────────────────────
describe('getMimeType', () => {
  it('应返回正确的图片 MIME', () => {
    assert.strictEqual(getMimeType('test.jpg'), 'image/jpeg');
    assert.strictEqual(getMimeType('test.png'), 'image/png');
    assert.strictEqual(getMimeType('test.gif'), 'image/gif');
  });

  it('应返回正确的文档 MIME', () => {
    assert.strictEqual(getMimeType('test.pdf'), 'application/pdf');
    assert.strictEqual(getMimeType('test.txt'), 'text/plain');
  });

  it('应返回正确的压缩包 MIME', () => {
    assert.strictEqual(getMimeType('test.zip'), 'application/zip');
  });

  it('未知扩展名应返回 octet-stream', () => {
    assert.strictEqual(getMimeType('test.xyz'), 'application/octet-stream');
  });

  it('无扩展名应返回 octet-stream', () => {
    assert.strictEqual(getMimeType('test'), 'application/octet-stream');
  });

  it('应忽略大小写', () => {
    assert.strictEqual(getMimeType('TEST.JPG'), 'image/jpeg');
    assert.strictEqual(getMimeType('Test.PnG'), 'image/png');
  });
});
