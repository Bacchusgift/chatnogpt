package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// cover.go —— 「思考伪装」语料池。
//
// 思考强度=最高时，前端把真实消息渐隐并覆盖为一段"AI 技术性话语"。
// 语料池来源优先级：
//  1. data/cover_pool.json（已缓存，重启复用）
//  2. GLM API 现场生成（GLM_API_KEY 环境变量存在时）
//  3. 内置语料（无网络/无 key 时的兜底，也能用）
//
// 覆盖文本按消息 id 在前端做确定性哈希取用，两端看到同一消息的覆盖文本
// 一致，无需为每条消息单独存储或同步。

const (
	glmDefaultModel   = "glm-4-flash"
	glmDefaultURL     = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
	glmClientTimeout  = 180 * time.Second // glm-4.6 等思考型模型生成长列表可能超过一分钟
	coverPoolTarget   = 40                // 向 GLM 请求的目标条数
	coverPoolMinValid = 10                // 少于这个数视为生成失败，回退内置
)

// builtinCoverLines —— 内置技术性话语（GLM 不可用时的兜底语料）。
var builtinCoverLines = []string{
	"先把这次变更的调用链梳理了一遍，核心路径上的锁粒度还有收窄空间，瓶颈应该不在热点数据结构上。",
	"缓存命中率是关键，冷启动阶段的回源压力需要在入口层做合并请求，否则穿透量会把下游打满。",
	"这段逻辑的时间复杂度看起来是 O(n log n)，瓶颈其实出在重复的序列化上，改成流式处理能省掉一次全量拷贝。",
	"幂等性没保证的话，重试风暴会把状态机推到不可恢复的分支，建议给写入路径加请求指纹去重。",
	"连接池的回收策略偏激进，长尾请求容易被掐断，把空闲超时放宽到秒级再看 P99。",
	"这个方案的分片键选得不理想，热点集中在一个维度上，写入倾斜会在高峰期放大排队延迟。",
	"异步任务的重试要有退避，指数退避加抖动是标准做法，不然同一时刻的重试会形成波峰。",
	"内存曲线在GC后回落得很慢，像是有一批对象被闭包引用住了，先抓一份堆快照对比两代之间的差集。",
	"接口的响应结构里冗余字段偏多，移动端的解析开销不可忽略，裁剪到只保留渲染必需的字段。",
	"从可靠性角度讲，这里应该显式处理部分失败的语义，要么全部回滚，要么把成功子集持久化并记录偏移量。",
	"限流阈值是按容量推算的，压测数据才是准绳，先跑一轮阶梯压测找到拐点再定参数。",
	"日志里这条堆栈的调用顺序有讲究，异常是从内层包装出来的，根因在更底层的超时设置。",
	"版本兼容这块要留意灰度期的双写窗口，schema 变更必须向后兼容一个发布周期。",
	"这里的并发模型选得对，但背压没传导到入口，队列一旦堆积就只剩超时兜底了。",
	"索引选择性不高，优化器可能走了全表扫描，加一个覆盖索引把回表消掉试试。",
	"签名校验和重放窗口要一起看，时间戳偏移量放得太宽等于没有防重放。",
	"这个 watch 机制在抖动场景下会惊群，加一层随机延迟让回调错峰触发。",
	"把配置热更新做成快照替换，读路径无锁，写路径单线程提交，语义最干净。",
	"慢查询都集中在同一个聚合操作上，预聚合表比实时计算划算，代价是多一条同步链路。",
	"这层的抽象有点过度，两个实现类的差异只剩构造参数，合并成策略表更直观。",
	"优雅停机的关键是先摘流量再等存量请求排空，超时上限要小于探活失败阈值。",
	"这里的状态同步用事件溯源更稳，重放即可恢复任意时刻的视图，代价是存储翻倍。",
	"TLS 握手延迟主要在证书链验证，会话复用和 OCSP 装订能把这个时间压下去大半。",
	"灰度策略按地域切不如按用户特征切，特征选择要保证组间分布足够接近。",
	"这段正则的回溯风险不小，恶意输入能把它拖成指数级，换成有限状态机的写法更安全。",
	"消息序号用单调递增的足够，乱序场景靠客户端缓冲区重排，别在服务端维护复杂窗口。",
	"压测时观察队列深度比观察 CPU 更有意义，堆积是容量告警的先行指标。",
	"数据迁移要双写校验一段时间，逐批比对哈希，确认无误再切读流量。",
	"冷热分离的阈值不该拍脑袋，按访问频率的分位数定，并且要留运行时调整的开关。",
	"这里的降级开关粒度太粗，一降全降，按依赖分成三档可以保住核心路径。",
	"重放日志的压缩格式选列式更省，分析型查询基本只碰少数几列。",
	"租户隔离做到连接级就够了吗，这个规模下更应该考虑 schema 级的硬隔离。",
	"对外暴露的健康检查端口要和内部指标分开，避免探活流量干扰采样。",
	"重试预算的思路值得借鉴，超过预算直接快速失败，防止雪崩扩散到上游。",
	"这批告警的根因是同一个，告警聚合按指纹聚类能少掉百分之八十的噪音。",
	"幂等键的过期窗口要大于最大重试间隔，否则两次重试会被当成两个请求。",
	"这个函数的副作用藏在返回值后面，调用方很容易漏掉错误分支，改成显式返回 error 更稳。",
	"预热的时机要卡在流量切进来之前，首日冷启动的那波超时基本都源于此。",
	"双缓冲在这里是必要的，直接切换会让正在读取的一侧看到半成品状态。",
	"把重逻辑从请求路径挪到后台队列，入口只做校验和入队，延迟立刻降一个数量级。",
	"这个协议的字段对齐方式有坑，跨语言解析要显式声明字节序，别依赖默认行为。",
	"埋点的采样率要分层，核心链路全量，边缘交互按比例，存储成本才可控。",
	"熔断器的半开探测间隔偏长，恢复感知慢，先调到秒级观察探针成功率。",
	"这里的序列化协议升级空间不大了，字段编号已经用掉大半，下一版要留迁移期。",
	"竞争窗口很窄但确实存在，原子操作加版本号能把这个撕裂读问题消掉。",
	"读扩散还是写扩散的选择取决于读放大倍数，这个场景的读写比明显偏向读扩散。",
	"符号表查询在这个热点路径上被调用了百万次，加个一级缓存就能把哈希开销摊平。",
	"这条链路的超时预算分配不合理，下游占了大头，入口反而没有剩余预算。",
	"把幂繁操作合并成批处理接口，网络往返次数是这里最大的隐藏成本。",
	"特征开关的清理要及时，长期积累的死分支会让测试矩阵失去意义。",
}

