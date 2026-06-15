require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const compression = require('compression');
const archiver = require('archiver');

const {
  sanitizeFilename: _sanitizeFilename,
  generateUniqueFolderName: _generateUniqueFolderName,
  resolveSafePath: _resolveSafePath,
  resolvePath: _resolvePath,
  formatBytes,
  getMimeType
} = require('./lib/utils');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const UPLOAD_DIR = path.resolve(__dirname, process.env.UPLOAD_DIR || 'uploads');
const TEMP_DIR = path.resolve(__dirname, process.env.TEMP_DIR || '.temp_chunks');
const DEDUP_DB_PATH = path.join(UPLOAD_DIR, '.dedup_hashes.json');

// ── 分块上传配置 ──────────────────────────────────
const CHUNK_SIZE = 5 * 1024 * 1024;       // 5MB 每块
const CONCURRENT_UPLOADS = 10;             // 全局并发上传数（多用户）

// ── 配置 ──────────────────────────────────────────
const config = {
    blockedExtensions: (process.env.BLOCKED_EXTENSIONS || '.exe,.bat,.cmd,.scr,.pif,.com,.sh,.ps1').split(','),
    enableLogging: process.env.ENABLE_LOGGING !== 'false',
    enableSanitization: process.env.ENABLE_SANITIZATION !== 'false',
    cacheFolderSize: process.env.CACHE_FOLDER_SIZE !== 'false',
    cacheTTL: parseInt(process.env.CACHE_TTL, 10) || 60000
};

// ── 日志工具 ──────────────────────────────────────
const logger = {
    info: (msg, data) => config.enableLogging && console.log(`[INFO] ${new Date().toISOString()} - ${msg}`, data || ''),
    warn: (msg, data) => config.enableLogging && console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`, data || ''),
    error: (msg, err) => config.enableLogging && console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`, err || ''),
    debug: (msg, data) => config.enableLogging && console.log(`[DEBUG] ${new Date().toISOString()} - ${msg}`, data || '')
};

// ── 中间件 ────────────────────────────────────────
// 压缩中间件：跳过文件下载/预览/原始下载路由（二进制文件压缩无意义）
app.use(compression({
    filter: (req, res) => {
        if (req.path.startsWith('/api/download/') ||
            req.path.startsWith('/api/preview/') ||
            req.path.startsWith('/api/raw/')) {
            return false;
        }
        return compression.filter(req, res);
    }
}));

// CORS + 安全响应头
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'SAMEORIGIN');
    res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; base-uri 'self'; form-action 'self'");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// 速率限制（简单内存实现，每IP每分钟最多600请求）
const rateLimiter = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 600;
const RATE_LIMITER_MAX_ENTRIES = 50000; // 防止 Map 无限膨胀
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimiter.entries()) {
        if (now > entry.resetAt) rateLimiter.delete(ip);
    }
    // 如果条目仍然过多，淘汰最旧的
    if (rateLimiter.size > RATE_LIMITER_MAX_ENTRIES) {
        const entries = [...rateLimiter.entries()]
            .sort((a, b) => a[1].resetAt - b[1].resetAt);
        for (let i = 0; i < entries.length - RATE_LIMITER_MAX_ENTRIES; i++) {
            rateLimiter.delete(entries[i][0]);
        }
    }
}, 60000);

app.use((req, res, next) => {
    // 极端情况：Map 膨胀超过阈值，拒绝新连接避免内存溢出
    if (rateLimiter.size > RATE_LIMITER_MAX_ENTRIES * 1.2) {
        return res.status(503).json({ error: '服务繁忙，请稍后再试' });
    }
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = rateLimiter.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + RATE_LIMIT_WINDOW; }
    entry.count++;
    rateLimiter.set(ip, entry);
    if (entry.count > RATE_LIMIT_MAX) {
        return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    next();
});

// 请求追踪
app.use((req, res, next) => {
    req.id = crypto.randomBytes(8).toString('hex');
    const start = Date.now();
    res.on('finish', () => {
        logger.info('请求完成', { id: req.id, method: req.method, path: req.path, status: res.statusCode, duration: `${Date.now() - start}ms` });
    });
    next();
});

app.use(express.json({ limit: '50mb' }));

// 文件夹大小缓存
const folderSizeCache = new Map();

// 访问统计（限制最大条目数，防止内存溢出）
const accessStats = new Map();
const ACCESS_STATS_MAX = 20000;
let storageSizeCache = { size: 0, timestamp: 0 };

// 清理过期缓存
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of folderSizeCache.entries()) {
        if (now - value.timestamp > config.cacheTTL) {
            folderSizeCache.delete(key);
        }
    }
}, config.cacheTTL);

// 确保上传目录和临时目录存在
[UPLOAD_DIR, TEMP_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logger.info('创建目录', { path: dir });
    }
});

