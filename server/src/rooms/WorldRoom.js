const { Room } = require("colyseus");
const {
  WorldState,
  PlayerState,
  ResourceNodeState,
  BuildingState,
  CastleState,
  FollowerState,
  LootState,
} = require("../schema/PlayerState");
const {
  savePlayer,
  loadPlayer,
  saveBuilding,
  loadAllBuildings,
} = require("../db");
const path = require("path");
const fs = require("fs");

const nationsPath = path.join(__dirname, "../../../client/data/nations.json");
const unitsPath = path.join(__dirname, "../../../client/data/units.json");
const resourcesPath = path.join(__dirname, "../../../client/data/resources.json");
const buildingsPath = path.join(__dirname, "../../../client/data/buildings.json");
const lootPath = path.join(__dirname, "../../../client/data/loot.json");

const nationsData = JSON.parse(fs.readFileSync(nationsPath, "utf8"));
const unitsData = JSON.parse(fs.readFileSync(unitsPath, "utf8"));
const resourcesData = JSON.parse(fs.readFileSync(resourcesPath, "utf8"));
const buildingsData = JSON.parse(fs.readFileSync(buildingsPath, "utf8"));
const lootData = JSON.parse(fs.readFileSync(lootPath, "utf8"));

const nationById = Object.fromEntries(nationsData.nations.map((n) => [n.id, n]));
const unitById = Object.fromEntries(unitsData.units.map((u) => [u.id, u]));
const resourceTypes = resourcesData.types || {};
const barracksCfg = buildingsData.barracks;
const castleCfg = buildingsData.castle || {};
const POP_CAP = buildingsData.populationCap || 300;
const lootItems = lootData.items || {};
const lootTables = lootData.tables || {};
const pickupRadius = lootData.pickupRadius || 32;
const lootDespawnMs = lootData.despawnMs || 120000;
const playerDeathCfg = lootData.playerDeath || {};

const WORLD_W = 1600;
const WORLD_H = 1200;
const TICK_MS = 50;
const PVP_DAMAGE_SCALE = 0.45;
const RES_KEYS = ["wood", "meat", "stone", "gold"];

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function costOf(cost, key) {
  if (!cost) return 0;
  if (key === "meat") return cost.meat || cost.food || 0; // accept legacy food key
  return cost[key] || 0;
}

function canAfford(player, cost) {
  return RES_KEYS.every((k) => (player[k] || 0) >= costOf(cost, k));
}

