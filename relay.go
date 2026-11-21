package main

import (
	"errors"
	"net"
	"sync"
	"time"

	"github.com/pion/turn/v5"
)

const (
	freeRelayBytes               = 100_000_000
	grantDuration                = 45 * time.Minute
	turnRealm                    = "filetransfer"
	maxRelayAllocationsPerDevice = 8
)

var (
	errRelayPeer    = errors.New("relay destination outside this pair")
	errSessionQuota = errors.New("relay session quota exhausted")
	errGlobalQuota  = errors.New("daily relay quota exhausted")
	errRelayBusy    = errors.New("relay receive buffer full")
)

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type relayAccount struct {
	limit, used int64
}

type relayGrant struct {
	account    *relayAccount
	authorized bool
	expires    time.Time
	revoked    bool
	reason     string
	users      [2]string
}

type relayCredential struct {
	grant       *relayGrant
	host        bool
	key         []byte
	allocations int
}

// Browsers gather relay-only ICE candidates on both sides. These virtual
// addresses are routed in-process and have no corresponding OS sockets.
// Every accepted datagram crosses this router once, even with two allocations.
type relayRouter struct {
	forwardMu sync.Mutex

	mu       sync.Mutex
	ip       net.IP
	ledger   *dailyLedger
	nextPort int
	sockets  map[int]*relaySocket
	users    map[string]*relayCredential
}

func newRelayRouter(ip net.IP, ledger *dailyLedger) *relayRouter {
	return &relayRouter{
		ip: ip.To4(), ledger: ledger, nextPort: 49152,
		sockets: make(map[int]*relaySocket), users: make(map[string]*relayCredential),
	}
}

func (r *relayRouter) issue(account *relayAccount, authorized bool, urls []string) (*relayGrant, [2]iceServer, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var servers [2]iceServer
	grant := &relayGrant{account: account, authorized: authorized, expires: time.Now().Add(grantDuration)}
	for i := range servers {
		name, err := randomToken()
		if err != nil {
			return nil, servers, err
		}
		password, err := randomToken()
		if err != nil {
			return nil, servers, err
		}
		servers[i] = iceServer{URLs: urls, Username: name, Credential: password}
		grant.users[i] = name
	}
	for i, server := range servers {
		r.users[server.Username] = &relayCredential{
			grant: grant, host: i == 0, key: turn.GenerateAuthKey(server.Username, turnRealm, server.Credential),
		}
	}
	return grant, servers, nil
}

func (r *relayRouter) revoke(grant *relayGrant) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if grant == nil {
		return
	}
	grant.revoked = true
	for _, name := range grant.users {
		delete(r.users, name)
	}
	for _, socket := range r.sockets {
		if socket.credential != nil && socket.credential.grant == grant {
			socket.closeLocked()
		}
	}
}

func relayActive(grant *relayGrant) bool {
	return !grant.revoked && grant.reason == "" && time.Now().Before(grant.expires)
}

func (r *relayRouter) status(account *relayAccount, grant *relayGrant, authorized bool) (int64, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	remaining := r.ledger.remaining(authorized)
	if !authorized {
		remaining = min(remaining, account.limit-account.used)
	}
	if grant == nil {
		if !authorized && account.used >= account.limit {
			return 0, "session_quota"
		}
		if remaining <= 0 {
			return 0, "global_quota"
		}
		return remaining, ""
	}
	if grant.reason != "" {
		return remaining, grant.reason
	}
	if !time.Now().Before(grant.expires) {
		return remaining, "relay_expired"
	}
	return remaining, ""
}

func (r *relayRouter) auth(request *turn.RequestAttributes) (string, []byte, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	credential := r.users[request.Username]
	if request.Realm != turnRealm || credential == nil || !relayActive(credential.grant) {
		return "", nil, false
	}
	return request.Username, credential.key, true
}

func (r *relayRouter) Validate() error {
	if r.ip == nil || r.ip.IsUnspecified() || r.ip.IsMulticast() {
		return errors.New("TURN requires a usable IPv4 address")
	}
	return nil
}

