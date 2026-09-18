const { Room } = require("colyseus");
const { WorldState, PlayerState } = require("../schema/PlayerState");
const { savePlayer, loadPlayer } = require("../db");
const path = require("path");
const fs = require("fs");

const nationsPath = path.join(__dirname, "../../../client/data/nations.json");
const unitsPath = path.join(__dirname, "../../../client/data/units.json");
const nationsData = JSON.parse(fs.readFileSync(nationsPath, "utf8"));
const unitsData = JSON.parse(fs.readFileSync(unitsPath, "utf8"));

const nationById = Object.fromEntries(nationsData.nations.map((n) => [n.id, n]));
const unitById = Object.fromEntries(unitsData.units.map((u) => [u.id, u]));

const WORLD_W = 1600;
const WORLD_H = 1200;
const TICK_MS = 50; // 20 Hz movement apply

class WorldRoom extends Room {
  onCreate() {
    this.setState(new WorldState());
    this.state.worldW = WORLD_W;
    this.state.worldH = WORLD_H;
    this.maxClients = 64;
    this.inputs = new Map(); // sessionId -> {dx, dy}
    this.saveTimers = new Map();

    this.onMessage("move", (client, message) => {
      const dx = Number(message?.dx) || 0;
      const dy = Number(message?.dy) || 0;
      // clamp to unit circle-ish
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

    this.setSimulationInterval((deltaTime) => this.update(deltaTime), TICK_MS);
    console.log("[WorldRoom] created");
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
    } else {
      p.x = nation.startX + (Math.random() * 40 - 20);
      p.y = nation.startY + (Math.random() * 40 - 20);
    }

    this.state.players.set(client.sessionId, p);
    this.inputs.set(client.sessionId, { dx: 0, dy: 0 });

    // autosave every 15s
    const timer = setInterval(() => this.persistPlayer(client.sessionId), 15000);
    this.saveTimers.set(client.sessionId, timer);

    this.broadcast("system", { text: `${p.name} 進入了星隕之境`, t: Date.now() });
    console.log(`[WorldRoom] join ${p.name} (${client.sessionId})`);
  }

  update(deltaTime) {
    const dt = Math.min(deltaTime, 100) / 1000;
    this.state.players.forEach((player, sessionId) => {
      const input = this.inputs.get(sessionId) || { dx: 0, dy: 0 };
      if (input.dx === 0 && input.dy === 0) return;

      const nx = player.x + input.dx * player.speed * dt;
      const ny = player.y + input.dy * player.speed * dt;
      player.x = Math.max(16, Math.min(WORLD_W - 16, nx));
      player.y = Math.max(16, Math.min(WORLD_H - 16, ny));

      // facing from dominant axis
      if (Math.abs(input.dx) > Math.abs(input.dy)) {
        player.dir = input.dx > 0 ? "right" : "left";
      } else {
        player.dir = input.dy > 0 ? "down" : "up";
      }
    });
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
