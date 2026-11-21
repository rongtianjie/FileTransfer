package main

import (
	"encoding/json"
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
	hub.handle(host, request{Type: "relay", Token: created.Token, Key: "test relay key"})
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
