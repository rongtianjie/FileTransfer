package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	adminCookie = "filetransfer_admin"
	adminTTL    = 8 * time.Hour
	loginWindow = 5 * time.Minute
)

type admin struct {
	username, password [sha256.Size]byte
	mu                 sync.Mutex
	sessions           map[string]time.Time
	attempts           map[string]rateWindow
	now                func() time.Time
	settings           *adminSettings
	hub                *hub
	ledger             *dailyLedger
	persistSettings    func(string, any) error
}

type configUpdate struct {
	PublicLimit   *int64          `json:"publicLimit"`
	ReservedLimit *int64          `json:"reservedLimit"`
	KeyAction     string          `json:"keyAction"`
	Key           string          `json:"key"`
	Expected      *configExpected `json:"expected"`
}

type configExpected struct {
	PublicLimit   *int64  `json:"publicLimit"`
	ReservedLimit *int64  `json:"reservedLimit"`
	KeyVersion    *uint64 `json:"keyVersion"`
}

var errConfigConflict = errors.New("relay settings changed")

type roomStats struct {
	Active   int               `json:"active"`
	Direct   int               `json:"direct"`
	Relay    int               `json:"relay"`
	Failures map[string]uint64 `json:"failures"`
}

type adminDashboard struct {
	ledgerView
	TurnEnabled   bool      `json:"turnEnabled"`
	KeyConfigured bool      `json:"keyConfigured"`
	KeyVersion    uint64    `json:"keyVersion"`
	Rooms         roomStats `json:"rooms"`
}

func newAdmin(username, password string, settings *adminSettings, h *hub, ledger *dailyLedger) *admin {
	return &admin{
		username: sha256.Sum256([]byte(username)), password: sha256.Sum256([]byte(password)),
		sessions: make(map[string]time.Time), attempts: make(map[string]rateWindow),
		now: time.Now, settings: settings, hub: h, ledger: ledger, persistSettings: persistJSON,
	}
}

func (a *admin) register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/admin/login", a.guard(false, a.login))
	mux.HandleFunc("POST /api/admin/logout", a.guard(true, a.logout))
	mux.HandleFunc("GET /api/admin/session", a.guard(true, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	mux.HandleFunc("GET /api/admin/dashboard", a.guard(true, a.dashboard))
	mux.HandleFunc("POST /api/admin/relay-totals", a.guard(true, a.relayTotals))
	mux.HandleFunc("PUT /api/admin/config", a.guard(true, a.configure))
	mux.HandleFunc("PATCH /api/admin/config", a.guard(true, a.configure))
	mux.HandleFunc("PUT /api/admin/time-zone", a.guard(true, a.configureTimeZone))
}

func (a *admin) guard(auth bool, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodGet && r.Method != http.MethodHead && !adminSameOrigin(r) {
			adminProblem(w, http.StatusForbidden, "请求来源无效。")
			return
		}
		if auth && !a.authenticated(r) {
			adminProblem(w, http.StatusUnauthorized, "请登录管理后台。")
			return
		}
		next(w, r)
	}
}

func adminSameOrigin(r *http.Request) bool {
	origin, err := url.Parse(r.Header.Get("Origin"))
	if err != nil {
		return false
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return origin.Scheme == scheme && origin.Host != "" && strings.EqualFold(origin.Host, r.Host) &&
		origin.User == nil && origin.Path == "" && !origin.ForceQuery && origin.RawQuery == "" && origin.Fragment == ""
}

func (a *admin) authenticated(r *http.Request) bool {
	cookie, err := r.Cookie(adminCookie)
	if err != nil {
		return false
	}
	return a.validSession(cookie.Value)
}

func (a *admin) validSession(token string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	expires, ok := a.sessions[token]
	if ok && a.now().Before(expires) {
		return true
	}
	delete(a.sessions, token)
	return false
}

func (a *admin) relayTotals(w http.ResponseWriter, r *http.Request) {
	var input struct {
		AdminProof string `json:"adminProof"`
	}
	if !readAdminJSON(w, r, &input) {
		return
	}
	if input.AdminProof != "" {
		// Bind the socket using its private proof so the cookie stays scoped to /api/admin/.
		cookie, _ := r.Cookie(adminCookie)
		token := cookie.Value
		a.hub.bindAdmin(input.AdminProof, &socketAdminSession{valid: func() bool { return a.validSession(token) }})
	}
	totals, available := a.ledger.relayTotals()
	if !available {
		adminProblem(w, http.StatusServiceUnavailable, "中继流量数据暂不可用。")
		return
	}
	writeAdminJSON(w, http.StatusOK, totals)
}

func (a *admin) allowLogin(source string, now time.Time) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	for ip, attempt := range a.attempts {
		if !now.Before(attempt.until) {
			delete(a.attempts, ip)
		}
	}
	attempt, exists := a.attempts[source]
	if !exists {
		if len(a.attempts) >= 4096 {
			return false
		}
		attempt.until = now.Add(loginWindow)
	}
	if attempt.count >= 6 {
		return false
	}
	attempt.count++
	a.attempts[source] = attempt
	return true
}