func (r *relayRouter) AllocatePacketConn(request turn.AllocateListenerConfig) (net.PacketConn, net.Addr, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if request.Network != "udp4" || request.RequestedPort != 0 {
		return nil, nil, errors.New("explicit TURN ports are unsupported")
	}
	credential := r.users[request.UserID]
	if request.Realm != turnRealm || credential == nil || !relayActive(credential.grant) ||
		credential.allocations >= maxRelayAllocationsPerDevice {
		return nil, nil, errors.New("relay allocation unavailable for this device")
	}
	for attempts := 0; attempts < 16384; attempts++ {
		port := r.nextPort
		r.nextPort++
		if r.nextPort > 65535 {
			r.nextPort = 49152
		}
		if r.sockets[port] != nil {
			continue
		}
		address := &net.UDPAddr{IP: r.ip, Port: port}
		socket := &relaySocket{
			router: r, address: address, credential: credential,
			packets: make(chan relayPacket, 64), done: make(chan struct{}),
		}
		credential.allocations++
		r.sockets[port] = socket
		return socket, address, nil
	}
	return nil, nil, errors.New("relay capacity exhausted")
}

func (*relayRouter) AllocateConn(turn.AllocateConnConfig) (net.Conn, error) {
	return nil, errors.New("TCP peer transport is unsupported")
}

func (*relayRouter) AllocateListener(turn.AllocateListenerConfig) (net.Listener, net.Addr, error) {
	return nil, nil, errors.New("TCP peer transport is unsupported")
}

type relayPacket struct {
	data   []byte
	source net.Addr
}

type relaySocket struct {
	router     *relayRouter
	address    *net.UDPAddr
	credential *relayCredential
	packets    chan relayPacket
	done       chan struct{}
	closed     bool
}

func (s *relaySocket) WriteTo(data []byte, addr net.Addr) (int, error) {
	r := s.router
	peer, ok := addr.(*net.UDPAddr)
	if !ok || !peer.IP.Equal(r.ip) {
		return 0, errRelayPeer
	}

	// Relay writers serialize quota spending. Signal handling, connection
	// cleanup and readers need only the state mutex, even during a disk sync.
	r.forwardMu.Lock()
	defer r.forwardMu.Unlock()
	r.mu.Lock()
	dst, grant, err := s.routeLocked(peer, len(data))
	r.mu.Unlock()
	if err != nil {
		return 0, err
	}

	count := int64(len(data))
	charged := r.ledger.charge(count, grant.authorized)
	r.mu.Lock()
	defer r.mu.Unlock()
	if !charged {
		grant.reason = "global_quota"
		return 0, errGlobalQuota
	}
	if s.closed || dst.closed || !relayActive(grant) {
		return 0, errRelayPeer
	}
	if !grant.authorized {
		grant.account.used += count
	}
	dst.packets <- relayPacket{data: append([]byte(nil), data...), source: s.address}
	return len(data), nil
}

func (s *relaySocket) routeLocked(peer *net.UDPAddr, count int) (*relaySocket, *relayGrant, error) {
	if s.closed || s.credential == nil {
		return nil, nil, errRelayPeer
	}
	dst := s.router.sockets[peer.Port]
	src := s.credential
	grant := src.grant
	if dst == nil || dst.credential.host == src.host || dst.credential.grant != grant || !relayActive(grant) {
		return nil, nil, errRelayPeer
	}
	if count > 1600 || len(dst.packets) == cap(dst.packets) {
		return nil, nil, errRelayBusy
	}
	if !grant.authorized && int64(count) > grant.account.limit-grant.account.used {
		grant.reason = "session_quota"
		return nil, nil, errSessionQuota
	}
	return dst, grant, nil
}

func (s *relaySocket) ReadFrom(buf []byte) (int, net.Addr, error) {
	select {
	case <-s.done:
		return 0, nil, net.ErrClosed
	case packet := <-s.packets:
		s.router.mu.Lock()
		defer s.router.mu.Unlock()
		if s.closed || !relayActive(s.credential.grant) {
			return 0, nil, net.ErrClosed
		}
		return copy(buf, packet.data), packet.source, nil
	}
}

func (s *relaySocket) closeLocked() {
	if s.closed {
		return
	}
	s.closed = true
	delete(s.router.sockets, s.address.Port)
	if s.credential != nil {
		s.credential.allocations--
	}
	close(s.done)
}

func (s *relaySocket) Close() error {
	s.router.mu.Lock()
	defer s.router.mu.Unlock()
	s.closeLocked()
	return nil
}

func (s *relaySocket) LocalAddr() net.Addr { return s.address }

// Pion's allocation reader is interrupted by Close and does not set deadlines.
func (*relaySocket) SetDeadline(time.Time) error      { return errors.ErrUnsupported }
func (*relaySocket) SetReadDeadline(time.Time) error  { return errors.ErrUnsupported }
func (*relaySocket) SetWriteDeadline(time.Time) error { return errors.ErrUnsupported }