// ── 并发上传限流器 ───────────────────────────────
const uploadSemaphore = {
    active: 0,
    queue: [],
    acquire() {
        return new Promise(resolve => {
            if (this.active < CONCURRENT_UPLOADS) {
                this.active++;
                resolve();
            } else {
                this.queue.push(resolve);
            }
        });
    },
    release() {
        this.active--;
        if (this.queue.length > 0) {
            this.active++;
            this.queue.shift()();
        }
    }
};

// ── SHA256 去重数据库 ────────────────────────────
let dedupDB = {};
function loadDedupDB() {
    try {
        if (fs.existsSync(DEDUP_DB_PATH)) {
            dedupDB = JSON.parse(fs.readFileSync(DEDUP_DB_PATH, 'utf8'));
            logger.info('去重数据库已加载', { entries: Object.keys(dedupDB).length });
        }
    } catch (err) { dedupDB = {}; }
}
let dedupSaveTimer = null;
function saveDedupDB() {
    // debounce：500ms 内多次调用只写一次磁盘
    if (dedupSaveTimer) clearTimeout(dedupSaveTimer);
    dedupSaveTimer = setTimeout(() => {
        saveDedupDBSync();
    }, 500);
}
// 同步写入版本，用于进程退出时立即写盘
function saveDedupDBSync() {
    if (dedupSaveTimer) { clearTimeout(dedupSaveTimer); dedupSaveTimer = null; }
    try { fs.writeFileSync(DEDUP_DB_PATH, JSON.stringify(dedupDB, null, 2)); }
    catch (err) { logger.error('保存去重数据库失败', err); }
}
// 进程正常退出前确保最后一次写入
process.on('beforeExit', () => saveDedupDBSync());
loadDedupDB();

// 计算文件 SHA256（流式，适合大文件）
function calcSHA256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

// 清理过期临时 chunk 文件（启动时和每10分钟运行一次）
function cleanTempChunks() {
    try {
        if (!fs.existsSync(TEMP_DIR)) return;
        const now = Date.now();
        fs.readdirSync(TEMP_DIR).forEach(entry => {
            const entryPath = path.join(TEMP_DIR, entry);
            try {
                const stats = fs.statSync(entryPath);
                if (stats.isDirectory() && (now - stats.mtimeMs > 3600000)) {
                    fs.rmSync(entryPath, { recursive: true, force: true });
                    logger.debug('清理过期临时目录', { dir: entry });
                } else if (stats.isFile() && entry.startsWith('chunk_') && (now - stats.mtimeMs > 3600000)) {
                    // 清理孤儿 chunk 文件（上传中断导致未移动到目录的文件）
                    fs.unlinkSync(entryPath);
                    logger.debug('清理孤儿 chunk 文件', { file: entry });
                }
            } catch (e) { /* skip */ }
        });
    } catch (e) { /* skip */ }
}
// 服务启动时立即清理一次
cleanTempChunks();
setInterval(cleanTempChunks, 600000); // 每10分钟清理一次

// 获取本机IP
function getLocalIP() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

// 文件名清理（委托到 lib/utils，传入配置开关）
function sanitizeFilename(filename) {
    return _sanitizeFilename(filename, config.enableSanitization);
}

// 验证文件
function validateFile(file) {
    const ext = path.extname(file.originalname).toLowerCase();
    
    // 检查是否为禁止的文件类型
    if (config.blockedExtensions.includes(ext)) {
        throw new Error(`文件类型 ${ext} 不被允许上传`);
    }
    
    // 检查文件大小（不限制大小）
    return true;
}

// 生成唯一文件夹名（委托到 lib/utils）
function generateUniqueFolderName(customName = null) {
    return _generateUniqueFolderName(customName);
}