function pay(player, cost) {
  for (const k of RES_KEYS) {
    player[k] = Math.max(0, (player[k] || 0) - costOf(cost, k));
  }
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function unitStats(specId) {
  return unitById[specId] || unitById.militia;
}

function addResource(target, type, amount) {
  // accept legacy "food" as meat
  const key = type === "food" ? "meat" : type;
  if (!RES_KEYS.includes(key)) return;
  target[key] = (target[key] || 0) + amount;
}

class WorldRoom extends Room {
  onCreate() {
    this.setState(new WorldState());
    this.state.worldW = WORLD_W;
    this.state.worldH = WORLD_H;
    this.maxClients = 64;
    this.inputs = new Map();
    this.saveTimers = new Map();
    this.gatherAcc = new Map();
    this.followerGatherAcc = new Map();
    this.atkCooldown = new Map();
    this.attackIntent = new Map();
    this.lootSeq = 0;
    this.followerSeq = 0;
    // ownerSessionId -> array of serialized follower snapshots
    this.garrisonStore = new Map();

    this.spawnResourceNodes();
    this.loadPersistedBuildings();

    this.onMessage("move", (client, message) => {
      const dx = Number(message?.dx) || 0;
      const dy = Number(message?.dy) || 0;
      const len = Math.hypot(dx, dy);
      if (len > 1.05) {
        this.inputs.set(client.sessionId, { dx: dx / len, dy: dy / len });
      } else {
        this.inputs.set(client.sessionId, { dx, dy });
      }
    });

    this.onMessage("chat", (client, message) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const text = String(message?.text || "").slice(0, 120).trim();
      if (!text) return;
      this.broadcast("chat", {
        from: player.name,
        nationId: player.nationId,
        text,
        t: Date.now(),
      });
    });

    this.onMessage("save", (client) => this.persistPlayer(client.sessionId));
    this.onMessage("build", (client, message) => this.handleBuild(client, message));
    this.onMessage("train", (client, message) => this.handleTrain(client, message));
    this.onMessage("attack", (client, message) => {
      const on = message?.on !== false && message?.on !== 0;
      this.attackIntent.set(client.sessionId, !!on);
      if (on) this.tryPlayerAttack(client.sessionId, true);
    });

    this.onMessage("castle", (client, message) => this.handleCastle(client, message));
    // playtest helper: drop a small loot pile at feet (disabled when FRACTURED_TEST_KIT=0)
    this.onMessage("dev_loot", (client) => {
      if (process.env.FRACTURED_TEST_KIT === "0") return;
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      this.spawnLoot(player.x + 8, player.y, "meat", 17, "");
      this.spawnLoot(player.x - 8, player.y, "gold", 5, "");
      this.notifyClient(client.sessionId, "測試掉落已放喺腳邊");
    });

    this.setSimulationInterval((deltaTime) => this.update(deltaTime), TICK_MS);
    console.log("[WorldRoom] created (Phase 4+: combat/loot/castle/pop300)");
  }

  spawnResourceNodes() {
    for (const n of resourcesData.nodes || []) {
      const node = new ResourceNodeState();
      node.id = n.id;
      node.type = n.type === "food" ? "meat" : n.type;
      node.x = n.x;
      node.y = n.y;
      node.amount = n.amount;
      this.state.resources.set(n.id, node);
    }
  }

  loadPersistedBuildings() {
    try {
      const rows = loadAllBuildings();
      for (const row of rows) {
        if (row.type === "castle") {
          const c = new CastleState();
          c.id = row.id;
          c.ownerId = row.owner_id;
          c.ownerSessionId = "";
          c.x = row.x;
          c.y = row.y;
          c.targetX = row.x;
          c.targetY = row.y;
          c.moving = false;
          c.followOwner = false;
          c.garrison = 0;
          c.color = castleCfg.color || "#4A3728";
          this.state.castles.set(c.id, c);
          continue;
        }
        const b = new BuildingState();
        b.id = row.id;
        b.ownerId = row.owner_id;
        b.ownerSessionId = "";
        b.type = row.type || "barracks";
        b.x = row.x;
        b.y = row.y;
        b.queueMs = 0;
        b.queueUnit = "";
        this.state.buildings.set(b.id, b);
      }
      if (rows.length) {
        console.log(`[WorldRoom] restored ${rows.length} building(s)/castle(s) from SQLite`);
      }
    } catch (err) {
      console.error("[WorldRoom] load buildings failed", err.message);
    }
  }

  ensureCastle(player, sessionId) {
    let found = null;
    this.state.castles.forEach((c) => {
      if (c.ownerId === player.id) found = c;
    });
    if (found) {
      found.ownerSessionId = sessionId;
      found.color = player.color || found.color;
      return found;
    }
    const c = new CastleState();
    c.id = `castle_${player.id}`;
    c.ownerId = player.id;
    c.ownerSessionId = sessionId;
    c.x = Math.max(40, Math.min(WORLD_W - 40, player.x - 50));
    c.y = Math.max(40, Math.min(WORLD_H - 40, player.y + 40));
    c.targetX = c.x;
    c.targetY = c.y;
    c.moving = false;
    c.followOwner = false;
    c.garrison = 0;
    c.color = player.color || castleCfg.color || "#4A3728";
    this.state.castles.set(c.id, c);
    this.garrisonStore.set(sessionId, []);
    try {
      saveBuilding({ id: c.id, ownerId: c.ownerId, type: "castle", x: c.x, y: c.y });
    } catch (err) {
      console.error("[WorldRoom] save castle failed", err.message);
    }
    return c;
  }

  countPop(sessionId) {
    let n = 0;
    this.state.followers.forEach((f) => {
      if (f.ownerSessionId === sessionId) n += 1;
    });
    const g = this.garrisonStore.get(sessionId);
    if (g) n += g.length;
    return n;
  }

  refreshPop(sessionId) {
    const p = this.state.players.get(sessionId);
    if (!p) return;
    p.pop = this.countPop(sessionId);
    const castle = this.findCastleBySession(sessionId);
    if (castle) {
      const g = this.garrisonStore.get(sessionId) || [];
      castle.garrison = g.length;
    }
  }

  findCastleBySession(sessionId) {
    let found = null;
    this.state.castles.forEach((c) => {
      if (c.ownerSessionId === sessionId) found = c;
    });
    return found;
  }

  onJoin(client, options = {}) {
    const name = String(options.name || "旅人").slice(0, 16);
    const nationId = nationById[options.nationId] ? options.nationId : "britons";
    const specId = unitById[options.specId] ? options.specId : "militia";
    const playerId = String(options.playerId || client.sessionId);

    const nation = nationById[nationId];
    const unit = unitById[specId];

    const existing = loadPlayer(playerId);
    const p = new PlayerState();
    p.id = playerId;
    p.name = name;
    p.nationId = nationId;
    p.specId = specId;
    p.color = nation.color;
    p.speed = unit.speed;
    p.hp = unit.hp;
    p.maxHp = unit.hp;
    p.atk = unit.atk || 8;
    p.atkBonus = 0;
    p.pop = 0;

    if (existing && existing.nation_id === nationId) {
      p.x = existing.x;
      p.y = existing.y;
      p.wood = existing.wood || 0;
      p.meat = existing.meat || existing.food || 0;
      p.stone = existing.stone || 0;
      p.gold = existing.gold || 0;
      p.atkBonus = existing.atk_bonus || 0;
    } else {
      p.x = nation.startX + (Math.random() * 40 - 20);
      p.y = nation.startY + (Math.random() * 40 - 20);
      p.wood = 0;
      p.meat = 0;
      p.stone = 0;
      p.gold = 0;
    }

    // Playtest kit: enough to build barracks, train, and try castle/combat without grinding
    const TEST_KIT = { wood: 500, meat: 500, stone: 500, gold: 200 };
    if (process.env.FRACTURED_TEST_KIT !== "0") {
      p.wood = Math.max(p.wood, TEST_KIT.wood);
      p.meat = Math.max(p.meat, TEST_KIT.meat);
      p.stone = Math.max(p.stone, TEST_KIT.stone);
      p.gold = Math.max(p.gold, TEST_KIT.gold);
    }

    this.state.players.set(client.sessionId, p);
    this.inputs.set(client.sessionId, { dx: 0, dy: 0 });
    this.gatherAcc.set(client.sessionId, 0);
    this.attackIntent.set(client.sessionId, false);
    this.atkCooldown.set(`p:${client.sessionId}`, 0);
    if (!this.garrisonStore.has(client.sessionId)) {
      this.garrisonStore.set(client.sessionId, []);
    }

    this.state.buildings.forEach((b) => {
      if (b.ownerId === playerId) b.ownerSessionId = client.sessionId;
    });

    this.ensureCastle(p, client.sessionId);
    this.refreshPop(client.sessionId);

    const timer = setInterval(() => this.persistPlayer(client.sessionId), 15000);
    this.saveTimers.set(client.sessionId, timer);

    this.broadcast("system", { text: `${p.name} 進入了星隕之境`, t: Date.now() });
    client.send("system", {
      text: `Phase 4+：木/肉/石/金 · 戰鬥掉落 · 村民AI · 移動城堡 · 人口上限${POP_CAP}`,
      t: Date.now(),
    });
    console.log(`[WorldRoom] join ${p.name} (${client.sessionId})`);
  }

  handleBuild(client, message) {
    const player = this.state.players.get(client.sessionId);
    if (!player || !barracksCfg) return;

    let owned = false;
    this.state.buildings.forEach((b) => {
      if (b.ownerId === player.id && b.type === "barracks") owned = true;
    });
    if (owned) {
      client.send("system", { text: "你已有一座兵營", t: Date.now() });
      return;
    }

    const cost = barracksCfg.placeCost || {};
    if (!canAfford(player, cost)) {
      client.send("system", {
        text: `兵營需要 木${costOf(cost, "wood")} 石${costOf(cost, "stone")}`,
        t: Date.now(),
      });
      return;
    }

    const ox = Number(message?.ox);
    const oy = Number(message?.oy);
    let bx = player.x + (Number.isFinite(ox) ? ox : 40);
    let by = player.y + (Number.isFinite(oy) ? oy : 0);
    bx = Math.max(40, Math.min(WORLD_W - 40, bx));
    by = Math.max(40, Math.min(WORLD_H - 40, by));

    pay(player, cost);
    const b = new BuildingState();
    b.id = `br_${player.id}`;
    b.ownerId = player.id;
    b.ownerSessionId = client.sessionId;
    b.type = "barracks";
    b.x = bx;
    b.y = by;
    b.queueMs = 0;
    b.queueUnit = "";
    this.state.buildings.set(b.id, b);
    try {
      saveBuilding({ id: b.id, ownerId: b.ownerId, type: b.type, x: b.x, y: b.y });
    } catch (err) {
      console.error("[WorldRoom] save building failed", err.message);
    }
    client.send("system", { text: "兵營建造完成！走近後訓練民兵／村民", t: Date.now() });
  }

  resolveTrainCfg(unitKey) {
    const trains = barracksCfg?.trains || {};
    if (unitKey && trains[unitKey]) return trains[unitKey];
    if (trains.militia) return trains.militia;
    return barracksCfg?.train || null;
  }

  handleTrain(client, message) {
    const player = this.state.players.get(client.sessionId);
    if (!player || !barracksCfg) return;

    const unitKey = String(message?.unit || message?.unitId || "militia");
    const train = this.resolveTrainCfg(unitKey);
    if (!train) return;

    let barracks = null;
    this.state.buildings.forEach((b) => {
      if (b.ownerId === player.id && b.type === "barracks") barracks = b;
    });
    if (!barracks) {
      client.send("system", { text: "尚未建造兵營（按 B）", t: Date.now() });
      return;
    }
    if (dist(player.x, player.y, barracks.x, barracks.y) > (barracksCfg.interactRange || 72)) {
      client.send("system", { text: "請走近兵營再訓練", t: Date.now() });
      return;
    }
    if (barracks.queueMs > 0) {
      client.send("system", { text: "兵營訓練中…", t: Date.now() });
      return;
    }

    const pop = this.countPop(client.sessionId);
    if (pop >= POP_CAP) {
      client.send("system", {
        text: `人口已達上限（${pop}/${POP_CAP}），無法再訓練`,
        t: Date.now(),
      });
      return;
    }

    const cost = train.cost || {};
    if (!canAfford(player, cost)) {
      client.send("system", {
        text: `訓練需要 肉${costOf(cost, "meat")}`,
        t: Date.now(),
      });
      return;
    }

    pay(player, cost);
    barracks.queueUnit = train.unitId || unitKey;
    barracks.queueMs = train.durationMs || 4000;
    const label = train.labelZh || unitById[barracks.queueUnit]?.nameZh || "單位";
    client.send("system", { text: `${label}訓練中…（人口 ${pop}/${POP_CAP}）`, t: Date.now() });
  }

  handleCastle(client, message) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    const castle = this.ensureCastle(player, client.sessionId);
    const action = String(message?.action || "");

    if (action === "follow") {
      castle.followOwner = true;
      castle.moving = true;
      client.send("system", { text: "城堡跟隨開啟", t: Date.now() });
      return;
    }
    if (action === "stop") {
      castle.followOwner = false;
      castle.moving = false;
      castle.targetX = castle.x;
      castle.targetY = castle.y;
      client.send("system", { text: "城堡停止移動", t: Date.now() });
      this.persistCastle(castle);
      return;
    }
    if (action === "move") {
      const tx = Number(message?.x);
      const ty = Number(message?.y);
      if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
        // default: move to player
        castle.targetX = player.x;
        castle.targetY = player.y;
      } else {
        castle.targetX = Math.max(40, Math.min(WORLD_W - 40, tx));
        castle.targetY = Math.max(40, Math.min(WORLD_H - 40, ty));
      }
      castle.followOwner = false;
      castle.moving = true;
      client.send("system", { text: "城堡開始移動", t: Date.now() });
      return;
    }
    if (action === "garrison" || action === "enter") {
      this.doGarrison(client, castle, player);
      return;
    }
    if (action === "deploy" || action === "exit") {
      this.doDeploy(client, castle, player);
      return;
    }
    client.send("system", {
      text: "城堡指令：跟隨／停止／入城／出城",
      t: Date.now(),
    });
  }

  snapshotFollower(f) {
    return {
      specId: f.specId,
      hp: f.hp,
      maxHp: f.maxHp,
      atk: f.atk,
      color: f.color,
      speed: f.speed,
      carryWood: f.carryWood || 0,
      carryMeat: f.carryMeat || 0,
      carryStone: f.carryStone || 0,
      carryGold: f.carryGold || 0,
      ai: f.ai || "follow",
    };
  }

  doGarrison(client, castle, player) {
    const range = castleCfg.garrisonRadius || 100;
    const store = this.garrisonStore.get(client.sessionId) || [];
    const toPull = [];
    this.state.followers.forEach((f, id) => {
      if (f.ownerSessionId !== client.sessionId) return;
      if (dist(f.x, f.y, castle.x, castle.y) <= range) toPull.push(id);
    });
    // also auto-pull if player is near castle — pull all owned field units
    if (dist(player.x, player.y, castle.x, castle.y) <= range) {
      this.state.followers.forEach((f, id) => {
        if (f.ownerSessionId === client.sessionId && !toPull.includes(id)) {
          toPull.push(id);
        }
      });
    }
    if (!toPull.length) {
      client.send("system", { text: "附近沒有可入城的單位（請走近城堡）", t: Date.now() });
      return;
    }
    for (const id of toPull) {
      const f = this.state.followers.get(id);
      if (!f) continue;
      store.push(this.snapshotFollower(f));
      this.state.followers.delete(id);
      this.followerGatherAcc.delete(id);
      this.atkCooldown.delete(`f:${id}`);
    }
    this.garrisonStore.set(client.sessionId, store);
    castle.garrison = store.length;
    this.refreshPop(client.sessionId);
    client.send("system", {
      text: `已入城 ${toPull.length} 名（城內 ${castle.garrison} · 人口 ${player.pop}/${POP_CAP}）`,
      t: Date.now(),
    });
  }

  doDeploy(client, castle, player) {
    const store = this.garrisonStore.get(client.sessionId) || [];
    if (!store.length) {
      client.send("system", { text: "城堡內沒有單位", t: Date.now() });
      return;
    }
    const deployed = store.splice(0, store.length);
    let i = 0;
    for (const snap of deployed) {
      this.followerSeq += 1;
      const f = new FollowerState();
      f.id = `fol_${client.sessionId}_${this.followerSeq}`;
      f.ownerSessionId = client.sessionId;
      f.specId = snap.specId || "militia";
      const ang = (i / Math.max(1, deployed.length)) * Math.PI * 2;
      f.x = castle.x + Math.cos(ang) * 36;
      f.y = castle.y + Math.sin(ang) * 36 + 20;
      f.dir = "down";
      f.color = snap.color || player.color;
      f.speed = snap.speed || 95;
      f.hp = snap.hp || unitStats(f.specId).hp;
      f.maxHp = snap.maxHp || f.hp;
      f.atk = snap.atk || unitStats(f.specId).atk || 5;
      f.carryWood = snap.carryWood || 0;
      f.carryMeat = snap.carryMeat || 0;
      f.carryStone = snap.carryStone || 0;
      f.carryGold = snap.carryGold || 0;
      f.ai = snap.ai || (unitStats(f.specId).role === "economy" ? "gather" : "follow");
      this.state.followers.set(f.id, f);
      this.followerGatherAcc.set(f.id, 0);
      this.atkCooldown.set(`f:${f.id}`, 0);
      i += 1;
    }
    this.garrisonStore.set(client.sessionId, store);
    castle.garrison = store.length;
    this.refreshPop(client.sessionId);
    client.send("system", {
      text: `已出城 ${deployed.length} 名（城內 ${castle.garrison}）`,
      t: Date.now(),
    });
  }

  persistCastle(castle) {
    try {
      saveBuilding({
        id: castle.id,
        ownerId: castle.ownerId,
        type: "castle",
        x: castle.x,
        y: castle.y,
      });
    } catch (err) {
      console.error("[WorldRoom] persist castle failed", err.message);
    }
  }

  spawnFollower(ownerSessionId, barracks, unitId) {
    const player = this.state.players.get(ownerSessionId);
    if (!player) return;
    if (this.countPop(ownerSessionId) >= POP_CAP) {
      // refund meat roughly
      const train = this.resolveTrainCfg(unitId);
      if (train) {
        player.meat += costOf(train.cost, "meat");
      }
      return;
    }
    const unit = unitById[unitId] || unitById.militia;
    this.followerSeq += 1;
    const f = new FollowerState();
    f.id = `fol_${ownerSessionId}_${this.followerSeq}`;
    f.ownerSessionId = ownerSessionId;
    f.specId = unit.id;
    f.x = barracks.x + (Math.random() * 30 - 15);
    f.y = barracks.y + 28 + Math.random() * 10;
    f.dir = "down";
    f.color = player.color || unit.color;
    f.speed = (unit.speed || 100) * 0.92;
    f.hp = unit.hp;
    f.maxHp = unit.hp;
    f.atk = unit.atk || 5;
    f.carryWood = 0;
    f.carryMeat = 0;
    f.carryStone = 0;
    f.carryGold = 0;
    f.ai = unit.role === "economy" ? "gather" : "follow";
    this.state.followers.set(f.id, f);
    this.followerGatherAcc.set(f.id, 0);
    this.atkCooldown.set(`f:${f.id}`, 0);
    this.refreshPop(ownerSessionId);
    this.broadcast("system", {
      text: `${player.name} 訓練出一名${unit.nameZh}（${player.pop}/${POP_CAP}）`,
      t: Date.now(),
    });
  }

  effectiveAtk(entity, isPlayer) {
    const base = entity.atk || 5;
    const bonus = isPlayer ? (entity.atkBonus || 0) : 0;
    return base + bonus;
  }

  findHostileTarget(ax, ay, range, mySessionId, preferFollowers = true) {
    let best = null;
    let bestD = Infinity;

    this.state.followers.forEach((f, id) => {
      if (f.ownerSessionId === mySessionId) return;
      if (f.hp <= 0) return;
      const d = dist(ax, ay, f.x, f.y);
      if (d <= range && d < bestD) {
        bestD = d;
        best = { kind: "follower", id, ref: f };
      }
    });

    this.state.players.forEach((p, sid) => {
      if (sid === mySessionId) return;
      if (p.hp <= 0) return;
      const d = dist(ax, ay, p.x, p.y);
      if (d <= range && d < bestD) {
        if (!preferFollowers || !best || best.kind !== "follower" || d + 8 < bestD) {
          bestD = d;
          best = { kind: "player", id: sid, ref: p };
        }
      }
    });

    return best;
  }

  applyDamage(targetKind, targetId, targetRef, amount, hitX, hitY, attackerName) {
    const dmg = Math.max(1, Math.round(amount));
    targetRef.hp = Math.max(0, targetRef.hp - dmg);
    this.broadcast("fx", {
      type: "dmg",
      x: hitX,
      y: hitY - 18,
      value: dmg,
      t: Date.now(),
    });

    if (targetRef.hp > 0) return;

    if (targetKind === "follower") {
      this.killFollower(targetId, targetRef, attackerName);
    } else if (targetKind === "player") {
      this.killPlayer(targetId, targetRef, attackerName);
    }
  }

  rollDrops(specId, x, y) {
    const table = lootTables[specId] || lootTables.default || [];
    for (const entry of table) {
      if (Math.random() > (entry.chance ?? 1)) continue;
      if (entry.kind === "item" && entry.itemId) {
        this.spawnLoot(x, y, "item", 1, entry.itemId);
      } else {
        let kind = entry.kind;
        if (kind === "food") kind = "meat";
        if (RES_KEYS.includes(kind)) {
          const amt = Math.round(randRange(entry.min || 1, entry.max || 3));
          if (amt > 0) this.spawnLoot(x, y, kind, amt, "");
        }
      }
    }
  }

  spawnLoot(x, y, kind, amount, itemId) {
    if (kind === "food") kind = "meat";
    this.lootSeq += 1;
    const loot = new LootState();
    loot.id = `loot_${this.lootSeq}_${Date.now().toString(36)}`;
    loot.x = x + (Math.random() * 24 - 12);
    loot.y = y + (Math.random() * 24 - 12);
    loot.kind = kind;
    loot.amount = amount;
    loot.itemId = itemId || "";
    loot.spawnAt = Date.now();
    if (kind === "item" && itemId && lootItems[itemId]) {
      const it = lootItems[itemId];
      loot.label = it.nameZh || itemId;
      loot.color = it.color || "#DAA520";
    } else {
      const meta = resourceTypes[kind] || {};
      loot.label = meta.symbol || kind;
      loot.color = meta.color || "#DAA520";
    }
    this.state.loot.set(loot.id, loot);
  }

  killFollower(id, f, killerName) {
    this.rollDrops(f.specId, f.x, f.y);
    for (const k of RES_KEYS) {
      const carryKey = "carry" + k.charAt(0).toUpperCase() + k.slice(1);
      const amt = f[carryKey] || 0;
      if (amt > 0) this.spawnLoot(f.x, f.y, k, Math.ceil(amt), "");
    }

    const owner = this.state.players.get(f.ownerSessionId);
    const uname = unitById[f.specId]?.nameZh || "單位";
    this.broadcast("system", {
      text: `${killerName || "未知"} 擊敗了${owner ? owner.name + "的" : ""}${uname}`,
      t: Date.now(),
    });
    const sid = f.ownerSessionId;
    this.state.followers.delete(id);
    this.followerGatherAcc.delete(id);
    this.atkCooldown.delete(`f:${id}`);
    this.refreshPop(sid);
  }

  killPlayer(sessionId, player, killerName) {
    const frac = playerDeathCfg.resourceLoseFraction ?? 0.25;
    for (const k of RES_KEYS) {
      const drop = Math.floor((player[k] || 0) * frac);
      if (drop > 0) {
        player[k] -= drop;
        this.spawnLoot(player.x, player.y, k, drop, "");
      }
    }
    this.rollDrops(player.specId, player.x, player.y);

    const nation = nationById[player.nationId];
    if (nation) {
      player.x = nation.startX + (Math.random() * 30 - 15);
      player.y = nation.startY + (Math.random() * 30 - 15);
    }
    const hpFrac = playerDeathCfg.respawnHpFraction ?? 0.6;
    player.hp = Math.max(1, Math.floor(player.maxHp * hpFrac));

    this.broadcast("system", {
      text: `${player.name} 被${killerName || "敵人"}擊敗，於出生點重整`,
      t: Date.now(),
    });
    this.persistPlayer(sessionId);
  }

  tryPlayerAttack(sessionId, force = false) {
    const player = this.state.players.get(sessionId);
    if (!player || player.hp <= 0) return;
    const unit = unitStats(player.specId);
    const cdKey = `p:${sessionId}`;
    const cdLeft = this.atkCooldown.get(cdKey) || 0;
    if (cdLeft > 0) return;

    const range = unit.atkRange || 36;
    const target = this.findHostileTarget(player.x, player.y, range, sessionId, true);
    if (!target) return;

    const raw = this.effectiveAtk(player, true);
    const scale = target.kind === "player" ? PVP_DAMAGE_SCALE : 1;
    const dmg = raw * scale * (0.9 + Math.random() * 0.2);
    this.applyDamage(
      target.kind,
      target.id,
      target.ref,
      dmg,
      target.ref.x,
      target.ref.y,
      player.name
    );
    this.atkCooldown.set(cdKey, unit.atkCooldownMs || 700);
  }

  tryFollowerAttack(f, id) {
    if (f.hp <= 0) return false;
    const unit = unitStats(f.specId);
    const cdKey = `f:${id}`;
    if ((this.atkCooldown.get(cdKey) || 0) > 0) return false;

    const range = unit.atkRange || 36;
    const target = this.findHostileTarget(f.x, f.y, range, f.ownerSessionId, true);
    if (!target) return false;

    const owner = this.state.players.get(f.ownerSessionId);
    const raw = f.atk || unit.atk || 5;
    const scale = target.kind === "player" ? PVP_DAMAGE_SCALE : 1;
    const dmg = raw * scale * (0.9 + Math.random() * 0.2);
    this.applyDamage(
      target.kind,
      target.id,
      target.ref,
      dmg,
      target.ref.x,
      target.ref.y,
      owner ? `${owner.name}的${unit.nameZh}` : unit.nameZh
    );
    this.atkCooldown.set(cdKey, unit.atkCooldownMs || 700);
    f.ai = "combat";
    return true;
  }

  carryTotal(f) {
    return RES_KEYS.reduce((s, k) => {
      const key = "carry" + k.charAt(0).toUpperCase() + k.slice(1);
      return s + (f[key] || 0);
    }, 0);
  }

  moveToward(ent, tx, ty, speed, dt, stopDist = 8) {
    const dx = tx - ent.x;
    const dy = ty - ent.y;
    const d = Math.hypot(dx, dy);
    if (d <= stopDist) return d;
    const nx = dx / d;
    const ny = dy / d;
    const step = Math.min(d - stopDist, speed * dt);
    ent.x += nx * step;
    ent.y += ny * step;
    if (ent.dir !== undefined) {
      if (Math.abs(nx) > Math.abs(ny)) ent.dir = nx > 0 ? "right" : "left";
      else ent.dir = ny > 0 ? "down" : "up";
    }
    return d - step;
  }

  findNearestNode(x, y, maxRange = 280) {
    let best = null;
    let bestD = Infinity;
    this.state.resources.forEach((node) => {
      if (node.amount <= 0) return;
      const d = dist(x, y, node.x, node.y);
      if (d < bestD && d <= maxRange) {
        bestD = d;
        best = node;
      }
    });
    return best;
  }

  depositCarry(f, player) {
    if (!player) return;
    for (const k of RES_KEYS) {
      const key = "carry" + k.charAt(0).toUpperCase() + k.slice(1);
      player[k] = (player[k] || 0) + (f[key] || 0);
      f[key] = 0;
    }
  }

  tickFollowerGather(f, id, owner, dt) {
    const unit = unitStats(f.specId);
    const isVillager = unit.role === "economy" || f.specId === "villager";
    const gatherMult = unit.gatherMult || 0;
    if (gatherMult <= 0) return false;

    const cap = unit.carryCap || 10;
    const total = this.carryTotal(f);

    if (total >= cap * 0.95) {
      f.ai = "deposit";
      const d = this.moveToward(f, owner.x, owner.y, f.speed, dt, 28);
      if (d <= 30) {
        this.depositCarry(f, owner);
        f.ai = isVillager ? "gather" : "follow";
      }
      return true;
    }

    const nearNode = this.findNearestNode(f.x, f.y, isVillager ? 320 : 72);
    if (!nearNode) {
      if (total > 0 && isVillager) {
        f.ai = "deposit";
        const d = this.moveToward(f, owner.x, owner.y, f.speed, dt, 28);
        if (d <= 30) {
          this.depositCarry(f, owner);
          f.ai = "gather";
        }
        return true;
      }
      return false;
    }

    const type = resourceTypes[nearNode.type];
    if (!type) return false;
    const radius = type.radius || 48;
    const d = dist(f.x, f.y, nearNode.x, nearNode.y);

    if (d > radius) {
      f.ai = "gather";
      this.moveToward(f, nearNode.x, nearNode.y, f.speed, dt, radius * 0.6);
      return true;
    }

    f.ai = "gather";
    let acc = (this.followerGatherAcc.get(id) || 0) + dt;
    const rate = (type.gatherPerSec || 3) * gatherMult;
    while (acc >= 0.35 && nearNode.amount > 0 && this.carryTotal(f) < cap) {
      acc -= 0.35;
      const take = Math.min(nearNode.amount, rate * 0.35, cap - this.carryTotal(f));
      nearNode.amount = Math.max(0, nearNode.amount - take);
      if (nearNode.type === "wood") f.carryWood += take;
      else if (nearNode.type === "meat" || nearNode.type === "food") f.carryMeat += take;
      else if (nearNode.type === "stone") f.carryStone += take;
      else if (nearNode.type === "gold") f.carryGold += take;
    }
    this.followerGatherAcc.set(id, acc);
    return true;
  }

  notifyClient(sessionId, text) {
    for (const c of this.clients) {
      if (c.sessionId === sessionId) {
        c.send("system", { text, t: Date.now() });
        return;
      }
    }
  }

  tickLootPickup(sessionId, player) {
    const toRemove = [];
    this.state.loot.forEach((loot, id) => {
      if (dist(player.x, player.y, loot.x, loot.y) > pickupRadius) return;
      if (loot.kind === "item" && loot.itemId) {
        const it = lootItems[loot.itemId];
        if (it) {
          player.atkBonus = (player.atkBonus || 0) + (it.atkBonus || 0);
          this.notifyClient(
            sessionId,
            `拾取 ${it.nameZh}（攻擊+${it.atkBonus || 0}）`
          );
        } else {
          this.notifyClient(sessionId, `拾取 ${loot.label || loot.itemId || "物品"}`);
        }
      } else {
        const amt = Number(loot.amount) || 0;
        if (amt > 0) {
          addResource(player, loot.kind, amt);
          const label = loot.label || loot.kind;
          this.notifyClient(sessionId, `拾取 ${label} ×${Math.round(amt)}`);
        }
      }
      toRemove.push(id);
    });
    toRemove.forEach((id) => this.state.loot.delete(id));
  }

  update(deltaTime) {
    const dt = Math.min(deltaTime, 100) / 1000;

    this.atkCooldown.forEach((ms, key) => {
      this.atkCooldown.set(key, Math.max(0, ms - deltaTime));
    });

    const now = Date.now();
    const expired = [];
    this.state.loot.forEach((loot, id) => {
      if (now - (loot.spawnAt || now) > lootDespawnMs) expired.push(id);
    });
    expired.forEach((id) => this.state.loot.delete(id));

    // castles move
    const castleSpeed = castleCfg.speed || 55;
    this.state.castles.forEach((castle) => {
      const owner = this.state.players.get(castle.ownerSessionId);
      if (castle.followOwner && owner) {
        castle.targetX = owner.x - 40;
        castle.targetY = owner.y + 50;
        castle.moving = true;
      }
      if (!castle.moving) return;
      const d = this.moveToward(castle, castle.targetX, castle.targetY, castleSpeed, dt, 12);
      castle.x = Math.max(40, Math.min(WORLD_W - 40, castle.x));
      castle.y = Math.max(40, Math.min(WORLD_H - 40, castle.y));
      if (d <= 14) {
        castle.moving = castle.followOwner ? true : false;
        if (!castle.followOwner) this.persistCastle(castle);
      }
    });

    this.state.players.forEach((player, sessionId) => {
      if (player.hp <= 0) return;
      const input = this.inputs.get(sessionId) || { dx: 0, dy: 0 };
      if (input.dx !== 0 || input.dy !== 0) {
        const nx = player.x + input.dx * player.speed * dt;
        const ny = player.y + input.dy * player.speed * dt;
        player.x = Math.max(16, Math.min(WORLD_W - 16, nx));
        player.y = Math.max(16, Math.min(WORLD_H - 16, ny));
        if (Math.abs(input.dx) > Math.abs(input.dy)) {
          player.dir = input.dx > 0 ? "right" : "left";
        } else {
          player.dir = input.dy > 0 ? "down" : "up";
        }
      }

      this.tickGather(sessionId, player, dt);
      this.tickLootPickup(sessionId, player);

      if (this.attackIntent.get(sessionId)) {
        this.tryPlayerAttack(sessionId, false);
      }
    });

    this.state.buildings.forEach((b) => {
      if (b.queueMs <= 0) return;
      b.queueMs = Math.max(0, b.queueMs - deltaTime);
      if (b.queueMs <= 0 && b.queueUnit) {
        const unitId = b.queueUnit;
        b.queueUnit = "";
        if (b.ownerSessionId && this.state.players.has(b.ownerSessionId)) {
          this.spawnFollower(b.ownerSessionId, b, unitId);
        }
      }
    });

    this.state.followers.forEach((f, id) => {
      const owner = this.state.players.get(f.ownerSessionId);
      if (!owner) return;
      if (f.hp <= 0) return;

      const unit = unitStats(f.specId);
      const hostile = this.findHostileTarget(
        f.x, f.y,
        (unit.atkRange || 36) + 8,
        f.ownerSessionId,
        true
      );
      if (hostile) {
        const d = dist(f.x, f.y, hostile.ref.x, hostile.ref.y);
        if (d > (unit.atkRange || 36)) {
          this.moveToward(f, hostile.ref.x, hostile.ref.y, f.speed, dt, (unit.atkRange || 36) * 0.7);
        }
        this.tryFollowerAttack(f, id);
        return;
      }

      const isVillager = unit.role === "economy" || f.specId === "villager";
      if (isVillager || f.ai === "gather" || f.ai === "deposit") {
        const busy = this.tickFollowerGather(f, id, owner, dt);
        if (busy) return;
      } else {
        const near = this.findNearestNode(f.x, f.y, 56);
        if (near && this.carryTotal(f) < (unit.carryCap || 8) * 0.9) {
          const busy = this.tickFollowerGather(f, id, owner, dt);
          if (busy) return;
        }
      }

      f.ai = "follow";
      const dx = owner.x - f.x;
      const dy = owner.y - f.y;
      const d = Math.hypot(dx, dy);
      if (d > 42) {
        const nx = dx / d;
        const ny = dy / d;
        const move = Math.min(d - 36, f.speed * dt);
        if (move > 0) {
          f.x += nx * move;
          f.y += ny * move;
          if (Math.abs(nx) > Math.abs(ny)) f.dir = nx > 0 ? "right" : "left";
          else f.dir = ny > 0 ? "down" : "up";
        }
      }
    });
  }

  tickGather(sessionId, player, dt) {
    let nearest = null;
    let nearestD = Infinity;
    this.state.resources.forEach((node) => {
      if (node.amount <= 0) return;
      const type = resourceTypes[node.type];
      if (!type) return;
      const d = dist(player.x, player.y, node.x, node.y);
      if (d <= (type.radius || 48) && d < nearestD) {
        nearest = node;
        nearestD = d;
      }
    });
    if (!nearest) {
      this.gatherAcc.set(sessionId, 0);
      return;
    }
    const type = resourceTypes[nearest.type];
    let acc = (this.gatherAcc.get(sessionId) || 0) + dt;
    const rate = type.gatherPerSec || 3;
    while (acc >= 0.35 && nearest.amount > 0) {
      acc -= 0.35;
      const take = Math.min(nearest.amount, rate * 0.35);
      nearest.amount = Math.max(0, nearest.amount - take);
      addResource(player, nearest.type, take);
    }
    this.gatherAcc.set(sessionId, acc);
  }

  persistPlayer(sessionId) {
    const p = this.state.players.get(sessionId);
    if (!p) return;
    try {
      savePlayer({
        id: p.id,
        name: p.name,
        nationId: p.nationId,
        specId: p.specId,
        x: p.x,
        y: p.y,
        wood: p.wood,
        meat: p.meat,
        stone: p.stone,
        gold: p.gold,
        atkBonus: p.atkBonus,
      });
    } catch (err) {
      console.error("[WorldRoom] save failed", err.message);
    }
    const castle = this.findCastleBySession(sessionId);
    if (castle) this.persistCastle(castle);
  }

  onLeave(client) {
    this.persistPlayer(client.sessionId);
    const timer = this.saveTimers.get(client.sessionId);
    if (timer) clearInterval(timer);
    this.saveTimers.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    this.gatherAcc.delete(client.sessionId);
    this.attackIntent.delete(client.sessionId);
    this.atkCooldown.delete(`p:${client.sessionId}`);
    this.garrisonStore.delete(client.sessionId);

    const toRemove = [];
    this.state.followers.forEach((f, id) => {
      if (f.ownerSessionId === client.sessionId) toRemove.push(id);
    });
    toRemove.forEach((id) => {
      this.state.followers.delete(id);
      this.followerGatherAcc.delete(id);
      this.atkCooldown.delete(`f:${id}`);
    });

    this.state.buildings.forEach((b) => {
      if (b.ownerSessionId === client.sessionId) {
        b.ownerSessionId = "";
        b.queueMs = 0;
        b.queueUnit = "";
        try {
          saveBuilding({ id: b.id, ownerId: b.ownerId, type: b.type, x: b.x, y: b.y });
        } catch (_) {}
      }
    });

    this.state.castles.forEach((c) => {
      if (c.ownerSessionId === client.sessionId) {
        c.ownerSessionId = "";
        c.moving = false;
        c.followOwner = false;
        c.garrison = 0;
        this.persistCastle(c);
      }
    });

    const p = this.state.players.get(client.sessionId);
    if (p) {
      this.broadcast("system", { text: `${p.name} 離開了`, t: Date.now() });
      this.state.players.delete(client.sessionId);
    }
    console.log(`[WorldRoom] leave ${client.sessionId}`);
  }

  onDispose() {
    this.saveTimers.forEach((t) => clearInterval(t));
    this.saveTimers.clear();
    console.log("[WorldRoom] disposed");
  }
}

module.exports = { WorldRoom };
