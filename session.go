package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	pairCodeTTL   = 5 * time.Minute
	joinTTL       = 30 * time.Second
	connectTTL    = 25 * time.Second
	unpairedTTL   = 5 * time.Minute
	failedRoomTTL = 10 * time.Minute
	pairedTTL     = 24 * time.Hour
)

type request struct {
	RequestID string          `json:"requestId"`
	Type      string          `json:"type"`
	Token     string          `json:"token"`
	Code      string          `json:"code"`
	Epoch     int             `json:"epoch"`
	Key       string          `json:"key"`
	Data      json.RawMessage `json:"data"`
}

type response struct {
	RequestID      string          `json:"requestId,omitempty"`
	Type           string          `json:"type"`
	Code           string          `json:"code,omitempty"`
	Token          string          `json:"token,omitempty"`
	ExpiresAt      int64           `json:"expiresAt,omitempty"`
	Epoch          int             `json:"epoch,omitempty"`
	Mode           string          `json:"mode,omitempty"`
	Initiator      bool            `json:"initiator"`
	ICEServers     []iceServer     `json:"iceServers,omitempty"`
	Remaining      int64           `json:"remaining"`
	Authorized     bool            `json:"authorized"`
	RelayAvailable bool            `json:"relayAvailable"`
	KeyAvailable   bool            `json:"keyAvailable"`
	Message        string          `json:"message,omitempty"`
	Reason         string          `json:"reason,omitempty"`
	Data           json.RawMessage `json:"data,omitempty"`
}

type sessionClient struct {
	unboundAt time.Time
	source    string
	out       chan response
	conn      *websocket.Conn
	room      *room
	token     string
	ready     bool
}

func (c *sessionClient) send(event response) {
	select {
	case c.out <- event:
	default:
		if c.conn != nil {
			_ = c.conn.Close()
		}
	}
}

func (c *sessionClient) problem(reason, message string) {
	c.send(response{Type: "error", Reason: reason, Message: message})
}

type room struct {
	sessionUntil, failedUntil           time.Time
	requestID                           string
	code                                string
	host, guest                         *sessionClient
	expires, pendingUntil, connectUntil time.Time
	locked                              bool
	epoch                               int
	mode                                string
	failed                              bool
	account                             relayAccount
	grant                               *relayGrant
	authorized                          bool
	keyGeneration                       uint64
	remaining                           int64
}

func (r *room) peer(client *sessionClient) *sessionClient {
	if client == r.host {
		return r.guest
	}
	return r.host
}

func (r *room) notify(event response) {
	r.host.send(event)
	if r.guest != nil {
		r.guest.send(event)
	}
}

type rateKey struct {
	source, action string
}

type rateWindow struct {
	until time.Time
	count int
}

type hub struct {
	clients            map[*sessionClient]struct{}
	mu                 sync.Mutex
	pending            map[string]*room
	rooms              map[*room]struct{}
	windows            map[rateKey]rateWindow
	connections        map[string]int
	totalConnections   int
	stunURLs, turnURLs []string
	router             *relayRouter
	hasKey             bool
	keyHash            [32]byte
	keyGeneration      uint64
	failures           map[string]uint64
}

func newHub(router *relayRouter, stunURLs, turnURLs []string, key string) *hub {
	return &hub{
		pending: make(map[string]*room), rooms: make(map[*room]struct{}), clients: make(map[*sessionClient]struct{}),
		windows: make(map[rateKey]rateWindow), connections: make(map[string]int),
		router: router, stunURLs: stunURLs, turnURLs: turnURLs,
		hasKey: key != "", keyHash: sha256.Sum256([]byte(key)), failures: make(map[string]uint64),
	}
}

func (h *hub) allowed(c *sessionClient, action string, maxCount int, now time.Time) bool {
	key := rateKey{source: c.source, action: action}
	window := h.windows[key]
	if !now.Before(window.until) {
		window = rateWindow{until: now.Add(time.Minute)}
	}
	if window.count >= maxCount || (window.count == 0 && len(h.windows) >= 16384) {
		c.problem("rate_limit", "尝试次数过多，请稍后再试。")
		return false
	}
	window.count++
	h.windows[key] = window
	return true
}

