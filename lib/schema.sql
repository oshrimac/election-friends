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
