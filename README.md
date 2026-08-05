# 🐍 蛇蛇突擊 - 貪吃蛇線上多人遊戲

可愛卡通風格的貪吃蛇，支援 **登入 / 註冊系統**、**Firebase 儲存使用者資料**、
**即時線上多人對戰**（房間代碼制）、**個人最高紀錄**與**全球排行榜**。

後端使用 **Express + Socket.io** 打造真正的 WebSocket 伺服器，所有移動、碰撞、
食物判定都由伺服器統一計算（防作弊），用戶端只負責送出方向輸入與畫面繪製。
登入使用 **Firebase Authentication**（Email / 密碼），使用者資料與最高分存在
**Firestore**，分數只能由伺服器（firebase-admin）寫入，玩家無法從瀏覽器端竄改。

## 專案結構

```
snake-online/
├── server.js              # 伺服器主程式（房間管理、遊戲迴圈、碰撞判定、Firebase 驗證與寫分）
├── package.json
├── firestore.rules        # Firestore 安全規則
├── .env.example            # 環境變數範例
├── public/
│   ├── index.html
│   ├── style.css
│   ├── firebase-config.js  # 前端 Firebase 設定（需自行填入你的專案資訊）
│   ├── auth.js              # 登入 / 註冊 / 訪客模式
│   ├── leaderboard.js       # 排行榜、個人最高紀錄
│   └── game.js               # Socket.io 連線、房間、畫面繪製、操控
└── README.md
```

## Step 1：建立 Firebase 專案

