CREATE TABLE profiles (
    id text PRIMARY KEY,
    subject text NOT NULL UNIQUE,
    name text NOT NULL
);

ALTER TABLE carts ADD COLUMN is_private boolean NOT NULL DEFAULT false;

CREATE TABLE cart_members (
    cart_id text NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
    profile_id text NOT NULL REFERENCES profiles (id),
    role text NOT NULL CHECK (role IN ('owner', 'member')),
    PRIMARY KEY (cart_id, profile_id)
);
CREATE UNIQUE INDEX cart_one_owner ON cart_members (cart_id) WHERE role = 'owner';
CREATE INDEX cart_members_profile ON cart_members (profile_id);

CREATE TABLE cart_invites (
    token_hash bytea PRIMARY KEY,
    cart_id text NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX cart_invites_cart ON cart_invites (cart_id);
CREATE INDEX cart_invites_expiration ON cart_invites (expires_at);
