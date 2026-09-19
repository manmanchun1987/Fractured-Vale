class BootScene extends Phaser.Scene {
  constructor() {
    super("Boot");
  }

  preload() {
    const g = this.make.graphics({ x: 0, y: 0, add: false });
    g.fillStyle(0xffffff, 1);
    g.fillRoundedRect(0, 4, 20, 24, 4);
    g.fillStyle(0x111111, 1);
    g.fillCircle(10, 8, 3);
    g.generateTexture("unit_body", 20, 28);
    g.destroy();

    const t = this.make.graphics({ x: 0, y: 0, add: false });
    t.fillStyle(0x3d5c3a, 1);
    t.fillRect(0, 0, 64, 64);
    t.lineStyle(1, 0x2f4a2d, 0.4);
    t.strokeRect(0, 0, 64, 64);
    t.generateTexture("grass", 64, 64);
    t.destroy();

    const d = this.make.graphics({ x: 0, y: 0, add: false });
    d.fillStyle(0x6b5344, 1);
    d.fillRect(0, 0, 64, 64);
    d.generateTexture("dirt", 64, 64);
    d.destroy();
  }

  async create() {
    const boot = document.getElementById("boot-msg");
    try {
      const [nations, units, resources, buildings] = await Promise.all([
        fetch("data/nations.json").then((r) => r.json()),
        fetch("data/units.json").then((r) => r.json()),
        fetch("data/resources.json").then((r) => r.json()),
        fetch("data/buildings.json").then((r) => r.json()),
      ]);
      this.registry.set("nations", nations);
      this.registry.set("units", units);
      this.registry.set("resources", resources);
      this.registry.set("buildings", buildings);
      if (boot) boot.classList.add("hidden");
      this.scene.start("Create");
    } catch (err) {
      if (boot) boot.textContent = "載入失敗：" + err.message;
    }
  }
}

window.BootScene = BootScene;
