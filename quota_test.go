package main

import (
	"path/filepath"
	"testing"
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
