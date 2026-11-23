package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode"
)

var errInvalidIdentity = errors.New("invalid or expired authentication")

type Identity struct {
	Subject   string
	Name      string
	ExpiresAt time.Time
}

type authVerifier struct {
	jwksURL  string
	issuer   string
	audience string
	client   *http.Client

	mu          sync.Mutex
	keys        map[string]ed25519.PublicKey
	keysExpire  time.Time
	nextRefresh time.Time
}

func newAuthVerifier(jwksURL, issuer, audience string) (*authVerifier, error) {
	endpoint, err := url.Parse(jwksURL)
	if err != nil || endpoint.Scheme != "https" || endpoint.Hostname() == "" ||
		endpoint.User != nil || endpoint.Fragment != "" || issuer == "" || audience == "" {
		return nil, errors.New("authentication requires an HTTPS JWKS URL, issuer, and audience")
	}
	return &authVerifier{
		jwksURL: jwksURL, issuer: issuer, audience: audience,
		client: &http.Client{
			Timeout: 5 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

func (v *authVerifier) Verify(ctx context.Context, bearer string) (Identity, error) {
	if v == nil || len(bearer) > 8192 {
		return Identity{}, errInvalidIdentity
	}
	parts := strings.Split(bearer, ".")
	if len(parts) != 3 {
		return Identity{}, errInvalidIdentity
	}
	var header struct {
		Algorithm string          `json:"alg"`
		KeyID     string          `json:"kid"`
		Critical  json.RawMessage `json:"crit"`
		Base64    *bool           `json:"b64"`
	}
	if !decodeTokenPart(parts[0], &header) || header.Algorithm != "EdDSA" ||
		header.KeyID == "" || len(header.KeyID) > 255 ||
		len(header.Critical) != 0 || (header.Base64 != nil && !*header.Base64) {
		return Identity{}, errInvalidIdentity
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(signature) != ed25519.SignatureSize {
		return Identity{}, errInvalidIdentity
	}

	var claims struct {
		Subject   string          `json:"sub"`
		Name      string          `json:"name"`
		Role      string          `json:"role"`
		Banned    bool            `json:"banned"`
		Issuer    string          `json:"iss"`
		Audience  json.RawMessage `json:"aud"`
		ExpiresAt int64           `json:"exp"`
		NotBefore int64           `json:"nbf"`
	}
	if !decodeTokenPart(parts[1], &claims) || claims.Issuer != v.issuer ||
		!includesAudience(claims.Audience, v.audience) || !validSubject(claims.Subject) ||
		(claims.Role != "authenticated" && claims.Role != "admin") || claims.Banned ||
		claims.ExpiresAt <= time.Now().Unix() || claims.NotBefore > time.Now().Unix() {
		return Identity{}, errInvalidIdentity
	}

	key := v.key(ctx, header.KeyID)
	if key == nil || !ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), signature) ||
		claims.ExpiresAt <= time.Now().Unix() {
		return Identity{}, errInvalidIdentity
	}
	return Identity{Subject: claims.Subject, Name: claims.Name, ExpiresAt: time.Unix(claims.ExpiresAt, 0)}, nil
}

func decodeTokenPart(encoded string, decoded any) bool {
	data, err := base64.RawURLEncoding.DecodeString(encoded)
	return err == nil && json.Unmarshal(data, decoded) == nil
}

func validSubject(subject string) bool {
	return subject != "" && len(subject) <= 255 && strings.TrimSpace(subject) == subject &&
		strings.IndexFunc(subject, unicode.IsControl) == -1
}

func includesAudience(raw json.RawMessage, expected string) bool {
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return one == expected
	}
	var many []string
	if json.Unmarshal(raw, &many) == nil {
		for _, candidate := range many {
			if candidate == expected {
				return true
			}
		}
	}
	return false
}

func (v *authVerifier) key(ctx context.Context, keyID string) ed25519.PublicKey {
	v.mu.Lock()
	defer v.mu.Unlock()

	now := time.Now()
	if key := v.keys[keyID]; key != nil && now.Before(v.keysExpire) {
		return key
	}
	// Limit refreshes for unknown key IDs, including failed fetches.
	if now.Before(v.nextRefresh) || ctx.Err() != nil {
		return nil
	}
	v.nextRefresh = now.Add(10 * time.Second)
	keys, err := v.fetchKeys(ctx)
	if err != nil {
		return nil
	}
	v.keys = keys
	v.keysExpire = time.Now().Add(5 * time.Minute)
	return keys[keyID]
}

func (v *authVerifier) fetchKeys(ctx context.Context) (map[string]ed25519.PublicKey, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, v.jwksURL, nil)
	if err != nil {
		return nil, err
	}
	response, err := v.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("could not read authentication keys")
	}

	const maxJWKSSize = 64 << 10
	data, err := io.ReadAll(io.LimitReader(response.Body, maxJWKSSize+1))
	if err != nil || len(data) > maxJWKSSize {
		return nil, errors.New("invalid authentication key response")
	}
	var document struct {
		Keys []struct {
			ID        string `json:"kid"`
			Type      string `json:"kty"`
			Curve     string `json:"crv"`
			Algorithm string `json:"alg"`
			Use       string `json:"use"`
			X         string `json:"x"`
		} `json:"keys"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		return nil, err
	}
	keys := make(map[string]ed25519.PublicKey)
	for _, key := range document.Keys {
		if key.ID == "" || key.Type != "OKP" || key.Curve != "Ed25519" ||
			(key.Algorithm != "" && key.Algorithm != "EdDSA") ||
			(key.Use != "" && key.Use != "sig") {
			continue
		}
		publicKey, err := base64.RawURLEncoding.DecodeString(key.X)
		if err == nil && len(publicKey) == ed25519.PublicKeySize {
			if _, duplicate := keys[key.ID]; duplicate {
				return nil, errors.New("duplicate authentication key ID")
			}
			keys[key.ID] = ed25519.PublicKey(publicKey)
		}
	}
	if len(keys) == 0 {
		return nil, errors.New("no usable authentication keys")
	}
	return keys, nil
}

type socketTicket struct {
	identity  Identity
	cartID    string
	expiresAt time.Time
}

type socketTickets struct {
	mu      sync.Mutex
	tickets map[[sha256.Size]byte]socketTicket
}

func newSocketTickets() *socketTickets {
	return &socketTickets{tickets: make(map[[sha256.Size]byte]socketTicket)}
}

func (s *socketTickets) issue(identity Identity, cartID string) (string, error) {
	now := time.Now()
	if !validSubject(identity.Subject) || cartID == "" || !now.Before(identity.ExpiresAt) {
		return "", errInvalidIdentity
	}

	var tokenBytes [32]byte
	if _, err := rand.Read(tokenBytes[:]); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes[:])
	tokenHash := sha256.Sum256([]byte(token))

	s.mu.Lock()
	defer s.mu.Unlock()
	for key, ticket := range s.tickets {
		if !now.Before(ticket.expiresAt) {
			delete(s.tickets, key)
		}
	}
	if len(s.tickets) >= 4096 {
		return "", errors.New("too many pending WebSocket tickets")
	}
	expiresAt := now.Add(30 * time.Second)
	if identity.ExpiresAt.Before(expiresAt) {
		expiresAt = identity.ExpiresAt
	}
	s.tickets[tokenHash] = socketTicket{identity: identity, cartID: cartID, expiresAt: expiresAt}
	return token, nil
}

func (s *socketTickets) redeem(token, cartID string) (Identity, error) {
	if len(token) != base64.RawURLEncoding.EncodedLen(32) {
		return Identity{}, errInvalidIdentity
	}
	tokenHash := sha256.Sum256([]byte(token))
	s.mu.Lock()
	defer s.mu.Unlock()
	ticket, ok := s.tickets[tokenHash]
	if !ok || ticket.cartID != cartID {
		return Identity{}, errInvalidIdentity
	}
	delete(s.tickets, tokenHash)
	if !time.Now().Before(ticket.expiresAt) {
		return Identity{}, errInvalidIdentity
	}
	return ticket.identity, nil
}
