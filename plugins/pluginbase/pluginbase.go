// Package pluginbase 定义基座与插件之间的契约：插件自描述（Meta）+ 自挂载（Mount），
// 经 Register 进入注册表。基座不感知任何具体插件：目录、脚本注入、详情页、对话模式
// 全部由 Meta 派生。新增插件 = 实现接口 + 在 main.go 调用一次 Register。
package pluginbase

import (
	"context"
	"net/http"
	"sync"
)

// DetailItem 插件详情页内容项。Type: "step"（编号步骤）| "note"（浅色说明）。
type DetailItem struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// RoomMode 插件贡献的群聊对话模式（创建房间时可选）。
type RoomMode struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// Meta 插件自描述清单，驱动基座的目录页、脚本注入与对话模式选择。
type Meta struct {
	Name      string       `json:"name"`                 // 全局唯一，用于启停与门禁
	Title     string       `json:"title"`                // 展示名
	Desc      string       `json:"desc"`                 // 一句话描述
	Icon      string       `json:"icon,omitempty"`       // emoji 图标
	Script    string       `json:"script,omitempty"`     // 前端脚本 URL（含 ?v= 版本号，由插件自行维护）
	Download  string       `json:"download,omitempty"`   // 可选附件下载 URL（如浏览器扩展包）
	Detail    []DetailItem `json:"detail,omitempty"`     // 插件详情页内容（服务端下发）
	RoomModes []RoomMode   `json:"room_modes,omitempty"` // 贡献的对话模式（文档性；前端以运行时注册为准）
}

// Gate 基座门禁：已完成鉴权与按用户启用检查的处理器包装。
type Gate func(http.HandlerFunc) http.HandlerFunc

// Plugin 插件契约。Mount 内自行挂载 API 路由与前端脚本路由（均可套 gate）。
type Plugin interface {
	Meta() Meta
	Mount(mux *http.ServeMux, gate Gate)
}

var (
	mu  sync.Mutex
	all []Plugin
)

// Register 登记插件（同名替换：实例绑定各自配置，重复 Register 以最新为准）。
func Register(p Plugin) {
	mu.Lock()
	defer mu.Unlock()
	for i, existing := range all {
		if existing.Meta().Name == p.Meta().Name {
			all[i] = p
			return
		}
	}
	all = append(all, p)
}

// All 返回全部已登记插件（切片副本）。
func All() []Plugin {
	mu.Lock()
	defer mu.Unlock()
	out := make([]Plugin, len(all))
	copy(out, all)
	return out
}

// ---- 统一身份上下文：门禁注入调用者，插件经 UserIDFrom 读取 ----

type ctxKey struct{}

// WithUser 由基座门禁注入调用者身份（各插件包的同名函数均为本函数的薄封装）。
func WithUser(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, ctxKey{}, userID)
}

// UserIDFrom 读取门禁注入的调用者身份。
func UserIDFrom(ctx context.Context) string {
	v, _ := ctx.Value(ctxKey{}).(string)
	return v
}
