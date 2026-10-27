-- Rate-limit shared table for multi-instance correctness (012)
CREATE TABLE IF NOT EXISTS rate_limit_hits (
  key VARCHAR(255) PRIMARY KEY,
  hits INT NOT NULL DEFAULT 0,
  window_start BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_updated ON rate_limit_hits(updated_at);
