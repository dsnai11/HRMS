-- Single sign-on (Google Workspace, Microsoft 365). Each sign-in attempt keeps a one-time
-- state, nonce and PKCE verifier for ten minutes; sessions record how they were opened.
CREATE TABLE IF NOT EXISTS sso_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  nonce TEXT NOT NULL,
  verifier TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT 'password';
