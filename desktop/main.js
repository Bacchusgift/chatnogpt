'use strict';

// ChatNoGPT 桌面壳：加载线上（或本地）服务地址，关闭窗口时驻留系统托盘，
// 消息通知由页面内的 Web Notification 触发，Electron 会渲染成 Windows/macOS
// 的原生系统气泡——窗口隐藏时依然有效。

const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');

const DEFAULT_URL = 'https://chatnogpt.autowired.cn/';

// 地址优先级：环境变量 CHATNOGPT_URL > 命令行里的 http 参数 > 线上地址
function resolveURL() {
  if (process.env.CHATNOGPT_URL) return process.env.CHATNOGPT_URL;
  const arg = process.argv.find(a => /^https?:\/\//.test(a));
  return arg || DEFAULT_URL;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let tray = null;
let quitting = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    backgroundColor: '#111111',
    autoHideMenuBar: true,
    title: 'ChatNoGPT',
    icon: path.join(__dirname, 'icon-256.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(resolveURL());
  win.on('page-title-updated', e => e.preventDefault());
  // 站内图片点击会用 window.open 打开 blob 预览：允许为独立窗口；外链交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
  });
  // 关闭窗口 = 隐藏到托盘，后台继续接收消息通知
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  win.show();
  win.focus();
}

function createTray() {
  const iconPath = path.join(__dirname, 'tray.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('ChatNoGPT - 新消息会在这里提醒');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 ChatNoGPT', click: showWindow },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

const gotLock = app.requestSingleInstanceLock();
if (gotLock) {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    createWindow();
    createTray();
  });
  app.on('activate', showWindow);
  app.on('before-quit', () => { quitting = true; });
} else {
  app.quit();
}
