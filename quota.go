package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

const (
	reservationSize int64 = 256 * 1024
	historyDays           = 90
)

type dailyUsage struct {
	Day      string `json:"day"`
	Public   int64  `json:"public"`
	Reserved int64  `json:"reserved"`
}

type usageFile struct {
	dailyUsage
	Version int          `json:"version"`
	History []dailyUsage `json:"history,omitempty"`
}

// Only durable reservations are spendable. After a restart, an unfinished
// reservation from the previous process is counted as spent.
type dailyLedger struct {
	last                        atomic.Pointer[quotaSnapshot]
	mu                          sync.Mutex
	path                        string
	now                         func() time.Time
	publicLimit, reserveLimit   int64
	durable                     usageFile
	publicCredit, reserveCredit int64
	failed                      bool
	settingsUncertain           bool
	needsWrite                  bool
}

type quotaSnapshot struct {
	day                       string
	public, reserved          int64
	publicLimit, reserveLimit int64
	failed                    bool
}

type poolUsage struct {
	Used      int64 `json:"used"`
	Limit     int64 `json:"limit"`
	Remaining int64 `json:"remaining"`
}

type historyPoint struct {
	Day      string `json:"day"`
	Public   *int64 `json:"public"`
	Reserved *int64 `json:"reserved"`
}

type ledgerView struct {
	Public       poolUsage      `json:"public"`
	Reserved     poolUsage      `json:"reserved"`
	History      []historyPoint `json:"history"`
	LedgerFailed bool           `json:"ledgerFailed"`
}

func openLedger(path string, publicLimit, reserveLimit int64) (*dailyLedger, error) {
	return openLedgerWithClock(path, publicLimit, reserveLimit, time.Now)
}

func openLedgerWithClock(path string, publicLimit, reserveLimit int64, now func() time.Time) (*dailyLedger, error) {
	l, err := prepareLedger(path, publicLimit, reserveLimit, now)
	if err != nil {
		return nil, err
	}
	if err := l.activate(); err != nil {
		return nil, err
	}
	return l, nil
}

func prepareLedger(path string, publicLimit, reserveLimit int64, now func() time.Time) (*dailyLedger, error) {
	l := &dailyLedger{path: path, publicLimit: publicLimit, reserveLimit: reserveLimit, now: now}
	usage, err := readUsage(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		l.needsWrite = true
	case err != nil:
		return nil, err
	default:
		l.durable = usage
		l.needsWrite = usage.Version == 0
	}
	l.advanceDay(now())
	l.publish()
	return l, nil
}

func (l *dailyLedger) activate() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.advanceDay(l.now())
	ok := l.persistPending()
	l.publish()
	if !ok {
		return errors.New("initialize quota ledger")
	}
	return nil
}

func readUsage(path string) (usageFile, error) {
	var usage usageFile
	data, err := os.ReadFile(path)
	if err != nil {
		return usage, err
	}
	if err := json.Unmarshal(data, &usage); err != nil {
		return usage, fmt.Errorf("read quota ledger: %w", err)
	}
	return usage, validateUsage(usage)
}

func validateUsage(value usageFile) error {
	valid := func(usage dailyUsage) bool {
		_, err := time.Parse(time.DateOnly, usage.Day)
		return err == nil && usage.Public >= 0 && usage.Reserved >= 0
	}
	if !valid(value.dailyUsage) || value.Version < 0 || value.Version > 1 || len(value.History) >= historyDays {
		return errors.New("invalid quota ledger")
	}
	previous := ""
	for _, usage := range value.History {
		if !valid(usage) || usage.Day <= previous || usage.Day >= value.Day {
			return errors.New("invalid quota history")
		}
		previous = usage.Day
	}
	return nil
}

// Advance only the observed day. Dates skipped while offline remain missing.
func (l *dailyLedger) advanceDay(now time.Time) {
	now = now.UTC()
	day := now.Format(time.DateOnly)
	if l.failed || l.durable.Day >= day {
		return
	}
	cutoff := now.AddDate(0, 0, 1-historyDays).Format(time.DateOnly)
	history := l.durable.History
	for len(history) > 0 && history[0].Day < cutoff {
		history = history[1:]
	}
	if l.durable.Day >= cutoff {
		history = append(history, l.spent())
	}
	l.durable = usageFile{Version: 1, History: history, dailyUsage: dailyUsage{Day: day}}
	l.publicCredit, l.reserveCredit = 0, 0
	l.needsWrite = true
}

