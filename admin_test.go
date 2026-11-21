package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAdminLoginLogoutAndSameOrigin(t *testing.T) {
	cfg, err := openAdminSettings(t.TempDir(), 100, 50)
	if err != nil {
		t.Fatal(err)
	}
	h := newHub(nil, nil, nil, "old")
	mux := http.NewServeMux()
	ledger, err := loadLedger(filepath.Join(t.TempDir(), "relay-usage.json"), 100, 50, time.Now, true)
	if err != nil {
		t.Fatal(err)
	}
	a := newAdmin("ops", "strong-password", cfg, h, ledger)
	a.register(mux)
	request := func(method, path, origin, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "https://transfer.test"+path, strings.NewReader(body))
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/json")
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	const origin = "https://transfer.test"
	const credentials = `{"username":"ops","password":"strong-password"}`
	if res := request("GET", "/api/admin/session", "", "", nil); res.Code != 401 || res.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("unauthenticated session probe: %d %v", res.Code, res.Header())
	}
	if res := request("GET", "/api/admin/dashboard", "", "", nil); res.Code != 401 {
		t.Fatalf("unauthenticated dashboard: %d", res.Code)
	}
	if res := request("POST", "/api/admin/login", "https://other.test", credentials, nil); res.Code != 403 {
		t.Fatalf("cross-origin login: %d", res.Code)
	}
	if res := request("POST", "/api/admin/login", origin, `{"username":"ops","password":"wrong"}`, nil); res.Code != 401 {
		t.Fatalf("invalid password: %d", res.Code)
	}
	login := request("POST", "/api/admin/login", origin, credentials, nil)
	if login.Code != 204 || len(login.Result().Cookies()) != 1 {
		t.Fatalf("login: %d %s", login.Code, login.Body)
	}
	cookie := login.Result().Cookies()[0]
	if res := request("GET", "/api/admin/session", "", "", cookie); res.Code != 204 || res.Body.Len() != 0 {
		t.Fatalf("authenticated session probe: %d %s", res.Code, res.Body)
	}
	if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatal("admin cookie flags missing")
	}
	if res := request("GET", "/api/admin/dashboard?days=7", "", "", cookie); res.Code != 200 || strings.Contains(res.Body.String(), "strong-password") {
		t.Fatalf("dashboard: %d %s", res.Code, res.Body)
	}
	const timeZone = `{"timeZone":"Pacific/Auckland"}`
	if res := request("PUT", "/api/admin/time-zone", origin, timeZone, nil); res.Code != 401 {
		t.Fatalf("unauthenticated timezone change: %d", res.Code)
	}
	if res := request("PUT", "/api/admin/time-zone", "https://other.test", timeZone, cookie); res.Code != 403 {
		t.Fatalf("cross-origin timezone change: %d", res.Code)
	}
	if res := request("PUT", "/api/admin/time-zone", origin, `{"timeZone":"Local"}`, cookie); res.Code != 400 {
		t.Fatalf("server-local timezone was accepted: %d", res.Code)
	}
	if res := request("PUT", "/api/admin/time-zone", origin, timeZone, cookie); res.Code != 204 {
		t.Fatalf("timezone save: %d %s", res.Code, res.Body)
	}
	if res := request("GET", "/api/admin/dashboard", "", "", cookie); !strings.Contains(res.Body.String(), `"timeZone":"Pacific/Auckland"`) {
		t.Fatalf("configured timezone missing: %s", res.Body)
	}

	const config = `{"publicLimit":25,"reservedLimit":10,"keyAction":"replace","key":"next","expected":{"publicLimit":100,"reservedLimit":50,"keyVersion":0}}`
	if res := request("PUT", "/api/admin/config", "https://other.test", config, cookie); res.Code != 403 {
		t.Fatalf("cross-origin config: %d", res.Code)
	}
	if res := request("PUT", "/api/admin/config", origin, config, cookie); res.Code != 204 {
		t.Fatalf("config update: %d %s", res.Code, res.Body)
	}
	if res := request("POST", "/api/admin/logout", origin, "", cookie); res.Code != 204 {
		t.Fatalf("logout: %d", res.Code)
	}
	if res := request("GET", "/api/admin/session", "", "", cookie); res.Code != 401 {
		t.Fatalf("logged out session probe: %d", res.Code)
	}
	if res := request("GET", "/api/admin/dashboard", "", "", cookie); res.Code != 401 {
		t.Fatalf("logged out cookie accepted: %d", res.Code)
	}
}