type coverStore struct {
	mu    sync.Mutex
	path  string
	lines []string
	src   string
}

// initCoverPool 加载/生成语料池。失败回退内置语料；GLM 生成异步进行，
// 服务先用内置语料立即上线，成功后热替换。
func initCoverPool(dataDir string) *coverStore {
	cs := &coverStore{path: filepath.Join(dataDir, "cover_pool.json")}
	if loadCoverPoolFile(cs) {
		return cs
	}
	cs.lines = append([]string(nil), builtinCoverLines...)
	cs.src = "builtin"
	saveCoverPoolFile(cs)
	if key := strings.TrimSpace(os.Getenv("GLM_API_KEY")); key != "" {
		log.Printf("cover pool: generating via GLM (%s) in background...", glmModel())
		go func() {
			lines, err := generateCoverViaGLM(key)
			if err != nil {
				log.Printf("cover pool: GLM generation failed, keep builtin: %v", err)
				return
			}
			cs.setLines(lines, "glm")
			saveCoverPoolFile(cs)
		}()
	}
	return cs
}

func glmModel() string {
	if m := strings.TrimSpace(os.Getenv("GLM_MODEL")); m != "" {
		return m
	}
	return glmDefaultModel
}

func glmURL() string {
	if u := strings.TrimSpace(os.Getenv("GLM_BASE_URL")); u != "" {
		return u
	}
	return glmDefaultURL
}

func loadCoverPoolFile(cs *coverStore) bool {
	raw, err := os.ReadFile(cs.path)
	if err != nil {
		return false
	}
	var d struct {
		Source string   `json:"source"`
		Lines  []string `json:"lines"`
	}
	if json.Unmarshal(raw, &d) != nil || len(d.Lines) < coverPoolMinValid {
		return false
	}
	cs.lines = d.Lines
	cs.src = d.Source
	log.Printf("cover pool: loaded %d line(s) from %s (source=%s)", len(cs.lines), cs.path, cs.src)
	return true
}

