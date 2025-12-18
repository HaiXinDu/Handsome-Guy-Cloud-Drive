const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 5000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// 确保上传目录存在
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 获取本机IP
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const interface of interfaces[name]) {
            if (interface.family === 'IPv4' && !interface.internal) {
                return interface.address;
            }
        }
    }
    return 'localhost';
}

// 配置multer存储
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // 检查是否指定了目标文件夹
        const targetFolder = req.body.targetFolder;
        const customFolderName = req.body.customFolderName;
        let sessionDir;
        
        console.log('服务器接收到 - targetFolder:', targetFolder, 'customFolderName:', customFolderName);
        
        if (targetFolder) {
            // 上传到现有文件夹
            console.log('使用现有文件夹:', targetFolder);
            sessionDir = path.join(UPLOAD_DIR, targetFolder);
            req.timestamp = targetFolder;
            req.isNewFolder = false;
            req.folderType = 'existing';
        } else if (customFolderName) {
            // 使用自定义名称创建新文件夹
            const sanitizedName = customFolderName.replace(/[<>:"/\\|?*]/g, '_').trim();
            console.log('创建自定义文件夹:', sanitizedName);
            sessionDir = path.join(UPLOAD_DIR, sanitizedName);
            req.timestamp = sanitizedName;
            req.isNewFolder = true;
            req.folderType = 'custom';
        } else {
            // 创建新的时间戳文件夹
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            console.log('创建时间戳文件夹:', timestamp);
            sessionDir = path.join(UPLOAD_DIR, `upload-${timestamp}`);
            req.timestamp = timestamp;
            req.isNewFolder = true;
            req.folderType = 'timestamp';
        }
        
        // 确保会话目录存在
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }
        
        // 处理文件路径 - 重点修复这里
        let originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
        let filePath = '';
        
        // 优先使用 webkitRelativePath，这保留了文件夹结构
        if (file.webkitRelativePath && file.webkitRelativePath !== '') {
            filePath = file.webkitRelativePath;
            console.log('使用 webkitRelativePath:', filePath);
        } else {
            // 对于普通上传，使用原始文件名中的路径
            const normalizedPath = originalname.replace(/\\/g, '/');
            filePath = normalizedPath.includes('/') ? normalizedPath : '';
            console.log('使用原始文件名路径:', filePath);
        }
        
        // 从完整路径中提取目录部分和文件名
        const relativePath = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '';
        const targetDir = relativePath ? path.join(sessionDir, relativePath) : sessionDir;
        
        console.log('相对路径:', relativePath);
        console.log('目标目录:', targetDir);
        
        // 确保目标目录存在（这里会创建完整的文件夹结构）
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
            console.log('创建目录:', targetDir);
        }
        
        req.sessionDir = sessionDir;
        cb(null, targetDir);
    },
    filename: function (req, file, cb) {
        let originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
        
        // 如果有 webkitRelativePath，使用路径中的文件名
        if (file.webkitRelativePath && file.webkitRelativePath !== '') {
            originalname = path.basename(file.webkitRelativePath);
        } else {
            originalname = path.basename(originalname);
        }
        
        console.log('保存文件名:', originalname);
        cb(null, originalname);
    }
});

const upload = multer({ storage: storage });

// 中间件
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// 路由
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 上传文件
app.post('/api/upload', upload.array('files'), (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: '没有选择文件' });
        }

        const uploadedFiles = req.files.map(file => ({
            originalName: file.originalname,
            savedName: file.filename,
            size: file.size,
            mimetype: file.mimetype,
            relativePath: file.originalname.includes('/') ? file.originalname.substring(0, file.originalname.lastIndexOf('/')) : null
        }));

        let folderName, action;
        
        if (req.folderType === 'existing') {
            folderName = req.timestamp;
            action = '上传到现有文件夹';
        } else if (req.folderType === 'custom') {
            folderName = req.timestamp;
            action = '创建自定义文件夹并上传';
        } else {
            folderName = `upload-${req.timestamp}`;
            action = '创建时间戳文件夹并上传';
        }
        
        res.json({ 
            success: true, 
            uploaded: uploadedFiles,
            folder: {
                name: folderName,
                path: folderName,
                timestamp: req.timestamp,
                created: new Date().toISOString(),
                isNew: req.isNewFolder,
                type: req.folderType
            },
            message: `${action} ${uploadedFiles.length} 个文件到 "${folderName}"`,
            action: action,
            totalSize: uploadedFiles.reduce((sum, file) => sum + file.size, 0)
        });
    } catch (error) {
        console.error('上传错误:', error);
        res.status(500).json({ error: '上传失败: ' + error.message });
    }
});