func (a *admin) login(w http.ResponseWriter, r *http.Request) {
	now := a.now()
	if !a.allowLogin(sourceKey(r.RemoteAddr), now) {
		adminProblem(w, http.StatusTooManyRequests, "登录尝试过多，请稍后重试。")
		return
	}
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !readAdminJSON(w, r, &input) {
		return
	}
	username := sha256.Sum256([]byte(input.Username))
	password := sha256.Sum256([]byte(input.Password))
	if subtle.ConstantTimeCompare(username[:], a.username[:])&subtle.ConstantTimeCompare(password[:], a.password[:]) != 1 {
		adminProblem(w, http.StatusUnauthorized, "账号或密码不正确。")
		return
	}
	token, err := randomToken()
	if err != nil {
		adminProblem(w, http.StatusInternalServerError, "暂时无法建立管理会话。")
		return
	}
	expires := now.Add(adminTTL)
	a.mu.Lock()
	for session, until := range a.sessions {
		if !now.Before(until) {
			delete(a.sessions, session)
		}
	}
	if cookie, err := r.Cookie(adminCookie); err == nil {
		delete(a.sessions, cookie.Value)
	}
	if len(a.sessions) >= 64 {
		a.mu.Unlock()
		adminProblem(w, http.StatusTooManyRequests, "管理会话过多，请稍后重试。")
		return
	}
	a.sessions[token] = expires
	a.mu.Unlock()
	cookie := newAdminCookie(r, token)
	cookie.Expires = expires
	cookie.MaxAge = int(adminTTL.Seconds())
	http.SetCookie(w, cookie)
	w.WriteHeader(http.StatusNoContent)
}

func (a *admin) logout(w http.ResponseWriter, r *http.Request) {
	cookie, _ := r.Cookie(adminCookie)
	a.mu.Lock()
	delete(a.sessions, cookie.Value)
	a.mu.Unlock()
	cookie = newAdminCookie(r, "")
	cookie.Expires, cookie.MaxAge = time.Unix(0, 0), -1
	http.SetCookie(w, cookie)
	w.WriteHeader(http.StatusNoContent)
}

func newAdminCookie(r *http.Request, token string) *http.Cookie {
	return &http.Cookie{
		Name: adminCookie, Value: token, Path: "/api/admin/", HttpOnly: true,
		Secure: r.TLS != nil, SameSite: http.SameSiteStrictMode,
	}
}

func (a *admin) dashboard(w http.ResponseWriter, r *http.Request) {
	days := 30
	switch r.URL.Query().Get("days") {
	case "", "30":
	case "7":
		days = 7
	case "90":
		days = 90
	default:
		adminProblem(w, http.StatusBadRequest, "请选择 7、30 或 90 天。")
		return
	}
	a.settings.mu.Lock()
	ledger := a.ledger.view(days)
	if ledger.PendingTimeZone == ledger.TimeZone {
		// A same-zone transition carries the reset deadline after cancellation.
		ledger.PendingTimeZone = ""
	}
	a.hub.mu.Lock()
	view := adminDashboard{
		ledgerView: ledger, KeyConfigured: a.hub.hasKey, KeyVersion: a.hub.keyGeneration,
		TurnEnabled: a.hub.router != nil, Rooms: a.hub.stats(),
	}
	a.hub.mu.Unlock()
	a.settings.mu.Unlock()
	writeAdminJSON(w, http.StatusOK, view)
}

