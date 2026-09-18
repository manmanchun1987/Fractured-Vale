const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "players.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    nation_id TEXT NOT NULL,
    spec_id TEXT NOT NULL,
    x REAL NOT NULL DEFAULT 400,
    y REAL NOT NULL DEFAULT 400,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

const upsertStmt = db.prepare(`
  INSERT INTO players (id, name, nation_id, spec_id, x, y, created_at, updated_at)
  VALUES (@id, @name, @nation_id, @spec_id, @x, @y, @created_at, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    nation_id = excluded.nation_id,
    spec_id = excluded.spec_id,
    x = excluded.x,
    y = excluded.y,
    updated_at = excluded.updated_at
`);

const getStmt = db.prepare(`SELECT * FROM players WHERE id = ?`);
const getByNameStmt = db.prepare(`SELECT * FROM players WHERE name = ? COLLATE NOCASE`);

function savePlayer(p) {
  const now = Date.now();
  upsertStmt.run({
    id: p.id,
    name: p.name,
    nation_id: p.nationId,
    spec_id: p.specId,
    x: p.x,
    y: p.y,
    created_at: p.createdAt || now,
    updated_at: now,
  });
}

function loadPlayer(id) {
  return getStmt.get(id) || null;
}

function loadPlayerByName(name) {
  return getByNameStmt.get(name) || null;
}

module.exports = { db, savePlayer, loadPlayer, loadPlayerByName };
