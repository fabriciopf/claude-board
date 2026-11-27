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
  {
    // Repositories a card is about (D70), many per card. Not the card's working folder (repo_path): a
    // tag the user picks from a list managed in the settings, seeded with the three repos of the squad.
    version: 11,
    sql: `
CREATE TABLE repositories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE card_repositories (
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, repository_id)
);
INSERT INTO repositories (name) VALUES ('hdb'), ('ignite'), ('sms');
`,
  },
  {
    // Automations (D72): recurring tasks, fired by a schedule, by a look at a connector or by a URL, that
    // create cards for Claude. A card remembers the automation that created it.
    version: 12,
    sql: `
CREATE TABLE automations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  request TEXT NOT NULL DEFAULT '',
  instruction TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  app_id INTEGER REFERENCES apps(id) ON DELETE SET NULL,
  priority INTEGER NOT NULL DEFAULT 3,
  token TEXT NOT NULL,
  next_run_at TEXT,
  last_fired_at TEXT,
  last_checked_at TEXT,
  last_result TEXT,
  last_card_id INTEGER,
  fire_count INTEGER NOT NULL DEFAULT 0,
  seen_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX automations_token ON automations(token);
ALTER TABLE cards ADD COLUMN automation_id INTEGER REFERENCES automations(id) ON DELETE SET NULL;
`,
  },
  {
    // History of automation firings (card #160, D72): one row per firing, skipped turn or failed one. A watch
    // that keeps finding nothing updates its last row instead of adding one every few minutes.
    version: 13,
    sql: `
CREATE TABLE automation_runs (
  id INTEGER PRIMARY KEY,
  automation_id INTEGER REFERENCES automations(id) ON DELETE SET NULL,
  automation_name TEXT NOT NULL,
  at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  repeat_count INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL,
  outcome TEXT NOT NULL,
  card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
  detail TEXT
);
CREATE INDEX automation_runs_last_at ON automation_runs(last_at);
`,
  },
  {
    // The owner is who created the card, and only the user changes it by hand (D86). Until now a move
    // into "Pronta para o Claude", a reply or a comment passed it to Claude. Gives the user back every
    // card the user created. Cards Claude or the system created keep their owner. A card whose owner the
    // user edited in the "Dono" field (an "updated" event naming the field) keeps what it has.
    version: 14,
    sql: `
UPDATE cards SET owner = 'user'
WHERE owner <> 'user'
AND (SELECT e.author FROM events e WHERE e.card_id = cards.id AND e.type = 'created' ORDER BY e.id LIMIT 1) = 'user'
AND NOT EXISTS (
  SELECT 1 FROM events e, json_each(e.payload_json, '$.fields') f
  WHERE e.card_id = cards.id AND e.type = 'updated' AND e.author = 'user' AND f.value = 'owner'
);
`,
  },
  {
    // Agent per card (null = the settings decide) and the agent each run drove (D92). Runs from
    // before this migration were all Claude Code; their null reads as 'claude'.
    version: 15,
    sql: `
ALTER TABLE cards ADD COLUMN agent TEXT;
ALTER TABLE executions ADD COLUMN agent TEXT;
`,
  },
  {
    // Antigravity CLI replaced Gemini CLI as the second agent (D93): a card set to Gemini goes to
    // Antigravity. Runs keep 'gemini', the agent that really ran them.
    version: 16,
    sql: `
UPDATE cards SET agent = 'antigravity' WHERE agent = 'gemini';
`,
  },
  {
    // MCP connectors per card and per project (D124). Unused since D131 (card #246): every run loads every active connector.
    version: 17,
    sql: `
ALTER TABLE cards ADD COLUMN connectors_json TEXT;
ALTER TABLE apps ADD COLUMN connectors_json TEXT;
`,
  },
  {
    // The four token parts of each run and the plan usage read at its start and end (D126). tokens_in
    // keeps the old sum; runs from before this migration keep NULL parts and show as "não detalhado".
    version: 18,
    sql: `
ALTER TABLE executions ADD COLUMN tokens_input INTEGER;
ALTER TABLE executions ADD COLUMN tokens_cache_write INTEGER;
ALTER TABLE executions ADD COLUMN tokens_cache_read INTEGER;
ALTER TABLE executions ADD COLUMN usage_start_json TEXT;
ALTER TABLE executions ADD COLUMN usage_end_json TEXT;
ALTER TABLE executions ADD COLUMN usage_shared INTEGER;
`,
  },
  {
    // Plugins of the runs per project and per card (D128): rules like `-vercel +ignite` over the
    // settings' runPlugins. '' on a project and null on a card change nothing.
    version: 19,
    sql: `
ALTER TABLE apps ADD COLUMN plugins TEXT NOT NULL DEFAULT '';
ALTER TABLE cards ADD COLUMN plugins TEXT;
`,
  },
  {
    // How a card goes back to the agent after a delivery (D129): null = the settings decide. Each run
    // records whether it started a session, resumed one or opened a new one with the handoff package.
    version: 20,
    sql: `
ALTER TABLE cards ADD COLUMN resume_mode TEXT;
ALTER TABLE executions ADD COLUMN session_mode TEXT;
`,
  },
];