func (h *hub) stats() roomStats {
	stats := roomStats{Failures: make(map[string]uint64)}
	for reason, count := range h.failures {
		stats.Failures[reason] = count
	}
	for r := range h.rooms {
		if !r.locked {
			continue
		}
		stats.Active++
		if r.failed || !r.host.ready || !r.guest.ready {
			continue
		}
		switch r.mode {
		case "direct":
			stats.Direct++
		case "relay":
			stats.Relay++
		}
	}
	return stats
}

func (a *admin) configure(w http.ResponseWriter, r *http.Request) {
	var input configUpdate
	if !readAdminJSON(w, r, &input) {
		return
	}
	expected := input.Expected
	if r.Method == http.MethodPatch {
		if input.KeyAction == "" {
			input.KeyAction = "keep"
		}
		if expected == nil ||
			(input.PublicLimit == nil) != (expected.PublicLimit == nil) ||
			(input.ReservedLimit == nil) != (expected.ReservedLimit == nil) ||
			(input.KeyAction == "keep") != (expected.KeyVersion == nil) ||
			(input.PublicLimit == nil && input.ReservedLimit == nil && input.KeyAction == "keep") {
			adminProblem(w, http.StatusBadRequest, "请提交要修改的设置及其原值。")
			return
		}
	} else {
		if expected == nil {
			adminProblem(w, http.StatusConflict, "此页面提交的设置缺少原值。请刷新管理后台页面后重新编辑。")
			return
		}
		if input.PublicLimit == nil || input.ReservedLimit == nil ||
			expected.PublicLimit == nil || expected.ReservedLimit == nil || expected.KeyVersion == nil {
			adminProblem(w, http.StatusBadRequest, "完整更新须提供两类额度及其原值，以及当前密钥版本。")
			return
		}
	}
	if (input.PublicLimit != nil && !validQuota(*input.PublicLimit)) ||
		(input.ReservedLimit != nil && !validQuota(*input.ReservedLimit)) {
		adminProblem(w, http.StatusBadRequest, "额度必须为 0 到 1 PiB 之间的整数字节数。")
		return
	}
	keyValid := (input.KeyAction == "replace" && strings.TrimSpace(input.Key) != "" && len(input.Key) <= 512) ||
		((input.KeyAction == "keep" || input.KeyAction == "clear") && input.Key == "")
	if !keyValid {
		adminProblem(w, http.StatusBadRequest, "密钥操作无效，替换时请输入 1 到 512 字节的密钥。")
		return
	}
	if err := a.update(input); err != nil {
		if errors.Is(err, errConfigConflict) {
			adminProblem(w, http.StatusConflict, "要修改的设置已被更新。请刷新并核对最新设置后重新编辑。")
			return
		}
		log.Printf("persist Admin relay settings: %v", err)
		adminProblem(w, http.StatusInternalServerError, "中继设置未能确认保存，请检查服务日志和数据卷。")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *admin) configureTimeZone(w http.ResponseWriter, r *http.Request) {
	var input struct {
		TimeZone                    string    `json:"timeZone"`
		Action                      string    `json:"action"`
		ExpectedPendingTimeZone     string    `json:"expectedPendingTimeZone"`
		ExpectedTimeZoneEffectiveAt time.Time `json:"expectedTimeZoneEffectiveAt"`
	}
	if !readAdminJSON(w, r, &input) {
		return
	}
	var err error
	switch {
	case input.Action == "cancel" && input.TimeZone == "":
		if input.ExpectedPendingTimeZone == "" || input.ExpectedTimeZoneEffectiveAt.IsZero() {
			adminProblem(w, http.StatusBadRequest, "取消切换须提供计划中的时区及其生效时间。")
			return
		}
		err = a.ledger.cancelTimeZone(input.ExpectedPendingTimeZone, input.ExpectedTimeZoneEffectiveAt)
	case input.Action == "" && input.ExpectedPendingTimeZone == "" && input.ExpectedTimeZoneEffectiveAt.IsZero():
		var zone *time.Location
		zone, err = loadSettlementZone(input.TimeZone)
		if err != nil {
			adminProblem(w, http.StatusBadRequest, "无法识别所选时区。")
			return
		}
		err = a.ledger.scheduleTimeZone(zone)
	default:
		adminProblem(w, http.StatusBadRequest, "时区操作无效。")
		return
	}
	if err != nil {
		if errors.Is(err, errTimeZoneConflict) {
			adminProblem(w, http.StatusConflict, "时区切换计划已变化或已生效。请刷新并核对当前计划。")
			return
		}
		log.Printf("persist settlement time zone: %v", err)
		adminProblem(w, http.StatusInternalServerError, "时区未能保存，请检查服务日志和数据卷。")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *admin) update(input configUpdate) error {
	h := a.hub
	a.settings.mu.Lock()
	defer a.settings.mu.Unlock()

	expected := input.Expected
	changeKey := input.KeyAction == "replace" || input.KeyAction == "clear"
	if expected == nil || (input.PublicLimit != nil && expected.PublicLimit == nil) ||
		(input.ReservedLimit != nil && expected.ReservedLimit == nil) || (changeKey && expected.KeyVersion == nil) {
		return errConfigConflict
	}
	public, reserved := a.settings.limits()
	// All writes to the hub key after startup are serialized by settings.mu.
	if (expected.PublicLimit != nil && *expected.PublicLimit != public) ||
		(expected.ReservedLimit != nil && *expected.ReservedLimit != reserved) ||
		(expected.KeyVersion != nil && *expected.KeyVersion != h.keyGeneration) {
		return errConfigConflict
	}
	if a.ledger != nil {
		// Serialize charging with persistence and publication. Signaling can
		// continue reading the last published quota snapshot in the meantime.
		a.ledger.mu.Lock()
		defer a.ledger.mu.Unlock()
	}
	next := a.settings.values
	if input.PublicLimit != nil {
		next.PublicLimit = input.PublicLimit
	}
	if input.ReservedLimit != nil {
		next.ReservedLimit = input.ReservedLimit
	}
	if changeKey {
		digest := ""
		if input.KeyAction == "replace" {
			sum := sha256.Sum256([]byte(input.Key))
			digest = hex.EncodeToString(sum[:])
		}
		next.KeyDigest = &digest
	}
	if err := a.persistSettings(a.settings.path, next); err != nil {
		var uncertain replacedFileError
		if a.ledger != nil && errors.As(err, &uncertain) {
			a.ledger.settingsUncertain = true
			a.ledger.publish()
		}
		return err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	a.settings.values = next
	if a.ledger != nil {
		a.ledger.publicLimit, a.ledger.reserveLimit = a.settings.limits()
		a.ledger.settingsUncertain = false
		a.ledger.publish()
	}
	if changeKey {
		h.applyKeyDigest(next.KeyDigest)
		for c := range h.clients {
			c.send(response{Type: "config", RelayAvailable: h.router != nil, KeyAvailable: h.hasKey})
		}
	}
	return nil
}

func (h *hub) applyKeyDigest(digest *string) {
	if digest == nil {
		return
	}
	var hash [sha256.Size]byte
	_, _ = hex.Decode(hash[:], []byte(*digest))
	hasKey := *digest != ""
	if h.hasKey != hasKey || h.keyHash != hash {
		h.keyGeneration++
		if h.router != nil {
			h.router.freezePaidAllocations()
		}
	}
	h.hasKey, h.keyHash = hasKey, hash
}

func readAdminJSON(w http.ResponseWriter, r *http.Request, input any) bool {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		adminProblem(w, http.StatusUnsupportedMediaType, "请求需使用 JSON。")
		return false
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	d.DisallowUnknownFields()
	if err := d.Decode(input); err != nil || d.Decode(new(any)) != io.EOF {
		adminProblem(w, http.StatusBadRequest, "请求数据格式无效。")
		return false
	}
	return true
}

func adminProblem(w http.ResponseWriter, status int, message string) {
	writeAdminJSON(w, status, map[string]string{"error": message})
}

func writeAdminJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