// 获取文件列表
app.get('/api/files', (req, res) => {
    try {
        const { path: queryPath = '' } = req.query;
        const currentPath = queryPath ? path.join(UPLOAD_DIR, queryPath) : UPLOAD_DIR;
        
        if (!fs.existsSync(currentPath)) {
            return res.json({ files: [], currentPath: queryPath });
        }

        const items = fs.readdirSync(currentPath);
        const files = [];
        const folders = [];

        items.forEach(item => {
            const itemPath = path.join(currentPath, item);
            const stats = fs.statSync(itemPath);
            
            if (stats.isDirectory()) {
                folders.push({
                    name: item,
                    size: 0,
                    modified: stats.mtime,
                    created: stats.birthtime,
                    type: 'folder',
                    path: queryPath ? `${queryPath}/${item}` : item
                });
            } else {
                files.push({
                    name: item,
                    size: stats.size,
                    modified: stats.mtime,
                    created: stats.birthtime,
                    type: 'file',
                    extension: path.extname(item).toLowerCase(),
                    path: queryPath ? `${queryPath}/${item}` : item
                });
            }
        });

        // 排序：文件夹在前，按名称排序
        folders.sort((a, b) => a.name.localeCompare(b.name));
        files.sort((a, b) => new Date(b.modified) - new Date(a.modified));

        res.json({ 
            files: [...folders, ...files],
            currentPath: queryPath,
            parentPath: queryPath ? queryPath.split('/').slice(0, -1).join('/') : null,
            total: files.length,
            totalSize: files.reduce((sum, file) => sum + file.size, 0)
        });
    } catch (error) {
        console.error('获取文件列表错误:', error);
        res.status(500).json({ error: '获取文件列表失败: ' + error.message });
    }
});

// 下载文件
app.get('/api/download/:filename', (req, res) => {
    try {
        const filename = decodeURIComponent(req.params.filename);
        const { path: filePath = '' } = req.query;
        const fullPath = filePath ? path.join(UPLOAD_DIR, filePath, filename) : path.join(UPLOAD_DIR, filename);
        
        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ error: '文件不存在' });
        }

        const stats = fs.statSync(fullPath);
        if (stats.isDirectory()) {
            return res.status(400).json({ error: '不能下载目录' });
        }

        res.download(fullPath, filename, (err) => {
            if (err) {
                console.error('下载错误:', err);
                if (!res.headersSent) {
                    res.status(500).json({ error: '下载失败' });
                }
            }
        });
    } catch (error) {
        console.error('下载异常:', error);
        res.status(500).json({ error: '下载异常: ' + error.message });
    }
});

// 服务器信息
app.get('/api/info', (req, res) => {
    res.json({
        version: '2.0.0',
        nodeVersion: process.version,
        platform: os.platform(),
        uploadDir: UPLOAD_DIR
    });
});

// 启动服务器
app.listen(PORT, '0.0.0.0', () => {
    const localIP = getLocalIP();
    console.log('='.repeat(50));
    console.log('🚀 局域网网盘已启动');
    console.log('='.repeat(50));
    console.log(`📱 本地访问: http://localhost:${PORT}`);
    console.log(`🌐 局域网访问: http://${localIP}:${PORT}`);
    console.log(`📁 上传目录: ${UPLOAD_DIR}`);
    console.log('='.repeat(50));
});

// 优雅关闭
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));