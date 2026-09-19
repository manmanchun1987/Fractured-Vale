# 星隕之境 Fractured Vale

低奇幻中世紀策略 MMO（SLG × 動作混合，AOC 風味），**手機瀏覽器優先**，反課金設計，$0 成本。

目前版本：**Phase 3 MVP** — Phase 2 基礎 + 資源採集、簡易庫存、兵營訓練、士兵跟隨。

> 掉落物／戰鬥擊敗獎勵仍為後續工作；Loot 尚未實作。

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
| 兵營 | B 或「兵營」按鈕建造（耗木石） |
| 訓練 | 走近兵營後 T 或「訓練」按鈕（耗食物） |
| 聊天 | 左下角輸入框 |

資料驅動：改 `client/data/nations.json`、`units.json`、`resources.json`、`buildings.json` 即可調數值。

---

## Run (English)

```bash
npm install && npm start
# open http://localhost:2567
```

Stack: Node.js + Colyseus + SQLite (`better-sqlite3`) server; Phaser 3.80 + colyseus.js via CDN (no client bundler).

Optional deploy stubs: `Dockerfile`, `render.yaml` (do not change local `npm start`).

---

## 目錄結構

```
app/
  package.json
  server/src/index.js          # Express + Colyseus
  server/src/rooms/WorldRoom.js
  server/src/db.js             # SQLite player save
  client/index.html
  client/js/scenes/*.js
  client/data/nations.json     # 18 nations
  client/data/units.json       # 7 unit types
  client/data/resources.json   # Phase 3 nodes
  client/data/buildings.json   # barracks / train
```

## 授權與方針

私人專案。無內購、無抽卡。概念隨時會改 → 保持數據驅動。
