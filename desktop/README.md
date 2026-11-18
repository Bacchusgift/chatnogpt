# ChatNoGPT 桌面客户端（Electron）

把网页包成独立桌面应用：自有窗口、系统托盘驻留（关闭窗口 = 缩到托盘，
后台继续接收消息并弹出原生系统通知）、单实例、外链走系统浏览器。

## 开发运行

```sh
cd desktop
npm install
npm start
```

默认加载 `https://chatnogpt.autowired.cn/`；可用环境变量或命令行参数改地址：

```sh
set CHATNOGPT_URL=http://127.0.0.1:8080/
npm start
```

## 打包 Windows 便携版

```sh
npm run dist
```

产物在 `desktop/dist/ChatNoGPT-win32-x64/`，整个文件夹拷到哪都能跑
（入口 `ChatNoGPT.exe`）。

## 行为说明

- 关闭窗口不会退出：缩到托盘继续接收通知；托盘右键可退出。
- 通知由页面内的 Web Notification 触发，Electron 渲染为系统原生气泡，
  权限继承页面自身设置（首次弹出时在应用内点允许即可）。
- 登录态与网页版共享同一浏览器存储（独立于浏览器本体）。
