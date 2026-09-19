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
    this.dir = "down";
    this.color = "#4169E1";
    this.speed = 100;
    this.hp = 55;
    this.maxHp = 55;
    this.atk = 8;
    this.atkBonus = 0;
    this.wood = 0;
    this.food = 0;
    this.stone = 0;
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
  atk: "number",
  atkBonus: "number",
  wood: "number",
  food: "number",
  stone: "number",
});

class ResourceNodeState extends Schema {
  constructor() {
    super();
    this.id = "";
    this.type = "wood";
    this.x = 0;
    this.y = 0;
    this.amount = 100;
  }
}

defineTypes(ResourceNodeState, {
  id: "string",
  type: "string",
  x: "number",
  y: "number",
  amount: "number",
});

class BuildingState extends Schema {
  constructor() {
    super();
    this.id = "";
    this.ownerId = "";
    this.ownerSessionId = "";
    this.type = "barracks";
    this.x = 0;
    this.y = 0;
    this.queueMs = 0;
    this.queueUnit = "";
  }
}

defineTypes(BuildingState, {
  id: "string",
  ownerId: "string",
  ownerSessionId: "string",
  type: "string",
  x: "number",
  y: "number",
  queueMs: "number",
  queueUnit: "string",
});

class FollowerState extends Schema {
  constructor() {
    super();
    this.id = "";
    this.ownerSessionId = "";
    this.specId = "militia";
    this.x = 0;
    this.y = 0;
    this.dir = "down";
    this.color = "#8B7355";
    this.speed = 95;
    this.hp = 55;
    this.maxHp = 55;
    this.atk = 8;
    this.carryWood = 0;
    this.carryFood = 0;
    this.carryStone = 0;
    this.ai = "follow"; // follow | gather | deposit | combat
  }
}

defineTypes(FollowerState, {
  id: "string",
  ownerSessionId: "string",
  specId: "string",
  x: "number",
  y: "number",
  dir: "string",
  color: "string",
  speed: "number",
  hp: "number",
  maxHp: "number",
  atk: "number",
  carryWood: "number",
  carryFood: "number",
  carryStone: "number",
  ai: "string",
});

class LootState extends Schema {
  constructor() {
    super();
    this.id = "";
    this.x = 0;
    this.y = 0;
    this.kind = "food"; // wood|food|stone|item
    this.amount = 1;
    this.itemId = "";
    this.label = "";
    this.color = "#DAA520";
    this.spawnAt = 0;
  }
}

defineTypes(LootState, {
  id: "string",
  x: "number",
  y: "number",
  kind: "string",
  amount: "number",
  itemId: "string",
  label: "string",
  color: "string",
  spawnAt: "number",
});

class WorldState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    this.resources = new MapSchema();
    this.buildings = new MapSchema();
    this.followers = new MapSchema();
    this.loot = new MapSchema();
    this.worldW = 1600;
    this.worldH = 1200;
  }
}

defineTypes(WorldState, {
  players: { map: PlayerState },
  resources: { map: ResourceNodeState },
  buildings: { map: BuildingState },
  followers: { map: FollowerState },
  loot: { map: LootState },
  worldW: "number",
  worldH: "number",
});

module.exports = {
  PlayerState,
  ResourceNodeState,
  BuildingState,
  FollowerState,
  LootState,
  WorldState,
};
