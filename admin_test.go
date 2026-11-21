package main

import (
	"encoding/json"
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

	const config = `{"publicLimit":25,"reservedLimit":10,"keyAction":"replace","key":"next"}`
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
	if err := a.update(configUpdate{PublicLimit: new(int64), ReservedLimit: new(int64), KeyAction: "clear"}); err != nil {
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
