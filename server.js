require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const { admin, db, authEnabled } = require('./lib/firebase');
const createGameEngine = require('./lib/gameEngine');
const registerSocketHandlers = require('./lib/socketHandlers');
const registerRestRoutes = require('./lib/restRoutes');

// ---------- Express + Socket.io ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

// ---------- 組裝遊戲引擎 + 事件處理 + REST API ----------
// 這三個模組的內容都是從原本單一一大包的 server.js 拆出來的，邏輯完全沒有變動，
// 只是分別放到 lib/gameEngine.js、lib/socketHandlers.js、lib/restRoutes.js，
// 這裡負責把它們接起來（傳入 io / db / admin 這些共用資源）。
const engine = createGameEngine({ io, db, admin });
registerSocketHandlers({ io, db, admin, authEnabled, engine });
registerRestRoutes(app, { db, engine });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🐍 蛇蛇突擊伺服器已啟動：http://localhost:${PORT}`);
});
