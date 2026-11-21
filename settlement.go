package main

import (
	"errors"
	"time"
	_ "time/tzdata"
)

const defaultSettlementZone = "Asia/Shanghai"

var errTimeZoneConflict = errors.New("settlement time zone schedule changed")

func loadSettlementZone(name string) (*time.Location, error) {
	if name == "" || name == "Local" || len(name) > 128 {
		return nil, errors.New("expected an IANA time zone")
	}
	return time.LoadLocation(name)
}

func followingDay(day string) string {
	date, _ := time.Parse(time.DateOnly, day)
	return date.AddDate(0, 0, 1).Format(time.DateOnly)
}

// Locate the first instant at or after start when the target civil date has
// begun. Walking offsets also handles transitions that skip local midnight.
func firstSettlementBoundary(start time.Time, day string, zone *time.Location) time.Time {
	civil, _ := time.Parse(time.DateOnly, day)
	for cursor := start.In(zone); ; {
		_, offset := cursor.Zone()
		_, end := cursor.ZoneBounds()
		candidate := civil.Add(-time.Duration(offset) * time.Second)
		if candidate.Before(cursor) {
			candidate = cursor
		}
		if end.IsZero() || candidate.Before(end) {
			return candidate
		}
		cursor = end.In(zone)
	}
}

func (l *dailyLedger) scheduleTimeZone(zone *time.Location) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.failed {
		return errors.New("quota ledger is unavailable")
	}
	now := l.now()
	l.advanceDay(now)
	if l.durable.PendingTimeZone == zone.String() || (l.pending == nil && l.zone.String() == zone.String()) {
		return l.saveCurrentDay()
	}

	next, active, pending := l.planTimeZone(now, zone)
	return l.saveSchedule(next, active, pending)
}

func (l *dailyLedger) planTimeZone(now time.Time, zone *time.Location) (usageFile, *time.Location, *time.Location) {
	next := l.durable
	if l.pending == nil && l.inactive && l.durable.Unobserved && l.durable.Public == 0 && l.durable.Reserved == 0 && l.durable.Admin == 0 {
		next.Day = now.In(zone).Format(time.DateOnly)
		// If the new local date already has an archived point, keep that
		// point and switch on a later boundary instead.
		if len(next.History) == 0 || next.Day > next.History[len(next.History)-1].Day {
			next.TimeZone, next.PendingTimeZone, next.SwitchAt = zone.String(), "", time.Time{}
			return next, zone, nil
		}
		next.Day = l.durable.Day
	}

	next.PendingTimeZone = zone.String()
	next.SwitchAt = l.nextTimeZoneBoundary(now, zone)
	return next, l.zone, zone
}

func (l *dailyLedger) cancelTimeZone(expectedZone string, expectedAt time.Time) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.failed {
		return errors.New("quota ledger is unavailable")
	}
	now := l.now()
	if l.pending == nil || l.durable.PendingTimeZone == l.zone.String() ||
		l.durable.PendingTimeZone != expectedZone || !l.durable.SwitchAt.Equal(expectedAt) ||
		!now.Before(l.durable.SwitchAt) {
		return errTimeZoneConflict
	}

	// Keep the current bucket and persist a same-zone transition so a restart
	// cannot reset it before the previously announced deadline.
	next := l.durable
	next.PendingTimeZone = l.zone.String()
	next.SwitchAt = l.nextTimeZoneBoundary(now, l.zone)
	return l.saveSchedule(next, l.zone, l.zone)
}

func (l *dailyLedger) saveCurrentDay() error {
	ok := l.persistPending()
	l.publish()
	if !ok {
		return errors.New("could not persist settlement day")
	}
	return nil
}

func (l *dailyLedger) nextTimeZoneBoundary(now time.Time, zone *time.Location) time.Time {
	floor := l.durable.SwitchAt
	nextDay := followingDay(l.durable.Day)
	if floor.IsZero() {
		floor = firstSettlementBoundary(now, nextDay, l.zone)
	}
	// A new bucket must have a later date label so records aren't merged
	// when the administrator moves the clock west.
	target := max(followingDay(now.In(zone).Format(time.DateOnly)), nextDay)
	switchAt := firstSettlementBoundary(now, target, zone)
	if switchAt.Before(floor) {
		floorDay := floor.In(zone).Format(time.DateOnly)
		if floor.Add(-time.Nanosecond).In(zone).Format(time.DateOnly) < floorDay {
			switchAt = floor
		} else {
			switchAt = firstSettlementBoundary(floor, followingDay(floorDay), zone)
		}
	}
	return switchAt.UTC()
}

func (l *dailyLedger) saveSchedule(next usageFile, zone, pending *time.Location) error {
	next.Version = 2
	if err := persistJSON(l.path, next); err != nil {
		var uncertain replacedFileError
		if errors.As(err, &uncertain) {
			l.failed = true
		}
		l.publish()
		return err
	}
	l.durable, l.zone, l.pending = next, zone, pending
	l.needsWrite = false
	l.publish()
	return nil
}
