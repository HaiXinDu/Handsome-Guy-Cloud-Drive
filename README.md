# Handsome Guy Cloud Drive

局域网网盘系统 v2.0 —— 轻量、高效的本地文件共享服务。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量（可选）
cp .env.example .env

# 3. 启动服务
npm start
```

浏览器访问 `http://localhost:3000` 即可使用。

## 功能特性

- **文件上传**：支持大文件分块上传、断点续传、SHA256 去重
- **文件夹管理**：创建/删除文件夹、多选批量操作
- **文件预览**：支持图片（jpg/png/gif/webp/svg）和 PDF 在线预览
- **下载**：单文件下载、文件夹打包下载（自动生成 ZIP）、原始文件下载
- **访问统计**：记录文件下载/预览次数
- **安全防护**：请求速率限制、文件名过滤、敏感扩展名拦截、XSS 防护
- **流式处理**：分块合并使用流式 pipe，不阻塞事件循环

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `UPLOAD_DIR` | `uploads` | 文件存储目录 |
| `BLOCKED_EXTENSIONS` | `.exe,.bat,.cmd,.scr,.pif,.com,.sh,.ps1` | 禁止上传的扩展名 |
| `ENABLE_LOGGING` | `true` | 是否启用日志 |
| `ENABLE_SANITIZATION` | `true` | 是否启用文件名过滤 |
| `CACHE_FOLDER_SIZE` | `true` | 是否缓存文件夹大小 |
| `CACHE_TTL` | `60000` | 文件夹大小缓存时间（毫秒） |

## 技术栈

- **后端**：Node.js + Express
- **上传**：Multer（分块上传）
- **压缩**：compression + archiver
- **前端**：原生 HTML/CSS/JS（无框架依赖）

## 项目结构

```
jyw/
├── server.js          # 服务端入口
├── package.json       # 项目依赖
├── .env.example       # 环境变量模板
├── .gitignore
├── public/
│   └── index.html     # 前端页面
└── uploads/           # 文件存储目录（自动创建）
```

## License

MIT
