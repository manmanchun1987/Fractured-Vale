(function () {
  const config = {
    type: Phaser.AUTO,
    parent: "game-root",
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: "#1a2a1a",
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: [BootScene, CreateScene, GameScene],
    input: { activePointers: 3 },
    render: { antialias: false, pixelArt: true },
  };

  window.FVGame = new Phaser.Game(config);

  window.addEventListener("resize", () => {
    if (window.FVGame) {
      window.FVGame.scale.resize(window.innerWidth, window.innerHeight);
    }
  });
})();
