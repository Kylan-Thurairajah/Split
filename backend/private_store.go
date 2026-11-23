package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type Profile struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	NeedsName bool    `json:"needsName"`
	Theme     *string `json:"theme"`
}

type Invite struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type profileWriter interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

const (
	maxMembers     = 12
	inviteDuration = 24 * time.Hour
)

func ensureProfile(ctx context.Context, db profileWriter, identity Identity) (Profile, error) {
	name := strings.TrimSpace(identity.Name)
	if name == "" {
		name = "Split member"
	}
	if chars := []rune(name); len(chars) > 100 {
		name = string(chars[:100])
	}
	var profile Profile
	err := db.QueryRow(ctx, `INSERT INTO profiles (id, subject, name, needs_name) VALUES ($1,$2,$3,true)
		ON CONFLICT (subject) DO UPDATE SET subject = EXCLUDED.subject RETURNING id, name, needs_name, theme`,
		randomID(), identity.Subject, name).Scan(&profile.ID, &profile.Name, &profile.NeedsName, &profile.Theme)
	return profile, err
}

func (s Store) listCarts(ctx context.Context, subject string) ([]Cart, error) {
	rows, err := s.pool.Query(ctx, `SELECT c.state, m.role, m.profile_id
		FROM cart_members m JOIN carts c ON c.id = m.cart_id JOIN profiles p ON p.id = m.profile_id
		WHERE p.subject = $1 AND c.is_private
		ORDER BY c.state->>'completedAt' DESC NULLS FIRST, c.id`, subject)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	carts := []Cart{}
	for rows.Next() {
		var payload []byte
		var role, actor string
		if err := rows.Scan(&payload, &role, &actor); err != nil {
			return nil, err
		}
		cart, err := parseCart(payload)
		if err != nil {
			return nil, err
		}
		cart.Private, cart.Access, cart.ActorID = true, role, actor
		carts = append(carts, cart)
	}
	return carts, rows.Err()
}

func (s Store) createPrivate(ctx context.Context, identity Identity, name string) (Cart, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Cart{}, err
	}
	defer tx.Rollback(ctx)

	profile, err := ensureProfile(ctx, tx, identity)
	if err != nil {
		return Cart{}, err
	}
	cart := newCart(randomID(), false, name)
	cart.Private = true
	cart.Participants = []Participant{{ID: profile.ID, Name: profile.Name, Color: participants[0].Color}}
	if err := cart.recalculate(); err != nil {
		return Cart{}, err
	}
	if _, err := tx.Exec(ctx, "INSERT INTO carts (id, state, is_private) VALUES ($1,$2,true)", cart.ID, cart); err != nil {
		return Cart{}, err
	}
	if _, err := tx.Exec(ctx, "INSERT INTO cart_members (cart_id, profile_id, role) VALUES ($1,$2,'owner')", cart.ID, profile.ID); err != nil {
		return Cart{}, err
	}
	cart.Access, cart.ActorID = "owner", profile.ID
	return cart, tx.Commit(ctx)
}

func (s Store) createInvite(ctx context.Context, id, subject string) (Invite, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Invite{}, err
	}
	defer tx.Rollback(ctx)
	cart, err := lockOwnerCart(ctx, tx, id, subject)
	if err != nil {
		return Invite{}, err
	}
	if cart.CompletedAt != nil {
		return Invite{}, validationError{errors.New("This cart has already completed checkout.")}
	}
	var pending int
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM cart_invites WHERE cart_id = $1 AND expires_at > now()", id).Scan(&pending); err != nil {
		return Invite{}, err
	}
	if pending >= maxMembers {
		return Invite{}, validationError{errors.New("Revoke an outstanding invitation before creating another.")}
	}
	invite := Invite{Token: randomID(), ExpiresAt: time.Now().UTC().Add(inviteDuration)}
	hash := sha256.Sum256([]byte(invite.Token))
	if _, err := tx.Exec(ctx, "INSERT INTO cart_invites (token_hash, cart_id, expires_at) VALUES ($1,$2,$3)", hash[:], id, invite.ExpiresAt); err != nil {
		return Invite{}, err
	}
	return invite, tx.Commit(ctx)
}

