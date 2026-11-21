package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"math/big"
	"net"
	"os"
	"sync"
	"testing"
	"time"
)

const turnTLSTestTimeout = 3 * time.Second

func TestTURNTLSRequiresConfig(t *testing.T) {
	for _, config := range []*tls.Config{nil, {}} {
		listener, err := listenTURNWithTLS("127.0.0.1:0", config)
		if err == nil {
			listener.Close()
			t.Fatal("listener started without a TLS certificate configuration")
		}
	}
}

func TestTURNTLSConnectionLimits(t *testing.T) {
	for _, tc := range []struct {
		name                  string
		globalLimit, accepted int
	}{
		{name: "per source", globalLimit: 256, accepted: 16},
		{name: "global", globalLimit: 2, accepted: 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			listener, _ := openTURNTLSTestListener(t)
			listener.maxConnections = tc.globalLimit
			var accepted net.Conn
			for i := 0; i < tc.accepted; i++ {
				dialTURNTLSTestTCP(t, listener)
				accepted = acceptTURNTLSTestConn(t, startTURNTLSTestAccept(listener))
			}

			// A rejected socket must never reach Pion's Accept loop.
			next := startTURNTLSTestAccept(listener)
			rejected := dialTURNTLSTestTCP(t, listener)
			if _, err := rejected.Read(make([]byte, 1)); err == nil || errors.Is(err, os.ErrDeadlineExceeded) {
				t.Fatalf("excess connection was not promptly closed: %v", err)
			}

			// Retrying Close must not release another connection's slot.
			if err := accepted.Close(); err != nil {
				t.Fatal(err)
			}
			if err := accepted.Close(); err != nil {
				t.Fatal(err)
			}
			client := dialTURNTLSTestTCP(t, listener)
			replacement := acceptTURNTLSTestConn(t, next)
			if replacement.RemoteAddr().String() != client.LocalAddr().String() {
				t.Fatalf("Accept returned %v, want replacement %v", replacement.RemoteAddr(), client.LocalAddr())
			}
			rejected = dialTURNTLSTestTCP(t, listener)
			next = startTURNTLSTestAccept(listener)
			if _, err := rejected.Read(make([]byte, 1)); err == nil || errors.Is(err, os.ErrDeadlineExceeded) {
				t.Fatalf("second excess connection was not promptly closed: %v", err)
			}
			if err := listener.Close(); err != nil {
				t.Fatal(err)
			}
			if result := <-next; !errors.Is(result.err, net.ErrClosed) {
				t.Fatalf("Accept after shutdown returned %+v", result)
			}
		})
	}
}

func TestTURNTLSRejectsPlaintext(t *testing.T) {
	listener, _ := openTURNTLSTestListener(t)
	client := dialTURNTLSTestTCP(t, listener)
	server := acceptTURNTLSTestConn(t, startTURNTLSTestAccept(listener))
	if _, err := client.Write([]byte("plain TURN data")); err != nil {
		t.Fatal(err)
	}
	if n, err := server.Read(make([]byte, 64)); n != 0 || err == nil || errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("plaintext read returned %d bytes, %v", n, err)
	}
}

func TestTURNTLSHandshakeDeadline(t *testing.T) {
	listener, config := openTURNTLSTestListener(t)
	listener.handshakeTimeout = 250 * time.Millisecond
	stalled := dialTURNTLSTestTCP(t, listener)
	server := acceptTURNTLSTestConn(t, startTURNTLSTestAccept(listener))
	tlsHeader := []byte{22, 3, 1, 4, 0}
	if _, err := stalled.Write(tlsHeader); err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				if _, err := stalled.Write([]byte{0}); err != nil {
					return
				}
			}
		}
	}()
	pending := make(chan error, 1)
	go func() {
		_, err := server.Read(make([]byte, 1))
		pending <- err
	}()

	// A stalled handshake must leave the listener available to the next client.
	client, peer := connectTURNTLSTestClient(t, listener, config)
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	peer.Close()
	select {
	case err := <-pending:
		if !errors.Is(err, os.ErrDeadlineExceeded) {
			t.Fatalf("stalled handshake returned %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("handshake deadline was not enforced while records trickled in")
	}
}

func TestTURNTLSIdleReadAndConcurrentWrites(t *testing.T) {
	listener, config := openTURNTLSTestListener(t)
	listener.readTimeout = 300 * time.Millisecond
	client, server := connectTURNTLSTestClient(t, listener, config)
	var writes sync.WaitGroup
	for _, b := range []byte{'a', 'b', 'c', 'd'} {
		writes.Add(1)
		go func(b byte) {
			defer writes.Done()
			if _, err := server.Write([]byte{b}); err != nil {
				t.Errorf("server Write: %v", err)
			}
		}(b)
	}
	defer writes.Wait()
	data := make([]byte, 4)
	if _, err := io.ReadFull(client, data); err != nil {
		t.Fatal(err)
	}
	seen := make(map[byte]bool)
	for _, b := range data {
		seen[b] = true
	}
	if len(seen) != 4 || !seen['a'] || !seen['b'] || !seen['c'] || !seen['d'] {
		t.Fatalf("unexpected TLS data %q", data)
	}

	if _, err := client.Write([]byte("reply")); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 5)
	if _, err := io.ReadFull(server, reply); err != nil || string(reply) != "reply" {
		t.Fatalf("server read %q, %v", reply, err)
	}

	if err := server.SetReadDeadline(time.Now().Add(turnTLSTestTimeout)); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if _, err := server.Read(make([]byte, 1)); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("idle TLS Read returned %v", err)
	}
	if elapsed := time.Since(start); elapsed >= time.Second {
		t.Fatalf("idle read deadline was extended by SetReadDeadline: %v", elapsed)
	}
}

