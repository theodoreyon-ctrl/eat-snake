// ---------- Socket.io 事件處理 ----------
// 內容從原本 server.js 搬過來，邏輯完全沒有變動，只是包成一個註冊函式。
module.exports = function registerSocketHandlers({ io, db, admin, authEnabled, engine }) {
const {
  rooms, createRoom, startCountdown, removePlayerFromRoom,
  attemptReconnect, broadcastRoom, fireBullet, getWeekId, chooseMobaElement, useMobaBoost,
} = engine;
const {
  RECONNECT_GRACE_MS, REPORT_THRESHOLD, RESTRICTION_DURATION_MS, MOBA_TEAM_SIZE,
  MAX_PLAYERS, BASE_LENGTH, COLORS, SKIN_CATALOG,
} = require('./config');

const uidSockets = new Map(); // uid -> 目前正在使用這個帳號的 socket.id（同一時間只允許一個）

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

  socket.on('disconnect', () => {
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
