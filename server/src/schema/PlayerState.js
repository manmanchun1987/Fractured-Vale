const { Schema, defineTypes, MapSchema } = require("@colyseus/schema");

class PlayerState extends Schema {
  constructor() {
    super();
    this.id = "";
    this.name = "";
    this.nationId = "britons";
    this.specId = "militia";
    this.x = 400;
    this.y = 400;
    this.dir = "down"; // up|down|left|right
    this.color = "#4169E1";
    this.speed = 100;
    this.hp = 55;
    this.maxHp = 55;
  }
}

defineTypes(PlayerState, {
  id: "string",
  name: "string",
  nationId: "string",
  specId: "string",
  x: "number",
  y: "number",
  dir: "string",
  color: "string",
  speed: "number",
  hp: "number",
  maxHp: "number",
});

class WorldState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    this.worldW = 1600;
    this.worldH = 1200;
  }
}

defineTypes(WorldState, {
  players: { map: PlayerState },
  worldW: "number",
  worldH: "number",
});

module.exports = { PlayerState, WorldState };
