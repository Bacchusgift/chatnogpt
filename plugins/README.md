# 插件开发规范

ChatNoGPT 的插件体系：基座只提供 hook 点与契约，插件自描述、自挂载。
**新增一个插件 = 实现接口 + 在 `main.go` 调用一次 `pluginbase.Register(...)`，基座其余文件零改动。**

## 目录结构

```
plugins/
  pluginbase/        # 契约包：Plugin 接口、Meta、注册表、统一身份上下文
  novelreader/       # 示例：小说阅读（API + go:embed 前端 + 扩展分发）
    plugin.go
    web/novel.js
  turtlesoup/        # 示例：海龟汤（故事本存储 + 游戏逻辑 + 前端）
    plugin.go
    seeds.go
    web/soup.js
    soup_test.go
  README.md
```

## 后端契约

实现 `pluginbase.Plugin` 接口并在 `main.go` 注册一次：

```go
type Plugin interface {
    Meta() Meta
    Mount(mux *http.ServeMux, gate Gate)
}
```

- **`Meta()`** 自描述清单，基座据此派生一切：
  - `Name` 全局唯一，用于启停（`users.disabled_plugins`）与门禁
  - `Title / Desc / Icon` 插件目录页展示
  - `Script` 前端脚本 URL（含 `?v=` 版本号，插件自行维护缓存版本）
  - `Download` 可选附件（如浏览器扩展包），详情页出现下载按钮
  - `Detail` 详情页内容项：`{"type":"step","text":...}` 编号步骤 / `{"type":"note","text":...}` 说明
  - `RoomModes` 贡献的群聊对话模式（创建房间时可选，文档性；运行时前端注册见下）
- **`Mount(mux, gate)`** 自挂载 API 与前端脚本路由，全部套 `gate`（基座已完成鉴权 +
  按用户启用检查，未启用统一 403）。用户身份经 `pluginbase.WithUser / UserIDFrom`
  注入读取。
- **存储**：DB 模式插件可用 `Config.DB`（基座同一数据库句柄）建自有表（表名加插件前缀，
  `CREATE TABLE IF NOT EXISTS` + 容错迁移）；文件模式用 `Config.Dir` 下自有 JSON。
- **注册**：`pluginbase.Register(impl)` 同名替换（以最新实例为准）。

## 前端契约

插件脚本是普通 `<script>`（非模块）。**插件只依赖 `window.CNGP` 门面**（稳定契约，
基座内部重构不影响插件），脚本自注册（IIFE + 顶层守卫 `window.__<name>Loaded`），
**禁止直接读写基座内部（state / 内部函数 / DOM 结构约定）与 monkey-patch**。

### CNGP 门面 API

| 成员 | 说明 |
|---|---|
| `CNGP.api(path, opts)` | 带鉴权的 HTTP 调用 |
| `CNGP.send(text)` | 向当前会话发消息（走正常通道，伪装一致；视图不在会话时自动 REST 兜底） |
| `CNGP.toast(msg)` | 轻提示 |
| `CNGP.confirm({title, body, okText, danger, onOk})` | 样式化确认弹窗 |
| `CNGP.context()` | 当前上下文只读快照 `{me, conv, coverMode}` |
| `CNGP.secureBlock(text, {tag, key, className})` | 伪装块：跟随思考伪装开关的密文覆盖行（悬停透视），秘密内容专用，**不得明文** |
| `CNGP.on(name, fn)` | 订阅 hook 事件（见下表） |
| `CNGP.roomMode({id, label})` | 贡献群聊对话模式 |
| `CNGP.drawer.setPanel({title, render(el, ctx)})` | 右侧抽屉面板：当前会话命中时头部出现切换按钮、抽屉自动展开；面板刷新经 `CNGP.drawer.refresh()`；用户可收起（收起的会话内不再自动展开） |

### Hook 事件（经 `CNGP.on` 订阅）

| 事件 | detail | 说明 |
|---|---|---|
| `conv-opened` | `{id, conv}` | 会话打开/切换并渲染完成 |
| `message-actions` | `{row, actions, content}` | 他人消息操作条渲染完成，可追加按钮 |
| `room-created` | `{conv, mode}` | 群聊室创建完成（带所选对话模式） |
| `plugins-loaded` | 无 | 全部启用插件脚本注入完成 |
| `window.cngpRoomModes` | 数组 | 插件加载时 push `{id, label}` 贡献对话模式 |

示例（soup.js 摘录）：

```js
(window.cngpRoomModes = window.cngpRoomModes || []).push({ id: 'turtle-soup', label: '海龟汤' });
window.addEventListener('cngp:conv-opened', e => tsOnConv(e.detail.id));
window.addEventListener('cngp:message-actions', e => tsAugmentActions(e.detail.row));
window.addEventListener('cngp:room-created', e => { /* mode 匹配后开局 */ });
```

## 必须遵守的规则

1. **伪装一致**：插件发出的消息必须走正常消息通道（`doSend` / `/send`），不得绕过
   密文打字机、圆孔透视、通知伪装。插件 UI 里的秘密（谜底等）即使仅特定角色可见，
   也**必须以伪装形态呈现**——复用基座覆盖行原语（`makeCoverLayer` / `coverTextInto`
   / `bindFlashlight` + `.covered`），不得明文展示（例：海龟汤谜底仅主持人可见，
   依然以密文 + 悬停透视渲染）。
2. **隐私边界**：插件不得缓存消息内容到 localStorage / Service Worker；谜底等秘密
   只能存在服务端，按归属下发。
3. **缓存版本化**：脚本 URL 必须带 `?v=x.y.z`，内容变更时插件自行 bump。
4. **基座零改动**：除 `main.go` 的 Register 一行外，不允许为任何插件修改基座文件；
   需要新 hook 时先在基座实现通用事件，再供所有插件使用。
5. **门禁一致**：所有 API 路由必须套 gate；未启用插件的请求一律 403。
6. **测试**：插件包自带单测（HTTP 流程 + 存储生命周期 + 越权路径）；上线前跑全量
   `go test ./...`（文件 + 数据库双后端）与对应浏览器冒烟脚本。
