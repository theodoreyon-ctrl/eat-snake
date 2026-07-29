// ---------- REST API 路由 ----------
// 內容從原本 server.js 搬過來，邏輯完全沒有變動，只是包成一個註冊函式。
module.exports = function registerRestRoutes(app, { db, engine }) {
const { rooms } = engine;

app.get('/api/rooms', async (req, res) => {
  const viewerUid = req.query.uid;
  let blockedSet = new Set();
  if (db && viewerUid) {
    try {
      const doc = await db.collection('users').doc(viewerUid).get();
      if (doc.exists) blockedSet = new Set(doc.data().blockedUids || []);
    } catch (e) { /* 查不到就當作沒有封鎖名單，不影響列表顯示 */ }
  }
  const list = Array.from(rooms.values())
    .filter((r) => r.status === 'lobby' && r.players.size > 0)
    .filter((r) => {
      for (const p of r.players.values()) {
        if (p.uid && blockedSet.has(p.uid)) return false;
        if (viewerUid && (p.blockedUids || []).includes(viewerUid)) return false;
      }
      return true;
    })
    .map((r) => ({
      code: r.code,
      mode: r.mode,
      playerCount: r.players.size,
      hostName: (r.players.get(r.hostId) || {}).name || '???',
    }))
    .sort((a, b) => b.playerCount - a.playerCount)
    .slice(0, 30);
  res.json({ rooms: list });
});

app.get('/api/leaderboard', async (req, res) => {
  if (!db) return res.json({ leaderboard: [], enabled: false });
  const period = req.query.period === 'week' ? 'week' : 'all';
  try {
    if (period === 'week') {
      const currentWeekId = getWeekId();
      // Firestore 只能對單一欄位排序又不用額外設定複合索引，
      // 所以先抓 weeklyHighScore 前 100 名，再篩選出真的屬於本週的資料。
      const snap = await db.collection('users').orderBy('weeklyHighScore', 'desc').limit(100).get();
      const leaderboard = snap.docs
        .map(d => d.data())
        .filter(d => d.weeklyWeekId === currentWeekId && (d.weeklyHighScore || 0) > 0)
        .slice(0, 20)
        .map((d, i) => ({
          rank: i + 1,
          name: d.displayName || '匿名玩家',
          highScore: d.weeklyHighScore || 0,
          gamesPlayed: d.gamesPlayed || 0,
        }));
      return res.json({ leaderboard, enabled: true, period });
    }
    const snap = await db.collection('users').orderBy('highScore', 'desc').limit(20).get();
    const leaderboard = snap.docs.map((d, i) => ({
      rank: i + 1,
      name: d.data().displayName || '匿名玩家',
      highScore: d.data().highScore || 0,
      gamesPlayed: d.data().gamesPlayed || 0,
    }));
    res.json({ leaderboard, enabled: true, period });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/me/:uid', async (req, res) => {
  if (!db) return res.json({ enabled: false });
  try {
    const doc = await db.collection('users').doc(req.params.uid).get();
    if (!doc.exists) {
      return res.json({
        enabled: true, highScore: 0, gamesPlayed: 0,
        coins: 0, ownedSkins: ['classic'], equippedSkin: 'classic',
        totalKills: 0, wins: 0,
      });
    }
    const data = doc.data();
    res.json({
      enabled: true,
      highScore: data.highScore || 0,
      gamesPlayed: data.gamesPlayed || 0,
      coins: data.coins || 0,
      ownedSkins: data.ownedSkins || ['classic'],
      equippedSkin: data.equippedSkin || 'classic',
      totalKills: data.totalKills || 0,
      wins: data.wins || 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

};
