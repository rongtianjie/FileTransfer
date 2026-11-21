package main

import (
	"bytes"
	"errors"
	"net"
	"path/filepath"
	"testing"
	"time"

	"github.com/pion/turn/v5"
)

func TestRelayRoutesOnlyToOtherSideAndChargesOnce(t *testing.T) {
	ledger, err := openLedger(filepath.Join(t.TempDir(), "usage.json"), 100, 100)
	if err != nil {
		t.Fatal(err)
	}
	router := newRelayRouter(net.IPv4(192, 0, 2, 1), ledger)
	first := &relayGrant{account: &relayAccount{limit: 8}, expires: testExpiry()}
	second := &relayGrant{account: &relayAccount{limit: 8}, expires: testExpiry()}
	host := allocateTestRelay(t, router, first, true)
	guest := allocateTestRelay(t, router, first, false)
	stranger := allocateTestRelay(t, router, second, false)

	if _, err := host.WriteTo([]byte("test"), stranger.LocalAddr()); !errors.Is(err, errRelayPeer) {
		t.Fatalf("cross-room routing returned %v", err)
	}
	if _, err := host.WriteTo([]byte("test"), &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 53}); !errors.Is(err, errRelayPeer) {
		t.Fatalf("external routing returned %v", err)
	}
	for _, route := range [][2]net.PacketConn{{host, guest}, {guest, host}} {
		if _, err := route[0].WriteTo([]byte("test"), route[1].LocalAddr()); err != nil {
			t.Fatal(err)
		}
		output := make([]byte, 4)
		n, from, err := route[1].ReadFrom(output)
		if n != 4 || err != nil || from.String() != route[0].LocalAddr().String() || !bytes.Equal(output, []byte("test")) {
			t.Fatalf("unexpected received packet %q from %v: %v", output, from, err)
		}
	}
	if _, err := host.WriteTo([]byte("x"), guest.LocalAddr()); !errors.Is(err, errSessionQuota) {
		t.Fatalf("over-quota packet returned %v", err)
	}
}

func testExpiry() time.Time { return time.Now().Add(time.Minute) }

func allocateTestRelay(t *testing.T, router *relayRouter, grant *relayGrant, host bool) net.PacketConn {
	t.Helper()
	name, err := randomToken()
	if err != nil {
		t.Fatal(err)
	}
	router.users[name] = &relayCredential{grant: grant, host: host}
	socket, _, err := router.AllocatePacketConn(turn.AllocateListenerConfig{Network: "udp4", UserID: name, Realm: turnRealm})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = socket.Close() })
	return socket
}

func TestRelayDiscardDuringReservationDoesNotSpend(t *testing.T) {
	for _, endGrant := range []string{"revoke", "expire"} {
		t.Run(endGrant, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "usage.json")
			ledger, err := openLedger(path, 2, 10)
			if err != nil {
				t.Fatal(err)
			}
			router := newRelayRouter(net.IPv4(192, 0, 2, 1), ledger)
			grant := &relayGrant{authorized: true, expires: testExpiry()}
			host := allocateTestRelay(t, router, grant, true)
			guest := allocateTestRelay(t, router, grant, false)

			reserving := make(chan struct{})
			resume := make(chan struct{})
			now := ledger.now
			ledger.now = func() time.Time {
				close(reserving)
				<-resume
				return now()
			}
			result := make(chan error, 1)
			go func() {
				_, err := host.WriteTo([]byte("test"), guest.LocalAddr())
				result <- err
			}()
			<-reserving
			ended := make(chan struct{})
			go func() {
				defer close(ended)
				if endGrant == "revoke" {
					router.revoke(grant)
				} else {
					router.mu.Lock()
					grant.expires = time.Now()
					router.mu.Unlock()
				}
			}()
			select {
			case <-ended:
				close(resume)
			case <-time.After(time.Second):
				close(resume)
				t.Fatal("grant lifecycle blocked on ledger reservation")
			}
			if err := <-result; !errors.Is(err, errRelayPeer) {
				t.Fatalf("discarded packet returned %v", err)
			}
			ledger.now = now
			if view := ledger.view(1); view.Public.Used != 0 || view.Reserved.Used != 0 {
				t.Fatalf("discarded packet consumed public=%d reserved=%d bytes", view.Public.Used, view.Reserved.Used)
			}
			durable, err := readUsage(path)
			if err != nil || durable.Public != 2 || durable.Reserved != 10 {
				t.Fatalf("expected both pools to retain durable reservations, got %+v, %v", durable, err)
			}
			next := &relayGrant{authorized: true, expires: testExpiry()}
			nextHost := allocateTestRelay(t, router, next, true)
			nextGuest := allocateTestRelay(t, router, next, false)
			if n, err := nextHost.WriteTo(make([]byte, 12), nextGuest.LocalAddr()); n != 12 || err != nil {
				t.Fatalf("could not reuse durable credit: wrote %d bytes, %v", n, err)
			}
		})
	}
}

