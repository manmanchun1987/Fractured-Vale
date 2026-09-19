const { Room } = require("colyseus");
const {
  WorldState,
  PlayerState,
  ResourceNodeState,
  BuildingState,
  FollowerState,
} = require("../schema/PlayerState");
const { savePlayer, loadPlayer } = require("../db");
const path = require("path");
const fs = require("fs");

const nationsPath = path.join(__dirname, "../../../client/data/nations.json");
const unitsPath = path.join(__dirname, "../../../client/data/units.json");
const resourcesPath = path.join(__dirname, "../../../client/data/resources.json");
const buildingsPath = path.join(__dirname, "../../../client/data/buildings.json");

const nationsData = JSON.parse(fs.readFileSync(nationsPath, "utf8"));
const unitsData = JSON.parse(fs.readFileSync(unitsPath, "utf8"));
const resourcesData = JSON.parse(fs.readFileSync(resourcesPath, "utf8"));
const buildingsData = JSON.parse(fs.readFileSync(buildingsPath, "utf8"));

const nationById = Object.fromEntries(nationsData.nations.map((n) => [n.id, n]));
const unitById = Object.fromEntries(unitsData.units.map((u) => [u.id, u]));
const resourceTypes = resourcesData.types || {};
const barracksCfg = buildingsData.barracks;

const WORLD_W = 1600;
const WORLD_H = 1200;
const TICK_MS = 50; // 20 Hz

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

class WorldRoom extends Room {
  onCreate() {
    this.setState(new WorldState());
    this.state.worldW = WORLD_W;
    this.state.worldH = WORLD_H;
    this.maxClients = 64;
    this.inputs = new Map(); // sessionId -> {dx, dy}
    this.saveTimers = new Map();
    this.gatherAcc = new Map(); // sessionId -> leftover gather seconds
    this.followerSeq = 0;

    this.spawnResourceNodes();

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

    this.onMessage("train", (client) => {
      this.handleTrain(client);
    });

    this.setSimulationInterval((deltaTime) => this.update(deltaTime), TICK_MS);
    console.log("[WorldRoom] created (Phase 3)");
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

    if (existing && existing.nation_id === nationId) {
      p.x = existing.x;
      p.y = existing.y;
      p.wood = existing.wood || 0;
      p.food = existing.food || 0;
      p.stone = existing.stone || 0;
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

    // Re-bind existing buildings owned by this playerId to new session
    this.state.buildings.forEach((b) => {
      if (b.ownerId === playerId) b.ownerSessionId = client.sessionId;
    });

    const timer = setInterval(() => this.persistPlayer(client.sessionId), 15000);
    this.saveTimers.set(client.sessionId, timer);

    this.broadcast("system", { text: `${p.name} 進入了星隕之境`, t: Date.now() });
    client.send("system", {
      text: "Phase 3：走近資源自動採集 · B 建兵營 · T 訓練民兵（需在兵營旁）",
      t: Date.now(),
    });
    console.log(`[WorldRoom] join ${p.name} (${client.sessionId})`);
  }

  handleBuild(client, message) {
    const player = this.state.players.get(client.sessionId);
    if (!player || !barracksCfg) return;

    // one barracks per player
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

    // place slightly in front / offset from player
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
    client.send("system", { text: "兵營建造完成！走近後按 T 訓練民兵", t: Date.now() });
  }

  handleTrain(client) {
    const player = this.state.players.get(client.sessionId);
    if (!player || !barracksCfg) return;

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
    const maxF = barracksCfg.train?.maxFollowers || 6;
    if (followerCount >= maxF) {
      client.send("system", { text: `跟隨單位已達上限（${maxF}）`, t: Date.now() });
      return;
    }

    const train = barracksCfg.train || {};
    const cost = train.cost || {};
    if (!canAfford(player, cost)) {
      client.send("system", {
        text: `訓練需要 食${cost.food || 0}`,
        t: Date.now(),
      });
      return;
    }

    pay(player, cost);
    barracks.queueUnit = train.unitId || "militia";
    barracks.queueMs = train.durationMs || 4000;
    client.send("system", { text: "民兵訓練中…", t: Date.now() });
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
    this.state.followers.set(f.id, f);
    if (player) {
      this.broadcast("system", {
        text: `${player.name} 訓練出一名${unit.nameZh}`,
        t: Date.now(),
      });
    }
  }

  update(deltaTime) {
    const dt = Math.min(deltaTime, 100) / 1000;

    // players move + auto-gather
    this.state.players.forEach((player, sessionId) => {
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

    // followers follow owner
    this.state.followers.forEach((f) => {
      const owner = this.state.players.get(f.ownerSessionId);
      if (!owner) return;
      const dx = owner.x - f.x;
      const dy = owner.y - f.y;
      const d = Math.hypot(dx, dy);
      const followDist = 42;
      if (d > followDist) {
        const nx = dx / d;
        const ny = dy / d;
        // stay a bit behind — move toward a ring around owner
        const targetGap = 36;
        const move = Math.min(d - targetGap, f.speed * dt);
        if (move > 0) {
          f.x += nx * move;
          f.y += ny * move;
          if (Math.abs(nx) > Math.abs(ny)) {
            f.dir = nx > 0 ? "right" : "left";
          } else {
            f.dir = ny > 0 ? "down" : "up";
          }
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

    // remove this session's followers (soldiers are session-scoped for MVP)
    const toRemove = [];
    this.state.followers.forEach((f, id) => {
      if (f.ownerSessionId === client.sessionId) toRemove.push(id);
    });
    toRemove.forEach((id) => this.state.followers.delete(id));

    // clear building session binding but keep building in world
    this.state.buildings.forEach((b) => {
      if (b.ownerSessionId === client.sessionId) {
        b.ownerSessionId = "";
        b.queueMs = 0;
        b.queueUnit = "";
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