func (s Store) revokeInvites(ctx context.Context, id, subject string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := lockOwnerCart(ctx, tx, id, subject); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM cart_invites WHERE cart_id = $1", id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s Store) redeemInvite(ctx context.Context, identity Identity, token string) (Cart, error) {
	if len(token) != 32 {
		return Cart{}, errInviteUnavailable
	}
	hash := sha256.Sum256([]byte(token))
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Cart{}, err
	}
	defer tx.Rollback(ctx)
	var id string
	err = tx.QueryRow(ctx, "SELECT cart_id FROM cart_invites WHERE token_hash = $1 AND expires_at > now()", hash[:]).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Cart{}, errInviteUnavailable
	}
	if err != nil {
		return Cart{}, err
	}

	// All changes to a cart or its invitations lock the cart first.
	cart, err := decodeCart(tx.QueryRow(ctx, "SELECT state "+activeCart+" AND is_private FOR UPDATE", id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Cart{}, errInviteUnavailable
	}
	if err != nil {
		return Cart{}, err
	}
	cart.Private = true
	if cart.CompletedAt != nil {
		return Cart{}, errInviteUnavailable
	}
	deleted, err := tx.Exec(ctx, "DELETE FROM cart_invites WHERE token_hash = $1 AND expires_at > clock_timestamp()", hash[:])
	if err != nil {
		return Cart{}, err
	}
	if deleted.RowsAffected() == 0 {
		return Cart{}, errInviteUnavailable
	}
	profile, err := ensureProfile(ctx, tx, identity)
	if err != nil {
		return Cart{}, err
	}
	index := -1
	for i, person := range cart.Participants {
		if person.ID == profile.ID {
			index = i
			break
		}
	}
	if len(cart.Participants) >= maxMembers && index == -1 {
		return Cart{}, validationError{errors.New("This cart is full.")}
	}
	added, err := tx.Exec(ctx, "INSERT INTO cart_members (cart_id, profile_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING", id, profile.ID)
	if err != nil {
		return Cart{}, err
	}
	if added.RowsAffected() == 0 {
		return Cart{}, validationError{errors.New("You already belong to this cart.")}
	}
	if index != -1 {
		cart.Participants[index].Inactive = false
		cart.Participants[index].Name = profile.Name
	} else {
		color := participants[len(cart.Participants)%len(participants)].Color
		cart.Participants = append(cart.Participants, Participant{ID: profile.ID, Name: profile.Name, Color: color})
	}
	if err := cart.recalculate(); err != nil {
		return Cart{}, err
	}
	cart.record(profile.ID, "joined the cart", time.Now().UTC())
	if err := saveCart(ctx, tx, cart); err != nil {
		return Cart{}, err
	}
	cart.Access, cart.ActorID = "member", profile.ID
	return cart, tx.Commit(ctx)
}

func (s Store) removeMember(ctx context.Context, id, subject, memberID string) (Cart, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Cart{}, err
	}
	defer tx.Rollback(ctx)
	cart, err := lockOwnerCart(ctx, tx, id, subject)
	if err != nil {
		return Cart{}, err
	}
	if memberID == cart.ActorID {
		return Cart{}, validationError{errors.New("The cart owner cannot be removed.")}
	}

	removed, err := tx.Exec(ctx, "DELETE FROM cart_members WHERE cart_id = $1 AND profile_id = $2 AND role = 'member'", id, memberID)
	if err != nil {
		return Cart{}, err
	}
	if removed.RowsAffected() == 0 {
		return Cart{}, pgx.ErrNoRows
	}

	// Preserve attribution for completed receipts and allocated items. An
	// inactive participant cannot be added to any new item allocation.
	for index, person := range cart.Participants {
		if person.ID != memberID {
			continue
		}
		if cart.CompletedAt != nil || cart.hasAllocation(memberID) {
			cart.Participants[index].Inactive = true
		} else {
			cart.Participants = append(cart.Participants[:index], cart.Participants[index+1:]...)
		}
		cart.record(cart.ActorID, "removed "+person.Name, time.Now().UTC())
		break
	}
	if err := cart.recalculate(); err != nil {
		return Cart{}, err
	}
	if err := saveCart(ctx, tx, cart); err != nil {
		return Cart{}, err
	}
	return cart, tx.Commit(ctx)
}

func lockOwnerCart(ctx context.Context, tx pgx.Tx, id, subject string) (Cart, error) {
	cart, err := lockCart(ctx, tx, id, subject)
	if err != nil {
		return Cart{}, err
	}
	if !cart.Private {
		return Cart{}, pgx.ErrNoRows
	}
	if cart.Access != "owner" {
		return Cart{}, errOwnerRequired
	}
	return cart, nil
}
