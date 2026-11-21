package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const maxQuotaBytes = 1 << 50

type relayOverrides struct {
	PublicLimit   *int64  `json:"publicLimit,omitempty"`
	ReservedLimit *int64  `json:"reservedLimit,omitempty"`
	KeyDigest     *string `json:"keyDigest,omitempty"`
}

type adminSettings struct {
	path                     string
	publicBase, reservedBase int64
	values                   relayOverrides
}

func openAdminSettings(dir string, publicBase, reservedBase int64) (*adminSettings, error) {
	settings := &adminSettings{
		path: filepath.Join(dir, "relay-settings.json"), publicBase: publicBase, reservedBase: reservedBase,
	}
	data, err := os.ReadFile(settings.path)
	if errors.Is(err, os.ErrNotExist) {
		return settings, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &settings.values); err != nil {
		return nil, fmt.Errorf("decode relay settings: %w", err)
	}
	values := settings.values
	if (values.PublicLimit != nil && !validQuota(*values.PublicLimit)) ||
		(values.ReservedLimit != nil && !validQuota(*values.ReservedLimit)) {
		return nil, errors.New("invalid persisted relay limits")
	}
	if values.KeyDigest != nil && *values.KeyDigest != "" {
		digest, err := hex.DecodeString(*values.KeyDigest)
		if err != nil || len(digest) != sha256.Size {
			return nil, errors.New("invalid persisted relay key digest")
		}
	}
	return settings, nil
}

func validQuota(value int64) bool {
	return value >= 0 && value <= maxQuotaBytes
}

func (s *adminSettings) limits() (public, reserved int64) {
	public, reserved = s.publicBase, s.reservedBase
	if value := s.values.PublicLimit; value != nil {
		public = *value
	}
	if value := s.values.ReservedLimit; value != nil {
		reserved = *value
	}
	return
}

func adminCredentials() (string, string, error) {
	username := os.Getenv("FILETRANSFER_ADMIN_USERNAME")
	password, passwordSet := os.LookupEnv("FILETRANSFER_ADMIN_PASSWORD")
	file, fileSet := os.LookupEnv("FILETRANSFER_ADMIN_PASSWORD_FILE")
	if username == "" && !passwordSet && !fileSet {
		return "", "", nil
	}
	if username == "" || len(username) > 256 || passwordSet == fileSet {
		return "", "", errors.New("configure FILETRANSFER_ADMIN_USERNAME and exactly one admin password source")
	}
	if fileSet {
		data, err := os.ReadFile(file)
		if err != nil {
			return "", "", fmt.Errorf("read admin password file: %w", err)
		}
		password = strings.TrimSuffix(strings.TrimSuffix(string(data), "\n"), "\r")
	}
	if password == "" || len(password) > 1024 {
		return "", "", errors.New("admin password must be between 1 and 1024 bytes")
	}
	return username, password, nil
}