// 配置multer存储
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        try {
            // 只在第一个文件时设置会话目录
            if (!req.sessionDir) {
                const { targetFolder, customFolderName } = req.body;
                let sessionDir, folderType, timestamp;
                
                if (targetFolder && fs.existsSync(path.join(UPLOAD_DIR, targetFolder))) {
                    // 上传到现有文件夹
                    sessionDir = path.join(UPLOAD_DIR, targetFolder);
                    timestamp = targetFolder;
                    folderType = 'existing';
                    logger.info('使用现有文件夹', { folder: targetFolder });
                } else {
                    // 创建新文件夹
                    timestamp = generateUniqueFolderName(customFolderName);
                    sessionDir = path.join(UPLOAD_DIR, timestamp);
                    folderType = customFolderName ? 'custom' : 'auto';
                    logger.info('创建新文件夹', { 
                        name: timestamp, 
                        type: folderType,
                        custom: customFolderName 
                    });
                }
                
                // 确保会话目录存在
                if (!fs.existsSync(sessionDir)) {
                    fs.mkdirSync(sessionDir, { recursive: true });
                }
                
                req.sessionDir = sessionDir;
                req.timestamp = timestamp;
                req.folderType = folderType;
            }
            
            // 处理文件的目标目录
            const originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
            let targetDir = req.sessionDir;
            
            // 优先使用 webkitRelativePath
            if (file.webkitRelativePath && file.webkitRelativePath !== '') {
                const relativePath = file.webkitRelativePath.replace(/\\/g, '/');
                if (relativePath.includes('/')) {
                    const pathOnly = relativePath.substring(0, relativePath.lastIndexOf('/'));
                    targetDir = path.join(req.sessionDir, pathOnly);
                }
                logger.debug('使用 webkitRelativePath', { 
                    original: file.webkitRelativePath,
                    target: targetDir 
                });
            } else if (originalname.includes('/') || originalname.includes('\\')) {
                const normalizedPath = originalname.replace(/\\/g, '/');
                if (normalizedPath.includes('/')) {
                    const pathOnly = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'));
                    targetDir = path.join(req.sessionDir, pathOnly);
                }
                logger.debug('使用原始文件名路径', { 
                    original: originalname,
                    target: targetDir 
                });
            }
            
            // 确保目标目录存在
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
                logger.debug('创建目录', { path: targetDir });
            }
            
            cb(null, targetDir);
        } catch (error) {
            logger.error('设置目标目录失败', error);
            cb(error);
        }
    },
    filename: function (req, file, cb) {
        try {
            let originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
            
            // 提取文件名
            if (file.webkitRelativePath && file.webkitRelativePath !== '') {
                const filePath = file.webkitRelativePath.replace(/\\/g, '/');
                originalname = path.basename(filePath);
            } else if (originalname.includes('/') || originalname.includes('\\')) {
                const normalizedPath = originalname.replace(/\\/g, '/');
                originalname = path.basename(normalizedPath);
            }
            
            // 清理文件名
            const cleanName = sanitizeFilename(originalname);
            logger.debug('保存文件', { original: originalname, cleaned: cleanName });
            
            cb(null, cleanName);
        } catch (error) {
            logger.error('设置文件名失败', error);
            cb(error);
        }
    }
});

// 文件过滤器
const fileFilter = (req, file, cb) => {
    try {
        validateFile(file);
        cb(null, true);
    } catch (error) {
        logger.error('文件验证失败', { filename: file.originalname, error: error.message });
        cb(error, false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter
});

// 分块上传专用的 multer（简单存储到临时目录）
const chunkUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, TEMP_DIR),
        filename: (req, file, cb) => cb(null, `chunk_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`)
    }),
    limits: { fileSize: CHUNK_SIZE + 1024 * 1024 } // 略大于分块大小
});

// ── 路由 ──────────────────────────────────────────

// 统一错误包装：支持同步和 async 处理器
const wrap = fn => (req, res, next) => {
    try {
        const result = fn(req, res, next);
        if (result instanceof Promise) {
            result.catch(next);
        }
    } catch (err) {
        next(err);
    }
};

// 静态文件服务
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'), {
        maxAge: 7 * 24 * 60 * 60 * 1000
    });
});

app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '7d',
    etag: true,
    lastModified: true
}));

// 上传文件
app.post('/api/upload', upload.array('files'), wrap((req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: '没有选择文件' });
    }

    const uploadedFiles = req.files.map(file => ({
        originalName: Buffer.from(file.originalname, 'latin1').toString('utf8'),
        savedName: file.filename,
        size: file.size,
        mimetype: file.mimetype,
        relativePath: file.originalname.includes('/')
            ? file.originalname.substring(0, file.originalname.lastIndexOf('/')) : null
    }));

    uploadedFiles.forEach(file => {
        logger.info('文件上传详情', { name: file.originalName, size: file.size, mimetype: file.mimetype });
    });

    const totalSize = uploadedFiles.reduce((sum, file) => sum + file.size, 0);
    const actionMap = {
        'existing': '上传到现有文件夹',
        'custom': '创建自定义文件夹并上传',
        'auto': '创建自动文件夹并上传'
    };

    logger.info('文件上传成功', { folder: req.timestamp, fileCount: uploadedFiles.length, totalSize, type: req.folderType });

    res.json({
        success: true,
        uploaded: uploadedFiles,
        folder: {
            name: req.timestamp, path: req.timestamp, timestamp: req.timestamp,
            created: new Date().toISOString(), type: req.folderType
        },
        message: `${actionMap[req.folderType] || '上传'} ${uploadedFiles.length} 个文件到 "${req.timestamp}"`,
        action: actionMap[req.folderType] || '上传',
        totalSize,
        stats: {
            fileCount: uploadedFiles.length, totalSize,
            averageSize: Math.round(totalSize / uploadedFiles.length)
        }
    });
}));

// ── 分块上传 API ──────────────────────────────────

