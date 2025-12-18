@echo off
title 局域网网盘

cd /d "%~dp0"

if not exist "node_modules" (
    echo 安装依赖...
    npm install
)

echo 启动服务器...
node server.js
pause