func (h *hub) handle(c *sessionClient, input request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now()

	if r := c.room; r != nil {
		h.expireRoom(r, now)
	}
	switch input.Type {
	case "create", "join":
		if c.room != nil {
			c.problem("already_joined", "请先退出当前配对。")
			return
		}
		if !h.allowed(c, input.Type, 10, now) {
			return
		}
		if input.Type == "create" {
			h.create(c, input.Code, now)
		} else {
			h.join(c, input.Code, now)
		}
		return
	}

	r := c.room
	if r == nil || subtle.ConstantTimeCompare([]byte(c.token), []byte(input.Token)) != 1 {
		c.problem("invalid_session", "配对已失效，请重新创建或加入。")
		return
	}

	if input.Type == "leave" {
		h.detachLocked(c)
		return
	}
	if !r.locked {
		if c == r.host && r.guest != nil {
			if (input.Type == "accept" || input.Type == "reject") && input.RequestID != r.requestID {
				c.problem("stale_request", "加入请求已变化，请重新确认。")
				return
			}
			switch input.Type {
			case "accept":
				r.locked = true
				r.sessionUntil = now.Add(pairedTTL)
				delete(h.pending, r.code)
				h.start(r, "direct", [2]iceServer{}, now)
				return
			case "reject":
				h.reject(r, "对方拒绝了加入请求。")
				return
			}
		}
		c.problem("awaiting_pair", "请等待对方确认配对。")
		return
	}

	if !r.failed && !(r.host.ready && r.guest.ready) && !now.Before(r.connectUntil) {
		h.fail(r, h.failureReason(r))
	}
	switch input.Type {
	case "signal":
		if !r.failed && input.Epoch == r.epoch && validSignal(input.Data, c == r.host) {
			r.peer(c).send(response{Type: "signal", Epoch: r.epoch, Data: input.Data})
		}
	case "ready":
		if input.Epoch == r.epoch && !r.failed {
			c.ready = true
		}
	case "failed":
		if input.Epoch == r.epoch && !r.failed {
			h.fail(r, h.failureReason(r))
		}
	case "retry":
		if c != r.host || !r.failed {
			c.problem("can_not_retry", "连接失败后可由发起方重试直连。")
			return
		}
		h.start(r, "direct", [2]iceServer{}, now)
	case "relay":
		h.startRelay(c, r, input.Key, now)
	default:
		c.problem("invalid_action", "无法识别此操作。")
	}
}

func validSignal(data json.RawMessage, host bool) bool {
	var signal struct {
		Type      string  `json:"type"`
		SDP       string  `json:"sdp"`
		Candidate *string `json:"candidate"`
	}
	if len(data) > 32*1024 || json.Unmarshal(data, &signal) != nil {
		return false
	}
	if signal.Type == "" && signal.Candidate != nil {
		return len(*signal.Candidate) <= 2048
	}
	return signal.SDP != "" && ((host && signal.Type == "offer") || (!host && signal.Type == "answer"))
}

func validCode(code string) bool {
	if len(code) != 4 {
		return false
	}
	for _, digit := range code {
		if digit < '0' || digit > '9' {
			return false
		}
	}
	return true
}

func (h *hub) create(c *sessionClient, code string, now time.Time) {
	if code != "" && !validCode(code) {
		c.problem("invalid_code", "请输入 4 位数字配对码。")
		return
	}
	if code == "" {
		for tries := 0; tries < 32; tries++ {
			candidate, err := randomCode()
			if err != nil {
				break
			}
			if existing := h.pending[candidate]; existing != nil {
				h.expirePending(existing, now)
			}
			if h.pending[candidate] == nil {
				code = candidate
				break
			}
		}
	}
	if code == "" {
		c.problem("unavailable", "暂时无法创建配对码，请重试。")
		return
	}
	if existing := h.pending[code]; existing != nil {
		h.expirePending(existing, now)
	}
	if h.pending[code] != nil {
		c.problem("code_taken", "该配对码正在使用，请换一个。")
		return
	}
	if !bindToken(c) {
		return
	}
	r := &room{code: code, host: c, expires: now.Add(pairCodeTTL), account: relayAccount{limit: freeRelayBytes}}
	c.room = r
	h.pending[code] = r
	h.rooms[r] = struct{}{}
	c.send(response{Type: "created", Code: code, Token: c.token, ExpiresAt: r.expires.UnixMilli()})
}

func (h *hub) join(c *sessionClient, code string, now time.Time) {
	if !validCode(code) {
		c.problem("invalid_code", "请输入 4 位数字配对码。")
		return
	}
	if existing := h.pending[code]; existing != nil {
		h.expirePending(existing, now)
	}
	r := h.pending[code]
	if r == nil || r.guest != nil {
		c.problem("code_unavailable", "无法加入，请确认配对码并重试。")
		return
	}
	if !bindToken(c) {
		return
	}
	id, err := randomToken()
	if err != nil {
		c.token = ""
		c.problem("unavailable", "暂时无法建立配对，请重试。")
		return
	}
	c.room = r
	r.guest = c
	r.requestID = id
	r.pendingUntil = now.Add(joinTTL)
	c.send(response{Type: "joined", Token: c.token})
	r.host.send(response{Type: "request", RequestID: id})
}