func (l *dailyLedger) spent() dailyUsage {
	return dailyUsage{Day: l.durable.Day, Public: l.durable.Public - l.publicCredit, Reserved: l.durable.Reserved - l.reserveCredit}
}

func (l *dailyLedger) rollDay() {
	snapshot := l.last.Load()
	if snapshot.failed || snapshot.day >= l.now().UTC().Format(time.DateOnly) {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.advanceDay(l.now())
	l.persistPending()
	l.publish()
}

// Signaling reads an advisory snapshot without waiting on a disk sync.
func (l *dailyLedger) remaining(authorized bool) int64 {
	current := l.last.Load()
	if current.failed {
		return 0
	}
	public, reserved := current.public, current.reserved
	if current.day < l.now().UTC().Format(time.DateOnly) {
		public, reserved = current.publicLimit, current.reserveLimit
	}
	if authorized {
		return public + reserved
	}
	return public
}

func (l *dailyLedger) publish() {
	public, reserved := l.available()
	l.last.Store(&quotaSnapshot{
		day: l.durable.Day, public: public, reserved: reserved, failed: l.blocked(),
		publicLimit: l.publicLimit, reserveLimit: l.reserveLimit,
	})
}

func (l *dailyLedger) blocked() bool {
	return l.failed || l.settingsUncertain
}

func (l *dailyLedger) available() (int64, int64) {
	if l.blocked() {
		return 0, 0
	}
	used := l.spent()
	return max(0, l.publicLimit-used.Public), max(0, l.reserveLimit-used.Reserved)
}

func (l *dailyLedger) charge(n int64, authorized bool) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.advanceDay(l.now())
	public, reserved := l.available()
	limit := public
	if authorized {
		limit += reserved
	}
	if n < 0 || n > limit || l.blocked() {
		if l.needsWrite {
			l.persistPending()
			l.publish()
		}
		return false
	}
	public = min(n, public)
	reserved = n - public
	publicBlock := reserveBlock(public, l.publicCredit, l.publicLimit-l.durable.Public)
	reservedBlock := reserveBlock(reserved, l.reserveCredit, l.reserveLimit-l.durable.Reserved)
	l.durable.Public += publicBlock
	l.durable.Reserved += reservedBlock
	l.needsWrite = l.needsWrite || publicBlock != 0 || reservedBlock != 0
	l.publicCredit += publicBlock
	l.reserveCredit += reservedBlock
	if !l.persistPending() {
		l.publish()
		return false
	}
	l.publicCredit -= public
	l.reserveCredit -= reserved
	l.publish()
	return true
}

func (l *dailyLedger) persistPending() bool {
	if l.failed {
		return false
	}
	if l.needsWrite {
		l.durable.Version = 1
		if err := persistJSON(l.path, l.durable); err != nil {
			l.failed = true
			log.Printf("TURN quota persistence failed: %v", err)
			return false
		}
		l.needsWrite = false
	}
	return true
}

func (l *dailyLedger) view(days int) ledgerView {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.advanceDay(now)
	if l.needsWrite {
		l.persistPending()
		l.publish()
	}
	used := l.spent()
	public, reserved := l.available()
	view := ledgerView{
		Public:       poolUsage{Used: used.Public, Limit: l.publicLimit, Remaining: public},
		Reserved:     poolUsage{Used: used.Reserved, Limit: l.reserveLimit, Remaining: reserved},
		LedgerFailed: l.blocked(),
	}
	view.History = historyWindow(now, days, l.durable.History, &used)
	return view
}

func historyWindow(now time.Time, days int, history []dailyUsage, current *dailyUsage) []historyPoint {
	known := make(map[string]dailyUsage, len(history)+1)
	for _, point := range history {
		known[point.Day] = point
	}
	if current != nil {
		known[current.Day] = *current
	}
	points := make([]historyPoint, 0, days)
	for offset := 1 - days; offset <= 0; offset++ {
		day := now.UTC().AddDate(0, 0, offset).Format(time.DateOnly)
		point := historyPoint{Day: day}
		if usage, ok := known[day]; ok {
			point.Public, point.Reserved = &usage.Public, &usage.Reserved
		}
		points = append(points, point)
	}
	return points
}

func reserveBlock(needed, credit, unreserved int64) int64 {
	if needed <= credit {
		return 0
	}
	return min(unreserved, max(reservationSize, needed-credit))
}

type replacedFileError struct{ error }

func persistJSON(path string, value any) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".filetransfer-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	err = json.NewEncoder(tmp).Encode(value)
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	directory, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer directory.Close()
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	if err := directory.Sync(); err != nil {
		return replacedFileError{err}
	}
	return nil
}
