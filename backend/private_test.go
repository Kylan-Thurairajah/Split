package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type fakeIdentityVerifier map[string]Identity

func (identities fakeIdentityVerifier) Verify(_ context.Context, token string) (Identity, error) {
	identity, ok := identities[token]
	if !ok {
		return Identity{}, errInvalidIdentity
	}
	return identity, nil
}

func TestPrivateCartAccessMatrix(t *testing.T) {
	store, api := privateTestAPI(t)
	endpoint := api.routes("")
	var profile, again Profile
	privateRequest(t, endpoint, "GET", "/api/me", "owner", "", 200, &profile)
	privateRequest(t, endpoint, "GET", "/api/me", "owner", "", 200, &again)
	if profile.ID == "" || profile != again || profile.Name != "O'Reilly; --" {
		t.Fatalf("unstable or altered profile: %+v %+v", profile, again)
	}
	if !profile.NeedsName {
		t.Fatal("new account did not require display name setup")
	}
	privateRequest(t, endpoint, "PATCH", "/api/me", "", `{"name":"Intruder"}`, 401, nil)
	privateRequest(t, endpoint, "PATCH", "/api/me", "owner", `{"theme":"invalid"}`, 422, nil)
	privateRequest(t, endpoint, "PATCH", "/api/me", "owner", `{"name":"Casey","theme":"dark"}`, 200, &profile)
	privateRequest(t, endpoint, "PATCH", "/api/me", "owner", `{"name":"Overwrite"}`, 200, &again)
	privateRequest(t, endpoint, "GET", "/api/me", "owner", "", 200, &again)
	if again.ID != profile.ID || again.NeedsName || again.Name != "Casey" || again.Theme == nil || *again.Theme != "dark" {
		t.Fatalf("profile setup or theme did not persist: %+v", again)
	}

	var cart Cart
	create := `{"name":"Private beta","private":true}`
	privateRequest(t, endpoint, "POST", "/api/carts", "", "", 400, nil)
	privateRequest(t, endpoint, "POST", "/api/carts", "", create, 401, nil)
	privateRequest(t, endpoint, "POST", "/api/carts", "owner", create, 201, &cart)
	if cart.Access != "owner" || cart.ActorID != profile.ID || !cart.Private || len(cart.Participants) != 1 {
		t.Fatalf("bad owned cart: %+v", cart)
	}
	t.Cleanup(func() { _, _ = store.pool.Exec(context.Background(), "DELETE FROM carts WHERE id = $1", cart.ID) })
	path := "/api/carts/" + cart.ID
	for _, token := range []string{"", "invalid", "expired"} {
		privateRequest(t, endpoint, "GET", path, token, "", 401, nil)
	}
	var list []Cart
	privateRequest(t, endpoint, "GET", "/api/me/carts", "outsider", "", 200, &list)
	if list == nil || len(list) != 0 {
		t.Fatalf("outsider list = %#v", list)
	}
	privateRequest(t, endpoint, "GET", path, "outsider", "", 404, nil)
	privateRequest(t, endpoint, "PATCH", path, "outsider", `{"version":0,"action":"checkout"}`, 404, nil)
	privateRequest(t, endpoint, "POST", path+"/ws-ticket", "outsider", "", 404, nil)
	privateRequest(t, endpoint, "POST", path+"/invites", "outsider", "", 404, nil)
	privateRequest(t, endpoint, "GET", path+"/ws", "", "", 401, nil)

	var revoked Invite
	privateRequest(t, endpoint, "POST", path+"/invites", "owner", "", 201, &revoked)
	privateRequest(t, endpoint, "DELETE", path+"/invites", "owner", "", 204, nil)
	privateRequest(t, endpoint, "POST", "/api/invites/redeem", "member", tokenBody(revoked.Token), 404, nil)

	var expired Invite
	privateRequest(t, endpoint, "POST", path+"/invites", "owner", "", 201, &expired)
	if _, err := store.pool.Exec(context.Background(), "UPDATE cart_invites SET expires_at = now() - interval '1 minute' WHERE cart_id = $1", cart.ID); err != nil {
		t.Fatal(err)
	}
	privateRequest(t, endpoint, "POST", "/api/invites/redeem", "member", tokenBody(expired.Token), 404, nil)

	var invite Invite
	privateRequest(t, endpoint, "POST", path+"/invites", "owner", "", 201, &invite)
	privateRequest(t, endpoint, "POST", "/api/invites/redeem", "", tokenBody(invite.Token), 401, nil)
	var joined Cart
	privateRequest(t, endpoint, "POST", "/api/invites/redeem", "member", tokenBody(invite.Token), 200, &joined)
	if joined.Access != "member" || joined.ActorID == cart.ActorID || len(joined.Participants) != 2 || len(joined.Activities) != 1 {
		t.Fatalf("unexpected member cart: %+v", joined)
	}
	privateRequest(t, endpoint, "POST", "/api/invites/redeem", "outsider", tokenBody(invite.Token), 404, nil)
	privateRequest(t, endpoint, "POST", path+"/invites", "member", "", 403, nil)
	privateRequest(t, endpoint, "DELETE", path+"/invites", "member", "", 403, nil)
	privateRequest(t, endpoint, "DELETE", path+"/members/"+joined.ActorID, "member", "", 403, nil)

	item := &Item{Name: "Price test", UnitCents: 1000, Quantity: 1, Mode: "owner", Members: []string{joined.ActorID}}
	edit, err := json.Marshal(Mutation{Version: joined.Version, Action: "upsert", Actor: cart.ActorID, Item: item})
	if err != nil {
		t.Fatal(err)
	}
	var changed Cart
	privateRequest(t, endpoint, "PATCH", path, "member", string(edit), 200, &changed)
	if changed.Activity == nil || changed.Activity.Actor != joined.ActorID || changed.TotalCents != 1000 {
		t.Fatalf("session actor or total was not authoritative: %+v", changed)
	}
	var conflict Cart
	privateRequest(t, endpoint, "PATCH", path, "member", string(edit), 409, &conflict)
	if conflict.Version != changed.Version || conflict.ActorID != joined.ActorID {
		t.Fatalf("bad member conflict snapshot: %+v", conflict)
	}

	checkout, err := json.Marshal(Mutation{Version: changed.Version, Action: "checkout"})
	if err != nil {
		t.Fatal(err)
	}
	var receipt Cart
	privateRequest(t, endpoint, "PATCH", path, "member", string(checkout), 200, &receipt)
	if receipt.CompletedAt == nil {
		t.Fatal("member checkout did not complete")
	}
	privateRequest(t, endpoint, "GET", "/api/me/carts", "member", "", 200, &list)
	if len(list) != 1 || list[0].CompletedAt == nil || list[0].ID != cart.ID {
		t.Fatalf("completed cart missing: %+v", list)
	}
	privateRequest(t, endpoint, "GET", path, "outsider", "", 404, nil)
	var removed Cart
	privateRequest(t, endpoint, "DELETE", path+"/members/"+joined.ActorID, "owner", "", 200, &removed)
	if len(removed.Participants) != 2 || !removed.Participants[1].Inactive || removed.Totals[joined.ActorID] != 1000 {
		t.Fatalf("removal affected receipt attribution: %+v", removed)
	}
	privateRequest(t, endpoint, "GET", path, "member", "", 404, nil)
	privateRequest(t, endpoint, "GET", "/api/me/carts", "member", "", 200, &list)
	if len(list) != 0 {
		t.Fatalf("removed member retained list access: %+v", list)
	}
	snapshot, err := decodeCart(store.pool.QueryRow(context.Background(), "SELECT state FROM checkout_snapshots WHERE cart_id = $1", cart.ID))
	if err != nil || snapshot.Access != "" || snapshot.ActorID != "" || snapshot.Version != receipt.Version || snapshot.Participants[1].Inactive {
		t.Fatalf("snapshot was personalized or mutated: %+v %v", snapshot, err)
	}
}

