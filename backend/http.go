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
	store   Store
	hub     *Hub
	origins map[string]bool
}

func (api API) routes(staticDir string) http.Handler {
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
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
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
		Demo bool   `json:"demo"`
		Name string `json:"name"`
	}
	if !readBody(w, r, &body) {
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if !body.Demo && (body.Name == "" || len([]rune(body.Name)) > 100) {
		fail(w, http.StatusUnprocessableEntity, "Enter a cart name up to 100 characters.")
		return
	}
	cart, err := api.store.create(r.Context(), body.Demo, body.Name)
	if err != nil {
		handleError(w, err)
		return
	}
	sendJSON(w, http.StatusCreated, cart)
}

func (api API) read(w http.ResponseWriter, r *http.Request) {
	cart, err := api.store.read(r.Context(), r.PathValue("id"))
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
	cart, err := api.store.mutate(r.Context(), r.PathValue("id"), change)
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
	id := r.PathValue("id")
	updates, unsubscribe := api.hub.subscribe(id)
	defer unsubscribe()

	initial, err := api.store.read(r.Context(), id)
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
		case cart := <-updates:
			if cart.Version > version {
				if write(cart) != nil {
					return
				}
				version = cart.Version
			}
		case <-ticker.C:
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
