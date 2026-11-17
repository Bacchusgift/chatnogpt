# ChatNoGPT

一个仿 ChatGPT 界面的 **真人扮演 AI** 的群聊服务。看起来你是在和 AI 对话，
实际上对方和你一样是登录进来的真人；只有他们发的消息在你这边渲染成
ChatGPT 的样子——左侧平铺 + 昵称标签 + 打字机逐字输出 + "正在输入…"。

**单一 Go 二进制、零第三方依赖**（WebSocket 是标准库实现的），前端全部通过
`go:embed` 内嵌，编译出来一个 exe，双击即用。

## 多站点皮肤

除仿 ChatGPT 主站外，同一后端还内置五套前端皮肤（`sites/` 目录）。
所有站点共用同一套账号、会话与消息，消息按所在站点被渲染成该站点语境
下的"AI 行为"：

| 域名（默认占位） | 内嵌目录 | 形态 | 消息渲染为 |
|---|---|---|---|
| `chat.example.com` | `web/` | 仿 ChatGPT 主站 | 打字机回复 + 思考时长 |
| `play.example.com` | `sites/play` | 3D 游戏（three.js） | NPC 台词 |
| `mall.example.com` | `sites/mall` | 电商页面 | AI 客服回复 |
| `news.example.com` | `sites/news` | 新闻门户 | 评论区楼中楼 |
| `work.example.com` | `sites/work` | 企业 OA | 审批节点意见 |
| `dev.example.com`  | `sites/dev` | 终端模拟器 | 命令输出 |

域名映射默认是占位符，实际域名通过 `-sites` 指定的 JSON 文件配置
（模板见 `sites.example.json`），例如：

```json
{
  "play.yourdomain.com": "sites/play",
  "mall.yourdomain.com": "sites/mall"
}
```

文件中出现的目录名必须是内置的 `sites/<name>` 之一，其余会被忽略并记录日志。
本地调试不配置域名即可：任意站点都可用 `http://127.0.0.1:8080/?_site=play`
这种方式访问（`_site` 取值：play / mall / news / work / dev）。

## 功能

- **注册 = 创建一个"模型"**：自动生成模型风格的名称（如 `gpt-6.1-sol`、
  `glm-5.3-flash`，可改可换），用户名即模型名（唯一），只需再输入密码。
  登录也用模型名 + 密码（PBKDF2-SHA256 加盐哈希存储）
- **多会话**：侧栏顶部“新增会话”可选择模型；同一对账号可开多个独立会话。
  首次选择模型发消息也会自动创建会话。会话标题与模型名称无关，由服务端随机生成；
  点击标题旁编辑按钮或双击侧栏会话可修改自己看到的标题
- **群聊**：一个聊天里可以有多个人，所有人互发消息
- **伪装机制**：对外完全是一个 AI 网站——别人的消息 = 对应皮肤的"AI 输出"；
  自己的消息 = 用户气泡；对方打字时显示"思考中 · Ns"（秒数实时计数），
  消息到达后无缝切换为"已思考 N 秒" + 逐字打字机输出
- **思考伪装模式**：选“思考强度：最高”后，对方的新回复从第一个字符起在密文层
  逐字输出技术文稿，不先显示原文；鼠标移动到回复上可用圆孔查看原文。自己发出的
  消息只替换气泡内文字，长度按原文字符数截取，气泡位置与尺寸不变，悬停直接还原。
  已展示消息的标识按账号和会话保存在本机 localStorage，刷新时历史消息直接显示密文，
  不重放打字机，也不短暂显示原文。最高模式下，自己发出的图片（含附带文字）仅显示
  `[image]`，悬停后展开；对方图片默认由遮挡层盖住，只能用原位圆孔查看，不可点击
  弹出无遮挡原图。关闭模式可查看完整真实对话。不调用外部模型
- WebSocket 实时通信（RFC6455 标准库实现），断线自动重连并按 `after_ts`
  补拉错过的消息；侧栏 5 秒轮询
- **消息时间**：间隔超过 5 分钟的消息之间插入居中时间分割线（当天显示 HH:MM，
  跨天显示“昨天/M月D日”）；悬停任意气泡可看完整时间戳
- **消息通知**：侧栏会话项右侧的绿点表示有未读消息，打开会话后消失，
  按账号保存在本机；页签在后台时，新消息触发浏览器系统通知 + 标题未读计数，
  点击通知跳转对应聊天；正在查看的会话不重复弹窗，最高模式下通知不含原文；
  当前聊天之外的新消息经侧栏轮询探测（后台降为 15 秒一次）
- **图片消息（主站）**：浏览器把原图缩小并压成 WebP 后上传服务端（单张压缩后 ≤900 KB），
  服务端限制请求体 ≤1 MiB 并校验 WebP 格式及尺寸。图片文件存于 `data/images/`，
  消息记录只保存图片标识；图片下载需登录且只允许发送者或会话成员读取
- 数据落盘为 JSON（`data/data.json`，原子写入），重启不丢；每条消息带昵称快照

## 目录结构

