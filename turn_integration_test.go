package main

import (
	"crypto/tls"
	"encoding/json"
	"errors"
	"net"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/pion/turn/v5"
)

func TestTURNClientsUseOnlyTheirPairAndShareTheHardLimit(t *testing.T) {
	udp, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = udp.Close() })

	ledger, err := openLedger(filepath.Join(t.TempDir(), "usage.json"), 1000, 1000)
	if err != nil {
		t.Fatal(err)
	}
	router := newRelayRouter(net.IPv4(127, 0, 0, 1), ledger)
	stream, clientTLS := openTURNTLSTestListener(t)
	relay, err := serveTURN(router, udp, []net.Listener{stream})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = relay.Close() })

	account := &relayAccount{limit: 8}
	grant, credentials, err := router.issue(account, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, other, err := router.issue(&relayAccount{limit: 10}, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	serverAddr := udp.LocalAddr().String()
	hostClient := turnClient(t, serverAddr, credentials[0])
	host := allocateTURN(t, hostClient)
	secureConnection, err := tls.DialWithDialer(&net.Dialer{Timeout: 3 * time.Second}, "tcp4", stream.Addr().String(), clientTLS)
	if err != nil {
		t.Fatal(err)
	}
	guestClient := turnClientWithConn(t, stream.Addr().String(), credentials[1], turn.NewSTUNConn(secureConnection))
	guest := allocateTURN(t, guestClient)
	strangerClient := turnClient(t, serverAddr, other[1])
	stranger := allocateTURN(t, strangerClient)

	for _, permission := range []struct {
		c       *turn.Client
		address net.Addr
	}{
		{hostClient, guest.LocalAddr()},
		{guestClient, host.LocalAddr()},
		{strangerClient, host.LocalAddr()},
	} {
		if err := permission.c.CreatePermission(permission.address); err != nil {
			t.Fatal(err)
		}
	}
	if err := hostClient.CreatePermission(&net.UDPAddr{IP: net.IPv4(192, 0, 2, 1), Port: 53}); err == nil {
		t.Fatal("TURN granted permission for an external IP")
	}
	if _, err := host.WriteTo([]byte("outside"), stranger.LocalAddr()); err != nil {
		t.Fatal(err)
	}
	assertNoDatagram(t, stranger)

	for _, pair := range [][2]net.PacketConn{{host, guest}, {guest, host}} {
		if _, err := pair[0].WriteTo([]byte("data"), pair[1].LocalAddr()); err != nil {
			t.Fatal(err)
		}
		_ = pair[1].SetReadDeadline(time.Now().Add(time.Second))
		data := make([]byte, 20)
		count, from, err := pair[1].ReadFrom(data)
		if err != nil || string(data[:count]) != "data" || from.String() != pair[0].LocalAddr().String() {
			t.Fatalf("unexpected forwarded datagram: %q %v %v", data[:count], from, err)
		}
	}
	if _, err := host.WriteTo([]byte("limit"), guest.LocalAddr()); err != nil {
		t.Fatal(err)
	}
	assertNoDatagram(t, guest)
	if remaining, reason := router.status(account, grant, false); remaining != 0 || reason != "session_quota" {
		t.Fatalf("expected exhausted session, remaining %d with reason %q", remaining, reason)
	}
	cfg, err := openAdminSettings(t.TempDir(), 1000, 1000)
	if err != nil {
		t.Fatal(err)
	}
	ops := newAdmin("ops", "test", cfg, newHub(router, nil, nil, ""), ledger)
	request := httptest.NewRequest("GET", "/api/admin/dashboard?days=7", nil)
	result := httptest.NewRecorder()
	ops.dashboard(result, request)
	var dashboard adminDashboard
	if err := json.NewDecoder(result.Body).Decode(&dashboard); err != nil {
		t.Fatal(err)
	}
	if len(dashboard.History) != 7 || dashboard.Public.Used != 8 || dashboard.Reserved.Used != 0 ||
		dashboard.History[6].Public == nil || *dashboard.History[6].Public != 8 ||
		dashboard.History[6].Reserved == nil || *dashboard.History[6].Reserved != 0 {
		t.Fatalf("expected the dashboard to count the eight relayed bytes once, got %+v", dashboard)
	}

	unknown := turnClient(t, serverAddr, iceServer{Username: "unknown", Credential: "unknown"})
	if conn, err := unknown.Allocate(); err == nil {
		conn.Close()
		t.Fatal("allocated TURN socket with unissued credentials")
	}
}

func assertNoDatagram(t *testing.T, conn net.PacketConn) {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(100 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	n, from, err := conn.ReadFrom(make([]byte, 20))
	var timeout net.Error
	if n != 0 || from != nil || !errors.As(err, &timeout) || !timeout.Timeout() {
		t.Fatalf("expected a read timeout with no datagram, got %d bytes from %v: %v", n, from, err)
	}
}

func turnClient(t *testing.T, remote string, server iceServer) *turn.Client {
	t.Helper()
	socket, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	return turnClientWithConn(t, remote, server, socket)
}

func turnClientWithConn(t *testing.T, remote string, server iceServer, socket net.PacketConn) *turn.Client {
	t.Helper()
	t.Cleanup(func() { _ = socket.Close() })
	client, err := turn.NewClient(&turn.ClientConfig{
		Conn: socket, TURNServerAddr: remote, Username: server.Username,
		Password: server.Credential, RTO: 40 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	if err := client.Listen(); err != nil {
		t.Fatal(err)
	}
	return client
}

func allocateTURN(t *testing.T, client *turn.Client) net.PacketConn {
	t.Helper()
	conn, err := client.Allocate()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}
