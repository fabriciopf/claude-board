// Versioned schema. Append new migrations; never edit an applied one.
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE areas (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#64748b',
  description TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE labels (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL
);
CREATE TABLE cards (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description_md TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  position REAL NOT NULL,
  owner TEXT NOT NULL DEFAULT 'user' CHECK (owner IN ('user','claude')),
  area_id INTEGER REFERENCES areas(id) ON DELETE SET NULL,
  priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
  due_date TEXT,
  origin TEXT NOT NULL DEFAULT 'manual',
  repo_path TEXT,
  base_branch TEXT,
  branch TEXT,
  worktree_path TEXT,
  permission_mode TEXT,
  max_turns INTEGER,
  budget_usd_per_run REAL,
  dangerous_allowed INTEGER NOT NULL DEFAULT 0,
  claude_session_id TEXT,
  next_prompt TEXT,
  next_prompt_kind TEXT,
  links_json TEXT NOT NULL DEFAULT '[]',
  suggested_status TEXT,
  suggestion_confidence REAL,
  suggestion_evidence TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX cards_status ON cards(status, archived, position);
CREATE TABLE card_labels (
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, label_id)
);
CREATE TABLE checklist_items (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL
);
CREATE TABLE comments (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  body_md TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'comment',
  execution_id INTEGER,
  options_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX comments_card ON comments(card_id, created_at);
CREATE TABLE executions (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  claude_session_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  transcript_path TEXT,
  summary_md TEXT,
  error_md TEXT,
  pid INTEGER,
  outcome TEXT,
  outcome_payload TEXT,
  prompt_kind TEXT,
  cwd TEXT
);
CREATE INDEX executions_card ON executions(card_id, started_at);
CREATE INDEX executions_started ON executions(started_at);
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  author TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX events_card ON events(card_id, created_at);
CREATE TABLE imported_sessions (
  claude_session_id TEXT PRIMARY KEY,
  project_path TEXT,
  transcript_path TEXT,
  first_prompt TEXT,
  last_prompt TEXT,
  ai_title TEXT,
  last_assistant TEXT,
  git_branch TEXT,
  first_event_at TEXT,
  last_event_at TEXT,
  turns INTEGER NOT NULL DEFAULT 0,
  edited_files_json TEXT NOT NULL DEFAULT '[]',
  links_json TEXT NOT NULL DEFAULT '[]',
  signals_json TEXT NOT NULL DEFAULT '[]',
  partial INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  classification_json TEXT,
  card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
  decision TEXT NOT NULL DEFAULT 'pending',
  scanned_at TEXT
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
`,
  },
  {
    // The app no longer tracks costs: drop the dollar columns and the old spend counter.
    version: 2,
    sql: `
ALTER TABLE cards DROP COLUMN budget_usd_per_run;
ALTER TABLE executions DROP COLUMN cost_usd;
DELETE FROM settings WHERE key = 'classificationSpendUsd';
`,
  },
  {
    // The card takes the session name when Claude starts it; the original request stays stored.
    version: 3,
    sql: `
ALTER TABLE cards ADD COLUMN original_title TEXT;
ALTER TABLE cards ADD COLUMN original_description_md TEXT;
ALTER TABLE cards ADD COLUMN session_name TEXT;
`,
  },
  {
    // A card Claude splits into independent tasks: each task is a card of its own, pointing back.
    version: 4,
    sql: `
ALTER TABLE cards ADD COLUMN parent_id INTEGER REFERENCES cards(id) ON DELETE SET NULL;
CREATE INDEX cards_parent ON cards(parent_id);
`,
  },
  {
    // The app (product or project) a task is about, usually a folder of the workspace.
    version: 5,
    sql: `
CREATE TABLE apps (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT,
  color TEXT NOT NULL DEFAULT '#64748b',
  description TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
ALTER TABLE cards ADD COLUMN app_id INTEGER REFERENCES apps(id) ON DELETE SET NULL;
CREATE INDEX cards_app ON cards(app_id);
`,
  },
  {
    // Model and effort: chosen per card (null = the settings decide) and recorded on each run.
    version: 6,
    sql: `
ALTER TABLE cards ADD COLUMN model TEXT;
ALTER TABLE cards ADD COLUMN effort TEXT;
ALTER TABLE executions ADD COLUMN model TEXT;
ALTER TABLE executions ADD COLUMN effort TEXT;
`,
  },
  {
    // Delivered card branches of the Board's own repo waiting to be published to the running Board (D42).
    version: 7,
    sql: `
CREATE TABLE publish_queue (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  worktree_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  kind TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  commit_sha TEXT,
  error_md TEXT
);
CREATE INDEX publish_queue_status ON publish_queue(status);
`,
  },
  {
    // Runs outlive a Board restart (D45): where the Board stopped reading the transcript, and when the
    // process started (to tell it from a recycled pid). Version 7 is the publish queue (card #45).
    version: 8,
    sql: `
ALTER TABLE executions ADD COLUMN stream_offset INTEGER;
ALTER TABLE executions ADD COLUMN spawned_at TEXT;
`,
  },
  {
    // The waiting, review and done lists read from the most recent arrival to the oldest (D58). Reorders
    // the cards already there by when they entered the list: the last "moved" event into it, else the
    // completion date, else the creation date (a card created straight into the list).
    version: 9,
    sql: `
UPDATE cards SET position = ranked.rn * 1024
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY status ORDER BY arrived DESC, id DESC) AS rn
  FROM (
    SELECT c.id, c.status,
      COALESCE(
        (SELECT MAX(e.created_at) FROM events e
          WHERE e.card_id = c.id AND e.type = 'moved' AND json_extract(e.payload_json, '$.to') = c.status),
        c.completed_at,
        c.created_at
      ) AS arrived
    FROM cards c
    WHERE c.status IN ('waiting_user', 'waiting_third_party', 'review', 'done')
  )
) AS ranked
WHERE cards.id = ranked.id;
`,
  },
  {
    // "Não iniciada" (backlog) joins the newest-first lists (D59), after version 9 already ran: same
    // reordering, by the last move into the list, else the creation date.
    version: 10,
    sql: `
UPDATE cards SET position = ranked.rn * 1024
FROM (
  SELECT id, ROW_NUMBER() OVER (ORDER BY arrived DESC, id DESC) AS rn
  FROM (
    SELECT c.id,
      COALESCE(
        (SELECT MAX(e.created_at) FROM events e
          WHERE e.card_id = c.id AND e.type = 'moved' AND json_extract(e.payload_json, '$.to') = 'backlog'),
        c.created_at
      ) AS arrived
    FROM cards c
    WHERE c.status = 'backlog'
  )
) AS ranked
WHERE cards.id = ranked.id;
`,
  },
];