func TestPrivateSocketTicketAndRevocation(t *testing.T) {
	store, api := privateTestAPI(t)
	endpoint := api.routes("")
	server := httptest.NewServer(endpoint)
	defer server.Close()

	var cart Cart
	privateRequest(t, endpoint, "POST", "/api/carts", "owner", `{"name":"WebSocket trial","private":true}`, 201, &cart)
	t.Cleanup(func() { _, _ = store.pool.Exec(context.Background(), "DELETE FROM carts WHERE id = $1", cart.ID) })
	path := "/api/carts/" + cart.ID
	var invite Invite
	privateRequest(t, endpoint, "POST", path+"/invites", "owner", "", 201, &invite)
	var member Cart
	privateRequest(t, endpoint, "POST", "/api/invites/redeem", "member", tokenBody(invite.Token), 200, &member)

	ticketFor := func(token string) string {
		t.Helper()
		var value struct{ Ticket string }
		privateRequest(t, endpoint, "POST", path+"/ws-ticket", token, "", 201, &value)
		return value.Ticket
	}
	dial := func(ticket string) (*websocket.Conn, *http.Response, error) {
		return websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+path+"/ws?ticket="+ticket, nil)
	}
	read := func(conn *websocket.Conn) Cart {
		t.Helper()
		conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		var snapshot Cart
		if err := conn.ReadJSON(&snapshot); err != nil {
			t.Fatal(err)
		}
		return snapshot
	}
	ownerTicket := ticketFor("owner")
	ownerConn, _, err := dial(ownerTicket)
	if err != nil {
		t.Fatal(err)
	}
	defer ownerConn.Close()
	if initial := read(ownerConn); initial.Access != "owner" || initial.ActorID != cart.ActorID {
		t.Fatalf("bad owner socket snapshot: %+v", initial)
	}
	if conn, response, err := dial(ownerTicket); err == nil || response == nil || response.StatusCode != 401 {
		if conn != nil {
			conn.Close()
		}
		t.Fatalf("ticket replay not denied: %v", err)
	}
	memberConn, _, err := dial(ticketFor("member"))
	if err != nil {
		t.Fatal(err)
	}
	defer memberConn.Close()
	if initial := read(memberConn); initial.Access != "member" || initial.ActorID != member.ActorID {
		t.Fatalf("bad member socket snapshot: %+v", initial)
	}

	change, err := json.Marshal(Mutation{Version: member.Version, Action: "upsert", Item: &Item{Name: "Desk", UnitCents: 1000, Quantity: 1, Mode: "owner", Members: []string{cart.ActorID}}})
	if err != nil {
		t.Fatal(err)
	}
	privateRequest(t, endpoint, "PATCH", path, "owner", string(change), 200, nil)
	if event := read(ownerConn); event.Version != member.Version+1 || event.ActorID != cart.ActorID {
		t.Fatalf("owner missed edit: %+v", event)
	}
	if event := read(memberConn); event.Access != "member" || event.ActorID != member.ActorID || len(event.Items) != 1 {
		t.Fatalf("member received wrong perspective: %+v", event)
	}

	preRevocationTicket := ticketFor("member")
	privateRequest(t, endpoint, "DELETE", path+"/members/"+member.ActorID, "owner", "", 200, nil)
	if event := read(ownerConn); event.Access != "owner" || event.ActorID != cart.ActorID || len(event.Participants) != 1 {
		t.Fatalf("owner received wrong removal event: %+v", event)
	}
	memberConn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, _, err := memberConn.ReadMessage(); !websocket.IsCloseError(err, websocket.ClosePolicyViolation) {
		t.Fatalf("removed socket kept access or was not closed with policy status: %v", err)
	}
	if conn, response, err := dial(preRevocationTicket); err == nil || response == nil || response.StatusCode != 404 {
		if conn != nil {
			conn.Close()
		}
		t.Fatalf("ticket issued before removal retained access: %v", err)
	}
}

