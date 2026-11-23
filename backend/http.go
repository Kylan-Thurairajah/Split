package main

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"
)

type API struct {
	store    Store
	hub      *Hub
	origins  map[string]bool
	verifier identityVerifier
	tickets  *socketTickets
	limits   *requestLimits
}

func (api API) routes(staticDir string) http.Handler {
	if api.limits == nil {
		api.limits = &requestLimits{}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		if err := api.store.pool.Ping(r.Context()); err != nil {
			fail(w, http.StatusServiceUnavailable, "Database unavailable.")
			return
		}
		sendJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("POST /api/carts", api.create)
	mux.HandleFunc("GET /api/carts/{id}", api.read)
	mux.HandleFunc("PATCH /api/carts/{id}", api.mutate)
	mux.HandleFunc("GET /api/carts/{id}/ws", api.socket)
	mux.HandleFunc("GET /api/me", api.me)
	mux.HandleFunc("PATCH /api/me", api.updateProfile)
	mux.HandleFunc("GET /api/me/carts", api.myCarts)
	mux.HandleFunc("POST /api/carts/{id}/ws-ticket", api.socketTicket)
	mux.HandleFunc("POST /api/carts/{id}/invites", api.invite)
	mux.HandleFunc("DELETE /api/carts/{id}/invites", api.revokeInvites)
	mux.HandleFunc("POST /api/invites/redeem", api.redeemInvite)
	mux.HandleFunc("DELETE /api/carts/{id}/members/{member}", api.removeMember)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		fail(w, http.StatusNotFound, "Endpoint not found.")
	})
	if staticDir != "" {
		files := http.FileServer(http.Dir(staticDir))
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				http.NotFound(w, r)
				return
			}
			asset := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
			if asset != "" && filepath.IsLocal(filepath.FromSlash(asset)) {
				file := filepath.Join(staticDir, filepath.FromSlash(asset))
				if info, err := os.Stat(file); err == nil && !info.IsDir() {
					files.ServeHTTP(w, r)
					return
				}
			}
			if path.Ext(asset) != "" {
				http.NotFound(w, r)
				return
			}
			http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
		})
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Add("Vary", "Origin")
			origin := r.Header.Get("Origin")
			if origin != "" {
				if !api.allowOrigin(r) {
					fail(w, http.StatusForbidden, "Origin not allowed.")
					return
				}
				w.Header().Set("Access-Control-Allow-Origin", origin)
			}
			if r.Method == http.MethodOptions {
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}

func (api API) allowOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" || api.origins[origin] {
		return true
	}
	parsed, err := url.Parse(origin)
	return err == nil && (parsed.Scheme == "https" || parsed.Scheme == "http") && strings.EqualFold(parsed.Host, r.Host)
}

func (api API) create(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Demo    bool   `json:"demo"`
		Name    string `json:"name"`
		Private bool   `json:"private"`
	}
	if !readBody(w, r, &body) {
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Demo && body.Private {
		fail(w, http.StatusUnprocessableEntity, "Seeded demos are separate from private carts.")
		return
	}
	if !body.Demo && (body.Name == "" || len([]rune(body.Name)) > 100) {
		fail(w, http.StatusUnprocessableEntity, "Enter a cart name up to 100 characters.")
		return
	}
	var cart Cart
	var err error
	if body.Private {
		identity, ok := api.requireIdentity(w, r)
		if !ok {
			return
		}
		if !api.limit(w, "private-create", identity.Subject, 30) {
			return
		}
		cart, err = api.store.createPrivate(r.Context(), identity, body.Name)
	} else {
		if !api.limit(w, "anonymous-create", requestIP(r), 60) {
			return
		}
		cart, err = api.store.create(r.Context(), body.Demo, body.Name)
	}
	if err != nil {
		handleError(w, err)
		return
	}
	sendJSON(w, http.StatusCreated, cart)
}

func (api API) read(w http.ResponseWriter, r *http.Request) {
	identity, _ := api.identity(r)
	cart, err := api.store.read(r.Context(), r.PathValue("id"), identity.Subject)
	if err != nil {
		handleError(w, err)
		return
	}
	sendJSON(w, http.StatusOK, cart)
}

func (api API) mutate(w http.ResponseWriter, r *http.Request) {
	var change Mutation
	if !readBody(w, r, &change) {
		return
	}
	identity, _ := api.identity(r)
	cart, err := api.store.mutate(r.Context(), r.PathValue("id"), identity.Subject, change)
	if errors.Is(err, errConflict) {
		sendJSON(w, http.StatusConflict, cart)
		return
	}
	if err != nil {
		handleError(w, err)
		return
	}
	api.hub.publish(cart)
	sendJSON(w, http.StatusOK, cart)
}

