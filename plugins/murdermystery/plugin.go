// Package murdermystery 提供剧本杀组局的基础入口。
package murdermystery

import (
	"chatnogpt/plugins/pluginbase"
	_ "embed"
	"net/http"
)

const (
	Name       = "murder-mystery"
	FrontendJS = "/plugins/murder-mystery/murder-mystery.js?v=1.0.0"
)

type Plugin struct{}

func New() *Plugin { return &Plugin{} }

func (p *Plugin) Meta() pluginbase.Meta {
	return pluginbase.Meta{
		Name: Name, Title: "剧本杀组局", Icon: "🎭",
		Desc:      "创建剧本杀群聊并邀请成员组局",
		Script:    FrontendJS,
		RoomModes: []pluginbase.RoomMode{{ID: Name, Label: "剧本杀组局"}},
		Detail: []pluginbase.DetailItem{
			{Type: "step", Text: "在插件页启用剧本杀组局。"},
			{Type: "step", Text: "新增会话并创建群聊，邀请成员并选择剧本杀组局模式。"},
			{Type: "step", Text: "创建后群聊中会发送组局消息，成员可继续在群内商量剧本和时间。"},
			{Type: "note", Text: "当前支持发起组局；剧本、角色和游戏流程将在后续完善。"},
		},
	}
}

//go:embed web/murder-mystery.js
var frontendJS string

func (p *Plugin) Mount(mux *http.ServeMux, _ pluginbase.Gate) {
	mux.HandleFunc("/plugins/murder-mystery/murder-mystery.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=300")
		_, _ = w.Write([]byte(frontendJS))
	})
}