// 上传单个分块
app.post('/api/upload/chunk', chunkUpload.single('chunk'), wrap(async (req, res) => {
    await uploadSemaphore.acquire();
    try {
        if (!req.file) {
            return res.status(400).json({ error: '未收到分块数据' });
        }
        const { uploadId, chunkIndex, totalChunks, fileName, relativePath } = req.body;
        if (!uploadId || chunkIndex === undefined || !totalChunks || !fileName) {
            return res.status(400).json({ error: '缺少必要参数' });
        }

        // 验证 uploadId 安全性（只允许字母数字和连字符）
        if (!/^[a-zA-Z0-9_-]+$/.test(uploadId)) {
            return res.status(400).json({ error: '无效的 uploadId' });
        }

        const chunkDir = path.join(TEMP_DIR, uploadId);
        if (!fs.existsSync(chunkDir)) {
            fs.mkdirSync(chunkDir, { recursive: true });
        }

        // 保存分块元信息
        const metaPath = path.join(chunkDir, 'meta.json');
        if (!fs.existsSync(metaPath)) {
            fs.writeFileSync(metaPath, JSON.stringify({
                fileName, totalChunks: parseInt(totalChunks),
                relativePath: relativePath || '',
                createdAt: new Date().toISOString()
            }));
        }

        // multer 已将 chunk 保存到临时位置，移动到分块目录
        const tmpPath = req.file.path;
        const chunkPath = path.join(chunkDir, `chunk_${chunkIndex}`);
        fs.renameSync(tmpPath, chunkPath);

        logger.debug('分块已接收', { uploadId, chunk: `${parseInt(chunkIndex) + 1}/${totalChunks}`, file: fileName });

        res.json({ success: true, chunkIndex: parseInt(chunkIndex), totalChunks: parseInt(totalChunks) });
    } catch (err) {
        logger.error('分块上传失败', err);
        res.status(500).json({ error: '分块上传失败' });
    } finally {
        uploadSemaphore.release();
    }
}));

// 查询分块上传状态（用于断点续传）
app.get('/api/upload/chunks/:uploadId', wrap((req, res) => {
    const { uploadId } = req.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(uploadId)) {
        return res.status(400).json({ error: '无效的 uploadId' });
    }

    const chunkDir = path.join(TEMP_DIR, uploadId);
    const metaPath = path.join(chunkDir, 'meta.json');

    if (!fs.existsSync(chunkDir) || !fs.existsSync(metaPath)) {
        return res.json({ exists: false, completedChunks: [], totalChunks: 0 });
    }

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const completedChunks = fs.readdirSync(chunkDir)
        .filter(f => f.startsWith('chunk_'))
        .map(f => parseInt(f.replace('chunk_', ''), 10));

    res.json({
        exists: true,
        fileName: meta.fileName,
        relativePath: meta.relativePath,
        totalChunks: meta.totalChunks,
        completedChunks,
        progress: meta.totalChunks > 0 ? Math.round((completedChunks.length / meta.totalChunks) * 100) : 0
    });
}));

// 合并分块并完成上传
app.post('/api/upload/merge', wrap(async (req, res) => {
    const { uploadId, targetFolder, customFolderName } = req.body;
    if (!uploadId || !/^[a-zA-Z0-9_-]+$/.test(uploadId)) {
        return res.status(400).json({ error: '无效的 uploadId' });
    }

    const chunkDir = path.join(TEMP_DIR, uploadId);
    const metaPath = path.join(chunkDir, 'meta.json');

    if (!fs.existsSync(chunkDir) || !fs.existsSync(metaPath)) {
        return res.status(404).json({ error: '上传会话不存在或已过期' });
    }

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const { fileName, totalChunks, relativePath: relPath } = meta;

    // 验证所有分块是否存在
    const missingChunks = [];
    for (let i = 0; i < totalChunks; i++) {
        if (!fs.existsSync(path.join(chunkDir, `chunk_${i}`))) {
            missingChunks.push(i);
        }
    }
    if (missingChunks.length > 0) {
        return res.status(400).json({
            error: '缺少分块',
            missingChunks,
            completedChunks: totalChunks - missingChunks.length
        });
    }

    // 确定目标目录
    let sessionDir;
    if (targetFolder && fs.existsSync(path.join(UPLOAD_DIR, targetFolder))) {
        sessionDir = path.join(UPLOAD_DIR, targetFolder);
    } else {
        const folderName = generateUniqueFolderName(customFolderName);
        sessionDir = path.join(UPLOAD_DIR, folderName);
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
    }

    // 处理相对路径（子目录）
    let targetDir = sessionDir;
    if (relPath) {
        const parts = relPath.replace(/\\/g, '/').split('/');
        parts.pop(); // 去掉文件名
        if (parts.length > 0) {
            targetDir = path.join(sessionDir, ...parts);
            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        }
    }

    const baseName = path.basename(fileName.replace(/\\/g, '/'));
    const safeName = sanitizeFilename(baseName);
    const finalPath = path.join(targetDir, safeName);

    // 合并分块（流式 pipe，避免 readFileSync 阻塞事件循环）
    const writeStream = fs.createWriteStream(finalPath, { highWaterMark: 1024 * 1024 });
    for (let i = 0; i < totalChunks; i++) {
        await new Promise((resolve, reject) => {
            const readStream = fs.createReadStream(path.join(chunkDir, `chunk_${i}`), { highWaterMark: 1024 * 1024 });
            readStream.pipe(writeStream, { end: false });
            readStream.on('end', resolve);
            readStream.on('error', reject);
        });
    }
    await new Promise((resolve, reject) => {
        writeStream.end(err => err ? reject(err) : resolve());
    });

    // 计算 SHA256 并检查去重
    const sha256 = await calcSHA256(finalPath);
    const finalStats = fs.statSync(finalPath);
    let dedupSkipped = false;

    if (dedupDB[sha256]) {
        // 文件已存在，删除刚上传的重复文件
        fs.unlinkSync(finalPath);
        dedupSkipped = true;
        logger.info('检测到重复文件，已跳过', { file: fileName, sha256: sha256.substring(0, 16), existingPath: dedupDB[sha256] });
    } else {
        dedupDB[sha256] = path.relative(UPLOAD_DIR, finalPath);
        saveDedupDB();
    }

    // 清理临时分块
    fs.rmSync(chunkDir, { recursive: true, force: true });

    logger.info('分块上传完成', { file: fileName, chunks: totalChunks, size: finalStats.size, dedupSkipped });

    res.json({
        success: true,
        fileName: safeName,
        size: finalStats.size,
        sha256,
        dedupSkipped,
        folder: path.relative(UPLOAD_DIR, sessionDir),
        message: dedupSkipped ? `文件 ${fileName} 已存在，已跳过` : `文件 ${fileName} 上传完成`
    });
}));

