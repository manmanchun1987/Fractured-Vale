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
    wood REAL NOT NULL DEFAULT 0,
    food REAL NOT NULL DEFAULT 0,
    meat REAL NOT NULL DEFAULT 0,
    stone REAL NOT NULL DEFAULT 0,
    gold REAL NOT NULL DEFAULT 0,
    atk_bonus REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS buildings (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    type TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

const cols = db.prepare("PRAGMA table_info(players)").all().map((c) => c.name);
for (const col of ["wood", "food", "meat", "stone", "gold", "atk_bonus"]) {
  if (!cols.includes(col)) {
    db.exec(`ALTER TABLE players ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`);
  }
}

// one-time-ish: copy legacy food into meat when meat is empty
try {
  db.exec(`UPDATE players SET meat = food WHERE (meat IS NULL OR meat = 0) AND food > 0`);
} catch (_) {}

const upsertStmt = db.prepare(`
  INSERT INTO players (id, name, nation_id, spec_id, x, y, wood, food, meat, stone, gold, atk_bonus, created_at, updated_at)
  VALUES (@id, @name, @nation_id, @spec_id, @x, @y, @wood, @food, @meat, @stone, @gold, @atk_bonus, @created_at, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    nation_id = excluded.nation_id,
    spec_id = excluded.spec_id,
    x = excluded.x,
    y = excluded.y,
    wood = excluded.wood,
    food = excluded.food,
    meat = excluded.meat,
    stone = excluded.stone,
    gold = excluded.gold,
    atk_bonus = excluded.atk_bonus,
    updated_at = excluded.updated_at
`);

const getStmt = db.prepare(`SELECT * FROM players WHERE id = ?`);
const getByNameStmt = db.prepare(`SELECT * FROM players WHERE name = ? COLLATE NOCASE`);

const upsertBuildingStmt = db.prepare(`
  INSERT INTO buildings (id, owner_id, type, x, y, updated_at)
  VALUES (@id, @owner_id, @type, @x, @y, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    owner_id = excluded.owner_id,
    type = excluded.type,
    x = excluded.x,
    y = excluded.y,
    updated_at = excluded.updated_at
`);

const deleteBuildingStmt = db.prepare(`DELETE FROM buildings WHERE id = ?`);
const listBuildingsStmt = db.prepare(`SELECT * FROM buildings`);
const listBuildingsByOwnerStmt = db.prepare(`SELECT * FROM buildings WHERE owner_id = ?`);

function savePlayer(p) {
  const now = Date.now();
  const meat = p.meat || 0;
  upsertStmt.run({
    id: p.id,
    name: p.name,
    nation_id: p.nationId,
    spec_id: p.specId,
    x: p.x,
    y: p.y,
    wood: p.wood || 0,
    food: meat, // keep legacy column in sync
    meat,
    stone: p.stone || 0,
    gold: p.gold || 0,
    atk_bonus: p.atkBonus || 0,
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

function saveBuilding(b) {
  upsertBuildingStmt.run({
    id: b.id,
    owner_id: b.ownerId,
    type: b.type || "barracks",
    x: b.x,
    y: b.y,
    updated_at: Date.now(),
  });
}

function deleteBuilding(id) {
  deleteBuildingStmt.run(id);
}

function loadAllBuildings() {
  return listBuildingsStmt.all();
}

function loadBuildingsByOwner(ownerId) {
  return listBuildingsByOwnerStmt.all(ownerId);
}

module.exports = {
  db,
  savePlayer,
  loadPlayer,
  loadPlayerByName,
  saveBuilding,
  deleteBuilding,
  loadAllBuildings,
  loadBuildingsByOwner,
};
