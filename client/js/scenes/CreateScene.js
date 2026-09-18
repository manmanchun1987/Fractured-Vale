class CreateScene extends Phaser.Scene {
  constructor() {
    super("Create");
  }

  create() {
    const panel = document.getElementById("create-panel");
    const nationSel = document.getElementById("nation-select");
    const specSel = document.getElementById("spec-select");
    const nationBonus = document.getElementById("nation-bonus");
    const specDesc = document.getElementById("spec-desc");
    const nameInput = document.getElementById("name-input");
    const enterBtn = document.getElementById("enter-btn");
    const errEl = document.getElementById("create-error");

    panel.classList.remove("hidden");
    document.getElementById("hud").classList.add("hidden");

    const nations = this.registry.get("nations").nations;
    const units = this.registry.get("units").units;

    // restore local prefs
    const saved = (() => {
      try { return JSON.parse(localStorage.getItem("fv_create") || "{}"); } catch { return {}; }
    })();
    if (saved.name) nameInput.value = saved.name;

    nationSel.innerHTML = nations.map((n) =>
      `<option value="${n.id}">${n.nameZh} (${n.nameEn})</option>`
    ).join("");
    specSel.innerHTML = units.map((u) =>
      `<option value="${u.id}">${u.nameZh} (${u.nameEn})</option>`
    ).join("");

    if (saved.nationId) nationSel.value = saved.nationId;
    if (saved.specId) specSel.value = saved.specId;

    const refreshHints = () => {
      const n = nations.find((x) => x.id === nationSel.value);
      const u = units.find((x) => x.id === specSel.value);
      nationBonus.textContent = n ? `加成：${n.bonus}` : "";
      specDesc.textContent = u ? u.desc : "";
      nationSel.style.borderColor = n ? n.color : "#30363d";
    };
    nationSel.onchange = refreshHints;
    specSel.onchange = refreshHints;
    refreshHints();

    const onEnter = async () => {
      errEl.textContent = "";
      enterBtn.disabled = true;
      enterBtn.textContent = "連線中…";
      const name = (nameInput.value || "旅人").trim().slice(0, 16) || "旅人";
      const nationId = nationSel.value;
      const specId = specSel.value;
      let playerId = localStorage.getItem("fv_player_id");
      if (!playerId) {
        playerId = "p_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        localStorage.setItem("fv_player_id", playerId);
      }
      localStorage.setItem("fv_create", JSON.stringify({ name, nationId, specId }));

      try {
        const { room } = await FVNet.connectWorld({ name, nationId, specId, playerId });
        panel.classList.add("hidden");
        this.registry.set("room", room);
        this.registry.set("me", { name, nationId, specId, playerId });
        this.scene.start("Game");
      } catch (err) {
        console.error(err);
        errEl.textContent = "連線失敗：" + (err.message || String(err));
        enterBtn.disabled = false;
        enterBtn.textContent = "進入世界";
      }
    };

    enterBtn.onclick = onEnter;
    nameInput.onkeydown = (e) => { if (e.key === "Enter") onEnter(); };
  }
}

window.CreateScene = CreateScene;
