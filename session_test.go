package main

import (
	"encoding/json"
	"errors"
	"net"
	"path/filepath"
	"testing"
	"time"

	"github.com/pion/turn/v5"
)

func TestPairRejectsThirdDeviceAndOnlyHostCanStartRelayAfterFailure(t *testing.T) {
	ledger, err := openLedger(t.TempDir()+"/quota.json", 500_000_000, 500_000_000)
	if err != nil {
		t.Fatal(err)
	}
	router := newRelayRouter([]byte{127, 0, 0, 1}, ledger)
	hub := newHub(router, []string{"stun:127.0.0.1:3478"}, []string{"turn:127.0.0.1:3478"}, "test relay key")
	host, guest, other := testClient("host"), testClient("guest"), testClient("other")
	hub.handle(host, request{Type: "create", Code: "0008"})
	created := expect(t, host, "created")
	hub.handle(other, request{Type: "create", Code: "0008"})
	expect(t, other, "error")
	hub.handle(guest, request{Type: "join", Code: "0008"})
	joined := expect(t, guest, "joined")
	application := expect(t, host, "request")
	hub.handle(other, request{Type: "join", Code: "0008"})
	expect(t, other, "error")
	hub.handle(host, request{Type: "accept", Token: joined.Token})
	expect(t, host, "error")
	hub.handle(host, request{Type: "accept", Token: created.Token, RequestID: application.RequestID})
	directHost := expect(t, host, "start")
	directGuest := expect(t, guest, "start")
	if directHost.Mode != "direct" || !directHost.Initiator || directGuest.Initiator || len(directHost.ICEServers) != 1 || directHost.ICEServers[0].Username != "" {
		t.Fatalf("unexpected direct configuration: %+v", directHost)
	}
	hub.handle(host, request{Type: "ready", Token: created.Token, Epoch: directHost.Epoch})
	if stats := hub.stats(); stats.Active != 1 || stats.Direct != 0 {
		t.Fatalf("one ready peer counted as a direct connection: %+v", stats)
	}
	hub.handle(guest, request{Type: "ready", Token: joined.Token, Epoch: directGuest.Epoch})
	if stats := hub.stats(); stats.Direct != 1 || stats.Relay != 0 {
		t.Fatalf("missing ready direct connection: %+v", stats)
	}

	hub.handle(host, request{Type: "relay", Token: created.Token})
	expect(t, host, "error")
	hub.handle(host, request{Type: "failed", Token: created.Token, Epoch: directHost.Epoch})
	expect(t, host, "failed")
	expect(t, guest, "failed")
	hub.handle(guest, request{Type: "relay", Token: joined.Token})
	expect(t, guest, "error")
	hub.handle(host, request{Type: "relay", Token: created.Token, Key: "incorrect"})
	if message := expect(t, host, "error"); message.Reason != "invalid_key" {
		t.Fatalf("wrong key returned %+v", message)
	}

	hub.handle(host, request{Type: "relay", Token: created.Token})
	free := expect(t, host, "start")
	remote := expect(t, guest, "start")
	if free.Mode != "relay" || free.Remaining != freeRelayBytes || free.ICEServers[0].Username == remote.ICEServers[0].Username {
		t.Fatalf("unexpected relay configuration: %+v", free)
	}
	hub.handle(host, request{Type: "ready", Token: created.Token, Epoch: free.Epoch})
	hub.handle(guest, request{Type: "ready", Token: joined.Token, Epoch: remote.Epoch})
	hub.handle(host, request{Type: "relay", Token: created.Token, Key: "test relay key"})
	if message := expect(t, host, "error"); message.Reason != "relay_upgrade_requires_reservation" {
		t.Fatalf("legacy request should leave the active relay intact, got %+v", message)
	}
	if _, _, ok := router.auth(&turn.RequestAttributes{Username: free.ICEServers[0].Username, Realm: turnRealm}); !ok {
		t.Fatal("legacy request revoked active relay credentials")
	}
	hub.handle(host, request{Type: "relay_upgrade", Token: created.Token, Epoch: directHost.Epoch, Key: "test relay key"})
	expect(t, host, "error")
	hub.handle(host, request{Type: "relay_upgrade", Token: created.Token, Epoch: free.Epoch, Key: "test relay key"})
	paid := expect(t, host, "start")
	expect(t, guest, "start")
	if !paid.Authorized || paid.Epoch <= free.Epoch {
		t.Fatalf("upgrade did not start a new authorized connection: %+v", paid)
	}
	if _, _, ok := router.auth(&turn.RequestAttributes{Username: free.ICEServers[0].Username, Realm: turnRealm}); ok {
		t.Fatal("old relay credentials are still active")
	}

	hub.handle(host, request{Type: "signal", Token: created.Token, Epoch: free.Epoch, Data: json.RawMessage(`{"type":"offer","sdp":"old"}`)})
	select {
	case msg := <-guest.out:
		t.Fatalf("forwarded stale signal: %+v", msg)
	default:
	}
	hub.handle(host, request{Type: "signal", Token: created.Token, Epoch: paid.Epoch, Data: json.RawMessage(`{"type":"offer","sdp":"new"}`)})
	expect(t, guest, "signal")

	hub.handle(host, request{Type: "ready", Token: created.Token, Epoch: paid.Epoch})
	hub.handle(guest, request{Type: "ready", Token: joined.Token, Epoch: paid.Epoch})
	if stats := hub.stats(); stats.Direct != 0 || stats.Relay != 1 || stats.Failures["connection_failed"] != 1 {
		t.Fatalf("unexpected stats after switching to relay: %+v", stats)
	}
	allocate := turn.AllocateListenerConfig{Network: "udp4", Realm: turnRealm, UserID: paid.ICEServers[0].Username}
	existing, _, err := router.AllocatePacketConn(allocate)
	if err != nil {
		t.Fatal(err)
	}
	defer existing.Close()

	dir := t.TempDir()
	cfg, err := openAdminSettings(dir, 500_000_000, 500_000_000)
	if err != nil {
		t.Fatal(err)
	}
	ops := newAdmin("ops", "test", cfg, hub, ledger)
	keyVersion := hub.keyGeneration
	if err := ops.update(configUpdate{KeyAction: "replace", Key: "rotated", Expected: &configExpected{KeyVersion: &keyVersion}}); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := router.auth(&turn.RequestAttributes{Username: paid.ICEServers[0].Username, Realm: turnRealm}); !ok {
		t.Fatal("rotating the key interrupted credentials already issued")
	}
	if replacement, _, err := router.AllocatePacketConn(allocate); err == nil {
		replacement.Close()
		t.Fatal("rotated key's credential allowed a new TURN allocation")
	}

	hub.handle(host, request{Type: "failed", Token: created.Token, Epoch: paid.Epoch})
	expect(t, host, "failed")
	expect(t, guest, "failed")
	hub.handle(host, request{Type: "relay", Token: created.Token, Key: "test relay key"})
	if message := expect(t, host, "error"); message.Reason != "invalid_key" {
		t.Fatal("rotated key remained valid")
	}
	hub.handle(host, request{Type: "relay", Token: created.Token})
	if reconnect := expect(t, host, "start"); reconnect.Authorized {
		t.Fatal("a previous authorization survived rotation on reconnect")
	}
	freeAgain := expect(t, guest, "start")
	hub.handle(host, request{Type: "ready", Token: created.Token, Epoch: freeAgain.Epoch})
	hub.handle(guest, request{Type: "ready", Token: joined.Token, Epoch: freeAgain.Epoch})
	hub.handle(host, request{Type: "relay_upgrade", Token: created.Token, Epoch: freeAgain.Epoch, Key: "rotated"})
	if reconnect := expect(t, host, "start"); !reconnect.Authorized {
		t.Fatal("new key did not authorize relay")
	}
	expect(t, guest, "start")

	hub.detach(host)
	expect(t, guest, "closed")
}

