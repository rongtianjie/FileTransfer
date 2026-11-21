package main

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"math/big"
)

func randomToken() (string, error) {
	var data [24]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data[:]), nil
}

func randomCode() (string, error) {
	value, err := rand.Int(rand.Reader, big.NewInt(10000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%04d", value.Int64()), nil
}
