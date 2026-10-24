CREATE TABLE IF NOT EXISTS ballot_game (
 id integer PRIMARY KEY CHECK(id=1), title text NOT NULL DEFAULT 'הפרלמנט של החבר׳ה',
 parties jsonb NOT NULL DEFAULT '[]', deadline timestamptz, configured boolean NOT NULL DEFAULT false,
 locked boolean NOT NULL DEFAULT true, published boolean NOT NULL DEFAULT false,
 actual jsonb, results_note text NOT NULL DEFAULT '', published_at timestamptz,
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ballot_game(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ballot_players (
 id uuid PRIMARY KEY, name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 40), name_key text NOT NULL UNIQUE,
 token_hash text NOT NULL UNIQUE, prediction jsonb, submitted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ballot_admin_sessions (
 token_hash text PRIMARY KEY, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS ballot_rate_limits (
 key text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS ballot_audit (
 id bigserial PRIMARY KEY, action text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);


-- Additive v2 migration: retain the original group and all existing predictions.
ALTER TABLE ballot_game DROP CONSTRAINT IF EXISTS ballot_game_id_check;
CREATE SEQUENCE IF NOT EXISTS ballot_group_ids START WITH 2;
ALTER TABLE ballot_game ALTER COLUMN id SET DEFAULT nextval('ballot_group_ids');
ALTER TABLE ballot_game ADD COLUMN IF NOT EXISTS slug text;
UPDATE ballot_game SET slug='default' WHERE id=1 AND slug IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ballot_game_slug_unique ON ballot_game(slug);
ALTER TABLE ballot_game ADD COLUMN IF NOT EXISTS admin_password_hash text;
ALTER TABLE ballot_players ADD COLUMN IF NOT EXISTS group_id integer NOT NULL DEFAULT 1 REFERENCES ballot_game(id);
ALTER TABLE ballot_players DROP CONSTRAINT IF EXISTS ballot_players_name_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS ballot_players_group_name ON ballot_players(group_id,name_key);
ALTER TABLE ballot_admin_sessions ADD COLUMN IF NOT EXISTS group_id integer NOT NULL DEFAULT 1 REFERENCES ballot_game(id);
CREATE INDEX IF NOT EXISTS ballot_admin_sessions_group ON ballot_admin_sessions(group_id);
ALTER TABLE ballot_audit ADD COLUMN IF NOT EXISTS group_id integer NOT NULL DEFAULT 1 REFERENCES ballot_game(id);
