# 星隕之境 Fractured Vale

低奇幻中世紀策略 MMO（SLG × 動作混合，AOC 風味），**手機瀏覽器優先**，反課金設計，$0 成本。

目前版本：**Phase 4** — 採集／庫存／兵營／跟隨 + **戰鬥、掉落物、村民採集 AI、兵營持久化**。

---

## 點樣跑（極簡）

喺專案根目錄（有 `package.json` 嗰層）：

```bash
npm install
npm start
```

然後用瀏覽器開：`http://localhost:2567`

- iPhone / Replit：用 https 網址即可，client 會自動用 `wss://`
- **唔使 build**，靜態 HTML/JS + CDN

### 操作

| 操作 | 說明 |
|------|------|
| 創角 | 揀國家（18）+ 專精兵種（7）+ 名稱 |
| 移動 | 左下虛擬搖桿，或鍵盤 WASD / 方向鍵 |
| 平移鏡頭 | 單指／滑鼠拖曳空白地圖（會暫停跟隨） |
| 返自己 | 右上「返自己」掣：鏡頭回角色並恢復跟隨 |
| 變焦 | 雙指捏合，或滑鼠滾輪／+/-（0.3x–2x） |
| 採集 | 走近木／食／石節點自動採集 |
| 兵營 | B 或「兵營」按鈕建造（耗木石；**存入 SQLite**） |
| 訓練 | 走近兵營：T 民兵／V 村民（耗食物） |
| 攻擊 | 按住「攻擊」或 A／空白鍵：打附近敵方單位／玩家（輕 PvP） |
| 掉落 | 單位死亡掉資源／裝備；走近自動拾取 |
| 村民 AI | 村民自動採集並交回主人；民兵閒置近節點也會輕採 |
| 聊天 | 右下角輸入框 |

資料驅動：改 `client/data/*.json`（含 `loot.json`）即可調數值。

---

## Run (English)

```bash
npm install && npm start
# open http://localhost:2567
```

Stack: Node.js + Colyseus + SQLite (`better-sqlite3`) server; Phaser 3.80 + colyseus.js via CDN (no client bundler).

Optional deploy stubs: `Dockerfile`, `render.yaml` (do not change local `npm start`).

Health: `GET /api/health` → `{ phase: 4, features: [...] }`.

---

## 目錄結構

```
app/
  package.json
  server/src/index.js          # Express + Colyseus
  server/src/rooms/WorldRoom.js
  server/src/db.js             # SQLite players + buildings
  client/index.html
  client/js/scenes/*.js
  client/data/nations.json     # 18 nations
  client/data/units.json       # 7 unit types (+ combat/gather)
  client/data/resources.json   # resource nodes
  client/data/buildings.json   # barracks / train
  client/data/loot.json        # death drops + items
```

## 授權與方針

私人專案。無內購、無抽卡。概念隨時會改 → 保持數據驅動。