func TestTURNTLSIdleWrite(t *testing.T) {
	listener, config := openTURNTLSTestListener(t)
	listener.writeTimeout = 300 * time.Millisecond
	client, server := connectTURNTLSTestClient(t, listener, config)
	if err := server.transport.Conn.(*net.TCPConn).SetWriteBuffer(1024); err != nil {
		t.Fatal(err)
	}
	if err := client.NetConn().(*net.TCPConn).SetReadBuffer(1024); err != nil {
		t.Fatal(err)
	}
	// The peer stops reading, so the TCP send buffer fills.
	if _, err := server.Write(make([]byte, 4<<20)); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("blocked TLS Write returned %v", err)
	}
}

func TestTURNTLSShutdownUnblocksAcceptAndConnections(t *testing.T) {
	listener, config := openTURNTLSTestListener(t)
	client, server := connectTURNTLSTestClient(t, listener, config)
	stalled := dialTURNTLSTestTCP(t, listener)
	handshaking := acceptTURNTLSTestConn(t, startTURNTLSTestAccept(listener))
	next := startTURNTLSTestAccept(listener)

	reads := make(chan error, 2)
	for _, conn := range []net.Conn{server, handshaking} {
		go func(conn net.Conn) {
			_, err := conn.Read(make([]byte, 1))
			reads <- err
		}(conn)
	}
	closed := make(chan error, 1)
	go func() { closed <- listener.Close() }()
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(turnTLSTestTimeout):
		t.Fatal("listener Close blocked")
	}
	if result := <-next; !errors.Is(result.err, net.ErrClosed) {
		t.Fatalf("Accept after shutdown returned %+v", result)
	}
	for _, conn := range []net.Conn{client, stalled} {
		if _, err := conn.Read(make([]byte, 1)); err == nil || errors.Is(err, os.ErrDeadlineExceeded) {
			t.Fatalf("client Read after shutdown returned %v", err)
		}
	}
	for i := 0; i < 2; i++ {
		select {
		case err := <-reads:
			if !errors.Is(err, net.ErrClosed) {
				t.Fatalf("server Read after shutdown returned %v", err)
			}
		case <-time.After(turnTLSTestTimeout):
			t.Fatal("server Read remained blocked after shutdown")
		}
	}
}

func openTURNTLSTestListener(t *testing.T) (*turnTLSListener, *tls.Config) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		DNSNames:     []string{"localhost"},
		NotBefore:    time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(parsed)
	listener, err := listenTURNWithTLS("127.0.0.1:0", &tls.Config{
		Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener.(*turnTLSListener), &tls.Config{ServerName: "localhost", RootCAs: roots}
}

type turnTLSTestAcceptResult struct {
	conn net.Conn
	err  error
}

func startTURNTLSTestAccept(listener net.Listener) <-chan turnTLSTestAcceptResult {
	result := make(chan turnTLSTestAcceptResult, 1)
	go func() {
		conn, err := listener.Accept()
		result <- turnTLSTestAcceptResult{conn, err}
	}()
	return result
}

func acceptTURNTLSTestConn(t *testing.T, pending <-chan turnTLSTestAcceptResult) *turnTLSConn {
	t.Helper()
	select {
	case result := <-pending:
		if result.err != nil {
			t.Fatal(result.err)
		}
		return result.conn.(*turnTLSConn)
	case <-time.After(turnTLSTestTimeout):
		t.Fatal("Accept blocked")
		return nil
	}
}

func dialTURNTLSTestTCP(t *testing.T, listener net.Listener) net.Conn {
	t.Helper()
	client, err := net.DialTimeout("tcp4", listener.Addr().String(), turnTLSTestTimeout)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	if err := client.SetDeadline(time.Now().Add(turnTLSTestTimeout)); err != nil {
		t.Fatal(err)
	}
	return client
}

func connectTURNTLSTestClient(t *testing.T, listener net.Listener, config *tls.Config) (*tls.Conn, *turnTLSConn) {
	t.Helper()
	client := tls.Client(dialTURNTLSTestTCP(t, listener), config)
	server := acceptTURNTLSTestConn(t, startTURNTLSTestAccept(listener))
	ready := make(chan error, 1)
	go func() {
		_, err := server.Write([]byte{42})
		ready <- err
	}()
	message := make([]byte, 1)
	if _, err := io.ReadFull(client, message); err != nil || message[0] != 42 {
		t.Fatalf("reading first TLS byte: %v, %v", message, err)
	}
	if err := <-ready; err != nil {
		t.Fatal(err)
	}
	return client, server
}
