package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresPersistenceAndConcurrentEdit(t *testing.T) {
	store := integrationStore(t)
	ctx := context.Background()
	cart := integrationCart(t, store)
	item := cart.Items[0]
	item.Quantity++
	change := Mutation{Version: cart.Version, Action: "upsert", Actor: "alex", Item: &item}

	errs := make(chan error, 2)
	var writers sync.WaitGroup
	for i := 0; i < 2; i++ {
		writers.Add(1)
		go func() {
			defer writers.Done()
			_, err := store.mutate(ctx, cart.ID, "", change)
			errs <- err
		}()
	}
	writers.Wait()
	close(errs)
	success, conflict := 0, 0
	for err := range errs {
		switch {
		case err == nil:
			success++
		case errors.Is(err, errConflict):
			conflict++
		default:
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("successes = %d, conflicts = %d", success, conflict)
	}
	got, err := store.read(ctx, cart.ID, "")
	if err != nil || got.Version != cart.Version+1 || got.Items[0].Quantity != item.Quantity {
		t.Fatalf("unexpected persisted edit: %+v, %v", got, err)
	}
	another, err := store.create(ctx, true, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = store.pool.Exec(ctx, "DELETE FROM carts WHERE id = $1", another.ID) })
	if another.ID == cart.ID || another.Items[0].Quantity != cart.Items[0].Quantity {
		t.Fatalf("seeded carts are not isolated: %+v", another)
	}
}

func TestPostgresCheckoutSnapshotSurvivesReset(t *testing.T) {
	store := integrationStore(t)
	ctx := context.Background()
	cart := integrationCart(t, store)
	completed, err := store.mutate(ctx, cart.ID, "", Mutation{Version: cart.Version, Action: "checkout", Actor: "sam"})
	if err != nil {
		t.Fatal(err)
	}
	if completed.CompletedAt == nil {
		t.Fatal("checkout did not mark completion")
	}
	reset, err := store.mutate(ctx, cart.ID, "", Mutation{Version: completed.Version, Action: "reset", Actor: "sam"})
	if err != nil || reset.CompletedAt != nil || reset.Version != completed.Version+1 {
		t.Fatalf("unexpected reset response: %+v, %v", reset, err)
	}
	snapshot, err := decodeCart(store.pool.QueryRow(ctx, "SELECT state FROM checkout_snapshots WHERE cart_id = $1 AND version = $2", cart.ID, completed.Version))
	if err != nil || snapshot.TotalCents != completed.TotalCents || snapshot.CompletedAt == nil || !snapshot.CompletedAt.Equal(*completed.CompletedAt) {
		t.Fatalf("unexpected completed snapshot: %+v, %v", snapshot, err)
	}
	if _, err := store.pool.Exec(ctx, "UPDATE carts SET expires_at = now() - interval '1 second' WHERE id = $1", cart.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.read(ctx, cart.ID, ""); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("expired cart remained accessible: %v", err)
	}
	if err := store.cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	var exists bool
	if err := store.pool.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM checkout_snapshots WHERE cart_id = $1)", cart.ID).Scan(&exists); err != nil || exists {
		t.Fatalf("expired snapshot remains: %t, %v", exists, err)
	}
}

func TestWebSocketRoomReceivesVersionedHTTPMutation(t *testing.T) {
	store := integrationStore(t)
	cart := integrationCart(t, store)
	api := API{store: store, hub: &Hub{rooms: make(map[string]map[chan Cart]struct{})}}
	server := httptest.NewServer(api.routes(""))
	defer server.Close()
	url := server.URL + "/api/carts/" + cart.ID
	wsURL := "ws" + strings.TrimPrefix(url, "http") + "/ws"
	connections := make([]*websocket.Conn, 2)
	for i := range connections {
		conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		connections[i] = conn
		conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		var initial Cart
		if err := conn.ReadJSON(&initial); err != nil || initial.Version != cart.Version {
			t.Fatalf("unexpected initial cart: %+v, %v", initial, err)
		}
	}
	body, err := json.Marshal(Mutation{Version: cart.Version, Action: "remove", Actor: "jordan", ItemID: cart.Items[0].ID})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("PATCH", url, strings.NewReader(string(body)))
	response := httptest.NewRecorder()
	api.routes("").ServeHTTP(response, req)
	if response.Code != 200 {
		t.Fatalf("mutation status = %d: %s", response.Code, response.Body.String())
	}
	for _, conn := range connections {
		var updated Cart
		if err := conn.ReadJSON(&updated); err != nil || updated.Version != cart.Version+1 || len(updated.Items) != 4 {
			t.Fatalf("unexpected socket update: %+v, %v", updated, err)
		}
	}
}

func integrationStore(t *testing.T) Store {
	t.Helper()
	database := os.Getenv("TEST_DATABASE_URL")
	if database == "" {
		t.Skip("set TEST_DATABASE_URL to run PostgreSQL integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, database)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	store := Store{pool: pool}
	if err := store.migrate(ctx); err != nil {
		t.Fatal(err)
	}
	return store
}

func integrationCart(t *testing.T, store Store) Cart {
	t.Helper()
	ctx := context.Background()
	cart, err := store.create(ctx, true, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := store.pool.Exec(ctx, "DELETE FROM carts WHERE id = $1", cart.ID); err != nil {
			t.Errorf("clean up cart: %v", err)
		}
	})
	return cart
}
