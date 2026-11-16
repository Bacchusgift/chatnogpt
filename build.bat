@echo off
rem 构建当前平台 (Windows) 可执行文件
cd /d "%~dp0"
go build -o chatnogpt.exe .
if errorlevel 1 (
  echo build failed
  exit /b 1
)
echo Built chatnogpt.exe
