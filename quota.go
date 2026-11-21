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

var errLedgerUnavailable = errors.New("relay quota ledger unavailable")

type dailyUsage struct {
	Day      string `json:"day"`
	TimeZone string `json:"timeZone,omitempty"`
	Public   int64  `json:"public"`
	Reserved int64  `json:"reserved"`
}

type usageFile struct {
	dailyUsage
	Version         int          `json:"version"`
	History         []dailyUsage `json:"history,omitempty"`
	PendingTimeZone string       `json:"pendingTimeZone,omitempty"`
	SwitchAt        time.Time    `json:"switchAt,omitzero"`
	Unobserved      bool         `json:"unobserved,omitempty"`
}

// Only durable reservations are spendable. After a restart, an unfinished
// reservation from the previous process is counted as spent.
type dailyLedger struct {
	last                        atomic.Pointer[quotaSnapshot]
	mu                          sync.Mutex
	path                        string
	zone, pending               *time.Location
	inactive                    bool
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
	zone                      *time.Location
	switchAt                  time.Time
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
	TimeZone string `json:"timeZone,omitempty"`
	Public   *int64 `json:"public"`
	Reserved *int64 `json:"reserved"`
}

type ledgerView struct {
	Public              poolUsage      `json:"public"`
	Reserved            poolUsage      `json:"reserved"`
	History             []historyPoint `json:"history"`
	LedgerFailed        bool           `json:"ledgerFailed"`
	TimeZone            string         `json:"timeZone"`
	PendingTimeZone     string         `json:"pendingTimeZone,omitempty"`
	TimeZoneEffectiveAt time.Time      `json:"timeZoneEffectiveAt,omitzero"`
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
	return loadLedger(path, publicLimit, reserveLimit, now, false)
}

func loadLedger(path string, publicLimit, reserveLimit int64, now func() time.Time, inactive bool) (*dailyLedger, error) {
	return loadLedgerWithDefault(path, publicLimit, reserveLimit, now, inactive, time.UTC)
}

func loadSiteLedger(path string, publicLimit, reserveLimit int64, inactive bool) (*dailyLedger, error) {
	zone, err := loadSettlementZone(defaultSettlementZone)
	if err != nil {
		return nil, err
	}
	ledger, err := loadLedgerWithDefault(path, publicLimit, reserveLimit, time.Now, inactive, zone)
	if err == nil || !inactive {
		return ledger, err
	}
	log.Printf("read disabled TURN ledger: %v", err)
	ledger = &dailyLedger{
		path: path, publicLimit: publicLimit, reserveLimit: reserveLimit, now: time.Now,
		zone: zone, inactive: true, failed: true, durable: usageFile{Unobserved: true},
	}
	ledger.publish()
	return ledger, nil
}

func loadLedgerWithDefault(path string, publicLimit, reserveLimit int64, now func() time.Time, inactive bool, defaultZone *time.Location) (*dailyLedger, error) {
	l := &dailyLedger{path: path, publicLimit: publicLimit, reserveLimit: reserveLimit, now: now, zone: defaultZone, inactive: inactive}
	usage, err := readUsage(path)
	legacy := err == nil && usage.Version < 2
	switch {
	case errors.Is(err, os.ErrNotExist):
		l.needsWrite = true
	case err != nil:
		return nil, err
	default:
		l.durable = usage
		l.needsWrite = usage.Version == 0
		name := usage.TimeZone
		if name == "" {
			name = "UTC"
		}
		l.zone, err = loadSettlementZone(name)
		if err != nil {
			return nil, err
		}
		l.durable.TimeZone = name
		if usage.PendingTimeZone != "" {
			l.pending, err = loadSettlementZone(usage.PendingTimeZone)
			if err != nil {
				return nil, err
			}
		}
	}
	current := now()
	l.advanceDay(current)
	if legacy && l.zone.String() != defaultZone.String() {
		l.durable, l.zone, l.pending = l.planTimeZone(current, defaultZone)
		l.needsWrite = true
	}
	l.publish()
	return l, nil
}