1. 到 [Firebase 主控台](https://console.firebase.google.com/) 建立一個新專案（免費方案即可）。
2. 左側選單「Build → Authentication」→「開始使用」→ 啟用 **電子郵件/密碼** 登入方式。
3. 左側選單「Build → Firestore Database」→「建立資料庫」，選擇正式模式或測試模式皆可
   （待會會用 `firestore.rules` 覆蓋規則）。
4. 左側選單「專案設定（齒輪圖示）→ 一般」，往下捲到「你的應用程式」，點選 **Web（</>）** 圖示，
   註冊一個網頁應用程式，會拿到一組 `firebaseConfig`。
   把這組設定值貼到 `public/firebase-config.js` 對應欄位。
5. 「專案設定 → 服務帳戶（Service Accounts）」→「產生新的私密金鑰」，
   下載 JSON 檔案，改名為 `serviceAccountKey.json`，放到專案根目錄
   （**這個檔案很機密，不要上傳到公開的 GitHub repo**，已經幫你加進 `.gitignore` 了）。
6. 部署 Firestore 安全規則：可以在 Firebase 主控台的 Firestore →「規則」分頁，
   把 `firestore.rules` 的內容貼上並發布；或安裝 Firebase CLI 後執行
   `firebase deploy --only firestore:rules`。

## Step 2：本機執行

需要先安裝 [Node.js](https://nodejs.org/)（建議 18 以上版本）。

```bash
# 1. 安裝依賴套件
npm install

# 2. 確認 serviceAccountKey.json 已放在專案根目錄（Step 1-5）
#    也確認 public/firebase-config.js 已經填好你的 Firebase 設定（Step 1-4）

# 3. 啟動伺服器
npm start
```

啟動後開啟瀏覽器前往 `http://localhost:3000`，先註冊/登入帳號，
就能建立房間並把 4 碼房間代碼分享給朋友一起玩了。
（同一台電腦測試多人模式，可以開兩個瀏覽器分頁，或一般視窗+無痕視窗，各自登入不同帳號模擬兩位玩家。）

> 如果沒有設定 Firebase 金鑰，伺服器仍然會啟動，但登入 / 排行榜功能會顯示為未啟用，
> 遊戲本身（訪客模式）仍然可以正常連線測試多人對戰邏輯。

## 遊戲玩法

- **登入**：Email + 密碼註冊/登入，或用「訪客身分」直接試玩（訪客分數不會被記錄）。
- **建立房間**：取得 4 碼房間代碼，分享給朋友，於「加入房間」輸入即可，。
- **準備 / 開始**：所有人按下「準備好了」後，房主即可按下「開始遊戲」，倒數 3 秒後開局。
- **移動**：電腦把滑鼠移到想前進的方向，蛇會平滑地轉向那裡；手機用手指按住畫面拖動方向即可（跟 slither.io 類似手感，不是格子跳動）。
- **一般食物**（紅色）：+10 分，吃到會變長一節。
- **超級食物**（金色星星）：+30 分，限時出現，消失後會重新隨機生成。
- **加速道具**（藍色閃電）：吃到後 5 秒內移動速度變為 2 倍。
- **死亡條件**：撞牆、撞到自己的身體，或撞到其他玩家的蛇身都會死亡。
- **回合結束**：只剩最後一條蛇存活，或時間到（3 分鐘）即結束本局，
  已登入玩家的最高分會自動更新到 Firestore，並可在「全球排行榜」查看前 20 名。

## 部署到網路上分享給別人玩

⚠️ **重要提醒**：這個專案使用 WebSocket 做即時連線，伺服器需要「常駐執行」。
**Vercel 這類無伺服器（Serverless）平台不支援長駐 WebSocket 連線**，不適合部署本專案後端。
建議使用 **Render**、Railway 或 Fly.io 這類支援常駐 Node.js 程序的平台。

### 使用 Render 部署（推薦，有免費方案）

1. 將這個專案上傳到 GitHub（`serviceAccountKey.json` 不要一併上傳，`.gitignore` 已排除）。
2. 前往 [render.com](https://render.com) 註冊並登入，點選「New +」→「Web Service」，
   選擇你剛剛上傳的 GitHub repository。
3. 設定：
   - **Build Command**：`npm install`
   - **Start Command**：`npm start`
   - **Instance Type**：Free 方案即可（僅供測試玩樂用）
4. 在「Environment」分頁新增環境變數 `FIREBASE_SERVICE_ACCOUNT`，
   把整個 `serviceAccountKey.json` 的內容（完整 JSON）貼進去，
   這樣就不需要把金鑰檔案放進程式碼裡。
5. 點選「Create Web Service」，等待部署完成後會拿到一個網址，
   把它分享給朋友就能一起玩了！

> Render 免費方案在閒置一段時間後會休眠，重新連線時第一次載入可能會慢個十幾秒，正常現象。

### 其他選擇

- **Railway**（railway.app）：流程類似 Render，也支援常駐 Node.js。
- **Fly.io**：適合想要更低延遲、更靠近玩家所在地區的部署。

## 安全性設計重點

- 所有遊戲邏輯（移動、碰撞、吃食物、計分）都在伺服器端計算，用戶端只送方向輸入，
  防止用戶端竄改分數或穿牆作弊。
- 玩家登入時，Socket.io 連線會用 `firebase-admin` 驗證 `idToken`，確認身分後才綁定 `uid`。
- `highScore` / `gamesPlayed` 只能由伺服器的 `firebase-admin`（擁有完整權限，繞過 Firestore 規則）寫入，
  `firestore.rules` 明確禁止用戶端直接修改這兩個欄位，避免有人打開瀏覽器 Console 竄改自己的分數。

## 可以繼續調整的方向

- 調整 `server.js` 內的 `BASE_TICK_MS`（移動速度）、`ROUND_TIME_MS`（單局時間）等常數。
- 在 `public/game.js` 的繪製函式中新增動畫效果，例如蛇吐舌頭、死亡爆炸特效。
- 新增地圖障礙物、無敵道具、縮短對手蛇身等更多機制。
- 加上 Google 登入（`firebase.auth.GoogleAuthProvider`），減少註冊門檻。
- 加上好友對戰紀錄、每週排行榜（依 `lastPlayedAt` 篩選時間區間）等進階排行榜功能。

不一定要照這個資料夾結構，歡迎依需求調整！