// 获取文件列表（支持分页和搜索）
app.get('/api/files', wrap(async (req, res) => {
    const { path: queryPath = '', sortBy = 'name', sortOrder = 'asc', page = 1, pageSize = 50, search = '' } = req.query;
    const currentPage = parseInt(page, 10) || 1;
    const size = Math.min(parseInt(pageSize, 10) || 50, 200); // 上限 200
    const offset = (currentPage - 1) * size;

    const currentPath = queryPath ? path.join(UPLOAD_DIR, queryPath) : UPLOAD_DIR;
    if (!fs.existsSync(currentPath)) {
        return res.json({ files: [], currentPath: queryPath, error: '路径不存在' });
    }

    const items = fs.readdirSync(currentPath);
    const files = [];
    const folders = [];

    // 第一轮：同步 stat 分类（stat 本身很快，不会阻塞）
    items.forEach(item => {
        if (search && !item.toLowerCase().includes(search.toLowerCase())) return;

        const itemPath = path.join(currentPath, item);
        let stats;
        try { stats = fs.statSync(itemPath); } catch (err) {
            return logger.debug('读取文件信息失败', { item, error: err.message });
        }

        const itemData = {
            name: item, size: 0, type: stats.isDirectory() ? 'folder' : 'file',
            modified: stats.mtime, created: stats.birthtime,
            path: queryPath ? `${queryPath}/${item}` : item
        };

        if (stats.isDirectory()) {
            folders.push(itemData);
        } else {
            itemData.size = stats.size;
            itemData.extension = path.extname(item).toLowerCase();
            itemData.mime = getMimeType(item);
            files.push(itemData);
        }
    });

    // 第二轮：异步并行计算所有文件夹大小（不阻塞事件循环）
    await Promise.all(folders.map(async (folderData) => {
        const cacheKey = folderData.path;
        try {
            if (config.cacheFolderSize && folderSizeCache.has(cacheKey)) {
                folderData.size = folderSizeCache.get(cacheKey).size;
            } else {
                const itemPath = path.join(UPLOAD_DIR, folderData.path);
                folderData.size = await calculateFolderSizeAsync(itemPath);
                if (config.cacheFolderSize) {
                    folderSizeCache.set(cacheKey, { size: folderData.size, timestamp: Date.now() });
                }
            }
        } catch (e) { /* 忽略 */ }
    }));

    // 排序
    const sortFns = {
        name: (a, b) => a.name.localeCompare(b.name),
        size: (a, b) => a.size - b.size,
        modified: (a, b) => new Date(a.modified) - new Date(b.modified),
        type: (a, b) => a.type.localeCompare(b.type)
    };
    const sortFn = sortFns[sortBy] || sortFns.name;
    const asc = sortOrder === 'asc';
    folders.sort((a, b) => asc ? sortFn(a, b) : sortFn(b, a));
    files.sort((a, b) => asc ? sortFn(a, b) : sortFn(b, a));

    const allItems = [...folders, ...files];
    const totalItems = allItems.length;
    const totalPages = Math.ceil(totalItems / size);
    const paginatedItems = allItems.slice(offset, offset + size);
    const filesTotalSize = files.reduce((sum, f) => sum + f.size, 0);
    const foldersTotalSize = folders.reduce((sum, f) => sum + f.size, 0);

    res.json({
        files: paginatedItems,
        currentPath: queryPath,
        parentPath: queryPath ? queryPath.split('/').slice(0, -1).join('/') : null,
        stats: {
            totalFiles: files.length, totalFolders: folders.length,
            totalSize: filesTotalSize, folderSize: foldersTotalSize,
            grandTotal: filesTotalSize + foldersTotalSize
        },
        pagination: {
            currentPage, pageSize: size, totalItems, totalPages,
            hasNext: currentPage < totalPages, hasPrev: currentPage > 1
        },
        sorting: { sortBy, sortOrder },
        search: search || null
    });
}));

