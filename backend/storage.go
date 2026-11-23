package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrations embed.FS

var (
	errConflict          = errors.New("cart version changed")
	errUnauthenticated   = errors.New("sign-in required")
	errOwnerRequired     = errors.New("owner role required")
	errInviteUnavailable = errors.New("invite unavailable")
)

type validationError struct{ error }

type Store struct {
	pool *pgxpool.Pool
}

func (s Store) migrate(ctx context.Context) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(16480325)"); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "CREATE TABLE IF NOT EXISTS split_migrations (name text PRIMARY KEY)"); err != nil {
		return err
	}
	files, err := migrations.ReadDir("migrations")
	if err != nil {
		return err
	}
	for _, file := range files {
		var applied bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM split_migrations WHERE name = $1)", file.Name()).Scan(&applied); err != nil {
			return err
		}
		if applied {
			continue
		}
		sql, err := migrations.ReadFile("migrations/" + file.Name())
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			return fmt.Errorf("apply %s: %w", file.Name(), err)
		}
		if _, err := tx.Exec(ctx, "INSERT INTO split_migrations (name) VALUES ($1)", file.Name()); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s Store) create(ctx context.Context, demo bool, name string) (Cart, error) {
	cart := newCart(randomID(), demo, name)
	var expires *time.Time
	if demo {
		deadline := time.Now().Add(24 * time.Hour)
		expires = &deadline
	}
	_, err := s.pool.Exec(ctx, "INSERT INTO carts (id, state, expires_at) VALUES ($1, $2, $3)", cart.ID, cart, expires)
	return cart, err
}

const activeCart = "FROM carts WHERE id = $1 AND (expires_at IS NULL OR expires_at > now())"

func decodeCart(row pgx.Row) (Cart, error) {
	var payload []byte
	if err := row.Scan(&payload); err != nil {
		return Cart{}, err
	}
	return parseCart(payload)
}

func parseCart(payload []byte) (Cart, error) {
	var cart Cart
	err := json.Unmarshal(payload, &cart)
	return cart, err
}

func (s Store) read(ctx context.Context, id, subject string) (Cart, error) {
	const query = `SELECT CASE WHEN NOT c.is_private OR m.role IS NOT NULL THEN c.state END,
		c.is_private, COALESCE(m.role, ''), COALESCE(m.profile_id, '')
		FROM carts c
		LEFT JOIN cart_members m ON m.cart_id = c.id AND m.profile_id = (SELECT id FROM profiles WHERE subject = $2)
		WHERE c.id = $1 AND (c.expires_at IS NULL OR c.expires_at > now())`
	var payload []byte
	var private bool
	var role, actor string
	if err := s.pool.QueryRow(ctx, query, id, subject).Scan(&payload, &private, &role, &actor); err != nil {
		return Cart{}, err
	}
	if private {
		if subject == "" {
			return Cart{}, errUnauthenticated
		}
		if role == "" {
			return Cart{}, pgx.ErrNoRows
		}
	}
	cart, err := parseCart(payload)
	cart.Private, cart.Access, cart.ActorID = private, role, actor
	return cart, err
}

func lockCart(ctx context.Context, tx pgx.Tx, id, subject string) (Cart, error) {
	var payload []byte
	var private bool
	if err := tx.QueryRow(ctx, "SELECT state, is_private "+activeCart+" FOR UPDATE", id).Scan(&payload, &private); err != nil {
		return Cart{}, err
	}
	var role, actor string
	if private {
		if subject == "" {
			return Cart{}, errUnauthenticated
		}
		if err := tx.QueryRow(ctx, `SELECT m.role, p.id FROM cart_members m
			JOIN profiles p ON p.id = m.profile_id WHERE m.cart_id = $1 AND p.subject = $2`, id, subject).
			Scan(&role, &actor); err != nil {
			return Cart{}, err
		}
	}
	cart, err := parseCart(payload)
	cart.Private, cart.Access, cart.ActorID = private, role, actor
	return cart, err
}

func saveCart(ctx context.Context, tx pgx.Tx, cart Cart) error {
	cart.Access, cart.ActorID = "", ""
	_, err := tx.Exec(ctx, "UPDATE carts SET state = $2 WHERE id = $1", cart.ID, cart)
	return err
}

func (s Store) mutate(ctx context.Context, id, subject string, change Mutation) (Cart, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Cart{}, err
	}
	defer tx.Rollback(ctx)
	cart, err := lockCart(ctx, tx, id, subject)
	if err != nil {
		return Cart{}, err
	}
	if change.Version != cart.Version {
		return cart, errConflict
	}
	if cart.Private {
		change.Actor = cart.ActorID
	}
	if err := cart.apply(change, time.Now().UTC()); err != nil {
		return Cart{}, validationError{err}
	}
	if err := saveCart(ctx, tx, cart); err != nil {
		return Cart{}, err
	}
	if change.Action == "checkout" {
		snapshot := cart
		snapshot.Access, snapshot.ActorID = "", ""
		if _, err := tx.Exec(ctx, "INSERT INTO checkout_snapshots (cart_id, version, completed_at, state) VALUES ($1, $2, $3, $4)", id, cart.Version, cart.CompletedAt, snapshot); err != nil {
			return Cart{}, err
		}
	}
	return cart, tx.Commit(ctx)
}

func (s Store) cleanup(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, "DELETE FROM carts WHERE expires_at <= now()")
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, "DELETE FROM cart_invites WHERE expires_at <= now()")
	return err
}
