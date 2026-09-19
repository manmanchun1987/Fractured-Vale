class GameScene extends Phaser.Scene {
  constructor() {
    super("Game");
  }

  create() {
    this.room = this.registry.get("room");
    this.me = this.registry.get("me");
    this.nations = this.registry.get("nations").nations;
    this.units = this.registry.get("units").units;
    this.nationById = Object.fromEntries(this.nations.map((n) => [n.id, n]));
    this.unitById = Object.fromEntries(this.units.map((u) => [u.id, u]));

    const worldW = this.room.state.worldW || 1600;
    const worldH = this.room.state.worldH || 1200;
    this.worldW = worldW;
    this.worldH = worldH;

    // ground
    this.add.tileSprite(0, 0, worldW, worldH, "grass").setOrigin(0);
    // simple paths (visual only)
    for (let i = 0; i < 5; i++) {
      const x = 200 + i * 280;
      this.add.tileSprite(x, 0, 40, worldH, "dirt").setOrigin(0).setAlpha(0.55);
    }

    // nation spawn markers
    this.nations.forEach((n) => {
      const m = this.add.rectangle(n.startX, n.startY, 28, 28, Phaser.Display.Color.HexStringToColor(n.color).color, 0.35);
      m.setStrokeStyle(2, Phaser.Display.Color.HexStringToColor(n.color).color);
      this.add.text(n.startX, n.startY - 22, n.nameZh, {
        fontSize: "11px", color: "#ffffff", stroke: "#000", strokeThickness: 3,
      }).setOrigin(0.5);
    });

    // Phase 3 hooks (not implemented)
    // TODO Phase 3: resource nodes, barracks, follow AI, loot drops

    this.sprites = new Map(); // sessionId -> container
    this.mySessionId = this.room.sessionId;

    this.cameras.main.setBounds(0, 0, worldW, worldH);
    this.cameras.main.setZoom(1);
    this.zoom = 1;

    document.getElementById("hud").classList.remove("hidden");
    document.getElementById("hud-name").textContent =
      `${this.me.name} · ${this.nationById[this.me.nationId]?.nameZh || ""} · ${this.unitById[this.me.specId]?.nameZh || ""}`;

    this.joystick = FVJoystick.create(document.getElementById("joystick-zone"));
    this.setupChat();
    this.setupZoom();
    this.setupKeyboard();

    // sync existing players
    this.room.state.players.forEach((p, id) => this.ensureSprite(id, p));
    this.room.state.players.onAdd((p, id) => this.ensureSprite(id, p));
    this.room.state.players.onRemove((_p, id) => this.removeSprite(id));

    this.room.onMessage("chat", (msg) => this.appendChat("msg", `${msg.from}: ${msg.text}`));
    this.room.onMessage("system", (msg) => this.appendChat("sys", msg.text));

    this.lastSent = { dx: 0, dy: 0 };
    this.moveAcc = 0;
  }

  ensureSprite(id, p) {
    if (this.sprites.has(id)) return;
    const color = Phaser.Display.Color.HexStringToColor(p.color || "#888888").color;
    const unit = this.unitById[p.specId];
    const size = unit ? unit.size : 16;

    const container = this.add.container(p.x, p.y);
    const body = this.add.rectangle(0, 0, size, size * 1.2, color);
    body.setStrokeStyle(2, 0x000000, 0.5);
    const face = this.add.rectangle(0, -size * 0.35, size * 0.35, size * 0.25, 0xffffff);
    const label = this.add.text(0, -size - 10, p.name, {
      fontSize: "11px", color: "#fff", stroke: "#000", strokeThickness: 3,
    }).setOrigin(0.5);
    container.add([body, face, label]);
    container.setData("face", face);
    container.setData("body", body);
    container.setData("label", label);
    container.setData("size", size);
    this.sprites.set(id, container);

    if (id === this.mySessionId) {
      this.cameras.main.startFollow(container, true, 0.12, 0.12);
    }
  }

  removeSprite(id) {
    const s = this.sprites.get(id);
    if (s) { s.destroy(); this.sprites.delete(id); }
  }

  applyFacing(container, dir) {
    const face = container.getData("face");
    const size = container.getData("size") || 16;
    const o = size * 0.35;
    if (dir === "up") face.setPosition(0, -o);
    else if (dir === "down") face.setPosition(0, o);
    else if (dir === "left") face.setPosition(-o, 0);
    else face.setPosition(o, 0);
  }

  setupChat() {
    const form = document.getElementById("chat-form");
    const input = document.getElementById("chat-input");
    const chatBox = document.getElementById("chat-box");
    // 防止觸控落到 Phaser／搖桿區
    if (chatBox) {
      ["pointerdown", "touchstart", "mousedown"].forEach((ev) => {
        chatBox.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
      });
    }
    form.onsubmit = (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      this.room.send("chat", { text });
      input.value = "";
      input.blur();
    };
  }

  appendChat(cls, text) {
    const log = document.getElementById("chat-log");
    const line = document.createElement("div");
    line.className = cls;
    line.textContent = text;
    log.appendChild(line);
    while (log.children.length > 40) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  applyZoom(next) {
    const cam = this.cameras.main;
    this.zoom = Phaser.Math.Clamp(next, 0.3, 2);
    cam.setZoom(this.zoom);
    this.updateZoomHud();
  }

  setupZoom() {
    const canvas = this.game.canvas;
    this._pinch = null;
    this._zoomHandlers = [];

    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this._zoomHandlers.push({ target, type, fn, opts });
    };

    // Primary: native wheel on canvas (Phaser wheel often never fires / is swallowed)
    on(canvas, "wheel", (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      this.applyZoom(this.zoom * factor);
    }, { passive: false });

    // Backup: Phaser input wheel (if it fires)
    this._phaserWheel = (_p, _go, _dx, dy) => {
      if (!dy) return;
      this.applyZoom(this.zoom * (dy > 0 ? 0.9 : 1.1));
    };
    this.input.on("wheel", this._phaserWheel);

    const touchInJoystick = (touch) => {
      if (this.joystick && this.joystick.active) return true;
      const zone = document.getElementById("joystick-zone");
      if (!zone || !touch) return false;
      const r = zone.getBoundingClientRect();
      return (
        touch.clientX >= r.left && touch.clientX <= r.right &&
        touch.clientY >= r.top && touch.clientY <= r.bottom
      );
    };

    const touchInChat = (touch) => {
      const box = document.getElementById("chat-box");
      if (!box || !touch) return false;
      const r = box.getBoundingClientRect();
      return (
        touch.clientX >= r.left && touch.clientX <= r.right &&
        touch.clientY >= r.top && touch.clientY <= r.bottom
      );
    };

    const pinchBlocked = (touches) => {
      for (let i = 0; i < touches.length; i++) {
        if (touchInJoystick(touches[i]) || touchInChat(touches[i])) return true;
      }
      return false;
    };

    on(canvas, "touchstart", (e) => {
      if (e.touches.length !== 2) {
        this._pinch = null;
        return;
      }
      if (pinchBlocked(e.touches)) {
        this._pinch = null;
        return;
      }
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      if (d < 8) return;
      this._pinch = { dist: d, zoom: this.zoom };
    }, { passive: true });

    on(canvas, "touchmove", (e) => {
      if (e.touches.length !== 2 || !this._pinch) return;
      if (pinchBlocked(e.touches)) {
        this._pinch = null;
        return;
      }
      e.preventDefault();
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      if (d < 8) return;
      this.applyZoom(this._pinch.zoom * (d / this._pinch.dist));
    }, { passive: false });

    const endPinch = () => { this._pinch = null; };
    on(canvas, "touchend", endPinch, { passive: true });
    on(canvas, "touchcancel", endPinch, { passive: true });

    this.updateZoomHud();
  }

  teardownZoom() {
    if (this._phaserWheel) {
      this.input.off("wheel", this._phaserWheel);
      this._phaserWheel = null;
    }
    (this._zoomHandlers || []).forEach(({ target, type, fn, opts }) => {
      target.removeEventListener(type, fn, opts);
    });
    this._zoomHandlers = [];
    this._pinch = null;
  }

  updateZoomHud() {
    const el = document.getElementById("hud-zoom");
    if (el) el.textContent = this.zoom.toFixed(1) + "x";
  }

  setupKeyboard() {
    this.cursors = this.input.keyboard.createCursorKeys();
    this.keys = this.input.keyboard.addKeys("W,A,S,D");
    // Desktop zoom test: + / = zoom in, - zoom out
    this.input.keyboard.on("keydown-PLUS", () => this.applyZoom(this.zoom * 1.1));
    this.input.keyboard.on("keydown-EQUALS", () => this.applyZoom(this.zoom * 1.1));
    this.input.keyboard.on("keydown-MINUS", () => this.applyZoom(this.zoom * 0.9));
    this.input.keyboard.on("keydown-NUMPAD_ADD", () => this.applyZoom(this.zoom * 1.1));
    this.input.keyboard.on("keydown-NUMPAD_SUBTRACT", () => this.applyZoom(this.zoom * 0.9));
  }

  update(_t, dt) {
    // interpolate sprites toward schema state + LOD
    const cam = this.cameras.main;
    const view = cam.worldView;
    const pad = 80;
    const zoom = this.zoom;

    this.room.state.players.forEach((p, id) => {
      let spr = this.sprites.get(id);
      if (!spr) {
        this.ensureSprite(id, p);
        spr = this.sprites.get(id);
      }
      if (!spr) return;

      // basic LOD: hide far entities when zoomed out heavily, simplify labels
      const inView =
        p.x > view.x - pad && p.x < view.x + view.width + pad &&
        p.y > view.y - pad && p.y < view.y + view.height + pad;

      if (!inView && zoom < 0.6) {
        spr.setVisible(false);
        return;
      }
      spr.setVisible(true);

      const label = spr.getData("label");
      if (label) label.setVisible(zoom >= 0.55 || id === this.mySessionId);

      // smooth follow schema pos
      spr.x = Phaser.Math.Linear(spr.x, p.x, 0.35);
      spr.y = Phaser.Math.Linear(spr.y, p.y, 0.35);
      this.applyFacing(spr, p.dir || "down");
    });

    // input
    let dx = 0, dy = 0;
    const joy = this.joystick.vector;
    dx += joy.dx;
    dy += joy.dy;

    if (this.cursors.left.isDown || this.keys.A.isDown) dx -= 1;
    if (this.cursors.right.isDown || this.keys.D.isDown) dx += 1;
    if (this.cursors.up.isDown || this.keys.W.isDown) dy -= 1;
    if (this.cursors.down.isDown || this.keys.S.isDown) dy += 1;

    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }

    // send at ~20Hz if changed or moving
    this.moveAcc += dt;
    if (this.moveAcc >= 50) {
      this.moveAcc = 0;
      if (dx !== this.lastSent.dx || dy !== this.lastSent.dy || dx !== 0 || dy !== 0) {
        this.room.send("move", { dx, dy });
        this.lastSent = { dx, dy };
      }
    }
  }

  shutdown() {
    this.teardownZoom();
    if (this.joystick) this.joystick.destroy();
    document.getElementById("hud").classList.add("hidden");
  }
}

window.GameScene = GameScene;