// 下载文件
app.get('/api/download/:filename', (req, res) => {
    const filename = decodeURIComponent(req.params.filename);
    const filePath = req.query.path || '';
    const relativePath = filePath ? `${filePath}/${filename}` : filename;

    const result = resolveSafePath(relativePath);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const mimeType = getMimeType(filename);
    logger.info('文件下载', { file: filename, path: filePath, size: result.stats.size, mime: mimeType });
    recordAccess(relativePath, 'download');

    streamFile(req, res, result.fullPath, result.stats, {
        disposition: 'attachment', mimeType,
        cacheControl: 'no-cache, no-store, must-revalidate', filename
    });
});

// 下载文件夹（打包为 zip 流式传输）
app.get('/api/download-folder', (req, res) => {
    const folderPath = req.query.path || '';
    if (!folderPath) return res.status(400).json({ error: '缺少文件夹路径' });

    const result = resolvePath(folderPath);
    if (result.error) return res.status(result.status).json({ error: result.error });
    if (!result.stats.isDirectory()) return res.status(400).json({ error: '路径不是文件夹' });

    const folderName = path.basename(folderPath);
    const zipName = `${folderName}.zip`;

    logger.info('文件夹下载', { folder: folderPath, size: result.stats.size });

    // 设置响应头（zip 下载）
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    // 创建 zip 流，直接 pipe 到响应（零磁盘占用）
    // store=true：纯打包不压缩，局域网内速度最快（磁盘读速 ≈ 打包速度）
    const archive = new archiver.ZipArchive({
        store: true
    });

    archive.on('error', (err) => {
        logger.error('文件夹压缩失败', { folder: folderPath, error: err.message });
        if (!res.headersSent) {
            res.status(500).json({ error: '压缩失败' });
        }
    });

    archive.on('warning', (err) => {
        if (err.code === 'ENOENT') {
            logger.warn('压缩警告：文件不存在', { folder: folderPath });
        } else {
            throw err;
        }
    });

    archive.pipe(res);

    // 将整个文件夹加入 zip，保留目录结构
    archive.directory(result.fullPath, folderName);

    archive.finalize();
});

