ALTER TABLE profiles
    ADD COLUMN needs_name boolean NOT NULL DEFAULT false,
    ADD COLUMN theme text CHECK (theme IN ('light', 'dark'));