```
chatnogpt/
├── main.go            入口：路由、多站点 Host 分发、内嵌静态资源、日志中间件
├── store.go           JSON 文件存储：用户/会话/成员/消息/图片索引（互斥锁 + 原子落盘）
├── auth.go            PBKDF2 密码哈希、token、邀请码/模型名生成
├── api.go             REST API（注册/登录/会话/消息）
├── ws.go              标准库实现的 WebSocket + 按会话广播的 hub
├── images.go          WebP 上传、校验与授权下载
├── main_test.go       单元测试 + 双用户 WebSocket 端到端测试
├── web/               主站前端（index.html / style.css / app.js）
├── sites/             五套皮肤前端（结构与 web/ 相同）
├── sites.example.json 域名映射模板；复制为 sites.json 放在二进制旁
├── tools/wsprobe/     WebSocket 调试客户端
├── deploy/            nginx 配置示例 + SSH/SFTP 部署辅助脚本
├── build.bat          Windows 构建
└── build-linux.sh     交叉编译 Linux 二进制
```

## 本地运行

需要 Go 1.21+（无需任何网络拉包，零依赖）。本地双账号测试、数据隔离和 Gitee PR 流程见 [CONTRIBUTING.md](CONTRIBUTING.md)；不需要线上数据库或 GLM 密钥：

```
go build -o chatnogpt.exe .
.\chatnogpt.exe
```

默认监听 `127.0.0.1:8080` 并自动打开浏览器。可用参数：

| 参数     | 默认值           | 说明                                        |
|----------|------------------|---------------------------------------------|
| `-addr`  | `127.0.0.1:8080` | 监听地址；局域网用 `0.0.0.0:8080`           |
| `-data`  | `data`           | 数据目录（data.json）                       |
| `-sites` | `sites.json`     | 域名映射文件；传空字符串禁用                |
| `-open`  | `true`           | 启动后自动打开浏览器                        |

## 使用方法

1. 双方各自注册（系统自动分配模型名，也可自己改一个；**这个名字就是对方
   眼里的"模型名"和你的登录名**）。
2. 在输入框左下角选择对方的模型 → 直接发消息 → 会话自动建立，
   对方侧栏自动出现这条聊天。
3. 对方打字时你看到"思考中 · Ns"；消息到达后显示"已思考 N 秒"并逐字输出。
   你发给对方的消息同理（你是对方的"模型"）。

## 测试

```
go test ./...
go vet ./...
```

测试使用临时数据目录，不读取线上或本地 `data/`。覆盖：密码哈希向量、注册/登录（模型名与旧字段两种方式）、模型名查重自动分配、
模型列表、会话自动创建与复用（conv-with）、每个成员的本地标题、
非成员越权访问（返回 404 不泄露会话存在性）、`/s/` 分享链接路由返回 SPA、
双用户 WebSocket 实时互发、typing 事件、消息历史与断线增量同步、非法 token 拒绝。

## 部署到 Linux 服务器

### 1. 编译并上传

```
bash build-linux.sh        # 或: GOOS=linux GOARCH=amd64 go build -o chatnogpt-linux .
scp chatnogpt-linux user@server:/opt/chatnogpt/chatnogpt
ssh user@server 'chmod +x /opt/chatnogpt/chatnogpt'
```

如需多站点域名映射，把 `sites.json` 放到二进制同目录（工作目录）下。

### 2. systemd 常驻

`/etc/systemd/system/chatnogpt.service`：

```ini
[Unit]
Description=ChatNoGPT
After=network.target

[Service]
WorkingDirectory=/opt/chatnogpt
ExecStart=/opt/chatnogpt/chatnogpt -addr 127.0.0.1:8080 -data /opt/chatnogpt/data -open=false
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```
sudo systemctl daemon-reload
sudo systemctl enable --now chatnogpt
```

前端内嵌在二进制里，Nginx 只需要反代到 `127.0.0.1:8080` 即可。

### 3. Nginx + 证书

`deploy/nginx-chatnogpt.example.conf` 是示例（含 WebSocket 升级头与长连接
超时，聊天与打字机必需）。复制为 `/etc/nginx/conf.d/chatnogpt.conf`，
替换域名后按文件头注释签发证书：

```
sudo certbot --nginx -d chat.example.com
sudo nginx -t && sudo systemctl reload nginx
```

每个皮肤站一个 vhost，反代到同一个后端端口即可。

## 已知取舍

- 存储是单文件 JSON + 互斥锁，适合朋友规模使用；量大后可换 SQLite/Postgres。
- WebSocket 的 token 走查询参数（`/ws?token=...`），会出现在 Nginx 访问日志里；
  更稳妥可以改成子协议头或 cookie。
- 退出登录只删除 token；已建立的 WebSocket 连接在断开前仍然有效。
- 侧栏新会话提醒是 5 秒轮询；typing 事件只在同一会话的 WebSocket 里可见。
- 没有管理后台（删号/撤回等需停服改 data.json），没有改昵称、删会话、
  Markdown 渲染——后续可加。图片文件需与 `data.json` 一起备份；五套皮肤目前只显示文本，尚未渲染图片附件。
- 无注册限流，公网部署如担心被刷可在 Nginx 加 `limit_req`。

## License

[MIT](LICENSE)。
