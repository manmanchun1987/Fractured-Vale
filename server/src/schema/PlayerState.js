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
    this.meat = 0;
    this.stone = 0;
    this.gold = 0;
    this.pop = 0; // live unit count (followers + garrisoned)
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
  meat: "number",
  stone: "number",
  gold: "number",
  pop: "number",
});

class ResourceNodeState extends Schema {
  constructor() {
    super();
    this.id = "";
    this.type = "wood"; // wood|meat|stone|gold
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

class CastleState extends Schema {
  constructor() {
    super();
    this.id = "";
    this.ownerId = "";
    this.ownerSessionId = "";
    this.x = 0;
    this.y = 0;
    this.targetX = 0;
    this.targetY = 0;
    this.moving = false;
    this.followOwner = false;
    this.garrison = 0; // count of units inside
    this.color = "#4A3728";
  }
}

defineTypes(CastleState, {
  id: "string",
  ownerId: "string",
  ownerSessionId: "string",
  x: "number",
  y: "number",
  targetX: "number",
  targetY: "number",
  moving: "boolean",
  followOwner: "boolean",
  garrison: "number",
  color: "string",
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
    this.carryMeat = 0;
    this.carryStone = 0;
    this.carryGold = 0;
    this.ai = "follow";
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
  carryMeat: "number",
  carryStone: "number",
  carryGold: "number",
  ai: "string",
});

class LootState extends Schema {
  constructor() {
    super();
    this.id = "";
    this.x = 0;
    this.y = 0;
    this.kind = "meat"; // wood|meat|stone|gold|item
    this.amount = 1;
    this.itemId = "";
    this.label = "";
    this.color = "#C45C26";
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
    this.castles = new MapSchema();
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
  castles: { map: CastleState },
  followers: { map: FollowerState },
  loot: { map: LootState },
  worldW: "number",
  worldH: "number",
});

module.exports = {
  PlayerState,
  ResourceNodeState,
  BuildingState,
  CastleState,
  FollowerState,
  LootState,
  WorldState,
};
