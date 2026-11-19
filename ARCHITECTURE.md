# Architecture

The Expo Web client uses TanStack Query and receives full versioned cart snapshots over WebSocket. Go serializes writes with PostgreSQL row locks and checks the client version. Cart IDs are unguessable share links.

PostgreSQL stores a JSONB cart aggregate alongside its expiry and keeps immutable checkout snapshots in a separate table. Checkout persists both records in one transaction. Reset restores the seed on the same cart ID, preserves earlier checkout snapshots, and increments the cart version. Seeded carts expire 24 hours after creation.

- POST /api/carts with {"demo":true} or {"demo":false,"name":"..."} returns a Cart.
- GET /api/carts/{id} returns a Cart.
- PATCH /api/carts/{id} with {"version":1,"action":"upsert|remove|checkout|reset","item":{...},"itemId":"...","actor":"alex"} returns a Cart. Stale writes return HTTP 409 with the latest Cart.
- GET /api/carts/{id}/ws upgrades to WebSocket and sends Cart snapshots.
- Cart: {id,name,demo,version,participants:[{id,name,color}],items:[{id,name,unitCents,quantity,category,mode,shares,allocations}],totalCents,totals,completedAt?,activity?}.
- Participant IDs alex, jordan, sam. Colors are hex. Cart totals, shares (custom amounts), and computed allocations are records keyed by participant ID. Item mode is owner, equal, or custom. For owner/equal, send members (ordered participant ID array on the wire and Cart response). For custom send shares. Category is a slug. Activity is {actor,text}. New item ID may be omitted. completedAt is ISO timestamp.
- API errors use {"error":"..."} except conflict. Local frontend port 8081 and API 8080. Production may serve exported static files from Go.

The room hub is in process. It keeps the newest queued snapshot per connection and clients ignore versions older than their cached data. An initial snapshot is sent on subscription, and the client also refetches on reconnect. Run one Go instance for this MVP.