func TestAdminLimitsApplyWithoutResettingUsage(t *testing.T) {
	dir := t.TempDir()
	cfg, err := openAdminSettings(dir, 100, 50)
	if err != nil {
		t.Fatal(err)
	}
	ledger, err := openLedger(filepath.Join(dir, "usage.json"), 100, 50)
	if err != nil {
		t.Fatal(err)
	}
	h := newHub(nil, nil, nil, "old")
	if !ledger.charge(50, false) {
		t.Fatal("charge rejected")
	}
	a := newAdmin("ops", "password", cfg, h, ledger)
	public, reserved := cfg.limits()
	if err := a.update(configUpdate{
		PublicLimit: new(int64), ReservedLimit: new(int64), KeyAction: "clear",
		Expected: &configExpected{PublicLimit: &public, ReservedLimit: &reserved, KeyVersion: new(uint64)},
	}); err != nil {
		t.Fatal(err)
	}
	if ledger.charge(1, true) || ledger.view(7).Public.Used != 50 || h.hasKey {
		t.Fatal("lowering quota reset usage or clearing the key failed")
	}
	cfg, err = openAdminSettings(dir, 100, 50)
	if err != nil || cfg.values.PublicLimit == nil || *cfg.values.PublicLimit != 0 || cfg.values.KeyDigest == nil || *cfg.values.KeyDigest != "" {
		t.Fatalf("overrides lost: %+v %v", cfg, err)
	}
}

