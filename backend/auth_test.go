package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const authTestOrigin = "https://neon-auth.example"

func signTestToken(t *testing.T, key ed25519.PrivateKey, header, claims map[string]any) string {
	t.Helper()
	encode := func(value any) string {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return base64.RawURLEncoding.EncodeToString(data)
	}
	message := encode(header) + "." + encode(claims)
	return message + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte(message)))
}

func TestNeonTokenVerifier(t *testing.T) {
	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	_, untrusted, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kid": "expected", "kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig",
			"x": base64.RawURLEncoding.EncodeToString(public),
		}}})
	}))
	defer server.Close()
	verifier, err := newAuthVerifier(server.URL, authTestOrigin, authTestOrigin)
	if err != nil {
		t.Fatal(err)
	}
	verifier.client.Transport = server.Client().Transport

	now := time.Now().Unix()
	for _, tc := range []struct {
		name         string
		header       map[string]any
		claims       map[string]any
		badSignature bool
		wantOK       bool
	}{
		{name: "valid", wantOK: true},
		{name: "valid audience array", claims: map[string]any{"aud": []string{"other", authTestOrigin}}, wantOK: true},
		{name: "wrong environment", claims: map[string]any{"iss": "https://other.example"}},
		{name: "wrong audience", claims: map[string]any{"aud": "https://other.example"}},
		{name: "expired", claims: map[string]any{"exp": now - 1}},
		{name: "missing expiry", claims: map[string]any{"exp": nil}},
		{name: "not yet valid", claims: map[string]any{"nbf": now + 60}},
		{name: "missing subject", claims: map[string]any{"sub": ""}},
		{name: "anonymous token", claims: map[string]any{"role": "anonymous"}},
		{name: "banned", claims: map[string]any{"banned": true}},
		{name: "unverified email", claims: map[string]any{"emailVerified": false}},
		{name: "unsupported algorithm", header: map[string]any{"alg": "none"}},
		{name: "unknown key", header: map[string]any{"kid": "unknown"}},
		{name: "untrusted signature", badSignature: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			header := map[string]any{"alg": "EdDSA", "kid": "expected"}
			claims := map[string]any{"sub": "account-1", "name": "Example Name", "role": "authenticated", "emailVerified": true, "iss": authTestOrigin, "aud": authTestOrigin, "exp": now + 60}
			for k, v := range tc.header {
				header[k] = v
			}
			for k, v := range tc.claims {
				claims[k] = v
			}
			signingKey := private
			if tc.badSignature {
				signingKey = untrusted
			}
			identity, err := verifier.Verify(context.Background(), signTestToken(t, signingKey, header, claims))
			if !tc.wantOK {
				if err == nil {
					t.Fatal("invalid token was accepted")
				}
				return
			}
			if err != nil || identity.Subject != "account-1" || identity.Name != "Example Name" ||
				!identity.ExpiresAt.Equal(time.Unix(now+60, 0)) {
				t.Fatalf("unexpected verification result: %+v, %v", identity, err)
			}
		})
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("JWKS fetched %d times, want 1", got)
	}
}

func TestSocketTicketIsCartBoundAndSingleUse(t *testing.T) {
	tickets := newSocketTickets()
	identity := Identity{Subject: "account-1", ExpiresAt: time.Now().Add(time.Minute)}
	ticket, err := tickets.issue(identity, "cart-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tickets.redeem(ticket, "cart-2"); err == nil {
		t.Fatal("ticket was accepted for another cart")
	}

	var redeemed atomic.Int32
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, redeemErr := tickets.redeem(ticket, "cart-1")
			if redeemErr == nil && got.Subject == identity.Subject {
				redeemed.Add(1)
			}
		}()
	}
	wg.Wait()
	if got := redeemed.Load(); got != 1 {
		t.Fatalf("ticket redeemed %d times, want 1", got)
	}
}

func TestSocketTicketExpiresWithIdentity(t *testing.T) {
	tickets := newSocketTickets()
	identity := Identity{Subject: "account-1", ExpiresAt: time.Now().Add(10 * time.Second)}
	token, err := tickets.issue(identity, "cart")
	if err != nil {
		t.Fatal(err)
	}
	tokenHash := sha256.Sum256([]byte(token))
	ticket := tickets.tickets[tokenHash]
	if !ticket.expiresAt.Equal(identity.ExpiresAt) {
		t.Fatal("ticket expiry must be capped by the credential expiry")
	}
	ticket.expiresAt = time.Now().Add(-time.Second)
	tickets.tickets[tokenHash] = ticket
	if _, err := tickets.redeem(token, "cart"); err == nil {
		t.Fatal("expired ticket was accepted")
	}
	identity.ExpiresAt = time.Now().Add(-time.Second)
	if _, err := tickets.issue(identity, "cart"); err == nil {
		t.Fatal("expired identity was allowed to issue a ticket")
	}
}