// 批量删除文件/文件夹
app.delete('/api/delete', (req, res) => {
    const { paths } = req.body;
    if (!paths || paths.length === 0) return res.status(400).json({ error: '路径不能为空' });

    const deletedItems = [];
    const failedItems = [];

    for (const deletePath of paths) {
        const result = resolvePath(deletePath);
        if (result.error) {
            failedItems.push({ path: deletePath, error: result.error });
            continue;
        }
        try {
            const isDir = result.stats.isDirectory();
            if (isDir) {
                fs.rmSync(result.fullPath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(result.fullPath);
            }
            deletedItems.push({ path: deletePath, type: isDir ? 'folder' : 'file' });
        } catch (error) {
            failedItems.push({ path: deletePath, error: error.message });
        }
    }

    logger.info('批量删除完成', { deleted: deletedItems.length, failed: failedItems.length });
    res.json({
        success: true,
        message: `删除了 ${deletedItems.length} 项${failedItems.length > 0 ? `，失败 ${failedItems.length} 项` : ''}`,
        deleted: deletedItems,
        failed: failedItems
    });
});

// 文件预览接口
app.get('/api/preview/:filename(*)', (req, res) => {
    const relativePath = req.params[0] || '';
    const result = resolveSafePath(relativePath);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const mimeType = getMimeType(path.basename(relativePath));
    logger.info('文件预览', { path: relativePath, mime: mimeType });
    recordAccess(relativePath, 'preview');

    streamFile(req, res, result.fullPath, result.stats, {
        disposition: 'inline', mimeType,
        cacheControl: 'public, max-age=3600'
    });
});

// 原始下载接口（绕过所有处理，直接传输二进制）
app.get('/api/raw/:filename(*)', (req, res) => {
    const relativePath = req.params[0] || '';
    const result = resolveSafePath(relativePath);
    if (result.error) return res.status(result.status).json({ error: result.error });

    logger.info('原始文件下载', { path: relativePath, size: result.stats.size });
    streamFile(req, res, result.fullPath, result.stats, {
        disposition: 'attachment',
        mimeType: 'application/octet-stream',
        cacheControl: 'no-cache, no-store, must-revalidate'
    });
});

// 获取文件详细信息（用于调试）
app.get('/api/fileinfo', (req, res) => {
    const queryPath = req.query.path || '';
    const result = resolvePath(queryPath);
    if (result.error) return res.status(result.status).json({ error: result.error });

    res.json({
        path: queryPath || '/',
        fullPath: result.fullPath,
        size: result.stats.size,
        isDirectory: result.stats.isDirectory(),
        created: result.stats.birthtime,
        modified: result.stats.mtime,
        serverSize: result.stats.size
    });
});

// 访问统计接口
app.get('/api/stats', wrap((req, res) => {
    const values = Array.from(accessStats.values());
    const topFiles = [...values]
        .sort((a, b) => (b.downloadCount + b.previewCount) - (a.downloadCount + a.previewCount))
        .slice(0, 100);
    const totalAccess = values.reduce((sum, item) => sum + item.downloadCount + item.previewCount, 0);

    res.json({ totalAccess, topFiles, totalFiles: accessStats.size });
}));

// 健康检查接口
app.get('/api/health', wrap(async (req, res) => {
    const mem = process.memoryUsage();
    const storageStats = await getStorageStats();
    res.json({
        status: 'healthy',
        uptime: Math.floor(process.uptime()),
        memory: {
            heapUsed: Math.round(mem.heapUsed / 1048576) + ' MB',
            heapTotal: Math.round(mem.heapTotal / 1048576) + ' MB',
            rss: Math.round(mem.rss / 1048576) + ' MB'
        },
        storage: { totalSize: formatBytes(storageStats.totalSize), uploadDir: storageStats.path }
    });
}));

// 服务器信息
app.get('/api/info', wrap(async (req, res) => {
    const storageStats = await getStorageStats();
    res.json({
        version: '2.0.0',
        nodeVersion: process.version, platform: os.platform(), arch: os.arch(),
        uptime: process.uptime(), memory: process.memoryUsage(), uploadDir: UPLOAD_DIR,
        storage: storageStats,
        config: {
            blockedExtensions: config.blockedExtensions
        }
    });
}));

// 辅助函数
// 异步计算文件夹大小（不阻塞事件循环）
async function calculateFolderSizeAsync(folderPath, maxDepth = 10) {
    let totalSize = 0;
    const queue = [{ path: folderPath, depth: 0 }];

    while (queue.length > 0) {
        const batch = queue.splice(0, Math.min(queue.length, 50));
        for (const { path: dirPath, depth } of batch) {
            if (depth >= maxDepth) continue;
            try {
                const items = await fs.promises.readdir(dirPath);
                for (const item of items) {
                    const itemPath = path.join(dirPath, item);
                    try {
                        const stats = await fs.promises.stat(itemPath);
                        if (stats.isDirectory()) {
                            queue.push({ path: itemPath, depth: depth + 1 });
                        } else {
                            totalSize += stats.size;
                        }
                    } catch (e) { /* skip */ }
                }
            } catch (error) {
                logger.debug('计算文件夹大小时出错', { path: dirPath, error: error.message });
            }
        }
        // 每批处理后释放事件循环
        if (queue.length > 0) {
            await new Promise(r => setImmediate(r));
        }
    }
    return totalSize;
}

async function getStorageStats() {
    try {
        const stats = fs.statSync(UPLOAD_DIR);
        // 缓存 60 秒，避免每次 health/info 请求都递归扫描整个 uploads
        const now = Date.now();
        if (now - storageSizeCache.timestamp < 60000 && storageSizeCache.size > 0) {
            return {
                path: UPLOAD_DIR,
                totalSize: storageSizeCache.size,
                created: stats.birthtime,
                modified: stats.mtime
            };
        }
        const totalSize = await calculateFolderSizeAsync(UPLOAD_DIR);
        storageSizeCache = { size: totalSize, timestamp: now };
        return {
            path: UPLOAD_DIR,
            totalSize,
            created: stats.birthtime,
            modified: stats.mtime
        };
    } catch (error) {
        logger.error('获取存储统计失败', error);
        return {
            path: UPLOAD_DIR,
            totalSize: 0,
            error: error.message
        };
    }
}

// ── 共享辅助：路径安全校验 ──────────────────────

// 解析并校验路径（仅文件，拒绝目录）— 委托到 lib/utils
function resolveSafePath(relativePath) {
    return _resolveSafePath(UPLOAD_DIR, relativePath);
}

// 解析并校验路径（允许目录）— 委托到 lib/utils
function resolvePath(relativePath) {
    return _resolvePath(UPLOAD_DIR, relativePath);
}

// 统一的文件流传输（支持 Range 请求、断点续传、ETag 缓存、大文件多用户并行下载）
const STREAM_HIGH_WATER_MARK = 1024 * 1024; // 1MB 缓冲区（默认64KB）

function streamFile(req, res, fullPath, stats, options = {}) {
    const { disposition = 'attachment', mimeType = 'application/octet-stream', cacheControl = 'no-cache', filename } = options;
    const name = filename || path.basename(fullPath);
    const fileSize = stats.size;

    // ETag 用于缓存协商（基于文件大小 + 修改时间）
    const etag = `"${stats.size.toString(16)}-${stats.mtime.getTime().toString(16)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Accept-Ranges', 'bytes');

    // 条件 GET：304 Not Modified（浏览器缓存命中时跳过传输）
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch === etag) {
        res.status(304).end();
        return;
    }

    // 解析 Range 请求头
    const range = req.headers.range;
    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        // 多 Range 请求简化处理：只取第一个 range
        if (isNaN(start) || start >= fileSize) {
            res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
            return;
        }

        const validEnd = Math.min(end, fileSize - 1);
        if (start > validEnd) {
            res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
            return;
        }

        const chunkSize = validEnd - start + 1;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${validEnd}/${fileSize}`);
        res.setHeader('Content-Length', chunkSize);
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', disposition === 'inline' ? 'inline'
            : `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
        res.setHeader('Cache-Control', cacheControl);

        logger.info('Range请求', { file: name, range: `bytes ${start}-${validEnd}/${fileSize}`, size: chunkSize });

        const fileStream = fs.createReadStream(fullPath, {
            start, end: validEnd,
            highWaterMark: STREAM_HIGH_WATER_MARK
        });
        fileStream.pipe(res);
        fileStream.on('error', (err) => {
            logger.error('文件流错误', err);
            if (!res.headersSent) res.status(500).json({ error: '传输失败' });
        });
        res.on('close', () => fileStream.destroy());
        return;
    }

    // 完整文件下载
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', disposition === 'inline' ? 'inline'
        : `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Cache-Control', cacheControl);

    const fileStream = fs.createReadStream(fullPath, {
        highWaterMark: STREAM_HIGH_WATER_MARK
    });
    fileStream.pipe(res);

    fileStream.on('error', (err) => {
        logger.error('文件流错误', err);
        if (!res.headersSent) res.status(500).json({ error: '传输失败' });
    });
    res.on('close', () => fileStream.destroy());
}

