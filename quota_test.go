package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDailyLedgerUsesPublicBeforeReservedAndPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.json")
	ledger, err := openLedger(path, 10, 6)
	if err != nil {
		t.Fatal(err)
	}
	if !ledger.charge(8, false) || ledger.charge(3, false) || !ledger.charge(5, true) {
		t.Fatal("incorrect public or reserved admission")
	}
	ledger, err = openLedger(path, 10, 6)
	if err != nil {
		t.Fatal(err)
	}
	if ledger.charge(1, false) || ledger.charge(4, true) {
		t.Fatal("restarting restored spent quota")
	}
}

func TestDailyLedgerHistoryMigratesAndArchives(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.json")
	if err := os.WriteFile(path, []byte(`{"day":"2026-11-19","public":19,"reserved":4}`), 0600); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 21, 23, 59, 0, 0, time.UTC)
	open := func() *dailyLedger {
		t.Helper()
		ledger, err := openLedgerWithClock(path, 1_000_000, 20, func() time.Time { return now })
		if err != nil {
			t.Fatal(err)
		}
		return ledger
	}
	ledger := open()
	if !ledger.charge(5, false) {
		t.Fatal("charge rejected")
	}
	now = now.Add(2 * time.Minute)
	if !ledger.charge(7, false) {
		t.Fatal("charge after midnight rejected")
	}
	view := open().view(4)
	want := []int64{19, -1, 5, reservationSize}
	for i, bytes := range want {
		got := view.History[i].Public
		if bytes == -1 && got == nil {
			continue
		}
		if got == nil || *got != bytes {
			t.Fatalf("day %d: expected %d, got %+v", i, bytes, view.History[i])
		}
	}
	if view.Public.Used != reservationSize || *view.History[0].Reserved != 4 {
		t.Fatalf("unexpected migrated balances: %+v", view)
	}
}

func TestDailyLedgerHistoryDoesNotExceedRetention(t *testing.T) {
	now := time.Date(2026, 11, 21, 0, 0, 0, 0, time.UTC)
	ledger, err := openLedgerWithClock(filepath.Join(t.TempDir(), "usage.json"), 10, 10, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < historyDays+1; i++ {
		if !ledger.charge(1, false) {
			t.Fatal("charge rejected")
		}
		now = now.AddDate(0, 0, 1)
		ledger.rollDay()
	}
	stored, err := readUsage(ledger.path)
	if err != nil || len(stored.History) != historyDays-1 {
		t.Fatalf("retention: %d days, error %v", len(stored.History), err)
	}
	view := ledger.view(historyDays)
	if len(view.History) != historyDays || *view.History[0].Public != 1 || *view.History[historyDays-1].Public != 0 {
		t.Fatal("history should include yesterday's usage and today's observed zero")
	}
}

func TestLedgerRefusesTrafficAfterPersistenceFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.json")
	ledger, err := openLedger(path, 10, 10)
	if err != nil {
		t.Fatal(err)
	}
	// A directory at the destination prevents the atomic replacement.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if ledger.charge(1, false) || ledger.remaining(true) != 0 || !ledger.view(7).LedgerFailed {
		t.Fatal("ledger did not fail closed")
	}
}

func TestLedgerPreparationDoesNotRecordCoverage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.json")
	ledger, err := prepareLedger(path, 100, 50, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("preparing the ledger should not persist coverage: %v", err)
	}
	if err := ledger.activate(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
}

func TestBrowserTimeZonePreservesQuotaUntilNextSafeMidnight(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.json")
	now := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	ledger, err := openLedgerWithClock(path, 10, 6, clock)
	if err != nil {
		t.Fatal(err)
	}
	if !ledger.charge(13, true) {
		t.Fatal("initial charge rejected")
	}
	zone, err := loadSettlementZone("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	if err := ledger.scheduleTimeZone(zone); err != nil {
		t.Fatal(err)
	}
	ledger, err = openLedgerWithClock(path, 10, 6, clock)
	if err != nil {
		t.Fatal(err)
	}
	firstShanghaiMidnight := now.Add(4 * time.Hour)
	now = firstShanghaiMidnight.Add(9 * time.Hour)
	view := ledger.view(7)
	if view.TimeZone != "UTC" || view.PendingTimeZone != "Asia/Shanghai" || view.Public.Used != 10 ||
		ledger.remaining(true) != 0 || ledger.charge(1, true) {
		t.Fatalf("clock change granted fresh quota or lost schedule: %+v", view)
	}
	now = firstShanghaiMidnight.Add(24 * time.Hour)
	if !ledger.charge(5, false) {
		t.Fatal("Shanghai midnight did not unlock quota")
	}
	view = ledger.view(7)
	if view.TimeZone != "Asia/Shanghai" || view.PendingTimeZone != "" || view.Public.Used != 5 ||
		view.History[4].TimeZone != "UTC" || view.History[5].Public != nil ||
		view.History[6].Day != "2026-11-23" || view.History[6].TimeZone != "Asia/Shanghai" {
		t.Fatalf("unexpected post-switch history: %+v", view)
	}
}

