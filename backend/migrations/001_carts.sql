CREATE TABLE IF NOT EXISTS carts (
    id text PRIMARY KEY,
    state jsonb NOT NULL,
    expires_at timestamptz
);

CREATE INDEX IF NOT EXISTS carts_expiration ON carts (expires_at)
WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS checkout_snapshots (
    cart_id text NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
    version bigint NOT NULL,
    completed_at timestamptz NOT NULL,
    state jsonb NOT NULL,
    PRIMARY KEY (cart_id, version)
);
