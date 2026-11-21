package main

import (
	"crypto/tls"
	"errors"
	"net"
	"net/netip"
	"sync"
	"time"
)

func listenTURNWithTLS(addr string, config *tls.Config) (net.Listener, error) {
	if config == nil || (len(config.Certificates) == 0 && config.GetCertificate == nil && config.GetConfigForClient == nil) {
		return nil, errors.New("TURN TLS requires a certificate configuration")
	}
	listener, err := net.Listen("tcp4", addr)
	if err != nil {
		return nil, err
	}
	return &turnTLSListener{
		Listener:         listener,
		config:           config,
		maxConnections:   256,
		maxPerSource:     16,
		handshakeTimeout: 10 * time.Second,
		readTimeout:      5 * time.Minute,
		writeTimeout:     15 * time.Second,
		connections:      make(map[*turnTLSConn]struct{}),
		perSource:        make(map[netip.Addr]int),
	}, nil
}

type turnTLSListener struct {
	net.Listener
	config                    *tls.Config
	maxConnections            int
	maxPerSource              int
	handshakeTimeout          time.Duration
	readTimeout, writeTimeout time.Duration

	mu          sync.Mutex
	closed      bool
	connections map[*turnTLSConn]struct{}
	perSource   map[netip.Addr]int
	closeOnce   sync.Once
	closeErr    error
}

func (l *turnTLSListener) Accept() (net.Conn, error) {
	for {
		raw, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		handshakeDeadline := time.Now().Add(l.handshakeTimeout)
		source := raw.RemoteAddr().(*net.TCPAddr).AddrPort().Addr().Unmap()

		l.mu.Lock()
		if l.closed {
			l.mu.Unlock()
			raw.Close()
			return nil, net.ErrClosed
		}
		if len(l.connections) >= l.maxConnections || l.perSource[source] >= l.maxPerSource {
			l.mu.Unlock()
			raw.Close()
			// Pion stops accepting on any error. Drop the excess socket here.
			continue
		}
		transport := &turnTLSTransport{
			Conn:              raw,
			handshakeDeadline: handshakeDeadline,
			read:              turnTLSDeadline{timeout: l.readTimeout},
			write:             turnTLSDeadline{timeout: l.writeTimeout},
		}
		conn := &turnTLSConn{
			Conn:      tls.Server(transport, l.config),
			transport: transport,
			listener:  l,
			source:    source,
		}
		l.connections[conn] = struct{}{}
		l.perSource[source]++
		l.mu.Unlock()
		return conn, nil
	}
}

func (l *turnTLSListener) Close() error {
	l.closeOnce.Do(func() {
		l.mu.Lock()
		l.closed = true
		connections := make([]*turnTLSConn, 0, len(l.connections))
		for conn := range l.connections {
			connections = append(connections, conn)
		}
		l.mu.Unlock()

		l.closeErr = l.Listener.Close()
		for _, conn := range connections {
			conn.Close()
		}
	})
	return l.closeErr
}

type turnTLSConn struct {
	net.Conn
	transport *turnTLSTransport
	listener  *turnTLSListener
	source    netip.Addr

	handshakeOnce sync.Once
	handshakeErr  error
	closeOnce     sync.Once
	closeErr      error
}

func (c *turnTLSConn) handshake() error {
	c.handshakeOnce.Do(func() {
		c.handshakeErr = c.Conn.(*tls.Conn).Handshake()
		if c.handshakeErr != nil {
			c.Close()
			return
		}
		c.transport.mu.Lock()
		c.transport.handshakeDeadline = time.Time{}
		c.transport.mu.Unlock()
	})
	return c.handshakeErr
}

func (c *turnTLSConn) Read(p []byte) (int, error) {
	if err := c.handshake(); err != nil {
		return 0, err
	}
	return c.Conn.Read(p)
}

func (c *turnTLSConn) Write(p []byte) (int, error) {
	if err := c.handshake(); err != nil {
		return 0, err
	}
	return c.Conn.Write(p)
}

func (c *turnTLSConn) Close() error {
	c.closeOnce.Do(func() {
		// Closing TCP directly interrupts TLS I/O, including a stalled handshake.
		c.closeErr = c.transport.Conn.Close()

		l := c.listener
		l.mu.Lock()
		delete(l.connections, c)
		if l.perSource[c.source] == 1 {
			delete(l.perSource, c.source)
		} else {
			l.perSource[c.source]--
		}
		l.mu.Unlock()
	})
	return c.closeErr
}

// TLS serializes its underlying reads and writes independently. Set each
// deadline at the TCP operation so concurrent TLS writes get their own budget.
type turnTLSTransport struct {
	net.Conn
	mu                sync.Mutex
	handshakeDeadline time.Time
	read, write       turnTLSDeadline
}

type turnTLSDeadline struct {
	timeout         time.Duration
	idleDeadline    time.Time
	requestDeadline time.Time
}

func (c *turnTLSTransport) effectiveDeadline(d *turnTLSDeadline) time.Time {
	deadline := c.handshakeDeadline
	if deadline.IsZero() {
		deadline = d.idleDeadline
	}
	if requested := d.requestDeadline; !requested.IsZero() && (deadline.IsZero() || requested.Before(deadline)) {
		deadline = requested
	}
	return deadline
}

func (c *turnTLSTransport) Read(p []byte) (int, error) {
	c.mu.Lock()
	if c.handshakeDeadline.IsZero() {
		c.read.idleDeadline = time.Now().Add(c.read.timeout)
	}
	err := c.Conn.SetReadDeadline(c.effectiveDeadline(&c.read))
	c.mu.Unlock()
	if err != nil {
		return 0, err
	}
	return c.Conn.Read(p)
}

func (c *turnTLSTransport) Write(p []byte) (int, error) {
	c.mu.Lock()
	if c.handshakeDeadline.IsZero() {
		c.write.idleDeadline = time.Now().Add(c.write.timeout)
	}
	err := c.Conn.SetWriteDeadline(c.effectiveDeadline(&c.write))
	c.mu.Unlock()
	if err != nil {
		return 0, err
	}
	return c.Conn.Write(p)
}

func (c *turnTLSTransport) SetDeadline(t time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.read.requestDeadline = t
	c.write.requestDeadline = t
	readErr := c.Conn.SetReadDeadline(c.effectiveDeadline(&c.read))
	writeErr := c.Conn.SetWriteDeadline(c.effectiveDeadline(&c.write))
	if readErr != nil {
		return readErr
	}
	return writeErr
}

func (c *turnTLSTransport) SetReadDeadline(t time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.read.requestDeadline = t
	return c.Conn.SetReadDeadline(c.effectiveDeadline(&c.read))
}

func (c *turnTLSTransport) SetWriteDeadline(t time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.write.requestDeadline = t
	return c.Conn.SetWriteDeadline(c.effectiveDeadline(&c.write))
}
