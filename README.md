# 局域网网盘系统 v2.1

轻量、高效的局域网文件共享服务。拖拽上传、在线预览、文件夹打包下载，开箱即用。

---

## 部署方式

### 方式一：便携版（推荐，无需安装任何东西）

从 [Releases](https://github.com/HaiXinDu/Handsome-Guy-Cloud-Drive/releases) 下载 `server.exe`，**双击运行**。

浏览器访问终端里显示的地址（如 `http://192.168.1.100:3000`），局域网内其他设备也能访问。

> 首次运行会自动在 exe 所在目录创建 `uploads/` 文件夹存放文件。

### 方式二：源码运行（需要 Node.js）

```bash
git clone https://github.com/HaiXinDu/Handsome-Guy-Cloud-Drive.git
cd Handsome-Guy-Cloud-Drive
npm install
cp .env.example .env   # 可选，默认配置即可用
npm start
```

---

## 功能特性

- **文件上传** — 大文件自动分块（5MB/块）、断点续传、SHA256 去重、最多 3 个并发
- **文件夹上传** — 选择文件夹后浏览器端自动压缩为 zip，单文件上传，保留目录结构
- **文件夹下载** — 选中文件夹一键打包为 zip 流式下载（store 模式，不压缩，局域网最快）
- **文件预览** — 图片（jpg/png/gif/webp/svg）在线预览，PDF 新窗口打开
- **批量操作** — 多选文件/文件夹，一键下载或删除
- **搜索分页** — 文件/文件夹搜索，分页浏览（每页 50 条）
- **安全防护** — CSP 头、速率限制（600次/分钟）、敏感扩展名拦截、路径遍历防御、NTFS 保留名过滤
- **访问统计** — 下载/预览计数，TOP 100 排行

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `UPLOAD_DIR` | `uploads` | 文件存储目录 |
| `BLOCKED_EXTENSIONS` | `.exe,.bat,.cmd,.scr,.pif,.com,.sh,.ps1` | 禁止上传的扩展名 |
| `ENABLE_LOGGING` | `true` | 是否启用日志 |
| `ENABLE_SANITIZATION` | `true` | 文件名安全过滤 |
| `CACHE_FOLDER_SIZE` | `true` | 缓存文件夹大小 |
| `CACHE_TTL` | `60000` | 缓存有效期（ms） |

---

## 技术栈

**后端** Node.js + Express · Multer · archiver · compression  
**前端** 原生 HTML/CSS/JS · JSZip  
**测试** Node.js 内置 test runner（40 个用例）

---

## 项目结构

```
├── server.js          # 服务端
├── lib/utils.js       # 工具函数
├── public/            # 前端
├── tests/             # 单元测试
├── dist/              # 便携版构建产物
└── uploads/           # 文件存储（运行时）
```

## License

MIT