func TestSettlementMidnightFollowsDaylightSavingAndSkippedMidnight(t *testing.T) {
	for _, test := range []struct{ zone, start, target, want string }{
		{"America/New_York", "2026-03-08T05:00:00Z", "2026-03-09", "2026-03-09T04:00:00Z"},
		{"America/New_York", "2026-11-01T04:00:00Z", "2026-11-02", "2026-11-02T05:00:00Z"},
		{"America/Sao_Paulo", "2018-11-03T03:00:00Z", "2018-11-04", "2018-11-04T03:00:00Z"},
	} {
		t.Run(test.zone+test.target, func(t *testing.T) {
			loc, err := loadSettlementZone(test.zone)
			if err != nil {
				t.Fatal(err)
			}
			start, err := time.Parse(time.RFC3339, test.start)
			if err != nil {
				t.Fatal(err)
			}
			if got := firstSettlementBoundary(start, test.target, loc).UTC().Format(time.RFC3339); got != test.want {
				t.Fatalf("boundary %s, want %s", got, test.want)
			}
		})
	}
}

func TestSiteLedgerDefaultsToShanghaiAndMigratesLegacyUTC(t *testing.T) {
	now := time.Date(2026, 11, 21, 17, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	zone, err := loadSettlementZone(defaultSettlementZone)
	if err != nil {
		t.Fatal(err)
	}
	prepare := func(path string, inactive bool) *dailyLedger {
		t.Helper()
		ledger, err := loadLedgerWithDefault(path, 10, 7, clock, inactive, zone)
		if err != nil {
			t.Fatal(err)
		}
		return ledger
	}
	fresh := prepare(filepath.Join(t.TempDir(), "fresh.json"), false)
	if view := fresh.view(7); view.TimeZone != defaultSettlementZone || view.History[6].Day != "2026-11-22" {
		t.Fatalf("fresh ledger isn't using Shanghai: %+v", view)
	}
	legacyPath := filepath.Join(t.TempDir(), "legacy.json")
	if err := os.WriteFile(legacyPath, []byte(`{"version":1,"day":"2026-11-21","public":9,"reserved":5}`), 0600); err != nil {
		t.Fatal(err)
	}
	legacy := prepare(legacyPath, false)
	view := legacy.view(7)
	if view.TimeZone != "UTC" || view.PendingTimeZone != defaultSettlementZone || view.Public.Used != 9 ||
		view.Reserved.Used != 5 || !view.TimeZoneEffectiveAt.Equal(time.Date(2026, 11, 22, 16, 0, 0, 0, time.UTC)) {
		t.Fatalf("legacy quota isn't carried to the safe midnight: %+v", view)
	}
}

func TestBrowserZoneWhenTURNDisabledDoesNotRecordCoverage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.json")
	now := time.Date(2026, 11, 21, 17, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	ledger, err := loadLedger(path, 10, 6, clock, true)
	if err != nil {
		t.Fatal(err)
	}
	loc, err := loadSettlementZone("Pacific/Auckland")
	if err != nil {
		t.Fatal(err)
	}
	if err := ledger.scheduleTimeZone(loc); err != nil {
		t.Fatal(err)
	}
	view := ledger.view(7)
	if view.TimeZone != loc.String() || view.Public.Remaining != 0 || view.History[6].Public != nil {
		t.Fatalf("unexpected coverage while TURN is disabled: %+v", view)
	}
	ledger, err = openLedgerWithClock(path, 10, 6, clock)
	if err != nil {
		t.Fatal(err)
	}
	view = ledger.view(7)
	if view.TimeZone != loc.String() || view.Public.Remaining != 10 || view.History[6].Public == nil {
		t.Fatalf("enabled TURN didn't restore the configured zone: %+v", view)
	}
}