// 统一记录访问统计（带内存上限，超过时淘汰最旧的条目）
function recordAccess(key, type) {
    if (accessStats.has(key)) {
        const entry = accessStats.get(key);
        type === 'download' ? entry.downloadCount++ : entry.previewCount++;
        entry.lastAccess = new Date().toISOString();
    } else {
        // 超过上限时淘汰最旧的 2000 条
        if (accessStats.size >= ACCESS_STATS_MAX) {
            const entries = Array.from(accessStats.entries())
                .sort((a, b) => new Date(a[1].lastAccess) - new Date(b[1].lastAccess));
            for (let i = 0; i < 2000 && i < entries.length; i++) {
                accessStats.delete(entries[i][0]);
            }
        }
        accessStats.set(key, {
            path: key, type: 'file',
            downloadCount: type === 'download' ? 1 : 0,
            previewCount: type === 'preview' ? 1 : 0,
            lastAccess: new Date().toISOString()
        });
    }
}

// 错误处理中间件（必须在所有路由之后注册）
app.use((err, req, res, next) => {
    logger.error('请求处理错误', { id: req.id, error: err.message });

    if (err.code === 'LIMIT_FILE_SIZE')    return res.status(413).json({ error: '文件太大' });
    if (err.code === 'LIMIT_FILE_COUNT')   return res.status(413).json({ error: '文件数量太多' });
    if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: '意外的文件字段' });

    res.status(500).json({ error: '服务器内部错误' });
});

// 启动服务器
const server = app.listen(PORT, '0.0.0.0', () => {
    const localIP = getLocalIP();
    logger.info('服务器启动成功', {
        port: PORT,
        localIP,
        uploadDir: UPLOAD_DIR,
        nodeVersion: process.version
    });
    
    console.log('='.repeat(60));
    console.log('🚀 局域网网盘 v2.0.0');
    console.log('='.repeat(60));
    console.log(`📱 本地访问: http://localhost:${PORT}`);
    console.log(`🌐 局域网访问: http://${localIP}:${PORT}`);
    console.log(`📁 上传目录: ${UPLOAD_DIR}`);
    console.log('='.repeat(60));
});

// 优雅关闭
function gracefulShutdown(signal) {
    logger.info(`收到 ${signal} 信号，正在关闭服务器`);
    saveDedupDBSync();
    server.close(() => process.exit(0));
    // 强制退出保护，5 秒后还未关闭则强制退出
    setTimeout(() => process.exit(0), 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 未捕获异常处理
process.on('uncaughtException', (err) => {
    logger.error('未捕获的异常', err);
    saveDedupDBSync();
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('未处理的 Promise 拒绝', { reason, promise });
});