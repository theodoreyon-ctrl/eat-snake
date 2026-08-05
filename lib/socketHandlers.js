// ---------- Socket.io 事件處理 ----------
// 內容從原本 server.js 搬過來，邏輯完全沒有變動，只是包成一個註冊函式。
module.exports = function registerSocketHandlers({ io, db, admin, authEnabled, engine }) {
const {
  rooms, createRoom, startCountdown, removePlayerFromRoom,
  attemptReconnect, broadcastRoom, fireBullet, getWeekId, chooseMobaElement, useMobaBoost, attemptMobaAttack,
} = engine;
const {
  RECONNECT_GRACE_MS, REPORT_THRESHOLD, RESTRICTION_DURATION_MS, MOBA_TEAM_SIZE,
  MAX_PLAYERS, BASE_LENGTH, COLORS, SKIN_CATALOG, QUIZ_PASS_RATIO, POWERUP_CATALOG,
} = require('./config');
const { QUIZ_BANK } = require('./quizBank');

const uidSockets = new Map(); // uid -> 目前正在使用這個帳號的 socket.id（同一時間只允許一個）
const activeQuizzes = new Map(); // socket.id -> { powerupId, questions:[{q,options,answer}] }（正確答案只存在這裡，不會送到前端）
const earnedPowerups = new Map(); // sessionId -> powerupId陣列（背包，答對之後拿到、還沒在遊戲裡用掉的道具，可以疊加多個）
const activeDailyQuiz = new Map(); // socket.id -> { question:{q,options,answer} }（每日簽到題正在作答中的暫存）
const DAILY_CHECKIN_COINS = 15; // 每日簽到答對可以拿到的金幣
const DAILY_STREAK_MILESTONE_BONUS = 50; // 連續簽到每滿7天的額外獎勵
const QUIZ_COIN_PER_CORRECT = 2; // 解題加強：不管有沒有通過，答對一題就給的金幣(鼓勵作答意願)

function todayDateString() {
  // 用UTC+8(台灣時間)為準判斷「今天」，避免用伺服器所在時區算錯
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}
function yesterdayDateString() {
  const y = new Date(Date.now() + 8 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000);
  return y.toISOString().slice(0, 10);
}

// 累加答對率統計，訪客(沒有uid)不會被記錄，這是設計上就跟其他戰績欄位一致的行為
async function recordQuizStats(uid, correct, total) {
  if (!db || !uid) return { coinsEarned: 0, coins: null };
  const coinsEarned = correct * QUIZ_COIN_PER_CORRECT;
  try {
    const ref = db.collection('users').doc(uid);
    const newCoins = await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      const data = doc.exists ? doc.data() : {};
      const updatedCoins = (data.coins || 0) + coinsEarned;
      tx.set(ref, {
        quizCorrect: (data.quizCorrect || 0) + correct,
        quizTotal: (data.quizTotal || 0) + total,
        coins: updatedCoins,
      }, { merge: true });
      return updatedCoins;
    });
    return { coinsEarned, coins: newCoins };
  } catch (e) {
    console.error('寫入答對率統計/金幣失敗:', e.message);
    return { coinsEarned: 0, coins: null };
  }
}

