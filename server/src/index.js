const http = require("http");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { Server } = require("colyseus");
const { WebSocketTransport } = require("@colyseus/ws-transport");
const { WorldRoom } = require("./rooms/WorldRoom");

const PORT = Number(process.env.PORT) || 2567;
const clientDir = path.join(__dirname, "../../client");

const app = express();
app.use(cors());
app.use(express.json());

// health / smoke
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    name: "Fractured Vale",
    phase: 4,
    features: ["gather", "barracks", "combat", "loot", "villager-ai", "building-persist"],
  });
});

app.use(express.static(clientDir));

// SPA fallback for deep links
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/colyseus")) return next();
  res.sendFile(path.join(clientDir, "index.html"));
});

const server = http.createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server }),
});

gameServer.define("world", WorldRoom);

gameServer.listen(PORT).then(() => {
  console.log(`《星隕之境 Fractured Vale》Phase 4`);
  console.log(`http://localhost:${PORT}`);
  console.log(`Serving client from ${clientDir}`);
}).catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
