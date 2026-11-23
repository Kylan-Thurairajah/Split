package main

import (
	"context"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

type identityVerifier interface {
	Verify(context.Context, string) (Identity, error)
}

func (api API) identity(r *http.Request) (Identity, bool) {
	if api.verifier == nil {
		return Identity{}, false
	}
	headers := r.Header.Values("Authorization")
	if len(headers) != 1 || len(headers[0]) > 8192 {
		return Identity{}, false
	}
	parts := strings.Fields(headers[0])
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return Identity{}, false
	}
	identity, err := api.verifier.Verify(r.Context(), parts[1])
	if err != nil || identity.Subject == "" || !time.Now().Before(identity.ExpiresAt) {
		return Identity{}, false
	}
	return identity, true
}

func (api API) requireIdentity(w http.ResponseWriter, r *http.Request) (Identity, bool) {
	identity, ok := api.identity(r)
	if !ok {
		handleError(w, errUnauthenticated)
	}
	return identity, ok
}

func (api API) me(w http.ResponseWriter, r *http.Request) {
	identity, ok := api.requireIdentity(w, r)
	if !ok {
		return
	}
	profile, err := ensureProfile(r.Context(), api.store.pool, identity)
	if err != nil {
		handleError(w, err)
		return
	}
	sendJSON(w, http.StatusOK, profile)
}

func (api API) myCarts(w http.ResponseWriter, r *http.Request) {
	identity, ok := api.requireIdentity(w, r)
	if !ok {
		return
	}
	carts, err := api.store.listCarts(r.Context(), identity.Subject)
	if err != nil {
		handleError(w, err)
		return
	}
	sendJSON(w, http.StatusOK, carts)
}

func (api API) updateProfile(w http.ResponseWriter, r *http.Request) {
	identity, ok := api.requireIdentity(w, r)
	if !ok {
		return
	}
	var body struct {
		Name  *string `json:"name"`
		Theme *string `json:"theme"`
	}
	if !readBody(w, r, &body) {
		return
	}
	if body.Name != nil {
		name := strings.TrimSpace(*body.Name)
		if name == "" || len([]rune(name)) > 60 {
			fail(w, http.StatusUnprocessableEntity, "Enter a display name up to 60 characters.")
			return
		}
		body.Name = &name
	}
	if (body.Name == nil && body.Theme == nil) ||
		(body.Theme != nil && *body.Theme != "light" && *body.Theme != "dark") {
		fail(w, http.StatusUnprocessableEntity, "Provide a display name or a valid theme.")
		return
	}
	var profile Profile
	err := api.store.pool.QueryRow(r.Context(), `UPDATE profiles
		SET name = CASE WHEN needs_name THEN COALESCE($2::text, name) ELSE name END,
			needs_name = needs_name AND $2::text IS NULL,
			theme = COALESCE($3::text, theme)
		WHERE subject = $1
		RETURNING id, name, needs_name, theme`, identity.Subject, body.Name, body.Theme).
		Scan(&profile.ID, &profile.Name, &profile.NeedsName, &profile.Theme)
	if err != nil {
		handleError(w, err)
		return
	}
	sendJSON(w, http.StatusOK, profile)
}

func (api API) socketTicket(w http.ResponseWriter, r *http.Request) {
	identity, ok := api.requireIdentity(w, r)
	if !ok || !api.limit(w, "ws-ticket", identity.Subject, 120) {
		return
	}
	id := r.PathValue("id")
	cart, err := api.store.read(r.Context(), id, identity.Subject)
	if err != nil {
		handleError(w, err)
		return
	}
	if !cart.Private || api.tickets == nil {
		handleError(w, pgx.ErrNoRows)
		return
	}
	ticket, err := api.tickets.issue(identity, id)
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "Unable to connect. Please retry.")
		return
	}
	sendJSON(w, http.StatusCreated, map[string]string{"ticket": ticket})
}

func (api API) invite(w http.ResponseWriter, r *http.Request) {
	identity, ok := api.requireIdentity(w, r)
	if !ok || !api.limit(w, "invite-create", identity.Subject, 30) {
		return
	}
	invite, err := api.store.createInvite(r.Context(), r.PathValue("id"), identity.Subject)
	if err != nil {
		handleError(w, err)
		return
	}
	sendJSON(w, http.StatusCreated, invite)
}

func (api API) revokeInvites(w http.ResponseWriter, r *http.Request) {
	identity, ok := api.requireIdentity(w, r)
	if !ok {
		return
	}
	if err := api.store.revokeInvites(r.Context(), r.PathValue("id"), identity.Subject); err != nil {
		handleError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (api API) redeemInvite(w http.ResponseWriter, r *http.Request) {
	if !api.limit(w, "invite-redemption-ip", requestIP(r), 60) {
		return
	}
	identity, ok := api.requireIdentity(w, r)
	if !ok || !api.limit(w, "invite-redemption", identity.Subject, 20) {
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if !readBody(w, r, &body) {
		return
	}
	cart, err := api.store.redeemInvite(r.Context(), identity, body.Token)
	if err != nil {
		handleError(w, err)
		return
	}
	api.hub.publish(cart)
	sendJSON(w, http.StatusOK, cart)
}

func (api API) removeMember(w http.ResponseWriter, r *http.Request) {
	identity, ok := api.requireIdentity(w, r)
	if !ok {
		return
	}
	member := r.PathValue("member")
	cart, err := api.store.removeMember(r.Context(), r.PathValue("id"), identity.Subject, member)
	if err != nil {
		handleError(w, err)
		return
	}
	api.hub.evict(cart.ID, member)
	api.hub.publish(cart)
	sendJSON(w, http.StatusOK, cart)
}

type requestLimits struct {
	mu     sync.Mutex
	window time.Time
	counts map[string]int
}

func (limits *requestLimits) allow(key string, maximum int, now time.Time) bool {
	limits.mu.Lock()
	defer limits.mu.Unlock()
	if limits.counts == nil || now.Sub(limits.window) >= time.Minute {
		limits.window = now
		limits.counts = make(map[string]int)
	}
	count, exists := limits.counts[key]
	if count >= maximum || (!exists && len(limits.counts) >= 8192) {
		return false
	}
	limits.counts[key] = count + 1
	return true
}

func (api API) limit(w http.ResponseWriter, operation, actor string, maximum int) bool {
	if !api.limits.allow(operation+":"+actor, maximum, time.Now()) {
		w.Header().Set("Retry-After", "60")
		fail(w, http.StatusTooManyRequests, "Too many requests. Please try again in a minute.")
		return false
	}
	return true
}

func requestIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
