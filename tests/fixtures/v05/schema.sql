-- Released v0.5 schema 6, independent of the Store being tested.
PRAGMA foreign_keys=ON;
CREATE TABLE repositories (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, json TEXT NOT NULL);
CREATE TABLE workspaces (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id), json TEXT NOT NULL);
CREATE TABLE tasks (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id), state TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), at TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, data TEXT);
CREATE INDEX events_task_id ON events(task_id,id);
CREATE TABLE session_bindings (session_id TEXT PRIMARY KEY REFERENCES sessions(id), json TEXT NOT NULL);
CREATE TABLE task_queue (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT UNIQUE NOT NULL REFERENCES tasks(id), resume_session_id TEXT REFERENCES sessions(id), mode TEXT NOT NULL, enqueued_at TEXT NOT NULL);
CREATE TABLE review_records (workspace_id TEXT NOT NULL REFERENCES workspaces(id), revision TEXT NOT NULL, number INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(workspace_id,revision), UNIQUE(workspace_id,number));
PRAGMA user_version=6;
