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