func TestAdminSessionsExpireAndLoginIsLimited(t *testing.T) {
	cfg, err := openAdminSettings(t.TempDir(), 100, 50)
	if err != nil {
		t.Fatal(err)
	}
	a := newAdmin("ops", "password", cfg, newHub(nil, nil, nil, ""), nil)
	mux := http.NewServeMux()
	a.register(mux)
	now := time.Date(2026, 11, 21, 0, 0, 0, 0, time.UTC)
	a.now = func() time.Time { return now }
	for i := 0; i < 7; i++ {
		r := httptest.NewRequest("POST", "https://transfer.test/api/admin/login", strings.NewReader(`{"username":"ops","password":"wrong"}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", "https://transfer.test")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		want := 401
		if i == 6 {
			want = 429
		}
		if w.Code != want {
			t.Fatalf("attempt %d: status %d, expected %d", i+1, w.Code, want)
		}
	}
	a.sessions["expired"] = now.Add(-time.Second)
	r := httptest.NewRequest("GET", "https://transfer.test/api/admin/dashboard", nil)
	r.AddCookie(&http.Cookie{Name: adminCookie, Value: "expired"})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatalf("expired session accepted: %d", w.Code)
	}
}

func TestAdminRetainsHistoryWhenTURNDisabled(t *testing.T) {
	dir := t.TempDir()
	cfg, err := openAdminSettings(dir, 100, 50)
	if err != nil {
		t.Fatal(err)
	}
	day := time.Date(2026, 11, 20, 3, 0, 0, 0, time.UTC)
	ledger, err := openLedgerWithClock(filepath.Join(dir, "relay-usage.json"), 100, 50, func() time.Time { return day })
	if err != nil {
		t.Fatal(err)
	}
	if !ledger.charge(115, true) {
		t.Fatal("authorized traffic rejected")
	}
	disabled, err := loadLedger(ledger.path, 100, 50, func() time.Time { return day.AddDate(0, 0, 1) }, true)
	if err != nil {
		t.Fatal(err)
	}
	a := newAdmin("ops", "password", cfg, newHub(nil, nil, nil, ""), disabled)
	w := httptest.NewRecorder()
	a.dashboard(w, httptest.NewRequest("GET", "https://transfer.test/api/admin/dashboard?days=7", nil))
	var view adminDashboard
	if err := json.NewDecoder(w.Body).Decode(&view); err != nil {
		t.Fatal(err)
	}
	yesterday, today := view.History[5], view.History[6]
	if view.TurnEnabled || view.LedgerFailed || yesterday.Public == nil || *yesterday.Public != 100 ||
		yesterday.Reserved == nil || *yesterday.Reserved != 50 || today.Public != nil || today.Reserved != nil {
		t.Fatalf("unexpected archived data with TURN disabled: %+v", view)
	}
}

func TestAdminFieldUpdatesConflictOnlyOnTouchedFields(t *testing.T) {
	dir := t.TempDir()
	cfg, err := openAdminSettings(dir, 100, 50)
	if err != nil {
		t.Fatal(err)
	}
	ledger, err := openLedger(filepath.Join(dir, "usage.json"), 100, 50)
	if err != nil {
		t.Fatal(err)
	}
	h := newHub(nil, nil, nil, "old")
	a := newAdmin("ops", "password", cfg, h, ledger)
	a.sessions["test"] = time.Now().Add(time.Hour)
	mux := http.NewServeMux()
	a.register(mux)

	for _, tc := range []struct {
		method, body string
		status       int
	}{
		{"PATCH", `{"publicLimit":80,"expected":{"publicLimit":100}}`, 204},
		{"PATCH", `{"reservedLimit":40,"expected":{"reservedLimit":50}}`, 204},
		{"PATCH", `{"keyAction":"replace","key":"next","expected":{"keyVersion":0}}`, 204},
		{"PATCH", `{"keyAction":"clear","expected":{"keyVersion":0}}`, 409},
		{"PATCH", `{"publicLimit":10,"reservedLimit":20,"expected":{"publicLimit":80,"reservedLimit":50}}`, 409},
		{"PATCH", `{"publicLimit":10}`, 400},
		{"PATCH", `{"publicLimit":10,"expected":{}}`, 400},
		{"PATCH", `{"expected":{}}`, 400},
		{"PUT", `{"publicLimit":100,"reservedLimit":50,"keyAction":"clear"}`, 409},
		{"PUT", `{"publicLimit":100,"reservedLimit":50,"keyAction":"keep","expected":{"publicLimit":80,"reservedLimit":40}}`, 400},
		{"PUT", `{"publicLimit":100,"reservedLimit":50,"keyAction":"keep","expected":{"publicLimit":80,"reservedLimit":40,"keyVersion":0}}`, 409},
		{"PUT", `{"publicLimit":70,"reservedLimit":30,"keyAction":"keep","expected":{"publicLimit":80,"reservedLimit":40,"keyVersion":1}}`, 204},
	} {
		r := httptest.NewRequest(tc.method, "https://transfer.test/api/admin/config", strings.NewReader(tc.body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", "https://transfer.test")
		r.AddCookie(&http.Cookie{Name: adminCookie, Value: "test"})
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("%s %s: got %d, want %d (%s)", tc.method, tc.body, w.Code, tc.status, w.Body)
		}
		if tc.method == "PUT" && tc.status == 409 && !strings.Contains(w.Body.String(), "刷新") {
			t.Errorf("stale full update did not instruct the user to refresh: %s", w.Body)
		}
	}

	loaded, err := openAdminSettings(dir, 100, 50)
	if err != nil {
		t.Fatal(err)
	}
	public, reserved := loaded.limits()
	if public != 70 || reserved != 30 || !h.hasKey || h.keyGeneration != 1 {
		t.Fatalf("unexpected settings: public=%d reserved=%d keyConfigured=%v keyVersion=%d", public, reserved, h.hasKey, h.keyGeneration)
	}
	w := httptest.NewRecorder()
	a.dashboard(w, httptest.NewRequest("GET", "https://transfer.test/api/admin/dashboard", nil))
	if !strings.Contains(w.Body.String(), `"keyVersion":1`) {
		t.Fatalf("dashboard omitted the current key version: %s", w.Body)
	}
}

func TestAdminDashboardDoesNotHoldHubWhileReadingLedger(t *testing.T) {
	entered, resume, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	ledger, err := openLedger(filepath.Join(t.TempDir(), "usage.json"), 100, 50)
	if err != nil {
		t.Fatal(err)
	}
	ledger.now = func() time.Time {
		close(entered)
		<-resume
		return time.Now()
	}
	h := newHub(nil, nil, nil, "")
	cfg, err := openAdminSettings(t.TempDir(), 100, 50)
	if err != nil {
		t.Fatal(err)
	}
	a := newAdmin("ops", "password", cfg, h, ledger)
	go func() {
		defer close(done)
		a.dashboard(httptest.NewRecorder(), httptest.NewRequest("GET", "https://transfer.test/api/admin/dashboard", nil))
	}()
	<-entered
	if h.mu.TryLock() {
		h.mu.Unlock()
	} else {
		t.Error("hub is locked during the dashboard ledger read")
	}
	close(resume)
	<-done
}

func TestAdminSettingsKeepHubAvailableAndFailClosedOnUncertainSave(t *testing.T) {
	dir := t.TempDir()
	cfg, err := openAdminSettings(dir, 100, 50)
	if err != nil {
		t.Fatal(err)
	}
	ledger, err := openLedger(filepath.Join(dir, "usage.json"), 100, 50)
	if err != nil {
		t.Fatal(err)
	}
	h := newHub(nil, nil, nil, "old")
	a := newAdmin("ops", "password", cfg, h, ledger)
	entered, resume := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	a.persistSettings = func(path string, value any) error {
		close(entered)
		<-resume
		if err := persistJSON(path, value); err != nil {
			return err
		}
		return replacedFileError{errors.New("directory sync failed")}
	}
	limit := int64(80)
	public, _ := cfg.limits()
	input := configUpdate{
		PublicLimit: &limit, KeyAction: "clear",
		Expected: &configExpected{PublicLimit: &public, KeyVersion: new(uint64)},
	}
	go func() { done <- a.update(input) }()
	<-entered
	if h.mu.TryLock() {
		if !h.hasKey || ledger.remaining(true) != 150 {
			t.Error("unconfirmed settings were published")
		}
		h.mu.Unlock()
	} else {
		t.Error("hub blocked during settings persistence")
	}
	close(resume)
	if err := <-done; err == nil {
		t.Fatal("expected persistence error")
	}
	if !h.hasKey || ledger.remaining(true) != 0 || !ledger.view(7).LedgerFailed || ledger.charge(1, true) {
		t.Fatal("uncertain settings changed the key or left quota available")
	}

	a.persistSettings = persistJSON
	if err := a.update(input); err != nil {
		t.Fatal(err)
	}
	if h.hasKey || ledger.remaining(true) != 130 || ledger.view(7).LedgerFailed {
		t.Fatal("confirmed retry did not publish settings or restore quota")
	}
}

func TestAdminGuestUnlocksRoomAndTotalsRequireSession(t *testing.T) {
	ledger, err := openLedger(filepath.Join(t.TempDir(), "usage.json"), 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	h := newHub(newRelayRouter([]byte{127, 0, 0, 1}, ledger), nil, []string{"turn:127.0.0.1:3478"}, "")
	a := newAdmin("ops", "password", nil, h, ledger)
	mux := http.NewServeMux()
	a.register(mux)
	post := func(path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest("POST", "https://transfer.test/api/admin/"+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", "https://transfer.test")
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	host, guest := testClient("host"), testClient("guest")
	guest.adminProof = "guest-socket-proof"
	h.clients[guest] = struct{}{}
	h.handle(host, request{Type: "create", Code: "5500"})
	created := expect(t, host, "created")
	h.handle(guest, request{Type: "join", Code: "5500"})
	expect(t, guest, "joined")
	application := expect(t, host, "request")
	h.handle(host, request{Type: "accept", Token: created.Token, RequestID: application.RequestID})
	direct := expect(t, host, "start")
	expect(t, guest, "start")

	const proof = `{"adminProof":"guest-socket-proof"}`
	if w := post("relay-totals", proof, nil); w.Code != 401 {
		t.Fatalf("anonymous totals request returned %d", w.Code)
	}
	login := post("login", `{"username":"ops","password":"password"}`, nil)
	if login.Code != 204 {
		t.Fatalf("login returned %d", login.Code)
	}
	cookie := login.Result().Cookies()[0]
	if w := post("relay-totals", `{"adminProof":"different-socket"}`, cookie); w.Code != 200 || guest.isAdmin() {
		t.Fatalf("wrong proof identified guest: %d", w.Code)
	}
	if w := post("relay-totals", proof, cookie); w.Code != 200 || w.Body.String() != "{\"today\":0,\"month\":0}\n" {
		t.Fatalf("unexpected totals: %d %s", w.Code, w.Body)
	}
	h.tick(time.Now())
	if !expect(t, host, "balance").Unlimited || !expect(t, guest, "balance").Unlimited {
		t.Fatal("guest login did not unlock both sides")
	}
	h.handle(host, request{Type: "failed", Token: created.Token, Epoch: direct.Epoch})
	expect(t, host, "failed")
	expect(t, guest, "failed")
	h.handle(host, request{Type: "relay", Token: created.Token})
	if !expect(t, host, "start").Unlimited || !expect(t, guest, "start").Unlimited {
		t.Fatal("guest login did not permit relay while public and reserved quotas were exhausted")
	}
	if w := post("logout", "", cookie); w.Code != 204 {
		t.Fatalf("logout returned %d", w.Code)
	}
	h.tick(time.Now())
	if expect(t, host, "balance").Unlimited || expect(t, guest, "balance").Unlimited {
		t.Fatal("room stayed unlimited after logout")
	}
}