func (l *dailyLedger) activate() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.advanceDay(l.now())
	if !l.inactive && l.durable.Unobserved {
		l.durable.Unobserved, l.needsWrite = false, true
	}
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
	if !valid(value.dailyUsage) || value.Version < 0 || value.Version > 2 || len(value.History) >= historyDays {
		return errors.New("invalid quota ledger")
	}
	if (value.PendingTimeZone == "") != value.SwitchAt.IsZero() {
		return errors.New("invalid settlement time zone transition")
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
	if l.failed || !dayDue(now, l.durable.Day, l.zone, l.durable.SwitchAt) {
		return
	}
	prior := l.spent()
	zone := l.zone
	if l.pending != nil {
		zone = l.pending
	}
	day := now.In(zone).Format(time.DateOnly)
	if l.pending != nil {
		day = max(day, l.durable.SwitchAt.In(zone).Format(time.DateOnly))
	}
	cutoff := civilOffset(day, 1-historyDays)
	history := l.durable.History
	for len(history) > 0 && history[0].Day < cutoff {
		history = history[1:]
	}
	if prior.Day >= cutoff && !l.durable.Unobserved {
		history = append(history, prior)
	}
	l.durable = usageFile{
		Version: 2, History: history, Unobserved: l.inactive,
		dailyUsage: dailyUsage{Day: day, TimeZone: zone.String()},
	}
	l.zone, l.pending = zone, nil
	l.publicCredit, l.reserveCredit = 0, 0
	l.needsWrite = true
}

func dayDue(now time.Time, day string, zone *time.Location, switchAt time.Time) bool {
	if !switchAt.IsZero() {
		return !now.Before(switchAt)
	}
	return day < now.In(zone).Format(time.DateOnly)
}

func (l *dailyLedger) spent() dailyUsage {
	return dailyUsage{
		Day: l.durable.Day, TimeZone: l.zone.String(),
		Public: l.durable.Public - l.publicCredit, Reserved: l.durable.Reserved - l.reserveCredit,
	}
}

func (l *dailyLedger) rollDay() {
	snapshot := l.last.Load()
	if snapshot.failed || !dayDue(l.now(), snapshot.day, snapshot.zone, snapshot.switchAt) {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.advanceDay(l.now())
	l.persistPending()
	l.publish()
}

func (l *dailyLedger) remaining(authorized bool) int64 {
	remaining, _ := l.balance(authorized)
	return remaining
}

// Signaling reads an advisory snapshot without waiting on a disk sync.
func (l *dailyLedger) balance(authorized bool) (int64, bool) {
	current := l.last.Load()
	if current.failed {
		return 0, false
	}
	public, reserved := current.public, current.reserved
	if dayDue(l.now(), current.day, current.zone, current.switchAt) {
		public, reserved = current.publicLimit, current.reserveLimit
	}
	if authorized {
		return public + reserved, true
	}
	return public, true
}

func (l *dailyLedger) publish() {
	public, reserved := l.available()
	l.last.Store(&quotaSnapshot{
		day: l.durable.Day, zone: l.zone, switchAt: l.durable.SwitchAt, public: public, reserved: reserved, failed: l.blocked(),
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
	public, reserved, err := l.reserveLocked(n, authorized)
	if err != nil {
		return false
	}
	l.spendLocked(public, reserved)
	return true
}

// Keep mu held from reservation through admission so settlement and settings
// changes cannot intervene. Unspent reservations remain available as credit.
func (l *dailyLedger) reserveLocked(n int64, authorized bool) (int64, int64, error) {
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
		if l.blocked() {
			return 0, 0, errLedgerUnavailable
		}
		return 0, 0, errGlobalQuota
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
		return 0, 0, errLedgerUnavailable
	}
	return public, reserved, nil
}

func (l *dailyLedger) spendLocked(public, reserved int64) {
	l.publicCredit -= public
	l.reserveCredit -= reserved
	l.publish()
}

func (l *dailyLedger) persistPending() bool {
	if l.failed {
		return false
	}
	if l.needsWrite {
		l.durable.Version = 2
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
		LedgerFailed: l.blocked(), TimeZone: l.zone.String(),
		PendingTimeZone: l.durable.PendingTimeZone, TimeZoneEffectiveAt: l.durable.SwitchAt,
	}
	var observed *dailyUsage
	if !l.durable.Unobserved {
		observed = &used
	}
	view.History = historyWindow(now.In(l.zone), days, l.durable.History, observed)
	if l.inactive {
		view.Public.Remaining, view.Reserved.Remaining = 0, 0
	}
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
		day := civilOffset(now.Format(time.DateOnly), offset)
		point := historyPoint{Day: day}
		if usage, ok := known[day]; ok {
			point.Public, point.Reserved = &usage.Public, &usage.Reserved
			point.TimeZone = usage.TimeZone
			if point.TimeZone == "" {
				point.TimeZone = "UTC"
			}
		}
		points = append(points, point)
	}
	return points
}

func civilOffset(day string, offset int) string {
	date, _ := time.Parse(time.DateOnly, day)
	return date.AddDate(0, 0, offset).Format(time.DateOnly)
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
