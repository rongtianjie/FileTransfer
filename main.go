package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/pion/logging"
	"github.com/pion/turn/v5"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	addr := env("FILETRANSFER_HTTP_ADDR", "127.0.0.1:8080")
	cert, key := os.Getenv("FILETRANSFER_TLS_CERT"), os.Getenv("FILETRANSFER_TLS_KEY")
	if (cert == "") != (key == "") {
		return errors.New("configure both FILETRANSFER_TLS_CERT and FILETRANSFER_TLS_KEY")
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("invalid HTTP listen address: %w", err)
	}
	if cert == "" && !net.ParseIP(host).IsLoopback() {
		return errors.New("HTTPS certificate required for a non-loopback HTTP listener")
	}
	var tlsConfig *tls.Config
	if cert != "" {
		certificate, err := tls.LoadX509KeyPair(cert, key)
		if err != nil {
			return fmt.Errorf("load TLS certificate: %w", err)
		}
		tlsConfig = &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{certificate}}
	}
	dist := env("FILETRANSFER_WEB_DIR", "web/dist")
	if _, err := os.Stat(filepath.Join(dist, "index.html")); err != nil {
		return fmt.Errorf("build the web frontend first (npm --prefix web run build): %w", err)
	}

	username, adminPassword, err := adminCredentials()
	if err != nil {
		return err
	}
	turnIP := os.Getenv("FILETRANSFER_TURN_IP")
	dir := env("FILETRANSFER_DATA_DIR", "data")
	var settings *adminSettings
	if turnIP != "" || username != "" {
		publicLimit, err := byteLimit("FILETRANSFER_PUBLIC_DAILY_BYTES", 20_000_000_000)
		if err != nil {
			return err
		}
		reservedLimit, err := byteLimit("FILETRANSFER_RESERVED_DAILY_BYTES", 20_000_000_000)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
		lock, err := lockDataDirectory(dir)
		if err != nil {
			return err
		}
		defer lock.Close()
		settings, err = openAdminSettings(dir, publicLimit, reservedLimit)
		if err != nil {
			return err
		}
	}

	var router *relayRouter
	var ledger *dailyLedger
	var stunURLs, turnURLs []string
	if turnIP != "" {
		udpAddr := env("FILETRANSFER_TURN_UDP", "127.0.0.1:3478")
		turnHost := env("FILETRANSFER_TURN_HOST", turnIP)
		if strings.ContainsAny(turnHost, ":/?#@ \t\r\n") {
			return errors.New("FILETRANSFER_TURN_HOST must be an IPv4 address or hostname without a port")
		}
		publicLimit, reservedLimit := settings.limits()
		ledger, err = loadSiteLedger(filepath.Join(dir, "relay-usage.json"), publicLimit, reservedLimit, false)
		if err != nil {
			return err
		}

		router = newRelayRouter(net.ParseIP(turnIP), ledger)
		if err := router.Validate(); err != nil {
			return err
		}
		udp, err := net.ListenPacket("udp4", udpAddr)
		if err != nil {
			return fmt.Errorf("listen for TURN UDP: %w", err)
		}
		defer udp.Close()
		port := udp.LocalAddr().(*net.UDPAddr).Port
		stunURLs = []string{fmt.Sprintf("stun:%s:%d", turnHost, port)}
		turnURLs = []string{fmt.Sprintf("turn:%s:%d?transport=udp", turnHost, port)}
		var listeners []net.Listener
		if tlsAddr := os.Getenv("FILETRANSFER_TURN_TLS_ADDR"); tlsAddr != "" {
			if tlsConfig == nil {
				return errors.New("TURN over TLS requires the application TLS certificate")
			}
			listener, err := listenTURNWithTLS(tlsAddr, tlsConfig.Clone())
			if err != nil {
				return fmt.Errorf("listen for TURN TLS: %w", err)
			}
			defer listener.Close()
			listeners = append(listeners, listener)
			turnURLs = append(turnURLs, fmt.Sprintf("turns:%s:%d?transport=tcp", turnHost, listener.Addr().(*net.TCPAddr).Port))
		}
		relay, err := serveTURN(router, udp, listeners)
		if err != nil {
			return err
		}
		defer relay.Close()
		log.Printf("TURN listening on %s", udp.LocalAddr())
	}
	if ledger == nil && username != "" {
		publicLimit, reservedLimit := settings.limits()
		ledger, err = loadSiteLedger(filepath.Join(dir, "relay-usage.json"), publicLimit, reservedLimit, true)
		if err != nil {
			return err
		}
	}
	if list := os.Getenv("FILETRANSFER_STUN_URLS"); list != "" {
		stunURLs = nil
		for _, server := range strings.Split(list, ",") {
			server = strings.TrimSpace(server)
			if !strings.HasPrefix(server, "stun:") && !strings.HasPrefix(server, "stuns:") {
				return errors.New("FILETRANSFER_STUN_URLS only accepts STUN URLs")
			}
			stunURLs = append(stunURLs, server)
		}
	}
	relayKey := os.Getenv("FILETRANSFER_RELAY_KEY")
	if len(relayKey) > 512 {
		return errors.New("FILETRANSFER_RELAY_KEY must be at most 512 bytes")
	}
	hub := newHub(router, stunURLs, turnURLs, relayKey)
	if settings != nil {
		hub.applyKeyDigest(settings.values.KeyDigest)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/session", hub.serveSocket(os.Getenv("FILETRANSFER_ORIGIN")))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok\n"))
	})
	site := http.FileServer(http.Dir(dist))
	if username != "" {
		newAdmin(username, adminPassword, settings, hub, ledger).register(mux)
		mux.Handle("/admin/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			site.ServeHTTP(w, r)
		}))
	} else {
		mux.HandleFunc("/admin/", http.NotFound)
	}
	mux.HandleFunc("/api/admin/", http.NotFound)
	mux.Handle("/", site)
	server := &http.Server{
		Addr: addr, TLSConfig: tlsConfig, Handler: browserHeaders(mux),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
		WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024,
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	defer listener.Close()
	if router != nil {
		if err := ledger.activate(); err != nil {
			return err
		}
	}
	log.Printf("Web server listening on %s", listener.Addr())

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case now := <-ticker.C:
				if router != nil {
					ledger.rollDay()
				}
				hub.tick(now)
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() {
		<-ctx.Done()
		shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = server.Shutdown(shutdown)
	}()
	if tlsConfig != nil {
		err = server.ServeTLS(listener, "", "")
	} else {
		err = server.Serve(listener)
	}
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func serveTURN(router *relayRouter, udp net.PacketConn, streams []net.Listener) (*turn.Server, error) {
	// TURN itself grants an IP-wide permission. The virtual router additionally
	// checks the exact destination allocation, device and current grant.
	allowPeerIP := func(_ net.Addr, ip net.IP) bool { return router.ip.Equal(ip) }
	var listeners []turn.ListenerConfig
	for _, stream := range streams {
		listeners = append(listeners, turn.ListenerConfig{
			Listener: stream, RelayAddressGenerator: router, PermissionHandler: allowPeerIP,
		})
	}
	logger := &logging.DefaultLoggerFactory{DefaultLogLevel: logging.LogLevelDisabled, Writer: os.Stderr}
	return turn.NewServer(turn.ServerConfig{
		Realm: turnRealm, LoggerFactory: logger,
		AuthHandler: router.auth,
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn: udp, RelayAddressGenerator: router, PermissionHandler: allowPeerIP,
		}},
		ListenerConfigs: listeners,
	})
}

func browserHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self' wss: ws:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		if r.TLS != nil {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		}
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			w.Header().Set("Cache-Control", "no-cache")
		} else if strings.HasPrefix(r.URL.Path, "/assets/") {
			// Vite emits content-hashed file names under /assets/.
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		next.ServeHTTP(w, r)
	})
}

func lockDataDirectory(dir string) (*os.File, error) {
	lock, err := os.OpenFile(filepath.Join(dir, "relay.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		return nil, fmt.Errorf("relay data directory already in use: %w", err)
	}
	return lock, nil
}

func byteLimit(name string, fallback int64) (int64, error) {
	raw := env(name, strconv.FormatInt(fallback, 10))
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || !validQuota(n) {
		return 0, fmt.Errorf("%s must be a nonnegative integer byte limit up to 1 PiB", name)
	}
	return n, nil
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