func TestExpiredPairCodeCanBeCreatedAgain(t *testing.T) {
	hub := newHub(nil, nil, nil, "")
	host, newHost := testClient("host"), testClient("new-host")
	hub.handle(host, request{Type: "create", Code: "0090"})
	expect(t, host, "created")
	host.room.expires = time.Now().Add(-time.Second)
	hub.handle(newHost, request{Type: "create", Code: "0090"})
	expect(t, host, "closed")
	expect(t, newHost, "created")
}

func testClient(source string) *sessionClient {
	return &sessionClient{source: source, out: make(chan response, 16)}
}
func expect(t *testing.T, client *sessionClient, kind string) response {
	t.Helper()
	select {
	case event := <-client.out:
		if event.Type != kind {
			t.Fatalf("event = %+v, want %s", event, kind)
		}
		return event
	default:
		t.Fatalf("missing %s event", kind)
		return response{}
	}
}

func TestStaleApprovalCannotAcceptAReplacementGuest(t *testing.T) {
	hub := newHub(nil, nil, nil, "")
	host, first, second := testClient("host"), testClient("first"), testClient("second")
	hub.handle(host, request{Type: "create", Code: "0021"})
	created := expect(t, host, "created")
	hub.handle(first, request{Type: "join", Code: "0021"})
	expect(t, first, "joined")
	old := expect(t, host, "request")
	hub.detach(first)
	expect(t, first, "closed")
	expect(t, host, "waiting")
	hub.handle(second, request{Type: "join", Code: "0021"})
	expect(t, second, "joined")
	newRequest := expect(t, host, "request")
	if old.RequestID == "" || old.RequestID == newRequest.RequestID {
		t.Fatal("join requests reused their approval ID")
	}
	hub.handle(host, request{Type: "accept", Token: created.Token, RequestID: old.RequestID})
	expect(t, host, "error")
	hub.handle(host, request{Type: "accept", Token: created.Token, RequestID: newRequest.RequestID})
	expect(t, host, "start")
	expect(t, second, "start")
}

