@echo off
chcp 65001 >nul
title 局域网网盘系统

:: 检查 Node.js 是否安装
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js！
    echo 下载地址：https://nodejs.org/
    pause
    exit /b 1
)

:: 检查是否已安装依赖
if not exist "node_modules\" (
    echo [提示] 首次运行，正在安装依赖...
    call npm install --production
)

:: 获取本机局域网 IP
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    set LAN_IP=%%a
)

:: 启动服务
echo ============================================
echo   局域网网盘系统 v2.0
echo ============================================
echo   本地访问：http://localhost:3000
echo   局域网访问：http:/%LAN_IP%:3000
echo ============================================
echo.

node server.js
pause