func (api API) socket(w http.ResponseWriter, r *http.Request) {
	if !api.limit(w, "ws-upgrade", requestIP(r), 120) {
		return
	}
	id := r.PathValue("id")
	var identity Identity
	if token := r.URL.Query().Get("ticket"); token != "" {
		if api.tickets == nil {
			handleError(w, errUnauthenticated)
			return
		}
		var err error
		identity, err = api.tickets.redeem(token, id)
		if err != nil {
			handleError(w, errUnauthenticated)
			return
		}
	}
	initial, err := api.store.read(r.Context(), id, identity.Subject)
	if err != nil {
		handleError(w, err)
		return
	}
	updates, revoked, unsubscribe := api.hub.subscribe(id, initial.ActorID)
	defer unsubscribe()
	// Re-read after subscribing so a concurrent commit between the two steps
	// cannot be missed and a removed member cannot open a new socket.
	initial, err = api.store.read(r.Context(), id, identity.Subject)
	if err != nil {
		handleError(w, err)
		return
	}
	upgrader := websocket.Upgrader{CheckOrigin: api.allowOrigin, HandshakeTimeout: 5 * time.Second}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	var credentialExpired <-chan time.Time
	if initial.Private {
		expiry := time.NewTimer(time.Until(identity.ExpiresAt))
		defer expiry.Stop()
		credentialExpired = expiry.C
	}

	const heartbeat = 25 * time.Second
	done := make(chan struct{})
	conn.SetReadLimit(512)
	conn.SetReadDeadline(time.Now().Add(2 * heartbeat))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(2 * heartbeat))
	})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	write := func(cart Cart) error {
		conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		return conn.WriteJSON(cart)
	}
	closeAccess := func() {
		_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "Cart access ended."), time.Now().Add(time.Second))
	}
	select {
	case <-revoked:
		closeAccess()
		return
	default:
	}
	if initial.Private && !time.Now().Before(identity.ExpiresAt) {
		closeAccess()
		return
	}
	if write(initial) != nil {
		return
	}
	version := initial.Version
	ticker := time.NewTicker(heartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-r.Context().Done():
			return
		case <-credentialExpired:
			closeAccess()
			return
		case <-revoked:
			closeAccess()
			return
		case cart := <-updates:
			if cart.Version > version {
				if initial.Private {
					if !time.Now().Before(identity.ExpiresAt) {
						closeAccess()
						return
					}
					// Reauthorize against the latest committed membership, never
					// reuse the broadcasting client's role or actor ID.
					cart, err = api.store.read(r.Context(), id, identity.Subject)
					if err != nil {
						closeAccess()
						return
					}
				}
				if write(cart) != nil {
					return
				}
				version = cart.Version
			}
		case <-ticker.C:
			if initial.Private {
				if _, err := api.store.read(r.Context(), id, identity.Subject); err != nil {
					closeAccess()
					return
				}
			}
			if conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)) != nil {
				return
			}
		}
	}
}

func readBody(w http.ResponseWriter, r *http.Request, out any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10))
	if err := decoder.Decode(out); err != nil || decoder.Decode(new(any)) != io.EOF {
		fail(w, http.StatusBadRequest, "Invalid JSON request.")
		return false
	}
	return true
}

func handleError(w http.ResponseWriter, err error) {
	var validation validationError
	switch {
	case errors.Is(err, errUnauthenticated):
		w.Header().Set("WWW-Authenticate", "Bearer")
		fail(w, http.StatusUnauthorized, "Sign in to continue.")
	case errors.Is(err, errOwnerRequired):
		fail(w, http.StatusForbidden, "Only the cart owner can do that.")
	case errors.Is(err, errInviteUnavailable):
		fail(w, http.StatusNotFound, "This invitation is invalid, expired, or no longer available.")
	case errors.Is(err, pgx.ErrNoRows):
		fail(w, http.StatusNotFound, "Cart not found or expired.")
	case errors.As(err, &validation):
		fail(w, http.StatusUnprocessableEntity, validation.Error())
	default:
		log.Printf("cart operation: %v", err)
		fail(w, http.StatusInternalServerError, "Something went wrong. Please try again.")
	}
}

func fail(w http.ResponseWriter, status int, message string) {
	sendJSON(w, status, map[string]string{"error": message})
}

func sendJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("write JSON: %v", err)
	}
}
