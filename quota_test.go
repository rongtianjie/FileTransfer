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
