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

const reservationSize int64 = 256 * 1024

type dailyUsage struct {
	Day      string `json:"day"`
	Public   int64  `json:"public"`
	Reserved int64  `json:"reserved"`
}

// Only durable reservations are spendable. A crash may forfeit the unused
// tail of each reservation but cannot restore previously spent daily quota.
type dailyLedger struct {
	last                        atomic.Pointer[quotaSnapshot]
	mu                          sync.Mutex
	path                        string
	publicLimit, reserveLimit   int64
	durable                     dailyUsage
	publicCredit, reserveCredit int64
	failed                      bool
}

type quotaSnapshot struct {
	day              string
	public, reserved int64
	failed           bool
}

func openLedger(path string, publicLimit, reserveLimit int64) (*dailyLedger, error) {
	ledger := &dailyLedger{path: path, publicLimit: publicLimit, reserveLimit: reserveLimit}
	data, err := os.ReadFile(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		ledger.publish()
		return ledger, nil
	case err != nil:
		return nil, err
	}
	if err := json.Unmarshal(data, &ledger.durable); err != nil {
		return nil, fmt.Errorf("read quota ledger: %w", err)
	}
	if _, err := time.Parse(time.DateOnly, ledger.durable.Day); err != nil || ledger.durable.Public < 0 || ledger.durable.Reserved < 0 {
		return nil, errors.New("invalid quota ledger")
	}
	ledger.publish()
	return ledger, nil
}

func (l *dailyLedger) resetDay() {
	day := time.Now().UTC().Format(time.DateOnly)
	if l.durable.Day < day {
		l.durable = dailyUsage{Day: day}
		l.publicCredit, l.reserveCredit = 0, 0
	}
}

// Signaling reads an advisory snapshot without waiting on a disk sync.
// Only charge decides whether a packet can be forwarded.
func (l *dailyLedger) remaining(authorized bool) int64 {
	current := l.last.Load()
	if current.failed {
		return 0
	}
	if current.day < time.Now().UTC().Format(time.DateOnly) {
		if authorized {
			return l.publicLimit + l.reserveLimit
		}
		return l.publicLimit
	}
	if authorized {
		return current.public + current.reserved
	}
	return current.public
}

func (l *dailyLedger) publish() {
	public := l.available(false)
	l.last.Store(&quotaSnapshot{
		day: l.durable.Day, public: public, reserved: l.available(true) - public, failed: l.failed,
	})
}

func (l *dailyLedger) available(authorized bool) int64 {
	if l.failed {
		return 0
	}
	public := max(0, l.publicLimit-l.durable.Public+l.publicCredit)
	if !authorized {
		return public
	}
	return public + max(0, l.reserveLimit-l.durable.Reserved+l.reserveCredit)
}

func (l *dailyLedger) charge(n int64, authorized bool) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.resetDay()
	if n < 0 || n > l.available(authorized) || l.failed {
		return false
	}
	public := min(n, l.available(false))
	reserved := n - public
	next := l.durable
	publicBlock := reserveBlock(public, l.publicCredit, l.publicLimit-next.Public)
	reserveBlock := reserveBlock(reserved, l.reserveCredit, l.reserveLimit-next.Reserved)
	next.Public += publicBlock
	next.Reserved += reserveBlock
	if next != l.durable {
		if err := persistUsage(l.path, next); err != nil {
			l.failed = true
			l.publish()
			log.Printf("TURN quota persistence failed: %v", err)
			return false
		}
		l.durable = next
	}
	l.publicCredit += publicBlock - public
	l.reserveCredit += reserveBlock - reserved
	l.publish()
	return true
}

func reserveBlock(needed, credit, unreserved int64) int64 {
	if needed <= credit {
		return 0
	}
	return min(unreserved, max(reservationSize, needed-credit))
}

func persistUsage(path string, value dailyUsage) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".relay-usage-*")
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
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	directory, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