func bindToken(c *sessionClient) bool {
	token, err := randomToken()
	if err != nil {
		c.problem("unavailable", "暂时无法建立配对，请重试。")
		return false
	}
	c.token = token
	return true
}

func (h *hub) reject(r *room, message string) {
	r.guest.send(response{Type: "closed", Message: message})
	unbind(r.guest)
	r.guest = nil
	r.host.send(response{Type: "waiting"})
}

func (h *hub) expirePending(r *room, now time.Time) {
	if r.locked {
		return
	}
	if !now.Before(r.expires) {
		h.closeRoom(r, "配对码已过期，请重新创建。")
	} else if r.guest != nil && !now.Before(r.pendingUntil) {
		h.reject(r, "加入请求已超时，请重新输入配对码。")
	}
}

func (h *hub) expireRoom(r *room, now time.Time) {
	if !r.locked {
		h.expirePending(r, now)
	} else if !now.Before(r.sessionUntil) || (r.failed && !now.Before(r.failedUntil)) {
		h.closeRoom(r, "配对会话已过期，请重新配对。")
	}
}

func unbind(c *sessionClient) {
	c.room, c.token, c.unboundAt = nil, "", time.Now()
}

func (h *hub) closeRoom(r *room, message string) {
	if r.grant != nil {
		h.router.revoke(r.grant)
	}
	if h.pending[r.code] == r {
		delete(h.pending, r.code)
	}
	delete(h.rooms, r)
	r.notify(response{Type: "closed", Message: message})
	unbind(r.host)
	if r.guest != nil {
		unbind(r.guest)
	}
}

func (h *hub) detach(c *sessionClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.detachLocked(c)
	delete(h.clients, c)
}

func (h *hub) detachLocked(c *sessionClient) {
	if r := c.room; r != nil {
		if c == r.guest && !r.locked {
			h.reject(r, "已退出加入请求。")
		} else {
			h.closeRoom(r, "设备已退出配对。")
		}
	}
}

func (h *hub) start(r *room, mode string, servers [2]iceServer, now time.Time) {
	if mode == "direct" && r.grant != nil {
		h.router.revoke(r.grant)
		r.grant = nil
	}
	r.epoch++
	r.mode, r.failed = mode, false
	r.host.ready, r.guest.ready = false, false
	r.connectUntil = now.Add(connectTTL)
	for i, c := range []*sessionClient{r.host, r.guest} {
		config := []iceServer{{URLs: h.stunURLs}}
		if len(h.stunURLs) == 0 {
			config = []iceServer{}
		}
		if mode == "relay" {
			config = []iceServer{servers[i]}
		}
		c.send(response{Type: "start", Epoch: r.epoch, Mode: mode, Initiator: i == 0,
			ICEServers: config, Authorized: r.authorized, Remaining: r.remaining})
	}
}

func (h *hub) startRelay(c *sessionClient, r *room, key string, now time.Time) {
	upgrading := r.mode == "relay" && !r.authorized && key != ""
	if c != r.host || (!r.failed && !upgrading) {
		c.problem("relay_requires_confirmation", "直连失败后可由发起方确认加密中继。")
		return
	}
	if h.router == nil || len(h.turnURLs) == 0 {
		c.problem("relay_unavailable", "当前站点未启用加密中继。")
		return
	}
	authorized := r.authorized && r.keyGeneration == h.keyGeneration
	if key != "" {
		if !h.allowed(c, "key", 6, now) {
			return
		}
		hash := sha256.Sum256([]byte(key))
		if len(key) > 512 || !h.hasKey || subtle.ConstantTimeCompare(hash[:], h.keyHash[:]) != 1 {
			c.problem("invalid_key", "中继密钥不正确。")
			return
		}
		authorized = true
	}
	remaining, reason := h.router.status(&r.account, nil, authorized)
	if reason != "" {
		c.problem(reason, failureMessage(reason))
		return
	}
	grant, servers, err := h.router.issue(&r.account, authorized, h.turnURLs)
	if err != nil {
		c.problem("relay_unavailable", "中继暂时不可用，请重试。")
		return
	}
	h.router.revoke(r.grant)
	r.grant, r.authorized, r.remaining = grant, authorized, remaining
	r.keyGeneration = h.keyGeneration
	h.start(r, "relay", servers, now)
}

