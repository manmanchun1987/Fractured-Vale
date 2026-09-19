const { Room } = require("colyseus");
const {
  WorldState,
  PlayerState,
  ResourceNodeState,
  BuildingState,
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
const lootItems = lootData.items || {};
const lootTables = lootData.tables || {};
const pickupRadius = lootData.pickupRadius || 32;
const lootDespawnMs = lootData.despawnMs || 120000;
const playerDeathCfg = lootData.playerDeath || {};

const WORLD_W = 1600;
const WORLD_H = 1200;
const TICK_MS = 50; // 20 Hz
const PVP_DAMAGE_SCALE = 0.45; // light player-vs-player

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function canAfford(player, cost) {
  return (
    (player.wood || 0) >= (cost.wood || 0) &&
    (player.food || 0) >= (cost.food || 0) &&
    (player.stone || 0) >= (cost.stone || 0)
  );
}

function pay(player, cost) {
  player.wood = Math.max(0, (player.wood || 0) - (cost.wood || 0));
  player.food = Math.max(0, (player.food || 0) - (cost.food || 0));
  player.stone = Math.max(0, (player.stone || 0) - (cost.stone || 0));
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function unitStats(specId) {
  return unitById[specId] || unitById.militia;
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
    this.atkCooldown = new Map(); // key -> remaining ms
    this.attackIntent = new Map(); // sessionId -> bool (hold/tap attack)
    this.lootSeq = 0;
    this.followerSeq = 0;

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

    this.onMessage("save", (client) => {
      this.persistPlayer(client.sessionId);
    });

    this.onMessage("build", (client, message) => {
      this.handleBuild(client, message);
    });

    this.onMessage("train", (client, message) => {
      this.handleTrain(client, message);
    });

    this.onMessage("attack", (client, message) => {
      const on = message?.on !== false && message?.on !== 0;
      this.attackIntent.set(client.sessionId, !!on);
      // tap: fire once immediately
      if (on) this.tryPlayerAttack(client.sessionId, true);
    });

    this.setSimulationInterval((deltaTime) => this.update(deltaTime), TICK_MS);
    console.log("[WorldRoom] created (Phase 4: combat/loot/villager/persist)");
  }

  spawnResourceNodes() {
    for (const n of resourcesData.nodes || []) {
      const node = new ResourceNodeState();
      node.id = n.id;
      node.type = n.type;
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
        console.log(`[WorldRoom] restored ${rows.length} building(s) from SQLite`);
      }
    } catch (err) {
      console.error("[WorldRoom] load buildings failed", err.message);
    }
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

    if (existing && existing.nation_id === nationId) {
      p.x = existing.x;
      p.y = existing.y;
      p.wood = existing.wood || 0;
      p.food = existing.food || 0;
      p.stone = existing.stone || 0;
      p.atkBonus = existing.atk_bonus || 0;
    } else {
      p.x = nation.startX + (Math.random() * 40 - 20);
      p.y = nation.startY + (Math.random() * 40 - 20);
      p.wood = 10;
      p.food = 15;
      p.stone = 5;
    }

    this.state.players.set(client.sessionId, p);
    this.inputs.set(client.sessionId, { dx: 0, dy: 0 });
    this.gatherAcc.set(client.sessionId, 0);
    this.attackIntent.set(client.sessionId, false);
    this.atkCooldown.set(`p:${client.sessionId}`, 0);

    // Re-bind buildings owned by this playerId
    this.state.buildings.forEach((b) => {
      if (b.ownerId === playerId) b.ownerSessionId = client.sessionId;
    });

    const timer = setInterval(() => this.persistPlayer(client.sessionId), 15000);
    this.saveTimers.set(client.sessionId, timer);

    this.broadcast("system", { text: `${p.name} 進入了星隕之境`, t: Date.now() });
    client.send("system", {
      text: "Phase 4：採集 · 兵營/村民 · 攻擊 · 掉落物 · 兵營會存檔",
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
        text: `兵營需要 木${cost.wood || 0} 石${cost.stone || 0}`,
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

    let followerCount = 0;
    this.state.followers.forEach((f) => {
      if (f.ownerSessionId === client.sessionId) followerCount += 1;
    });
    const maxF = barracksCfg.maxFollowers || barracksCfg.train?.maxFollowers || 8;
    if (followerCount >= maxF) {
      client.send("system", { text: `跟隨單位已達上限（${maxF}）`, t: Date.now() });
      return;
    }

    const cost = train.cost || {};
    if (!canAfford(player, cost)) {
      client.send("system", {
        text: `訓練需要 食${cost.food || 0}`,
        t: Date.now(),
      });
      return;
    }

    pay(player, cost);
    barracks.queueUnit = train.unitId || unitKey;
    barracks.queueMs = train.durationMs || 4000;
    const label = train.labelZh || unitById[barracks.queueUnit]?.nameZh || "單位";
    client.send("system", { text: `${label}訓練中…`, t: Date.now() });
  }

  spawnFollower(ownerSessionId, barracks, unitId) {
    const player = this.state.players.get(ownerSessionId);
    const unit = unitById[unitId] || unitById.militia;
    this.followerSeq += 1;
    const f = new FollowerState();
    f.id = `fol_${ownerSessionId}_${this.followerSeq}`;
    f.ownerSessionId = ownerSessionId;
    f.specId = unit.id;
    f.x = barracks.x + (Math.random() * 30 - 15);
    f.y = barracks.y + 28 + Math.random() * 10;
    f.dir = "down";
    f.color = player ? player.color : unit.color;
    f.speed = (unit.speed || 100) * 0.92;
    f.hp = unit.hp;
    f.maxHp = unit.hp;
    f.atk = unit.atk || 5;
    f.carryWood = 0;
    f.carryFood = 0;
    f.carryStone = 0;
    f.ai = unit.role === "economy" ? "gather" : "follow";
    this.state.followers.set(f.id, f);
    this.followerGatherAcc.set(f.id, 0);
    this.atkCooldown.set(`f:${f.id}`, 0);
    if (player) {
      this.broadcast("system", {
        text: `${player.name} 訓練出一名${unit.nameZh}`,
        t: Date.now(),
      });
    }
  }

  // ---- Combat helpers ----

  effectiveAtk(entity, isPlayer) {
    const base = entity.atk || 5;
    const bonus = isPlayer ? (entity.atkBonus || 0) : 0;
    return base + bonus;
  }

  findHostileTarget(ax, ay, range, mySessionId, preferFollowers = true) {
    let best = null;
    let bestD = Infinity;

    // enemy followers
    this.state.followers.forEach((f, id) => {
      if (f.ownerSessionId === mySessionId) return;
      if (f.hp <= 0) return;
      const d = dist(ax, ay, f.x, f.y);
      if (d <= range && d < bestD) {
        bestD = d;
        best = { kind: "follower", id, ref: f };
      }
    });

    // other players (light PvP) — only if no follower closer or always check
    this.state.players.forEach((p, sid) => {
      if (sid === mySessionId) return;
      if (p.hp <= 0) return;
      const d = dist(ax, ay, p.x, p.y);
      if (d <= range && d < bestD) {
        // prefer followers slightly: only replace if meaningfully closer
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
      } else if (entry.kind === "wood" || entry.kind === "food" || entry.kind === "stone") {
        const amt = Math.round(randRange(entry.min || 1, entry.max || 3));
        if (amt > 0) this.spawnLoot(x, y, entry.kind, amt, "");
      }
    }
  }

  spawnLoot(x, y, kind, amount, itemId) {
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
    // drop carried resources
    if (f.carryWood > 0) this.spawnLoot(f.x, f.y, "wood", Math.ceil(f.carryWood), "");
    if (f.carryFood > 0) this.spawnLoot(f.x, f.y, "food", Math.ceil(f.carryFood), "");
    if (f.carryStone > 0) this.spawnLoot(f.x, f.y, "stone", Math.ceil(f.carryStone), "");

    const owner = this.state.players.get(f.ownerSessionId);
    const uname = unitById[f.specId]?.nameZh || "單位";
    this.broadcast("system", {
      text: `${killerName || "未知"} 擊敗了${owner ? owner.name + "的" : ""}${uname}`,
      t: Date.now(),
    });
    this.state.followers.delete(id);
    this.followerGatherAcc.delete(id);
    this.atkCooldown.delete(`f:${id}`);
  }

  killPlayer(sessionId, player, killerName) {
    const frac = playerDeathCfg.resourceLoseFraction ?? 0.25;
    const dropWood = Math.floor((player.wood || 0) * frac);
    const dropFood = Math.floor((player.food || 0) * frac);
    const dropStone = Math.floor((player.stone || 0) * frac);
    if (dropWood > 0) {
      player.wood -= dropWood;
      this.spawnLoot(player.x, player.y, "wood", dropWood, "");
    }
    if (dropFood > 0) {
      player.food -= dropFood;
      this.spawnLoot(player.x, player.y, "food", dropFood, "");
    }
    if (dropStone > 0) {
      player.stone -= dropStone;
      this.spawnLoot(player.x, player.y, "stone", dropStone, "");
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
    if (!force && cdLeft > 0) return;
    if (force && cdLeft > 0) return;

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

  // ---- Follower AI: gather / deposit / follow ----

  carryTotal(f) {
    return (f.carryWood || 0) + (f.carryFood || 0) + (f.carryStone || 0);
  }

  moveToward(f, tx, ty, dt, stopDist = 8) {
    const dx = tx - f.x;
    const dy = ty - f.y;
    const d = Math.hypot(dx, dy);
    if (d <= stopDist) return d;
    const nx = dx / d;
    const ny = dy / d;
    const step = Math.min(d - stopDist, f.speed * dt);
    f.x += nx * step;
    f.y += ny * step;
    if (Math.abs(nx) > Math.abs(ny)) f.dir = nx > 0 ? "right" : "left";
    else f.dir = ny > 0 ? "down" : "up";
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
    player.wood += f.carryWood || 0;
    player.food += f.carryFood || 0;
    player.stone += f.carryStone || 0;
    f.carryWood = 0;
    f.carryFood = 0;
    f.carryStone = 0;
  }

  tickFollowerGather(f, id, owner, dt) {
    const unit = unitStats(f.specId);
    const isVillager = unit.role === "economy" || f.specId === "villager";
    const gatherMult = unit.gatherMult || 0;
    if (gatherMult <= 0) return false;

    const cap = unit.carryCap || 10;
    const total = this.carryTotal(f);

    // full → deposit
    if (total >= cap * 0.95) {
      f.ai = "deposit";
      const d = this.moveToward(f, owner.x, owner.y, dt, 28);
      if (d <= 30) {
        this.depositCarry(f, owner);
        f.ai = isVillager ? "gather" : "follow";
      }
      return true;
    }

    // villagers always gather when not in combat; militia only if idle near node
    const nearNode = this.findNearestNode(f.x, f.y, isVillager ? 320 : 72);
    if (!nearNode) {
      if (total > 0 && isVillager) {
        f.ai = "deposit";
        const d = this.moveToward(f, owner.x, owner.y, dt, 28);
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
      this.moveToward(f, nearNode.x, nearNode.y, dt, radius * 0.6);
      return true;
    }

    // gather into carry
    f.ai = "gather";
    let acc = (this.followerGatherAcc.get(id) || 0) + dt;
    const rate = (type.gatherPerSec || 3) * gatherMult;
    while (acc >= 0.35 && nearNode.amount > 0 && this.carryTotal(f) < cap) {
      acc -= 0.35;
      const take = Math.min(nearNode.amount, rate * 0.35, cap - this.carryTotal(f));
      nearNode.amount = Math.max(0, nearNode.amount - take);
      if (nearNode.type === "wood") f.carryWood += take;
      else if (nearNode.type === "food") f.carryFood += take;
      else if (nearNode.type === "stone") f.carryStone += take;
    }
    this.followerGatherAcc.set(id, acc);
    return true;
  }

  tickLootPickup(sessionId, player) {
    const toRemove = [];
    this.state.loot.forEach((loot, id) => {
      if (dist(player.x, player.y, loot.x, loot.y) > pickupRadius) return;
      if (loot.kind === "item" && loot.itemId) {
        const it = lootItems[loot.itemId];
        if (it) {
          player.atkBonus = (player.atkBonus || 0) + (it.atkBonus || 0);
          let notify = null;
          for (const c of this.clients) {
            if (c.sessionId === sessionId) { notify = c; break; }
          }
          if (notify) {
            notify.send("system", {
              text: `拾取 ${it.nameZh}（攻擊+${it.atkBonus || 0}）`,
              t: Date.now(),
            });
          }
        }
      } else if (loot.kind === "wood") player.wood += loot.amount;
      else if (loot.kind === "food") player.food += loot.amount;
      else if (loot.kind === "stone") player.stone += loot.amount;
      toRemove.push(id);
    });
    toRemove.forEach((id) => this.state.loot.delete(id));
  }

  update(deltaTime) {
    const dt = Math.min(deltaTime, 100) / 1000;

    // cooldown tick
    this.atkCooldown.forEach((ms, key) => {
      this.atkCooldown.set(key, Math.max(0, ms - deltaTime));
    });

    // loot despawn
    const now = Date.now();
    const expired = [];
    this.state.loot.forEach((loot, id) => {
      if (now - (loot.spawnAt || now) > lootDespawnMs) expired.push(id);
    });
    expired.forEach((id) => this.state.loot.delete(id));

    // players
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

    // barracks queues
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

    // followers
    this.state.followers.forEach((f, id) => {
      const owner = this.state.players.get(f.ownerSessionId);
      if (!owner) return;
      if (f.hp <= 0) return;

      // combat first if hostile in range
      const unit = unitStats(f.specId);
      const hostile = this.findHostileTarget(
        f.x, f.y,
        (unit.atkRange || 36) + 8,
        f.ownerSessionId,
        true
      );
      if (hostile) {
        // close in if slightly out of range
        const d = dist(f.x, f.y, hostile.ref.x, hostile.ref.y);
        if (d > (unit.atkRange || 36)) {
          this.moveToward(f, hostile.ref.x, hostile.ref.y, dt, (unit.atkRange || 36) * 0.7);
        }
        this.tryFollowerAttack(f, id);
        return;
      }

      const isVillager = unit.role === "economy" || f.specId === "villager";
      if (isVillager || f.ai === "gather" || f.ai === "deposit") {
        const busy = this.tickFollowerGather(f, id, owner, dt);
        if (busy) return;
      } else {
        // militia idle near node: light auto-gather
        const near = this.findNearestNode(f.x, f.y, 56);
        if (near && this.carryTotal(f) < (unit.carryCap || 8) * 0.9) {
          const busy = this.tickFollowerGather(f, id, owner, dt);
          if (busy) return;
        }
      }

      // default follow
      f.ai = "follow";
      const dx = owner.x - f.x;
      const dy = owner.y - f.y;
      const d = Math.hypot(dx, dy);
      const followDist = 42;
      if (d > followDist) {
        const nx = dx / d;
        const ny = dy / d;
        const targetGap = 36;
        const move = Math.min(d - targetGap, f.speed * dt);
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
      if (nearest.type === "wood") player.wood += take;
      else if (nearest.type === "food") player.food += take;
      else if (nearest.type === "stone") player.stone += take;
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
        food: p.food,
        stone: p.stone,
        atkBonus: p.atkBonus,
      });
    } catch (err) {
      console.error("[WorldRoom] save failed", err.message);
    }
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
        // persist position (already saved on build; refresh)
        try {
          saveBuilding({ id: b.id, ownerId: b.ownerId, type: b.type, x: b.x, y: b.y });
        } catch (_) {}
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