func TestRequestLimitWindow(t *testing.T) {
	lim := &requestLimits{}
	start := time.Now()
	if !lim.allow("key", 1, start) || lim.allow("key", 1, start) || !lim.allow("other", 1, start) || !lim.allow("key", 1, start.Add(time.Minute)) {
		t.Fatal("request limiter failed to isolate actors or reset")
	}
}

func privateTestAPI(t *testing.T) (Store, API) {
	t.Helper()
	store := integrationStore(t)
	prefix := randomID()
	expiry := time.Now().Add(time.Hour)
	identities := fakeIdentityVerifier{
		"owner":    {Subject: prefix + "-1", Name: "O'Reilly; --", ExpiresAt: expiry},
		"member":   {Subject: prefix + "-2", Name: "Member", ExpiresAt: expiry},
		"outsider": {Subject: prefix + "-3", Name: "Outsider", ExpiresAt: expiry},
		"expired":  {Subject: prefix + "-4", Name: "Expired", ExpiresAt: time.Now().Add(-time.Hour)},
	}
	t.Cleanup(func() {
		_, _ = store.pool.Exec(context.Background(), "DELETE FROM profiles WHERE subject LIKE $1", prefix+"-%")
	})
	return store, API{store: store, hub: &Hub{rooms: make(map[string]map[chan Cart]struct{})}, verifier: identities, tickets: newSocketTickets()}
}

func privateRequest(t *testing.T, handler http.Handler, method, path, token, body string, want int, result any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != want {
		t.Fatalf("%s %s got %d, want %d: %s", method, path, res.Code, want, res.Body.String())
	}
	if result != nil {
		if err := json.Unmarshal(res.Body.Bytes(), result); err != nil {
			t.Fatal(err)
		}
	}
}

func tokenBody(token string) string {
	payload, _ := json.Marshal(map[string]string{"token": token})
	return string(payload)
}
