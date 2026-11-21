package main

import (
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAdminCancelTimeZonePreservesUsageAndSafeResetAcrossRestart(t *testing.T) {
	now := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	path := filepath.Join(t.TempDir(), "usage.json")
	ledger, err := openLedgerWithClock(path, 100, 50, clock)
	if err != nil {
		t.Fatal(err)
	}
	if !ledger.charge(120, true) {
		t.Fatal("initial traffic rejected")
	}
	shanghai, err := loadSettlementZone(defaultSettlementZone)
	if err != nil {
		t.Fatal(err)
	}
	if err := ledger.scheduleTimeZone(shanghai); err != nil {
		t.Fatal(err)
	}
	scheduled := ledger.view(7)
	if scheduled.PendingTimeZone != defaultSettlementZone {
		t.Fatalf("expected a pending change: %+v", scheduled)
	}

	cfg, err := openAdminSettings(t.TempDir(), 100, 50)
	if err != nil {
		t.Fatal(err)
	}
	a := newAdmin("ops", "password", cfg, newHub(nil, nil, nil, ""), ledger)
	body := timeZoneCancellationJSON(scheduled.PendingTimeZone, scheduled.TimeZoneEffectiveAt)
	r := httptest.NewRequest("PUT", "https://transfer.test/api/admin/time-zone", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	a.configureTimeZone(w, r)
	if w.Code != 204 {
		t.Fatalf("cancel returned HTTP %d: %s", w.Code, w.Body)
	}

	w = httptest.NewRecorder()
	a.dashboard(w, httptest.NewRequest("GET", "https://transfer.test/api/admin/dashboard", nil))
	var dashboard adminDashboard
	if err := json.NewDecoder(w.Body).Decode(&dashboard); err != nil {
		t.Fatal(err)
	}
	wantReset := time.Date(2026, 11, 23, 0, 0, 0, 0, time.UTC)
	if dashboard.PendingTimeZone != "" || !dashboard.TimeZoneEffectiveAt.Equal(wantReset) {
		t.Fatalf("dashboard should show the reset deadline with no pending switch: %+v", dashboard)
	}

	ledger, err = openLedgerWithClock(path, 100, 50, clock)
	if err != nil {
		t.Fatal(err)
	}
	now = scheduled.TimeZoneEffectiveAt
	if ledger.remaining(true) != 0 || ledger.charge(1, true) {
		t.Fatal("ledger replenished quota at the cancelled transition")
	}
	held := ledger.view(7)
	if held.TimeZone != "UTC" || held.Public.Used != 100 || held.Reserved.Used != 50 {
		t.Fatalf("cancel reset quota before the safe UTC midnight: %+v", held)
	}
	now = wantReset
	reset := ledger.view(7)
	if reset.TimeZone != "UTC" || reset.PendingTimeZone != "" || reset.Public.Used != 0 || ledger.remaining(true) != 150 {
		t.Fatalf("expected UTC reset after cancel: %+v", reset)
	}
	archived := reset.History[4]
	if archived.Day != "2026-11-21" || archived.TimeZone != "UTC" || archived.Public == nil || *archived.Public != 100 {
		t.Fatalf("original UTC bucket was not archived: %+v", archived)
	}
}

func TestAdminRescheduleAfterCancelKeepsResetFloorWhenTURNDisabled(t *testing.T) {
	now := time.Date(2026, 11, 21, 4, 0, 0, 0, time.UTC)
	path := filepath.Join(t.TempDir(), "usage.json")
	usage := usageFile{
		Version: 2, Unobserved: true,
		dailyUsage: dailyUsage{Day: "2026-11-21", TimeZone: "UTC"},
		History:    []dailyUsage{{Day: "2026-11-20", TimeZone: "UTC", Public: 100}},
	}
	if err := persistJSON(path, usage); err != nil {
		t.Fatal(err)
	}
	ledger, err := loadLedger(path, 100, 50, func() time.Time { return now }, true)
	if err != nil {
		t.Fatal(err)
	}
	west, err := loadSettlementZone("Pacific/Honolulu")
	if err != nil {
		t.Fatal(err)
	}
	if err := ledger.scheduleTimeZone(west); err != nil {
		t.Fatal(err)
	}
	scheduled := ledger.view(7)
	if err := ledger.cancelTimeZone(scheduled.PendingTimeZone, scheduled.TimeZoneEffectiveAt); err != nil {
		t.Fatal(err)
	}
	floor := ledger.view(7).TimeZoneEffectiveAt
	if floor.IsZero() {
		t.Fatal("cancel discarded the reset deadline")
	}

	east, err := loadSettlementZone(defaultSettlementZone)
	if err != nil {
		t.Fatal(err)
	}
	if err := ledger.scheduleTimeZone(east); err != nil {
		t.Fatal(err)
	}
	view := ledger.view(7)
	if view.TimeZone != "UTC" || view.PendingTimeZone != east.String() || view.TimeZoneEffectiveAt.Before(floor) {
		t.Fatalf("rescheduling shortened the existing period: %+v", view)
	}
}

func TestAdminCancelRejectsAReplacedOrEffectiveSchedule(t *testing.T) {
	now := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	dir := t.TempDir()
	ledger, err := openLedgerWithClock(filepath.Join(dir, "usage.json"), 100, 50, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := openAdminSettings(dir, 100, 50)
	if err != nil {
		t.Fatal(err)
	}
	a := newAdmin("ops", "password", cfg, newHub(nil, nil, nil, ""), ledger)
	schedule := func(name string) ledgerView {
		t.Helper()
		zone, err := loadSettlementZone(name)
		if err != nil {
			t.Fatal(err)
		}
		if err := ledger.scheduleTimeZone(zone); err != nil {
			t.Fatal(err)
		}
		return ledger.view(7)
	}
	first := schedule(defaultSettlementZone)
	replacement := schedule("Pacific/Honolulu")
	cancel := func(body string, want int) {
		t.Helper()
		r := httptest.NewRequest("PUT", "https://transfer.test/api/admin/time-zone", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		a.configureTimeZone(w, r)
		if w.Code != want {
			t.Fatalf("cancel %s: got %d, want %d (%s)", body, w.Code, want, w.Body)
		}
	}

	cancel(`{"action":"cancel"}`, 400)
	cancel(timeZoneCancellationJSON(first.PendingTimeZone, replacement.TimeZoneEffectiveAt), 409)
	if current := ledger.view(7); current.PendingTimeZone != replacement.PendingTimeZone ||
		!current.TimeZoneEffectiveAt.Equal(replacement.TimeZoneEffectiveAt) {
		t.Fatalf("stale zone changed the replacement schedule: %+v", current)
	}

	moved := schedule(first.PendingTimeZone)
	if !moved.TimeZoneEffectiveAt.After(first.TimeZoneEffectiveAt) {
		t.Fatalf("test requires a later schedule for the same zone: %+v", moved)
	}
	cancel(timeZoneCancellationJSON(first.PendingTimeZone, first.TimeZoneEffectiveAt), 409)
	if current := ledger.view(7); current.PendingTimeZone != moved.PendingTimeZone ||
		!current.TimeZoneEffectiveAt.Equal(moved.TimeZoneEffectiveAt) {
		t.Fatalf("stale time changed the replacement schedule: %+v", current)
	}

	now = moved.TimeZoneEffectiveAt
	cancel(timeZoneCancellationJSON(moved.PendingTimeZone, moved.TimeZoneEffectiveAt), 409)
	if current := ledger.view(7); current.TimeZone != moved.PendingTimeZone || current.PendingTimeZone != "" {
		t.Fatalf("the due schedule did not take effect: %+v", current)
	}
}

func timeZoneCancellationJSON(zone string, when time.Time) string {
	body, _ := json.Marshal(map[string]string{
		"action":                      "cancel",
		"expectedPendingTimeZone":     zone,
		"expectedTimeZoneEffectiveAt": when.Format(time.RFC3339Nano),
	})
	return string(body)
}