func TestRelayPaidQueueDrainsAfterQuotaDenial(t *testing.T) {
	for _, tc := range []struct {
		reason      string
		publicLimit int64
		roomLimit   int64
		denial      error
	}{
		{"session_quota", 100, 4, errSessionQuota},
		{"global_quota", 4, 100, errGlobalQuota},
	} {
		t.Run(tc.reason, func(t *testing.T) {
			ledger, err := openLedger(filepath.Join(t.TempDir(), "usage.json"), tc.publicLimit, 0)
			if err != nil {
				t.Fatal(err)
			}
			router := newRelayRouter(net.IPv4(192, 0, 2, 1), ledger)
			grant := &relayGrant{account: &relayAccount{limit: tc.roomLimit}, expires: testExpiry()}
			host := allocateTestRelay(t, router, grant, true)
			guest := allocateTestRelay(t, router, grant, false)
			for _, packet := range []string{"one", "!"} {
				if _, err := host.WriteTo([]byte(packet), guest.LocalAddr()); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := host.WriteTo([]byte("x"), guest.LocalAddr()); !errors.Is(err, tc.denial) {
				t.Fatalf("expected quota denial, got %v", err)
			}
			if _, err := guest.WriteTo([]byte("x"), host.LocalAddr()); err == nil {
				t.Fatal("admitted a new packet after quota denial")
			}
			for _, want := range []string{"one", "!"} {
				if remaining, reason := router.status(grant.account, grant, false); remaining != 0 || reason != "" {
					t.Errorf("status while paid packets are queued = (%d, %q)", remaining, reason)
				}
				buf := make([]byte, 16)
				n, from, err := guest.ReadFrom(buf)
				if err != nil || string(buf[:n]) != want || from == nil || from.String() != host.LocalAddr().String() {
					t.Fatalf("reading paid packet: got %q from %v, %v", buf[:n], from, err)
				}
			}
			if remaining, reason := router.status(grant.account, grant, false); remaining != 0 || reason != tc.reason {
				t.Fatalf("status after drain = (%d, %q), want (0, %q)", remaining, reason, tc.reason)
			}
		})
	}
}

func TestRelayLedgerFaultStatus(t *testing.T) {
	ledger, err := openLedger(filepath.Join(t.TempDir(), "usage.json"), 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	router := newRelayRouter(net.IPv4(192, 0, 2, 1), ledger)
	grant := &relayGrant{account: &relayAccount{limit: 100}, expires: testExpiry()}
	host := allocateTestRelay(t, router, grant, true)
	guest := allocateTestRelay(t, router, grant, false)
	ledger.path = filepath.Join(t.TempDir(), "missing", "usage.json")
	if n, err := host.WriteTo([]byte("test"), guest.LocalAddr()); n != 0 || err == nil || errors.Is(err, errGlobalQuota) {
		t.Errorf("failed persistence write: got %d bytes, %v", n, err)
	}
	other := &relayGrant{account: grant.account, expires: testExpiry()}
	for _, current := range []*relayGrant{nil, grant, other} {
		if remaining, reason := router.status(grant.account, current, false); remaining != 0 || reason != "ledger_unavailable" {
			t.Errorf("status for grant %p = (%d, %q), want (0, ledger_unavailable)", current, remaining, reason)
		}
	}
}

func TestRelayHardEndOverridesQuotaDrain(t *testing.T) {
	for _, endGrant := range []string{"revoke", "expire"} {
		t.Run(endGrant, func(t *testing.T) {
			ledger, err := openLedger(filepath.Join(t.TempDir(), "usage.json"), 100, 0)
			if err != nil {
				t.Fatal(err)
			}
			router := newRelayRouter(net.IPv4(192, 0, 2, 1), ledger)
			grant := &relayGrant{account: &relayAccount{limit: 4}, expires: testExpiry()}
			host := allocateTestRelay(t, router, grant, true)
			guest := allocateTestRelay(t, router, grant, false)
			if _, err := host.WriteTo([]byte("paid"), guest.LocalAddr()); err != nil {
				t.Fatal(err)
			}
			if _, err := host.WriteTo([]byte("x"), guest.LocalAddr()); !errors.Is(err, errSessionQuota) {
				t.Fatalf("expected session quota denial, got %v", err)
			}
			if endGrant == "revoke" {
				router.revoke(grant)
			} else {
				router.mu.Lock()
				grant.expires = time.Now()
				router.mu.Unlock()
				if _, reason := router.status(grant.account, grant, false); reason != "relay_expired" {
					t.Errorf("expired grant status reason = %q", reason)
				}
			}
			if n, from, err := guest.ReadFrom(make([]byte, 16)); n != 0 || from != nil || !errors.Is(err, net.ErrClosed) {
				t.Fatalf("hard-ended grant read %d bytes from %v: %v", n, from, err)
			}
			if view := ledger.view(1); view.Public.Used != 4 {
				t.Fatalf("admitted packet should remain charged, used %d bytes", view.Public.Used)
			}
		})
	}
}

func TestRelayFullQueueAndClosePreserveAccounting(t *testing.T) {
	ledger, err := openLedger(filepath.Join(t.TempDir(), "usage.json"), 1000, 0)
	if err != nil {
		t.Fatal(err)
	}
	router := newRelayRouter(net.IPv4(192, 0, 2, 1), ledger)
	grant := &relayGrant{account: &relayAccount{limit: 64}, expires: testExpiry()}
	host := allocateTestRelay(t, router, grant, true)
	guest := allocateTestRelay(t, router, grant, false)
	other := allocateTestRelay(t, router, grant, false)
	for range 64 {
		if _, err := host.WriteTo([]byte("x"), guest.LocalAddr()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := host.WriteTo([]byte("x"), guest.LocalAddr()); !errors.Is(err, errRelayBusy) {
		t.Fatalf("write to full queue returned %v", err)
	}
	if _, err := host.WriteTo([]byte("x"), other.LocalAddr()); !errors.Is(err, errSessionQuota) {
		t.Fatalf("write above session quota returned %v", err)
	}
	if err := guest.Close(); err != nil {
		t.Fatal(err)
	}
	if remaining, reason := router.status(grant.account, grant, false); remaining != 0 || reason != "session_quota" {
		t.Fatalf("status after queued socket closed = (%d, %q)", remaining, reason)
	}
	if used := ledger.view(1).Public.Used; used != 64 {
		t.Fatalf("ledger used %d bytes after admitting 64", used)
	}
}