func failureMessage(reason string) string {
	switch reason {
	case "session_quota":
		return "免密中继额度已用完。可由发起方输入密钥后重试。"
	case "global_quota":
		return "当前可用的每日中继额度已用完。"
	case "ledger_unavailable":
		return "中继流量账本暂不可用，请稍后重试或联系管理员。"
	case "relay_expired":
		return "本次中继授权已过期，请重新连接。"
	default:
		return "未能连接两台设备。"
	}
}

func (h *hub) failureReason(r *room) string {
	if r.grant != nil {
		if _, reason := h.router.status(&r.account, r.grant, r.authorized); reason != "" {
			return reason
		}
	}
	return "connection_failed"
}

func (h *hub) fail(r *room, reason string) {
	h.failures[reason]++
	r.failed = true
	r.failedUntil = time.Now().Add(failedRoomTTL)
	if r.grant != nil {
		h.router.revoke(r.grant)
		r.grant = nil
	}
	r.notify(response{Type: "failed", Epoch: r.epoch, Mode: r.mode, Message: failureMessage(reason), Reason: reason})
}

func (h *hub) tick(now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for key, window := range h.windows {
		if !now.Before(window.until) {
			delete(h.windows, key)
		}
	}
	for client := range h.clients {
		if client.room == nil && !now.Before(client.unboundAt.Add(unpairedTTL)) {
			_ = client.conn.Close()
		}
	}
	for r := range h.rooms {
		h.expireRoom(r, now)
		if r.host.room != r || !r.locked || r.failed {
			continue
		}
		if r.grant != nil {
			remaining, reason := h.router.status(&r.account, r.grant, r.authorized)
			if reason != "" {
				h.fail(r, reason)
				continue
			}
			if remaining != r.remaining {
				r.remaining = remaining
				r.notify(response{Type: "balance", Remaining: remaining, Authorized: r.authorized})
			}
		}
		if !(r.host.ready && r.guest.ready) && !now.Before(r.connectUntil) {
			h.fail(r, "connection_failed")
		}
	}
}

func sourceKey(remote string) string {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		return remote
	}
	ip := net.ParseIP(host)
	if ip != nil && ip.To4() == nil {
		return ip.Mask(net.CIDRMask(64, 128)).String()
	}
	return host
}

func (h *hub) serveSocket(origin string) http.HandlerFunc {
	upgrader := websocket.Upgrader{
		ReadBufferSize: 4096, WriteBufferSize: 4096,
		CheckOrigin: func(r *http.Request) bool {
			scheme := "http"
			if r.TLS != nil {
				scheme = "https"
			}
			expected := origin
			if expected == "" {
				expected = scheme + "://" + r.Host
			}
			return r.Header.Get("Origin") == expected
		},
	}
	return func(w http.ResponseWriter, r *http.Request) {
		source := sourceKey(r.RemoteAddr)
		h.mu.Lock()
		if h.totalConnections >= 1024 || h.connections[source] >= 32 {
			h.mu.Unlock()
			http.Error(w, "too many connections", http.StatusTooManyRequests)
			return
		}
		h.totalConnections++
		h.connections[source]++
		h.mu.Unlock()
		defer func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.totalConnections--
			h.connections[source]--
			if h.connections[source] == 0 {
				delete(h.connections, source)
			}
		}()

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		client := &sessionClient{source: source, out: make(chan response, 96), conn: conn, unboundAt: time.Now()}
		h.mu.Lock()
		h.clients[client] = struct{}{}
		client.send(response{Type: "config", RelayAvailable: h.router != nil, KeyAvailable: h.hasKey})
		h.mu.Unlock()
		defer h.detach(client)
		done := make(chan struct{})
		defer close(done)
		conn.SetReadLimit(64 * 1024)
		_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(60 * time.Second)) })
		go writeEvents(client, done)
		window := time.Now()
		messages := 0
		for {
			kind, raw, err := conn.ReadMessage()
			if err != nil || kind != websocket.TextMessage {
				return
			}
			now := time.Now()
			if now.Sub(window) >= time.Second {
				window, messages = now, 0
			}
			messages++
			if messages > 128 {
				return
			}
			var input request
			if json.Unmarshal(raw, &input) != nil || len(strings.TrimSpace(input.Type)) == 0 {
				client.problem("invalid_message", "无法读取配对消息。")
				continue
			}
			h.handle(client, input)
		}
	}
}

func writeEvents(c *sessionClient, done <-chan struct{}) {
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	defer c.conn.Close()
	for {
		select {
		case <-done:
			return
		case event := <-c.out:
			_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := c.conn.WriteJSON(event); err != nil {
				return
			}
		case <-ping.C:
			if err := c.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
				return
			}
		}
	}
}