io.on('connection', (socket) => {
  socket.data.uid = null;
  socket.data.name = `訪客${socket.id.slice(0, 4)}`;
  socket.data.sessionId = null;
  socket.data.equippedSkin = 'classic';

  socket.on('identify', ({ sessionId } = {}) => {
    if (typeof sessionId !== 'string' || !sessionId) return;
    socket.data.sessionId = sessionId;
    attemptReconnect(socket);
  });

  socket.on('auth', async ({ idToken } = {}) => {
    if (!authEnabled || !idToken) return;
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);

      // 同一個帳號同時間只能有一個裝置在連線，新裝置登入就把舊的踢下線
      const existingSocketId = uidSockets.get(decoded.uid);
      if (existingSocketId && existingSocketId !== socket.id) {
        const oldSocket = io.sockets.sockets.get(existingSocketId);
        if (oldSocket) {
          oldSocket.emit('force_logout', { message: '你的帳號在其他裝置登入了，這個連線已被登出' });
          oldSocket.disconnect(true);
        }
      }
      uidSockets.set(decoded.uid, socket.id);

      socket.data.uid = decoded.uid;
      let name = decoded.name || socket.data.name;
      let coins = 0, ownedSkins = ['classic'], equippedSkin = 'classic';
      let blockedUids = [];
      socket.data.restrictedUntil = 0;
      if (db) {
        const doc = await db.collection('users').doc(decoded.uid).get();
        if (doc.exists) {
          const data = doc.data();
          const storedNameLooksBroken = data.displayName && /^訪客/.test(data.displayName);
          if (data.displayName && !storedNameLooksBroken) {
            name = data.displayName;
          } else if (storedNameLooksBroken) {
            // Firestore 裡存的名字本身就壞掉了（過去的 bug 留下的），自動修正回去，不用手動去主控台改
            db.collection('users').doc(decoded.uid).set({ displayName: name }, { merge: true }).catch(() => {});
          }
          coins = data.coins || 0;
          ownedSkins = data.ownedSkins || ['classic'];
          equippedSkin = data.equippedSkin || 'classic';
          blockedUids = data.blockedUids || [];
          socket.data.restrictedUntil = data.restrictedUntil || 0;
        }
      }
      socket.data.name = name;
      socket.data.equippedSkin = equippedSkin;
      socket.data.blockedUids = blockedUids;
      socket.emit('auth_ok', { uid: decoded.uid, name, coins, ownedSkins, equippedSkin });

      // 如果驗證身分完成前玩家就已經先建立/加入房間了（名字當時還是暫時的訪客佔位名），
      // 這裡要把房間內凍結住的名字即時修正回來，不然回合結束寫分數時會把錯的名字存進 Firestore。
      const currentRoom = rooms.get(socket.data.roomCode);
      if (currentRoom && currentRoom.players.has(socket.id)) {
        const p = currentRoom.players.get(socket.id);
        p.uid = decoded.uid;
        p.name = name;
        broadcastRoom(currentRoom);
      }
    } catch (e) {
      socket.emit('auth_error', { message: '登入驗證失敗，請重新登入' });
    }
  });

  socket.on('set_name', (name) => {
    if (typeof name === 'string' && name.trim()) {
      socket.data.name = name.trim().slice(0, 16);
    }
  });

  socket.on('create_room', ({ mode } = {}) => {
    if (socket.data.restrictedUntil && Date.now() < socket.data.restrictedUntil) {
      const mins = Math.ceil((socket.data.restrictedUntil - Date.now()) / 60000);
      return socket.emit('join_error', { message: `你因為被多次檢舉，暫時無法建立房間（約 ${mins} 分鐘後解除）` });
    }
    const room = createRoom(socket.id, mode);
    joinRoomInternal(room, socket);
    socket.emit('room_created', { code: room.code, mode: room.mode });
  });

  socket.on('join_room', ({ code } = {}) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return socket.emit('join_error', { message: '找不到這個房間代碼' });
    const capacity = room.mode === 'moba' ? MOBA_TEAM_SIZE * 2 : MAX_PLAYERS - room.botCount;
    if (room.players.size >= capacity) return socket.emit('join_error', { message: '房間已滿' });
    if (room.status === 'playing' || room.status === 'countdown') {
      return socket.emit('join_error', { message: '這局遊戲進行中，請稍後再加入' });
    }
    // 封鎖名單檢查：不管是「我封鎖過房間裡的人」還是「房間裡有人封鎖過我」，都不能加入同一房間
    if (socket.data.uid) {
      const myBlocked = new Set(socket.data.blockedUids || []);
      for (const p of room.players.values()) {
        if (!p.uid) continue;
        if (myBlocked.has(p.uid) || (p.blockedUids || []).includes(socket.data.uid)) {
          return socket.emit('join_error', { message: '無法加入這個房間' });
        }
      }
    }
    joinRoomInternal(room, socket);
  });

  function joinRoomInternal(room, sock) {
    // 防呆：同一個帳號（uid）理論上不可能同時在同一個房間有兩筆紀錄，
    // 如果偵測到殘留的舊連線（例如網路短暫斷線又重連留下的），先清掉再加入，避免結算時被算兩次。
    if (sock.data.uid) {
      for (const [oldId, p] of room.players.entries()) {
        if (oldId !== sock.id && p.uid === sock.data.uid) {
          if (p.reconnectTimer) clearTimeout(p.reconnectTimer);
          room.players.delete(oldId);
        }
      }
    }
    sock.join(room.code);
    const color = COLORS[room.players.size % COLORS.length];
    room.players.set(sock.id, {
      id: sock.id,
      uid: sock.data.uid,
      name: sock.data.name,
      sessionId: sock.data.sessionId || null,
      team: null, lane: null,
      blockedUids: sock.data.blockedUids || [],
      skin: sock.data.equippedSkin || 'classic',
      color,
      ready: false,
      x: 0, y: 0, angle: 0, targetAngle: 0,
      points: [], length: BASE_LENGTH,
      alive: false,
      score: 0,
      kills: 0,
      respawnAt: null,
      boostUntil: 0,
      manualBoost: false,
      boostDrainCounter: 0,
      invincibleUntil: 0,
      disconnected: false,
      reconnectTimer: null,
    });
    sock.data.roomCode = room.code;
    broadcastRoom(room);
  }

  // ---------- 隱藏測試功能：一個人也能測MOBA，補5個站著不動的假人湊滿3v3 ----------
  // MOBA目前還沒有做AI(這是已知的待辦事項)，所以這裡的假人只是站在出生點不動，
  // 純粹讓房主可以自己測試移動/攻擊/地形，不是正式的電腦對手。
  socket.on('test_solo_moba', () => {
    const room = createRoom(socket.id, 'moba');
    joinRoomInternal(room, socket);
    const human = room.players.get(socket.id);
    human.team = 'A';
    human.lane = 'top';
    human.ready = true;

    const dummyTeams = [['A', 'mid'], ['A', 'bottom'], ['B', 'top'], ['B', 'mid'], ['B', 'bottom']];
    dummyTeams.forEach(([team, lane], i) => {
      const dummyId = `test_dummy_${room.code}_${i}`;
      room.players.set(dummyId, {
        id: dummyId, uid: null, name: `測試假人${i + 1}`, sessionId: null,
        team, lane, blockedUids: [], skin: 'classic',
        color: COLORS[(i + 1) % COLORS.length],
        ready: true,
        x: 0, y: 0, angle: 0, targetAngle: 0,
        points: [], length: BASE_LENGTH,
        alive: false, score: 0, kills: 0, respawnAt: null,
        boostUntil: 0, manualBoost: false, boostDrainCounter: 0,
        invincibleUntil: 0, disconnected: false, reconnectTimer: null,
      });
    });
    socket.emit('room_created', { code: room.code, mode: room.mode });
    startCountdown(room);
  });

  socket.on('toggle_ready', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.players.has(socket.id)) return;
    const p = room.players.get(socket.id);
    if (room.mode === 'moba' && !p.team) {
      return socket.emit('join_error', { message: '要先選好隊伍才能準備' });
    }
    p.ready = !p.ready;
    broadcastRoom(room);
  });

  socket.on('start_game', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;
    if (room.mode === 'moba') {
      const teamACount = Array.from(room.players.values()).filter(p => p.team === 'A').length;
      const teamBCount = Array.from(room.players.values()).filter(p => p.team === 'B').length;
      if (teamACount !== MOBA_TEAM_SIZE || teamBCount !== MOBA_TEAM_SIZE) {
        return socket.emit('join_error', { message: `MOBA 模式需要兩隊都滿 ${MOBA_TEAM_SIZE} 人才能開始（目前 A隊 ${teamACount} 人、B隊 ${teamBCount} 人）` });
      }
    }
    startCountdown(room);
  });

  // MOBA 模式：選隊伍（房主跟一般玩家都用這個），會自動依加入順序分配路線（上/中/下路）
  socket.on('select_team', ({ team } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.mode !== 'moba' || room.status !== 'lobby') return;
    if (team !== 'A' && team !== 'B') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    const teamCount = Array.from(room.players.values()).filter(x => x.team === team && x.id !== socket.id).length;
    if (teamCount >= MOBA_TEAM_SIZE) {
      return socket.emit('join_error', { message: '這隊已經滿了' });
    }
    p.team = team;
    p.lane = ['top', 'mid', 'bottom'][teamCount];
    p.ready = false; // 換隊要重新準備
    broadcastRoom(room);
  });

  // MOBA 模式：升級時選一個元素（永久生效的被動加成）
  socket.on('choose_element', ({ element } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.mode !== 'moba' || room.status !== 'playing') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    const ok = chooseMobaElement(p, element);
    if (ok) socket.emit('moba_element_chosen', { element, elementHistory: p.elementHistory });
  });

  // MOBA 模式：按下攻擊鍵時呼叫，不是自動開火
  socket.on('moba_attack', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.mode !== 'moba' || room.status !== 'playing') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    attemptMobaAttack(p, room);
  });

  // MOBA 模式：切換自動鎖定的優先權（推塔 / 殺人），Phase 3 還沒有塔，先把開關做好
  socket.on('set_attack_priority', ({ priority } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.mode !== 'moba') return;
    if (priority !== 'kill' && priority !== 'tower') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.attackPriority = priority;
  });

  // MOBA 模式：按下加速鍵（6級之前是基礎衝刺，6級之後依主導元素變成對應大招）
  socket.on('moba_use_boost', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.mode !== 'moba' || room.status !== 'playing') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    useMobaBoost(p);
  });

  socket.on('set_bot_count', (value) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;
    if (room.mode === 'moba') return; // MOBA 模式 Phase 1 還不支援電腦蛇
    const requested = Math.max(0, Math.min(MAX_PLAYERS - 1, Math.floor(Number(value) || 0)));
    room.botCount = Math.min(requested, Math.max(0, MAX_PLAYERS - room.players.size));
    broadcastRoom(room);
  });

  socket.on('set_bot_difficulty', (value) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;
    if (!['easy', 'normal', 'hard'].includes(value)) return;
    room.botDifficulty = value;
    broadcastRoom(room);
  });

  socket.on('set_angle', (angle) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing') return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    if (typeof angle !== 'number' || Number.isNaN(angle)) return;
    p.targetAngle = angle;
  });

  socket.on('set_boost', (value) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing') return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    p.manualBoost = !!value;
  });

  // MOBA模式專用：是否在移動(桌面點左鍵切換、手機放開搖桿就停)，停下來才躲得進草叢
  socket.on('set_moving', (value) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.mode !== 'moba' || room.status !== 'playing') return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    p.moving = !!value;
  });

  socket.on('shoot', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing') return;
    const p = room.players.get(socket.id);
    fireBullet(p, room);
  });

  socket.on('buy_skin', async (skinId) => {
    if (!db || !socket.data.uid) return socket.emit('shop_error', { message: '要先登入帳號才能使用商店' });
    const item = SKIN_CATALOG[skinId];
    if (!item || skinId === 'classic') return socket.emit('shop_error', { message: '找不到這個造型' });
    const ref = db.collection('users').doc(socket.data.uid);
    try {
      const result = await db.runTransaction(async (tx) => {
        const doc = await tx.get(ref);
        const data = doc.exists ? doc.data() : {};
        const coins = data.coins || 0;
        const owned = data.ownedSkins || ['classic'];
        if (owned.includes(skinId)) throw new Error('ALREADY_OWNED');
        if (coins < item.price) throw new Error('NOT_ENOUGH_COINS');
        const newCoins = coins - item.price;
        const newOwned = [...owned, skinId];
        tx.set(ref, { coins: newCoins, ownedSkins: newOwned }, { merge: true });
        return { coins: newCoins, ownedSkins: newOwned };
      });
      socket.emit('shop_update', result);
    } catch (e) {
      const msg = e.message === 'ALREADY_OWNED' ? '你已經有這個造型了'
        : e.message === 'NOT_ENOUGH_COINS' ? '金幣不夠'
        : '購買失敗，請稍後再試';
      socket.emit('shop_error', { message: msg });
    }
  });

  socket.on('equip_skin', async (skinId) => {
    if (!SKIN_CATALOG[skinId]) return socket.emit('shop_error', { message: '找不到這個造型' });
    if (skinId === 'classic') {
      socket.data.equippedSkin = 'classic';
      if (db && socket.data.uid) {
        db.collection('users').doc(socket.data.uid).set({ equippedSkin: 'classic' }, { merge: true }).catch(() => {});
      }
      return socket.emit('shop_update', { equippedSkin: 'classic' });
    }
    if (!db || !socket.data.uid) return socket.emit('shop_error', { message: '要先登入帳號才能更換造型' });
    try {
      const ref = db.collection('users').doc(socket.data.uid);
      const doc = await ref.get();
      const owned = doc.exists ? (doc.data().ownedSkins || ['classic']) : ['classic'];
      if (!owned.includes(skinId)) return socket.emit('shop_error', { message: '你還沒有買這個造型' });
      socket.data.equippedSkin = skinId;
      await ref.set({ equippedSkin: skinId }, { merge: true });
      socket.emit('shop_update', { equippedSkin: skinId });
    } catch (e) {
      socket.emit('shop_error', { message: '更換造型失敗，請稍後再試' });
    }
  });

  // ---------- 檢舉 ----------
  socket.on('report_player', async ({ targetUid, targetName, reason } = {}) => {
    if (!db || !socket.data.uid) return socket.emit('social_error', { message: '要先登入帳號才能檢舉' });
    if (!targetUid || targetUid === socket.data.uid) return;
    try {
      await db.collection('reports').add({
        reporterUid: socket.data.uid,
        reporterName: socket.data.name,
        targetUid,
        targetName: targetName || '',
        reason: (reason || '').slice(0, 200),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      const ref = db.collection('users').doc(targetUid);
      await db.runTransaction(async (tx) => {
        const doc = await tx.get(ref);
        const data = doc.exists ? doc.data() : {};
        const newCount = (data.reportCount || 0) + 1;
        const update = { reportCount: newCount };
        if (newCount >= REPORT_THRESHOLD) {
          update.restrictedUntil = Date.now() + RESTRICTION_DURATION_MS;
        }
        tx.set(ref, update, { merge: true });
      });
      socket.emit('social_ok', { message: '已送出檢舉，謝謝你協助維護遊戲環境' });
    } catch (e) {
      socket.emit('social_error', { message: '檢舉失敗，請稍後再試' });
    }
  });

  // ---------- 封鎖 ----------
  socket.on('block_player', async ({ targetUid, targetName } = {}) => {
    if (!db || !socket.data.uid) return socket.emit('social_error', { message: '要先登入帳號才能封鎖玩家' });
    if (!targetUid || targetUid === socket.data.uid) return;
    try {
      const ref = db.collection('users').doc(socket.data.uid);
      await ref.set({
        blockedUids: admin.firestore.FieldValue.arrayUnion(targetUid),
        [`blockedNames.${targetUid}`]: targetName || '玩家',
      }, { merge: true });
      socket.data.blockedUids = socket.data.blockedUids || [];
      if (!socket.data.blockedUids.includes(targetUid)) socket.data.blockedUids.push(targetUid);
      const room = rooms.get(socket.data.roomCode);
      if (room && room.players.has(socket.id)) room.players.get(socket.id).blockedUids = socket.data.blockedUids;
      socket.emit('social_ok', { message: `已封鎖 ${targetName || '這位玩家'}，之後不會被分到同一個房間` });
    } catch (e) {
      socket.emit('social_error', { message: '封鎖失敗，請稍後再試' });
    }
  });

  socket.on('unblock_player', async ({ targetUid } = {}) => {
    if (!db || !socket.data.uid || !targetUid) return;
    try {
      await db.collection('users').doc(socket.data.uid).set({
        blockedUids: admin.firestore.FieldValue.arrayRemove(targetUid),
      }, { merge: true });
      socket.data.blockedUids = (socket.data.blockedUids || []).filter((u) => u !== targetUid);
      socket.emit('social_ok', { message: '已解除封鎖' });
    } catch (e) {
      socket.emit('social_error', { message: '操作失敗，請稍後再試' });
    }
  });

  socket.on('get_blocked_list', async () => {
    if (!db || !socket.data.uid) return socket.emit('blocked_list', { blocked: [] });
    try {
      const doc = await db.collection('users').doc(socket.data.uid).get();
      const data = doc.exists ? doc.data() : {};
      const ids = data.blockedUids || [];
      const names = data.blockedNames || {};
      socket.emit('blocked_list', { blocked: ids.map((uid) => ({ uid, name: names[uid] || '未知玩家' })) });
    } catch (e) {
      socket.emit('blocked_list', { blocked: [] });
    }
  });

  // ---------- 好友 ----------
  socket.on('search_users', async (query) => {
    if (!db || !socket.data.uid) return socket.emit('user_search_results', { results: [] });
    const q = (query || '').trim().slice(0, 30);
    if (!q) return socket.emit('user_search_results', { results: [] });
    try {
      const snap = await db.collection('users')
        .where('displayName', '>=', q)
        .where('displayName', '<=', q + '\uf8ff')
        .limit(10)
        .get();
      const results = snap.docs
        .map((d) => ({ uid: d.id, name: d.data().displayName || '玩家' }))
        .filter((r) => r.uid !== socket.data.uid);
      socket.emit('user_search_results', { results });
    } catch (e) {
      socket.emit('user_search_results', { results: [] });
    }
  });

  socket.on('send_friend_request', async ({ targetUid, targetName } = {}) => {
    if (!db || !socket.data.uid) return socket.emit('social_error', { message: '要先登入帳號才能加好友' });
    if (!targetUid || targetUid === socket.data.uid) return;
    try {
      const myDoc = await db.collection('users').doc(socket.data.uid).get();
      const myFriends = (myDoc.exists && myDoc.data().friends) || [];
      if (myFriends.includes(targetUid)) return socket.emit('social_error', { message: '你們已經是好友了' });
      await db.collection('users').doc(targetUid).set({
        incomingRequests: admin.firestore.FieldValue.arrayUnion({ uid: socket.data.uid, name: socket.data.name }),
      }, { merge: true });
      socket.emit('social_ok', { message: `已送出好友邀請給 ${targetName || '對方'}` });
    } catch (e) {
      socket.emit('social_error', { message: '送出邀請失敗，請稍後再試' });
    }
  });

  socket.on('respond_friend_request', async ({ fromUid, fromName, accept } = {}) => {
    if (!db || !socket.data.uid || !fromUid) return;
    try {
      const myRef = db.collection('users').doc(socket.data.uid);
      const myDoc = await myRef.get();
      const incoming = (myDoc.exists && myDoc.data().incomingRequests) || [];
      const match = incoming.find((r) => r.uid === fromUid);
      const newIncoming = incoming.filter((r) => r.uid !== fromUid);
      const updates = { incomingRequests: newIncoming };
      if (accept) {
        updates.friends = admin.firestore.FieldValue.arrayUnion(fromUid);
        updates[`friendNames.${fromUid}`] = (match && match.name) || fromName || '玩家';
      }
      await myRef.set(updates, { merge: true });
      if (accept) {
        await db.collection('users').doc(fromUid).set({
          friends: admin.firestore.FieldValue.arrayUnion(socket.data.uid),
          [`friendNames.${socket.data.uid}`]: socket.data.name,
        }, { merge: true });
      }
      socket.emit('social_ok', { message: accept ? '已成為好友！' : '已拒絕邀請' });
    } catch (e) {
      socket.emit('social_error', { message: '操作失敗，請稍後再試' });
    }
  });

  socket.on('remove_friend', async ({ targetUid } = {}) => {
    if (!db || !socket.data.uid || !targetUid) return;
    try {
      await db.collection('users').doc(socket.data.uid).set({
        friends: admin.firestore.FieldValue.arrayRemove(targetUid),
      }, { merge: true });
      await db.collection('users').doc(targetUid).set({
        friends: admin.firestore.FieldValue.arrayRemove(socket.data.uid),
      }, { merge: true });
      socket.emit('social_ok', { message: '已刪除好友' });
    } catch (e) {
      socket.emit('social_error', { message: '操作失敗，請稍後再試' });
    }
  });

  socket.on('get_friends', async () => {
    if (!db || !socket.data.uid) return socket.emit('friends_data', { friends: [], incoming: [] });
    try {
      const doc = await db.collection('users').doc(socket.data.uid).get();
      const data = doc.exists ? doc.data() : {};
      const friendIds = data.friends || [];
      // 直接讀每個好友「目前」的暱稱，不依賴加好友當下存的快照（比較準，也不會受時序問題影響顯示成「玩家」）
      const friendDocs = await Promise.all(friendIds.map((uid) => db.collection('users').doc(uid).get()));
      const friends = friendIds.map((uid, i) => ({
        uid,
        name: (friendDocs[i].exists && friendDocs[i].data().displayName) || '玩家',
      }));
      const incomingRaw = data.incomingRequests || [];
      const incomingDocs = await Promise.all(incomingRaw.map((r) => db.collection('users').doc(r.uid).get()));
      const incoming = incomingRaw.map((r, i) => ({
        uid: r.uid,
        name: (incomingDocs[i].exists && incomingDocs[i].data().displayName) || r.name || '玩家',
      }));
      socket.emit('friends_data', { friends, incoming });
    } catch (e) {
      socket.emit('friends_data', { friends: [], incoming: [] });
    }
  });

  socket.on('leave_room', () => {
    removePlayerFromRoom(socket.id);
    socket.leave(socket.data.roomCode);
    socket.data.roomCode = null;
  });

  // ---------- 解題加強：答題換道具，只有生存/限時模式能用 ----------
  socket.on('request_quiz', ({ powerupId } = {}) => {
    const powerup = POWERUP_CATALOG[powerupId];
    if (!powerup) return;
    // 從題庫隨機抽題(不重複)
    const shuffled = [...QUIZ_BANK].sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, powerup.questionCount);
    activeQuizzes.set(socket.id, { powerupId, questions: picked, currentIndex: 0, correctCount: 0, history: [] });
    // 只送題目跟選項給前端，正確答案(answer)絕對不會送出去，避免看原始碼作弊
    socket.emit('quiz_started', {
      powerupId,
      questions: picked.map((q) => ({ q: q.q, options: q.options, category: q.category })),
    });
  });

  // 每答一題就送一次，伺服器立刻公布這一題對不對(答案是伺服器自己記錄的目前第幾題，前端無法亂指定跳題)
  socket.on('answer_quiz_question', async ({ selectedIndex } = {}) => {
    const quiz = activeQuizzes.get(socket.id);
    if (!quiz) return;
    const q = quiz.questions[quiz.currentIndex];
    if (!q) return;
    const correct = q.answer === selectedIndex;
    if (correct) quiz.correctCount++;
    quiz.history.push({ q: q.q, options: q.options, selectedIndex, correctIndex: q.answer, correct });
    quiz.currentIndex++;
    const isLast = quiz.currentIndex >= quiz.questions.length;
    socket.emit('quiz_answer_result', { correct, correctIndex: q.answer, isLast });

    if (isLast) {
      activeQuizzes.delete(socket.id);
      const total = quiz.questions.length;
      const ratio = total > 0 ? quiz.correctCount / total : 0;
      const passed = ratio >= QUIZ_PASS_RATIO;
      if (passed) {
        const sid = socket.data.sessionId || socket.id;
        const bag = earnedPowerups.get(sid) || [];
        bag.push(quiz.powerupId);
        earnedPowerups.set(sid, bag);
      }
      const { coinsEarned, coins } = await recordQuizStats(socket.data.uid, quiz.correctCount, total);
      socket.emit('quiz_result', {
        passed, correct: quiz.correctCount, total, powerupId: quiz.powerupId, history: quiz.history,
        coinsEarned, coins,
      });
    }
  });

  // 遊戲進行中手動使用已經拿到的道具(只有生存/限時模式能用，MOBA不行)，前端要指定用哪一個(背包裡可能有好幾個)
  socket.on('activate_powerup', ({ powerupId } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing') return;
    if (room.mode !== 'survival' && room.mode !== 'timed') return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    const sid = socket.data.sessionId || socket.id;
    const bag = earnedPowerups.get(sid) || [];
    const idx = bag.indexOf(powerupId);
    if (idx === -1) return; // 背包裡沒有這個道具
    bag.splice(idx, 1); // 用掉了就從背包移除，不管套用有沒有成功都不會卡住
    earnedPowerups.set(sid, bag);
    engine.applyPowerup(p, powerupId);
    socket.emit('powerup_activated', { powerupId });
  });

  // 加入/建立房間時順便告訴前端目前手上有沒有已經拿到但還沒用掉的道具(重新整理頁面後還能看到)
  socket.on('check_my_powerup', () => {
    const sid = socket.data.sessionId || socket.id;
    const bag = earnedPowerups.get(sid) || [];
    socket.emit('my_powerup_status', { bag });
  });

  // ---------- 每日簽到題：一天一題，答對送金幣，訪客(沒有uid)不能玩(跟金幣系統一致，都要有帳號) ----------
  socket.on('request_daily_checkin', async () => {
    if (!db) { socket.emit('daily_checkin_unavailable', { reason: 'no_firebase' }); return; }
    if (!socket.data.uid) { socket.emit('daily_checkin_unavailable', { reason: 'guest' }); return; }
    try {
      const ref = db.collection('users').doc(socket.data.uid);
      const doc = await ref.get();
      const data = doc.exists ? doc.data() : {};
      const today = todayDateString();
      if (data.lastCheckinDate === today) {
        socket.emit('daily_checkin_status', { alreadyDone: true, coins: data.coins || 0 });
        return;
      }
      const question = QUIZ_BANK[Math.floor(Math.random() * QUIZ_BANK.length)];
      activeDailyQuiz.set(socket.id, { question });
      socket.emit('daily_checkin_question', {
        q: question.q, options: question.options, category: question.category,
      });
    } catch (e) {
      console.error('每日簽到出題失敗:', e.message);
    }
  });

  // 純粹偷看今天簽到過沒，不會出題、不會消耗任何東西，用來決定登入後要不要自動跳出簽到視窗
  socket.on('peek_daily_checkin', async () => {
    if (!db || !socket.data.uid) return; // 訪客/沒設定Firebase的話安靜不回應，不用跳提示打擾人
    try {
      const doc = await db.collection('users').doc(socket.data.uid).get();
      const data = doc.exists ? doc.data() : {};
      const done = data.lastCheckinDate === todayDateString();
      socket.emit('daily_checkin_peek_result', { done });
    } catch (e) {
      console.error('每日簽到偷看狀態失敗:', e.message);
    }
  });

  socket.on('submit_daily_checkin', async ({ selectedIndex } = {}) => {
    const quiz = activeDailyQuiz.get(socket.id);
    if (!quiz || !db || !socket.data.uid) return;
    activeDailyQuiz.delete(socket.id);
    const correct = quiz.question.answer === selectedIndex;
    const today = todayDateString();
    const yesterday = yesterdayDateString();
    try {
      const ref = db.collection('users').doc(socket.data.uid);
      const result = await db.runTransaction(async (tx) => {
        const doc = await tx.get(ref);
        const data = doc.exists ? doc.data() : {};
        if (data.lastCheckinDate === today) {
          return { coins: data.coins || 0, streak: data.checkinStreak || 0, milestoneBonus: 0 }; // 防止同時開兩個分頁重複簽到
        }
        // 連續簽到天數：上次簽到剛好是昨天才算連續，不是的話重新從1開始算(不管有沒有答對，簽到就算出席)
        const newStreak = data.lastCheckinDate === yesterday ? (data.checkinStreak || 0) + 1 : 1;
        const milestoneBonus = newStreak % 7 === 0 ? DAILY_STREAK_MILESTONE_BONUS : 0;
        const updatedCoins = (data.coins || 0) + (correct ? DAILY_CHECKIN_COINS : 0) + milestoneBonus;
        tx.set(ref, { lastCheckinDate: today, checkinStreak: newStreak, coins: updatedCoins }, { merge: true });
        return { coins: updatedCoins, streak: newStreak, milestoneBonus };
      });
      socket.emit('daily_checkin_result', {
        correct, correctIndex: quiz.question.answer,
        coinsEarned: correct ? DAILY_CHECKIN_COINS : 0,
        coins: result.coins, streak: result.streak, milestoneBonus: result.milestoneBonus,
      });
    } catch (e) {
      console.error('每日簽到批改失敗:', e.message);
    }
  });

  socket.on('disconnect', () => {
    activeQuizzes.delete(socket.id);
    activeDailyQuiz.delete(socket.id);
    if (socket.data.uid && uidSockets.get(socket.data.uid) === socket.id) {
      uidSockets.delete(socket.data.uid);
    }
    const disconnectedId = socket.id;
    for (const room of rooms.values()) {
      const p = room.players.get(disconnectedId);
      if (!p) continue;
      if (socket.data.sessionId) {
        // 有身分識別碼，給一段寬限時間讓玩家重新整理/重新連線接回來
        p.disconnected = true;
        p.reconnectTimer = setTimeout(() => {
          const stillThere = room.players.get(disconnectedId);
          if (stillThere && stillThere.disconnected) {
            removePlayerFromRoom(disconnectedId);
          }
        }, RECONNECT_GRACE_MS);
        broadcastRoom(room);
      } else {
        removePlayerFromRoom(disconnectedId);
      }
      return;
    }
  });
});
};
