# Current milestone

M6 complete. The browser MVP is ready for demo recording.

| Milestone | Completed |
| --- | --- |
| M1 | Expo Web shell, responsive landing and cart, theme, bundled thumbnails |
| M2 | PostgreSQL carts and sessions, seeded and empty carts, item CRUD |
| M3 | WebSocket rooms, reconnect and refetch, version checks and conflict handling |
| M4 | Integer-cent ownership, equal and custom splits, animated allocation editor |
| M5 | Checkout review, simulated completion, persisted receipt and live reset |
| M6 | Same-origin production build, deployment configuration, CI checks, README screenshots |

## Verification

- Go build and vet plus six unit and integration tests passed against PostgreSQL.
- Frontend TypeScript, five model tests, and the Expo Web export passed.
- Three Playwright scenarios passed against Go serving the export with PostgreSQL. They cover two-tab WebSocket updates, checkout and receipt reload, reset, mobile custom splits and item editing, and stale-draft conflicts.
- Docker Compose configuration validates. Docker Desktop's Linux daemon was unavailable, so the local integration run used a portable PostgreSQL server. Linux CI is configured to run the Go race detector.

## Next

Record the 30–60 second demo and add it to the README. Deployment configuration is ready for a host that runs the Go API with PostgreSQL and supports WebSocket upgrades.
