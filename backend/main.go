package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	database := os.Getenv("DATABASE_URL")
	if database == "" {
		database = "postgres://split:split@localhost:5432/split?sslmode=disable"
	}

	startup, cancel := context.WithTimeout(ctx, 15*time.Second)
	pool, err := pgxpool.New(startup, database)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	store := Store{pool: pool}
	switch os.Getenv("SPLIT_DB_MODE") {
	case "", "auto":
		if err := store.migrate(startup); err != nil {
			log.Fatalf("initialize PostgreSQL: %v", err)
		}
	case "migrate":
		if err := store.migrate(startup); err != nil {
			log.Fatalf("migrate PostgreSQL: %v", err)
		}
		log.Print("Split database migrations applied")
		return
	case "runtime":
		if err := pool.Ping(startup); err != nil {
			log.Fatalf("connect to PostgreSQL: %v", err)
		}
	default:
		log.Fatal("SPLIT_DB_MODE must be auto, migrate, or runtime")
	}
	cancel()

	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			cleanup, cancel := context.WithTimeout(ctx, 10*time.Second)
			if err := store.cleanup(cleanup); err != nil && ctx.Err() == nil {
				log.Printf("expire demos: %v", err)
			}
			cancel()
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()

	origins := map[string]bool{}
	allowed := os.Getenv("ALLOWED_ORIGIN")
	if allowed == "" {
		allowed = "http://localhost:8081,http://127.0.0.1:8081"
	}
	for _, origin := range strings.Split(allowed, ",") {
		origins[strings.TrimSpace(origin)] = true
	}
	api := API{store: store, hub: &Hub{rooms: make(map[string]map[chan Cart]struct{})}, origins: origins}
	if base := strings.TrimRight(strings.TrimSpace(os.Getenv("NEON_AUTH_BASE_URL")), "/"); base != "" {
		endpoint, err := url.Parse(base)
		if err != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
			log.Fatal("Invalid NEON_AUTH_BASE_URL")
		}
		origin := endpoint.Scheme + "://" + endpoint.Host
		verifier, err := newAuthVerifier(base+"/.well-known/jwks.json", origin, origin)
		if err != nil {
			log.Fatal(err)
		}
		api.verifier = verifier
		api.tickets = newSocketTickets()
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	server := &http.Server{
		Addr:              net.JoinHostPort(os.Getenv("LISTEN_HOST"), port),
		Handler:           browserSecurity(api.routes(os.Getenv("STATIC_DIR")), os.Getenv("NEON_AUTH_BASE_URL")),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second,
		WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 24 << 10,
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			log.Printf("graceful shutdown: %v", err)
		}
	}()
	log.Printf("Split API listening on %s", server.Addr)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