func TestSignalingCannotBecomeReadyAfterItsDeadline(t *testing.T) {
	h := newHub(nil, nil, nil, "")
	host, guest := testClient("host"), testClient("guest")
	h.handle(host, request{Type: "create", Code: "3691"})
	created := expect(t, host, "created")
	h.handle(guest, request{Type: "join", Code: "3691"})
	expect(t, guest, "joined")
	application := expect(t, host, "request")
	h.handle(host, request{Type: "accept", Token: created.Token, RequestID: application.RequestID})
	start := expect(t, host, "start")
	expect(t, guest, "start")

	host.room.connectUntil = time.Now().Add(-time.Second)
	h.handle(host, request{Type: "ready", Token: created.Token, Epoch: start.Epoch})
	expect(t, host, "failed")
	expect(t, guest, "failed")
	h.tick(time.Now().Add(failedRoomTTL))
	expect(t, host, "closed")
	expect(t, guest, "closed")
}

func TestBrowserFailureDuringQuotaDrainWaitsForTick(t *testing.T) {
	for _, tc := range []struct {
		reason   string
		daily    int64
		room     int64
		writeErr error
	}{
		{"session_quota", 100, 2, errSessionQuota},
		{"global_quota", 2, 100, errGlobalQuota},
	} {
		t.Run(tc.reason, func(t *testing.T) {
			ledger, err := openLedger(filepath.Join(t.TempDir(), "usage.json"), tc.daily, 0)
			if err != nil {
				t.Fatal(err)
			}
			router := newRelayRouter(net.IPv4(192, 0, 2, 1), ledger)
			h := newHub(router, nil, nil, "")
			host, guest := testClient("host"), testClient("guest")
			r := &room{
				host: host, guest: guest, locked: true, epoch: 2, mode: "relay",
				sessionUntil: testExpiry(), account: relayAccount{limit: tc.room}, remaining: 2,
			}
			grant, _, err := router.issue(&r.account, false, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			r.grant = grant
			host.room, host.token, host.ready = r, "host-token", true
			guest.room, guest.token, guest.ready = r, "guest-token", true
			h.rooms[r] = struct{}{}
			src := allocateTestRelay(t, router, grant, true)
			dst := allocateTestRelay(t, router, grant, false)
			for _, packet := range []string{"a", "b"} {
				if _, err := src.WriteTo([]byte(packet), dst.LocalAddr()); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := src.WriteTo([]byte("c"), dst.LocalAddr()); !errors.Is(err, tc.writeErr) {
				t.Fatalf("quota denial = %v, want %v", err, tc.writeErr)
			}

			read := make(chan error, 1)
			go func() {
				_, _, err := dst.ReadFrom(make([]byte, 1))
				read <- err
			}()
			h.handle(host, request{Type: "failed", Token: host.token, Epoch: r.epoch})
			firstReadErr := <-read
			if r.failed || r.grant != grant || len(h.failures) != 0 {
				t.Fatalf("browser failure ended relay while a paid packet was queued: failed=%v, counts=%v", r.failed, h.failures)
			}
			if firstReadErr != nil {
				t.Fatalf("first paid read: %v", firstReadErr)
			}
			h.tick(time.Now())
			for _, client := range []*sessionClient{host, guest} {
				if message := expect(t, client, "balance"); message.Remaining != 0 {
					t.Fatalf("balance during drain = %+v", message)
				}
			}

			buf := make([]byte, 1)
			if n, _, err := dst.ReadFrom(buf); n != 1 || buf[0] != 'b' || err != nil {
				t.Fatalf("final paid read = %q, %v", buf[:n], err)
			}
			h.tick(time.Now())
			for _, client := range []*sessionClient{host, guest} {
				if message := expect(t, client, "failed"); message.Reason != tc.reason {
					t.Fatalf("failure after drain = %+v, want %q", message, tc.reason)
				}
			}
			if len(h.failures) != 1 || h.failures[tc.reason] != 1 || r.grant != nil {
				t.Fatalf("failure accounting after drain = %v, grant still set: %v", h.failures, r.grant != nil)
			}
		})
	}
}
