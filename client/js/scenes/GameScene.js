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

    this.resourceData = this.registry.get("resources") || { types: {}, nodes: [] };
    this.buildingData = this.registry.get("buildings") || {};
    this.resourceTypes = this.resourceData.types || {};

    this.sprites = new Map(); // sessionId -> container
    this.resourceSprites = new Map();
    this.buildingSprites = new Map();
    this.followerSprites = new Map();
    this.lootSprites = new Map();
    this.castleSprites = new Map();
    this.damageTexts = [];
    this.attackHeld = false;
    this.popCap = (this.buildingData && this.buildingData.populationCap) || 300;
    this.mySessionId = this.room.sessionId;
    this.lootData = this.registry.get("loot") || { items: {}, tables: {} };

    this.cameras.main.setBounds(0, 0, worldW, worldH);
    this.cameras.main.setZoom(1);
    this.zoom = 1;

    document.getElementById("hud").classList.remove("hidden");
    document.getElementById("hud-name").textContent =
      `${this.me.name} · ${this.nationById[this.me.nationId]?.nameZh || ""} · ${this.unitById[this.me.specId]?.nameZh || ""}`;

    this.joystick = FVJoystick.create(document.getElementById("joystick-zone"));
    this.setupChat();
    this.setupZoom();
    this.setupCameraPan();
    this.setupKeyboard();
    this.setupPhase3Actions();

    // sync existing players
    this.room.state.players.forEach((p, id) => this.ensureSprite(id, p));
    this.room.state.players.onAdd((p, id) => this.ensureSprite(id, p));
    this.room.state.players.onRemove((_p, id) => this.removeSprite(id));

    this.syncWorldEntities();

    this.room.onMessage("chat", (msg) => this.appendChat("msg", `${msg.from}: ${msg.text}`));
    this.room.onMessage("system", (msg) => this.appendChat("sys", msg.text));
    this.room.onMessage("fx", (msg) => this.onFx(msg));

    this.lastSent = { dx: 0, dy: 0 };
    this.moveAcc = 0;
    this.resHudAcc = 0;
  }

  onFx(msg) {
    if (!msg || msg.type !== "dmg") return;
    const t = this.add.text(msg.x, msg.y, "-" + String(msg.value), {
      fontSize: "14px",
      color: "#ff6b6b",
      stroke: "#000",
      strokeThickness: 4,
      fontStyle: "bold",
    }).setOrigin(0.5).setDepth(50);
    this.damageTexts.push({ text: t, life: 700, vy: -40 });
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
    const label = this.add.text(0, -size - 14, p.name, {
      fontSize: "11px", color: "#fff", stroke: "#000", strokeThickness: 3,
    }).setOrigin(0.5);
    const hpBg = this.add.rectangle(0, size * 0.75 + 4, size + 4, 5, 0x222222, 0.85);
    const hpFill = this.add.rectangle(-(size + 4) / 2 + 0.5, size * 0.75 + 4, size + 3, 3, 0x3fb950, 1).setOrigin(0, 0.5);
    container.add([body, face, label, hpBg, hpFill]);
    container.setData("face", face);
    container.setData("body", body);
    container.setData("label", label);
    container.setData("hpFill", hpFill);
    container.setData("hpW", size + 3);
    container.setData("size", size);
    this.sprites.set(id, container);

    if (id === this.mySessionId && !this.freeCam) {
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
    // iOS: #hud 曾蓋住全屏，touch 打唔到 canvas → 改聽 window，並加 +/- 掣
    const canvas = this.game.canvas;
    this._pinch = null;
    this._zoomHandlers = [];

    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this._zoomHandlers.push({ target, type, fn, opts });
    };

    const inUiBlock = (touch) => this.touchInUiBlock(touch);

    const pinchBlocked = (touches) => {
      for (let i = 0; i < touches.length; i++) {
        if (inUiBlock(touches[i])) return true;
      }
      return false;
    };

    const dist2 = (touches) => Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY
    );

    // Wheel on canvas + window (desktop / trackpad)
    const onWheel = (e) => {
      e.preventDefault();
      this.applyZoom(this.zoom * (e.deltaY > 0 ? 0.9 : 1.1));
    };
    on(canvas, "wheel", onWheel, { passive: false });
    on(window, "wheel", onWheel, { passive: false });

    this._phaserWheel = (_p, _go, _dx, dy) => {
      if (!dy) return;
      this.applyZoom(this.zoom * (dy > 0 ? 0.9 : 1.1));
    };
    this.input.on("wheel", this._phaserWheel);

    // Pinch on window so iOS Safari always gets it (HUD no longer steals)
    on(window, "touchstart", (e) => {
      if (e.touches.length !== 2) {
        this._pinch = null;
        return;
      }
      if (pinchBlocked(e.touches)) {
        this._pinch = null;
        return;
      }
      const d = dist2(e.touches);
      if (d < 10) return;
      this._pinch = { dist: d, zoom: this.zoom };
    }, { passive: true, capture: true });

    on(window, "touchmove", (e) => {
      if (e.touches.length !== 2 || !this._pinch) return;
      if (pinchBlocked(e.touches)) {
        this._pinch = null;
        return;
      }
      e.preventDefault();
      const d = dist2(e.touches);
      if (d < 10) return;
      this.applyZoom(this._pinch.zoom * (d / this._pinch.dist));
    }, { passive: false, capture: true });

    const endPinch = () => { this._pinch = null; };
    on(window, "touchend", endPinch, { passive: true, capture: true });
    on(window, "touchcancel", endPinch, { passive: true, capture: true });

    // Big on-screen buttons (most reliable on iPhone)
    const zin = document.getElementById("zoom-in");
    const zout = document.getElementById("zoom-out");
    if (zin) zin.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this.applyZoom(this.zoom * 1.15); };
    if (zout) zout.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this.applyZoom(this.zoom * 0.87); };


    this.input.keyboard.on("keydown-PLUS", () => this.applyZoom(this.zoom * 1.1));
    this.input.keyboard.on("keydown-EQUALS", () => this.applyZoom(this.zoom * 1.1));
    this.input.keyboard.on("keydown-MINUS", () => this.applyZoom(this.zoom * 0.9));
    this.input.keyboard.on("keydown-NUMPAD_ADD", () => this.applyZoom(this.zoom * 1.1));
    this.input.keyboard.on("keydown-NUMPAD_SUBTRACT", () => this.applyZoom(this.zoom * 0.9));

    this.updateZoomHud();
  }

  updateZoomHud() {
    const el = document.getElementById("hud-zoom");
    if (el) el.textContent = this.zoom.toFixed(1) + "x";
  }

  touchInUiBlock(touch) {
    if (!touch) return false;
    const x = touch.clientX;
    const y = touch.clientY;
    for (const id of ["joystick-zone", "chat-box", "zoom-controls", "hud-actions", "cam-recenter"]) {
      const el = document.getElementById(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
    if (this.joystick && this.joystick.active) return true;
    return false;
  }

  beginFreeCam() {
    if (this.freeCam) return;
    this.freeCam = true;
    this.cameras.main.stopFollow();
    const btn = document.getElementById("cam-recenter");
    if (btn) btn.classList.add("active");
  }

  recenterOnPlayer() {
    const spr = this.sprites.get(this.mySessionId);
    this.freeCam = false;
    this._pan = null;
    this._ignorePanUntil = performance.now() + 400;
    const cam = this.cameras.main;
    if (spr) {
      cam.stopFollow();
      cam.centerOn(spr.x, spr.y);
      // slightly snappier follow so 「返自己」明顯跟住角色
      cam.startFollow(spr, true, 0.22, 0.22);
    }
    const btn = document.getElementById("cam-recenter");
    if (btn) btn.classList.remove("active");
  }

  ensureCameraFollow() {
    if (this.freeCam) return;
    const spr = this.sprites.get(this.mySessionId);
    if (!spr) return;
    const cam = this.cameras.main;
    if (cam._follow !== spr) {
      cam.startFollow(spr, true, 0.22, 0.22);
    }
  }

  setupCameraPan() {
    // One-finger / mouse drag on empty map → free pan; stay free until 「返自己」
    this.freeCam = false;
    this._pan = null;
    this._panHandlers = this._panHandlers || [];
    // reuse zoom handler list so teardownZoom clears both
    if (!this._zoomHandlers) this._zoomHandlers = [];

    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this._zoomHandlers.push({ target, type, fn, opts });
    };

    const PAN_THRESHOLD = 8;

    const startPan = (clientX, clientY, pointerId) => {
      if (this._pinch) return;
      if (this._ignorePanUntil && performance.now() < this._ignorePanUntil) return;
      if (this.joystick && this.joystick.active) return;
      if (this.touchInUiBlock({ clientX, clientY })) return;
      this._pan = {
        id: pointerId,
        lastX: clientX,
        lastY: clientY,
        moved: false,
      };
    };

    const movePan = (clientX, clientY, pointerId, e) => {
      if (!this._pan || this._pan.id !== pointerId) return;
      if (this._pinch) {
        this._pan = null;
        return;
      }
      const dx = clientX - this._pan.lastX;
      const dy = clientY - this._pan.lastY;
      if (!this._pan.moved) {
        if (Math.hypot(dx, dy) < PAN_THRESHOLD) return;
        this._pan.moved = true;
        this.beginFreeCam();
      }
      if (e && e.cancelable) e.preventDefault();
      const cam = this.cameras.main;
      const z = cam.zoom || this.zoom || 1;
      cam.scrollX -= dx / z;
      cam.scrollY -= dy / z;
      this._pan.lastX = clientX;
      this._pan.lastY = clientY;
    };

    const endPan = (pointerId) => {
      if (!this._pan) return;
      if (pointerId != null && this._pan.id !== pointerId) return;
      this._pan = null;
    };

    // Pointer events (mouse + most mobile); capture so we keep tracking outside canvas
    on(window, "pointerdown", (e) => {
      if (e.pointerType === "touch") return; // touch handled below (multi-touch aware)
      if (e.button !== 0) return;
      startPan(e.clientX, e.clientY, e.pointerId);
    }, { passive: true, capture: true });

    on(window, "pointermove", (e) => {
      if (e.pointerType === "touch") return;
      movePan(e.clientX, e.clientY, e.pointerId, e);
    }, { passive: false, capture: true });

    on(window, "pointerup", (e) => {
      if (e.pointerType === "touch") return;
      endPan(e.pointerId);
    }, { passive: true, capture: true });

    on(window, "pointercancel", (e) => {
      if (e.pointerType === "touch") return;
      endPan(e.pointerId);
    }, { passive: true, capture: true });

    // Touch: only single-finger pan; two-finger is pinch
    on(window, "touchstart", (e) => {
      if (e.touches.length !== 1) {
        this._pan = null;
        return;
      }
      const t = e.touches[0];
      startPan(t.clientX, t.clientY, t.identifier);
    }, { passive: true, capture: true });

    on(window, "touchmove", (e) => {
      if (!this._pan) return;
      if (e.touches.length !== 1) {
        this._pan = null;
        return;
      }
      const t = e.touches[0];
      movePan(t.clientX, t.clientY, t.identifier, e);
    }, { passive: false, capture: true });

    on(window, "touchend", (e) => {
      if (!this._pan) return;
      // if the pan finger lifted, end
      let still = false;
      for (let i = 0; i < e.touches.length; i++) {
        if (e.touches[i].identifier === this._pan.id) { still = true; break; }
      }
      if (!still) this._pan = null;
    }, { passive: true, capture: true });

    on(window, "touchcancel", () => { this._pan = null; }, { passive: true, capture: true });

    const btn = document.getElementById("cam-recenter");
    if (btn) {
      const onRecenter = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
        this._pan = null;
        this.recenterOnPlayer();
      };
      // capture:true so window pan listener (also capture) does not steal the click
      ["pointerdown", "touchstart", "mousedown", "click"].forEach((ev) => {
        btn.addEventListener(ev, onRecenter, { capture: true });
      });
    }
  }

  teardownZoom() {
    if (this._phaserWheel) {
      this.input.off("wheel", this._phaserWheel);
      this._phaserWheel = null;
    }
    const list = this._zoomHandlers || [];
    for (const { target, type, fn, opts } of list) {
      try { target.removeEventListener(type, fn, opts); } catch (_) {}
    }
    this._zoomHandlers = [];
    this._pinch = null;
    this._pan = null;
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
    this.input.keyboard.on("keydown-B", () => this.requestBuild());
    this.input.keyboard.on("keydown-T", () => this.requestTrain("militia"));
    this.input.keyboard.on("keydown-V", () => this.requestTrain("villager"));
    this.input.keyboard.on("keydown-G", () => this.castleAction("garrison"));
    this.input.keyboard.on("keydown-E", () => this.castleAction("deploy"));
    this.input.keyboard.on("keydown-C", () => this.castleAction("follow"));
    this.input.keyboard.on("keydown-A", () => this.setAttack(true));
    this.input.keyboard.on("keyup-A", () => this.setAttack(false));
    this.input.keyboard.on("keydown-SPACE", () => this.setAttack(true));
    this.input.keyboard.on("keyup-SPACE", () => this.setAttack(false));
  }

  setupPhase3Actions() {
    const buildBtn = document.getElementById("btn-build");
    const trainBtn = document.getElementById("btn-train");
    const villBtn = document.getElementById("btn-train-villager");
    const atkBtn = document.getElementById("btn-attack");
    if (buildBtn) {
      buildBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this.requestBuild(); };
      ["pointerdown", "touchstart", "mousedown"].forEach((ev) => {
        buildBtn.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
      });
    }
    if (trainBtn) {
      trainBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this.requestTrain("militia"); };
      ["pointerdown", "touchstart", "mousedown"].forEach((ev) => {
        trainBtn.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
      });
    }
    if (villBtn) {
      villBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this.requestTrain("villager"); };
      ["pointerdown", "touchstart", "mousedown"].forEach((ev) => {
        villBtn.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
      });
    }
    const bindTap = (el, fn) => {
      if (!el) return;
      el.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(); };
      ["pointerdown", "touchstart", "mousedown"].forEach((ev) => {
        el.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
      });
    };
    bindTap(document.getElementById("btn-garrison"), () => this.castleAction("garrison"));
    bindTap(document.getElementById("btn-deploy"), () => this.castleAction("deploy"));
    bindTap(document.getElementById("btn-castle-follow"), () => this.castleAction("follow"));
    if (atkBtn) {
      const down = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setAttack(true);
        atkBtn.classList.add("held");
      };
      const up = (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        this.setAttack(false);
        atkBtn.classList.remove("held");
      };
      atkBtn.addEventListener("pointerdown", down);
      atkBtn.addEventListener("pointerup", up);
      atkBtn.addEventListener("pointerleave", up);
      atkBtn.addEventListener("pointercancel", up);
      atkBtn.addEventListener("touchstart", down, { passive: false });
      atkBtn.addEventListener("touchend", up);
      atkBtn.addEventListener("touchcancel", up);
      // prevent map pan from eating the button
      ["pointerdown", "touchstart", "mousedown"].forEach((ev) => {
        atkBtn.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
      });
    }
  }

  setAttack(on) {
    this.attackHeld = !!on;
    if (!this.room) return;
    this.room.send("attack", { on: !!on });
  }

  requestBuild() {
    if (!this.room) return;
    this.room.send("build", { ox: 48, oy: 0 });
  }

  requestTrain(unit) {
    if (!this.room) return;
    this.room.send("train", { unit: unit || "militia" });
  }

  castleAction(action) {
    if (!this.room) return;
    this.room.send("castle", { action });
  }

  syncWorldEntities() {
    const st = this.room.state;
    if (st.resources) {
      st.resources.forEach((n, id) => this.ensureResource(id, n));
      st.resources.onAdd((n, id) => this.ensureResource(id, n));
      st.resources.onRemove((_n, id) => this.removeResource(id));
    }
    if (st.buildings) {
      st.buildings.forEach((b, id) => this.ensureBuilding(id, b));
      st.buildings.onAdd((b, id) => this.ensureBuilding(id, b));
      st.buildings.onRemove((_b, id) => this.removeBuilding(id));
    }
    if (st.followers) {
      st.followers.forEach((f, id) => this.ensureFollower(id, f));
      st.followers.onAdd((f, id) => this.ensureFollower(id, f));
      st.followers.onRemove((_f, id) => this.removeFollower(id));
    }
    if (st.loot) {
      st.loot.forEach((l, id) => this.ensureLoot(id, l));
      st.loot.onAdd((l, id) => this.ensureLoot(id, l));
      st.loot.onRemove((_l, id) => this.removeLoot(id));
    }
    if (st.castles) {
      st.castles.forEach((c, id) => this.ensureCastle(id, c));
      st.castles.onAdd((c, id) => this.ensureCastle(id, c));
      st.castles.onRemove((_c, id) => this.removeCastle(id));
    }
  }

  ensureResource(id, n) {
    if (this.resourceSprites.has(id)) return;
    const meta = this.resourceTypes[n.type] || { color: "#888", symbol: "?" };
    const color = Phaser.Display.Color.HexStringToColor(meta.color || "#888888").color;
    const container = this.add.container(n.x, n.y);
    const body = this.add.circle(0, 0, 16, color, 0.9);
    body.setStrokeStyle(2, 0x000000, 0.45);
    const label = this.add.text(0, -22, meta.symbol || n.type, {
      fontSize: "12px", color: "#fff", stroke: "#000", strokeThickness: 3,
    }).setOrigin(0.5);
    const amt = this.add.text(0, 18, String(Math.floor(n.amount)), {
      fontSize: "10px", color: "#fff", stroke: "#000", strokeThickness: 2,
    }).setOrigin(0.5);
    container.add([body, label, amt]);
    container.setData("amt", amt);
    container.setDepth(1);
    this.resourceSprites.set(id, container);
  }

  removeResource(id) {
    const s = this.resourceSprites.get(id);
    if (s) { s.destroy(); this.resourceSprites.delete(id); }
  }

  ensureBuilding(id, b) {
    if (this.buildingSprites.has(id)) return;
    const cfg = this.buildingData.barracks || {};
    const color = Phaser.Display.Color.HexStringToColor(cfg.color || "#8B4513").color;
    const size = cfg.size || 36;
    const container = this.add.container(b.x, b.y);
    const body = this.add.rectangle(0, 0, size, size, color, 0.95);
    body.setStrokeStyle(2, 0x000000, 0.55);
    const label = this.add.text(0, -size / 2 - 10, cfg.nameZh || "兵營", {
      fontSize: "11px", color: "#fff", stroke: "#000", strokeThickness: 3,
    }).setOrigin(0.5);
    const queue = this.add.text(0, size / 2 + 8, "", {
      fontSize: "10px", color: "#ffe08a", stroke: "#000", strokeThickness: 2,
    }).setOrigin(0.5);
    container.add([body, label, queue]);
    container.setData("queue", queue);
    container.setDepth(2);
    this.buildingSprites.set(id, container);
  }

  removeBuilding(id) {
    const s = this.buildingSprites.get(id);
    if (s) { s.destroy(); this.buildingSprites.delete(id); }
  }

  ensureFollower(id, f) {
    if (this.followerSprites.has(id)) return;
    const unit = this.unitById[f.specId];
    const size = unit ? Math.max(10, unit.size - 2) : 12;
    const color = Phaser.Display.Color.HexStringToColor(f.color || "#888888").color;
    const container = this.add.container(f.x, f.y);
    const body = this.add.rectangle(0, 0, size, size * 1.1, color);
    body.setStrokeStyle(1, 0x000000, 0.5);
    const face = this.add.rectangle(0, -size * 0.3, size * 0.3, size * 0.2, 0xffffff);
    const hpBg = this.add.rectangle(0, size * 0.7 + 3, size + 2, 4, 0x222222, 0.85);
    const hpFill = this.add.rectangle(-(size + 2) / 2 + 0.5, size * 0.7 + 3, size + 1, 2, 0x3fb950, 1).setOrigin(0, 0.5);
    container.add([body, face, hpBg, hpFill]);
    container.setData("face", face);
    container.setData("hpFill", hpFill);
    container.setData("hpW", size + 1);
    container.setData("size", size);
    container.setDepth(3);
    this.followerSprites.set(id, container);
  }

  removeFollower(id) {
    const s = this.followerSprites.get(id);
    if (s) { s.destroy(); this.followerSprites.delete(id); }
  }

  ensureLoot(id, l) {
    if (this.lootSprites.has(id)) return;
    const color = Phaser.Display.Color.HexStringToColor(l.color || "#DAA520").color;
    const container = this.add.container(l.x, l.y);
    const body = this.add.circle(0, 0, 10, color, 0.95);
    body.setStrokeStyle(2, 0xffffff, 0.55);
    const label = this.add.text(0, 0, l.label || "?", {
      fontSize: "10px", color: "#111", stroke: "#fff", strokeThickness: 2,
    }).setOrigin(0.5);
    container.add([body, label]);
    container.setDepth(4);
    this.lootSprites.set(id, container);
  }

  removeLoot(id) {
    const s = this.lootSprites.get(id);
    if (s) { s.destroy(); this.lootSprites.delete(id); }
  }

  ensureCastle(id, c) {
    if (this.castleSprites.has(id)) return;
    const cfg = (this.buildingData && this.buildingData.castle) || {};
    const size = cfg.size || 52;
    const color = Phaser.Display.Color.HexStringToColor(c.color || cfg.color || "#4A3728").color;
    const container = this.add.container(c.x, c.y);
    const body = this.add.rectangle(0, 0, size, size * 0.85, color, 0.95);
    body.setStrokeStyle(3, 0xffd700, 0.65);
    const keep = this.add.rectangle(0, -size * 0.15, size * 0.35, size * 0.45, 0x2a1a10, 0.95);
    const label = this.add.text(0, -size / 2 - 12, cfg.nameZh || "移動城堡", {
      fontSize: "11px", color: "#ffe08a", stroke: "#000", strokeThickness: 3,
    }).setOrigin(0.5);
    const gTxt = this.add.text(0, size / 2 + 6, "", {
      fontSize: "10px", color: "#fff", stroke: "#000", strokeThickness: 2,
    }).setOrigin(0.5);
    container.add([body, keep, label, gTxt]);
    container.setData("gTxt", gTxt);
    container.setDepth(2.5);
    this.castleSprites.set(id, container);
  }

  removeCastle(id) {
    const s = this.castleSprites.get(id);
    if (s) { s.destroy(); this.castleSprites.delete(id); }
  }

  setHpBar(spr, hp, maxHp) {
    const fill = spr.getData("hpFill");
    const w = spr.getData("hpW") || 12;
    if (!fill) return;
    const ratio = Math.max(0, Math.min(1, (hp || 0) / Math.max(1, maxHp || 1)));
    fill.width = Math.max(0.5, w * ratio);
    if (ratio > 0.55) fill.setFillStyle(0x3fb950, 1);
    else if (ratio > 0.25) fill.setFillStyle(0xd29922, 1);
    else fill.setFillStyle(0xf85149, 1);
  }

  updateResHud() {
    const me = this.room.state.players.get(this.mySessionId);
    const el = document.getElementById("hud-res");
    const hpEl = document.getElementById("hud-hp");
    const popEl = document.getElementById("hud-pop");
    if (!me) return;
    if (el) {
      const bonus = me.atkBonus ? ` 攻+${Math.floor(me.atkBonus)}` : "";
      el.textContent =
        `木${Math.floor(me.wood || 0)} 肉${Math.floor(me.meat || 0)} 石${Math.floor(me.stone || 0)} 金${Math.floor(me.gold || 0)}${bonus}`;
    }
    if (hpEl) {
      hpEl.textContent = `HP ${Math.ceil(me.hp || 0)}/${Math.ceil(me.maxHp || 0)}`;
    }
    if (popEl) {
      const cap = this.popCap || 300;
      popEl.textContent = `人口 ${Math.floor(me.pop || 0)}/${cap}`;
    }
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
      if (id === this.mySessionId) this.ensureCameraFollow();
      this.applyFacing(spr, p.dir || "down");
      this.setHpBar(spr, p.hp, p.maxHp);
    });

    // resources
    if (this.room.state.resources) {
      this.room.state.resources.forEach((n, id) => {
        let spr = this.resourceSprites.get(id);
        if (!spr) { this.ensureResource(id, n); spr = this.resourceSprites.get(id); }
        if (!spr) return;
        spr.setVisible(n.amount > 0);
        const amt = spr.getData("amt");
        if (amt) amt.setText(String(Math.floor(n.amount)));
      });
    }

    // buildings
    if (this.room.state.buildings) {
      this.room.state.buildings.forEach((b, id) => {
        let spr = this.buildingSprites.get(id);
        if (!spr) { this.ensureBuilding(id, b); spr = this.buildingSprites.get(id); }
        if (!spr) return;
        spr.x = Phaser.Math.Linear(spr.x, b.x, 0.4);
        spr.y = Phaser.Math.Linear(spr.y, b.y, 0.4);
        const q = spr.getData("queue");
        if (q) {
          q.setText(b.queueMs > 0 ? `訓練 ${(b.queueMs / 1000).toFixed(1)}s` : "");
        }
      });
    }

    // castles
    if (this.room.state.castles) {
      this.room.state.castles.forEach((c, id) => {
        let spr = this.castleSprites.get(id);
        if (!spr) { this.ensureCastle(id, c); spr = this.castleSprites.get(id); }
        if (!spr) return;
        spr.x = Phaser.Math.Linear(spr.x, c.x, 0.25);
        spr.y = Phaser.Math.Linear(spr.y, c.y, 0.25);
        const gTxt = spr.getData("gTxt");
        if (gTxt) {
          const move = c.moving ? "移動中 · " : "";
          const fol = c.followOwner ? "跟隨 · " : "";
          gTxt.setText(`${fol}${move}駐軍 ${Math.floor(c.garrison || 0)}`);
        }
      });
    }

    // followers
    if (this.room.state.followers) {
      this.room.state.followers.forEach((f, id) => {
        let spr = this.followerSprites.get(id);
        if (!spr) { this.ensureFollower(id, f); spr = this.followerSprites.get(id); }
        if (!spr) return;
        spr.x = Phaser.Math.Linear(spr.x, f.x, 0.35);
        spr.y = Phaser.Math.Linear(spr.y, f.y, 0.35);
        this.applyFacing(spr, f.dir || "down");
        this.setHpBar(spr, f.hp, f.maxHp);
      });
    }

    // loot
    if (this.room.state.loot) {
      this.room.state.loot.forEach((l, id) => {
        let spr = this.lootSprites.get(id);
        if (!spr) { this.ensureLoot(id, l); spr = this.lootSprites.get(id); }
        if (!spr) return;
        spr.x = Phaser.Math.Linear(spr.x, l.x, 0.4);
        spr.y = Phaser.Math.Linear(spr.y, l.y, 0.4);
      });
    }

    // floating damage numbers
    if (this.damageTexts && this.damageTexts.length) {
      const remain = [];
      for (const d of this.damageTexts) {
        d.life -= dt;
        d.text.y += (d.vy * dt) / 1000;
        d.text.setAlpha(Math.max(0, d.life / 700));
        if (d.life > 0) remain.push(d);
        else d.text.destroy();
      }
      this.damageTexts = remain;
    }

    this.resHudAcc += dt;
    if (this.resHudAcc >= 200) {
      this.resHudAcc = 0;
      this.updateResHud();
    }

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
    this.setAttack(false);
    this.teardownZoom();
    this.freeCam = false;
    if (this.joystick) this.joystick.destroy();
    document.getElementById("hud").classList.add("hidden");
  }
}

window.GameScene = GameScene;
