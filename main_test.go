package main

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestFailedHTTPStartupDoesNotRecordRelayCoverage(t *testing.T) {
	occupied, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()

	dir := t.TempDir()
	web := t.TempDir()
	if err := os.WriteFile(filepath.Join(web, "index.html"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FILETRANSFER_HTTP_ADDR", occupied.Addr().String())
	t.Setenv("FILETRANSFER_WEB_DIR", web)
	t.Setenv("FILETRANSFER_DATA_DIR", dir)
	t.Setenv("FILETRANSFER_TURN_IP", "127.0.0.1")
	t.Setenv("FILETRANSFER_TURN_UDP", "127.0.0.1:0")
	t.Setenv("FILETRANSFER_TURN_TLS_ADDR", "")
	t.Setenv("FILETRANSFER_TLS_CERT", "")
	t.Setenv("FILETRANSFER_TLS_KEY", "")
	t.Setenv("FILETRANSFER_STUN_URLS", "")
	t.Setenv("FILETRANSFER_PUBLIC_DAILY_BYTES", "")
	t.Setenv("FILETRANSFER_RESERVED_DAILY_BYTES", "")
	t.Setenv("FILETRANSFER_RELAY_KEY", "")
	t.Setenv("FILETRANSFER_ADMIN_USERNAME", "admin")
	t.Setenv("FILETRANSFER_ADMIN_PASSWORD", "local-test")
	t.Setenv("FILETRANSFER_ADMIN_PASSWORD_FILE", "")
	if err := os.Unsetenv("FILETRANSFER_ADMIN_PASSWORD_FILE"); err != nil {
		t.Fatal(err)
	}

	var listenError *net.OpError
	if err := run(); !errors.As(err, &listenError) || listenError.Net != "tcp" {
		t.Fatalf("expected HTTP listen failure, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "relay-usage.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed HTTP startup should leave the relay ledger untouched, got %v", err)
	}
}