func saveCoverPoolFile(cs *coverStore) {
	if cs.path == "" {
		return
	}
	raw, _ := json.Marshal(map[string]any{"source": cs.src, "lines": cs.lines, "saved_at": time.Now().Unix()})
	tmp := cs.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		log.Printf("cover pool: save failed: %v", err)
		return
	}
	if err := os.Rename(tmp, cs.path); err != nil {
		log.Printf("cover pool: save failed: %v", err)
		return
	}
	log.Printf("cover pool: saved %d line(s) (source=%s)", len(cs.lines), cs.src)
}

func (c *coverStore) Lines() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.lines...)
}

// setLines 热替换语料池（GLM 异步生成完成后调用）。
func (c *coverStore) setLines(lines []string, src string) {
	c.mu.Lock()
	c.lines = lines
	c.src = src
	c.mu.Unlock()
	log.Printf("cover pool: switched to %d GLM line(s)", len(lines))
}

// generateCoverViaGLM 调 GLM chat/completions 批量生成技术性话语，返回净化后的列表。
func generateCoverViaGLM(key string) ([]string, error) {
	prompt := fmt.Sprintf(
		"你是一名资深软件工程师，正在对一段代码做内部技术评审。请生成 %d 条彼此话题不同的技术性独白短段，"+
			"主题在以下方向中轮换：系统架构、缓存策略、并发与锁、数据库索引、网络协议、性能剖析、测试策略、"+
			"发布与灰度、可观测性、安全加固、数据迁移、算法复杂度。"+
			"每条 80 到 150 个汉字，由 2 到 3 句连贯的话组成，有具体的工程细节和取舍分析，"+
			"语气是工作笔记式的自然思考，不要称呼任何人，不要引用任何对话内容，不要出现「用户」「你」「我」等人称，不要markdown格式。"+
			"只输出一个 JSON 数组，数组元素是字符串，不要输出任何其他文字。", coverPoolTarget)

	reqBody, _ := json.Marshal(map[string]any{
		"model": glmModel(),
		"messages": []map[string]string{
			{"role": "system", "content": "你是一个严格的 JSON 生成器，只输出合法 JSON。"},
			{"role": "user", "content": prompt},
		},
		"temperature": 1.0,
		"max_tokens":  8192,
		// 列表生成不需要推理链，关闭思考可把耗时从分钟级压到秒级
		"thinking": map[string]string{"type": "disabled"},
	})
	req, err := http.NewRequest(http.MethodPost, glmURL(), strings.NewReader(string(reqBody)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)

	client := &http.Client{Timeout: glmClientTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("glm http %d: %s", resp.StatusCode, truncateStr(string(raw), 200))
	}
	var gr struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &gr); err != nil {
		return nil, err
	}
	if len(gr.Choices) == 0 {
		return nil, fmt.Errorf("glm empty choices")
	}
	return parseCoverLines(gr.Choices[0].Message.Content)
}

// parseCoverLines 从模型输出里稳健地提取字符串数组。
func parseCoverLines(content string) ([]string, error) {
	start := strings.Index(content, "[")
	end := strings.LastIndex(content, "]")
	if start < 0 || end <= start {
		return nil, fmt.Errorf("no json array in glm output")
	}
	var arr []string
	if err := json.Unmarshal([]byte(content[start:end+1]), &arr); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(arr))
	for _, s := range arr {
		s = strings.TrimSpace(s)
		s = strings.Trim(s, "\"'` \t。")
		if utf8.RuneCountInString(s) < 40 || utf8.RuneCountInString(s) > 260 {
			continue
		}
		if seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	if len(out) < coverPoolMinValid {
		return nil, fmt.Errorf("glm produced only %d valid lines", len(out))
	}
	// 轻度洗牌，避免每次生成的顺序感
	rnd := rand.New(rand.NewSource(time.Now().UnixNano()))
	rnd.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	sortStringsStable(out)
	return out, nil
}

func sortStringsStable(s []string) { sort.Strings(s) }

func truncateStr(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
