// ---------- 遊戲引擎核心 ----------
// 這個檔案的函式內容是直接從原本 server.js 搬過來的，邏輯完全沒有變動，
// 只是包成一個工廠函式（傳入 io/db/admin），並在最後把其他模組需要用到的東西 export 出去。
module.exports = function createGameEngine({ io, db, admin }) {
const {
  WORLD_W, WORLD_H, TICK_MS, MAX_PLAYERS, TIMED_MODE_DURATION_MS, RESPAWN_DELAY_MS,
  BASE_SPEED, BOOST_SPEED, MAX_TURN_RATE, BODY_RADIUS, SELF_COLLIDE_SKIP, BASE_LENGTH,
  FOOD_EAT_RADIUS, SPEED_BOOST_MS, SUPER_FOOD_LIFETIME_MS, SPAWN_INVINCIBLE_MS,
  MIN_BOOST_LENGTH, BOOST_DRAIN_INTERVAL_TICKS, BOOST_DRAIN_AMOUNT,
  BULLET_SPEED, BULLET_RANGE, BULLET_RADIUS, MIN_SHOOT_LENGTH, BODY_HIT_SEGMENT_LOSS,
  DEATH_LENGTH_THRESHOLD, COIN_BY_RANK, computeRankCoins, BOT_PRESETS, COLORS,
  COLLISION_CELL_SIZE, NORMAL_FOOD_TARGET, SUPER_FOOD_TARGET, SPEED_FOOD_TARGET,
  MOBA_WORLD_SIZE, MOBA_BASE_A, MOBA_BASE_B, MOBA_LANES, MOBA_TEAM_SIZE, MOBA_MAX_LEVEL, MOBA_LENGTH_CAP,
  MOBA_BASE_LENGTH, MOBA_BASE_HP, MOBA_XP_THRESHOLDS, MOBA_FRUIT_XP, MOBA_FRUIT_GROWTH, MOBA_FRUIT_TARGET,
  MOBA_ELEMENT_BONUS,
  MOBA_ATTACK_RANGE, MOBA_BASE_ATTACK_INTERVAL_MS, MOBA_BASE_ATTACK_DAMAGE,
  MOBA_ATTACK_BULLET_SPEED, MOBA_ATTACK_BULLET_RANGE, MOBA_ELEMENT_COUNTER_MULTIPLIER,
  MOBA_ELEMENT_COUNTERS, MOBA_COMBO_ATTACKS,
  MOBA_BOOST_COOLDOWN_MIN_MS, MOBA_BOOST_COOLDOWN_MAX_MS,
  MOBA_BASIC_DASH_SPEED_MULT, MOBA_BASIC_DASH_DURATION_MS,
  MOBA_FIRE_DURATION_MS, MOBA_FIRE_SPEED_MULT, MOBA_FIRE_EXPLOSION_DAMAGE,
  MOBA_WATER_DURATION_MS, MOBA_WATER_SPEED_MULT, MOBA_WATER_TAIL_RANGE, MOBA_WATER_TAIL_DAMAGE,
  MOBA_WATER_TAIL_TICK_INTERVAL_MS, MOBA_WATER_SLOW_MULTIPLIER, MOBA_WATER_SLOW_DURATION_MS,
  MOBA_EARTH_DURATION_MS, MOBA_EARTH_SPEED_MULT, MOBA_EARTH_KNOCKBACK_DIST,
  MOBA_WIND_DURATION_MS, MOBA_WIND_SPEED_MULT,
  MOBA_BALANCED_DURATION_MS, MOBA_BALANCED_SPEED_MULT,
  MOBA_OUTER_TOWER_HP, MOBA_HIGHLAND_TOWER_HP, MOBA_MAIN_BASE_HP, MOBA_STRUCTURE_HIT_RADIUS,
  MOBA_HIGHLAND_TOWER_POSITION, MOBA_OUTER_TOWER_1_POSITION, MOBA_OUTER_TOWER_2_POSITION,
  MOBA_RESPAWN_MIN_MS, MOBA_RESPAWN_MAX_MS,
} = require('./config');

const rooms = new Map();

// 依模式決定這個房間的地圖尺寸：MOBA模式用專屬的正方形小地圖，其他模式維持原本的大地圖不變
function worldDimsFor(room) {
  return room.mode === 'moba' ? { w: MOBA_WORLD_SIZE, h: MOBA_WORLD_SIZE } : { w: WORLD_W, h: WORLD_H };
}

// MOBA模式的出生點：在自己隊伍的主堡附近，面向指定路線的下一個路點（往敵方主堡方向）
function mobaSpawnPosition(team, lane) {
  const base = team === 'A' ? MOBA_BASE_A : MOBA_BASE_B;
  const path = MOBA_LANES[lane] || MOBA_LANES.mid;
  const midPoint = path[1]; // 兩隊出生都是面向路線中繼點（往中間、往敵方主堡的方向）
  const angle = Math.atan2(midPoint.y - base.y, midPoint.x - base.x);
  return { x: base.x, y: base.y, angle };
}

// MOBA模式專用的回合重置：出生在自己主堡、面向指定路線，跟原本的resetPlayerForRound分開，
// 不會影響到生存/限時模式的出生邏輯。
function resetPlayerForMobaRound(player, team, lane) {
  const spot = mobaSpawnPosition(team, lane);
  player.x = spot.x;
  player.y = spot.y;
  player.angle = spot.angle;
  player.targetAngle = spot.angle;
  player.points = Array.from({ length: MOBA_BASE_LENGTH }, (_, i) => ({
    x: spot.x - Math.cos(spot.angle) * BASE_SPEED * i,
    y: spot.y - Math.sin(spot.angle) * BASE_SPEED * i,
  }));
  player.length = MOBA_BASE_LENGTH;
  player.alive = true;
  player.score = 0;
  player.kills = 0;
  player.respawnAt = null;
  player.boostUntil = 0;
  player.manualBoost = false;
  player.boostDrainCounter = 0;
  player.invincibleUntil = Date.now() + SPAWN_INVINCIBLE_MS;
  player.ready = false;

  // Phase 2：經驗值/等級/元素系統，永久累計的被動加成（火攻擊/水攻速/土血量/風跑速）
  player.level = 1;
  player.xp = 0;
  player.pendingElementChoice = false;
  player.elementHistory = []; // 依選擇順序記錄，例如 ['fire','water','fire']，Phase 3 合成技能會用到
  player.attackBonus = 0;
  player.attackSpeedBonus = 0;
  player.moveSpeedBonus = 0;
  player.maxHp = MOBA_BASE_HP;
  player.hp = MOBA_BASE_HP;

  // Phase 3：普攻合成、自動鎖定
  player.attackSynthesis = null; // 3級之前是null，用預設普攻；3級之後固定成 {type,id,name}
  player.attackPriority = player.attackPriority || 'kill'; // 'kill'=優先殺人, 'tower'=優先推塔（保留玩家上一局選的偏好）
  player.lastAttackAt = 0;

  // Phase 4：加速鍵大招（4~6級選的元素決定，6級才會真正變成大招，之前是基礎衝刺）
  player.ultimateType = null; // 6級才會確定：'fire'|'water'|'earth'|'wind'|'balanced'
  player.boostReadyAt = 0;    // 冷卻結束的時間點
  player.ultimateActiveUntil = 0; // 目前這次加速的生效結束時間
  player.ultimateSpeedMult = 1;
  player.activeUltimateEffect = null; // 這次加速是不是真的大招特效('fire'|'water'|'earth'|'wind'，null代表只是基礎衝刺或平衡加速)
  player.lastWaterTailAt = 0;
  player.slowUntil = 0;
  player.slowMultiplier = 1;
}

// 依照目前已經選過的元素，重新計算這個玩家的被動加成總和（血量上限會連帶調整目前血量的比例，不會突然被治滿或扣血）
function recalcMobaPassiveBonuses(player) {
  let attack = 0, attackSpeed = 0, hp = 0, moveSpeed = 0;
  player.elementHistory.forEach((el) => {
    const bonus = MOBA_ELEMENT_BONUS[el];
    if (!bonus) return;
    attack += bonus.attack || 0;
    attackSpeed += bonus.attackSpeed || 0;
    hp += bonus.hp || 0;
    moveSpeed += bonus.moveSpeed || 0;
  });
  player.attackBonus = attack;
  player.attackSpeedBonus = attackSpeed;
  player.moveSpeedBonus = moveSpeed;
  const oldMaxHp = player.maxHp || MOBA_BASE_HP;
  const newMaxHp = MOBA_BASE_HP + hp;
  const hpRatio = oldMaxHp > 0 ? player.hp / oldMaxHp : 1;
  player.maxHp = newMaxHp;
  player.hp = Math.round(newMaxHp * hpRatio);
}

// 隨機一個 MOBA 地圖範圍內的座標（果實生成用）
function randMobaPoint(margin = 150) {
  return {
    x: margin + Math.random() * (MOBA_WORLD_SIZE - margin * 2),
    y: margin + Math.random() * (MOBA_WORLD_SIZE - margin * 2),
  };
}

// 維持地圖上果實的數量
// 生成兩隊的塔跟主堡：每條路2個外塔+1個高地塔，沿著「自己主堡到路線中繼點」這條線內插出位置
function generateMobaStructures() {
  const structures = [];
  [['A', MOBA_BASE_A], ['B', MOBA_BASE_B]].forEach(([team, base]) => {
    ['top', 'mid', 'bottom'].forEach((lane) => {
      const mid = MOBA_LANES[lane][1];
      const lerp = (t) => ({ x: base.x + (mid.x - base.x) * t, y: base.y + (mid.y - base.y) * t });
      const highlandPos = lerp(MOBA_HIGHLAND_TOWER_POSITION);
      const outer1Pos = lerp(MOBA_OUTER_TOWER_1_POSITION);
      const outer2Pos = lerp(MOBA_OUTER_TOWER_2_POSITION);
      structures.push({ id: `tower_${team}_${lane}_highland`, team, type: 'tower', tier: 'highland', lane, x: highlandPos.x, y: highlandPos.y, hp: MOBA_HIGHLAND_TOWER_HP, maxHp: MOBA_HIGHLAND_TOWER_HP, alive: true });
      structures.push({ id: `tower_${team}_${lane}_outer1`, team, type: 'tower', tier: 'outer', lane, x: outer1Pos.x, y: outer1Pos.y, hp: MOBA_OUTER_TOWER_HP, maxHp: MOBA_OUTER_TOWER_HP, alive: true });
      structures.push({ id: `tower_${team}_${lane}_outer2`, team, type: 'tower', tier: 'outer', lane, x: outer2Pos.x, y: outer2Pos.y, hp: MOBA_OUTER_TOWER_HP, maxHp: MOBA_OUTER_TOWER_HP, alive: true });
    });
    structures.push({ id: `base_${team}`, team, type: 'base', tier: 'base', lane: null, x: base.x, y: base.y, hp: MOBA_MAIN_BASE_HP, maxHp: MOBA_MAIN_BASE_HP, alive: true });
  });
  return structures;
}

function ensureMobaFood(room) {
  const count = room.food.filter((f) => f.type === 'fruit').length;
  for (let i = count; i < MOBA_FRUIT_TARGET; i++) {
    const p = randMobaPoint(150);
    room.food.push({ ...p, type: 'fruit', points: MOBA_FRUIT_XP, growth: MOBA_FRUIT_GROWTH });
  }
}

// 玩家獲得經驗值，滿了就升級（升級後要先選元素，選完之前不會再繼續升級，避免疊加好幾個等待選擇的情況）
function gainMobaXp(player, amount) {
  if (player.level >= MOBA_MAX_LEVEL || player.pendingElementChoice) return;
  player.xp += amount;
  const needed = MOBA_XP_THRESHOLDS[player.level - 1];
  if (needed !== undefined && player.xp >= needed) {
    player.xp -= needed;
    player.level += 1;
    player.pendingElementChoice = true;
    io.to(player.id).emit('moba_level_up', { level: player.level });
  }
}

// 玩家選好這一級的元素，套用被動加成
// 3級技能合成：依照前3次選的元素決定普攻類型。
// 3個一樣 -> 強化版該元素球；2+1混合 -> 取數量較多的元素；3個都不同 -> 合成特殊組合技（不相剋任何人）
function computeMobaAttackSynthesis(elementHistory) {
  const first3 = elementHistory.slice(0, 3);
  if (first3.length < 3) return null;
  const counts = {};
  first3.forEach((e) => { counts[e] = (counts[e] || 0) + 1; });
  const uniqueElements = Object.keys(counts);
  if (uniqueElements.length === 3) {
    const comboKey = uniqueElements.slice().sort().join('+');
    const combo = MOBA_COMBO_ATTACKS[comboKey];
    return combo ? { type: 'combo', id: combo.id, name: combo.name } : { type: 'combo', id: 'basic', name: '普通彈' };
  }
  let best = uniqueElements[0];
  uniqueElements.forEach((e) => { if (counts[e] > counts[best]) best = e; });
  return { type: 'element', id: best, name: null }; // 強化版該元素球（前端自己依id顯示名稱跟顏色）
}

// 6級大招判定：依照全部6次選擇裡數量最多的元素決定，平手或四種都有就是「全元素綜合加速」
function computeMobaUltimateType(elementHistory) {
  if (elementHistory.length < 6) return null;
  const counts = { fire: 0, water: 0, earth: 0, wind: 0 };
  elementHistory.forEach((e) => { if (counts[e] !== undefined) counts[e]++; });
  const maxCount = Math.max(...Object.values(counts));
  const topElements = Object.keys(counts).filter((e) => counts[e] === maxCount);
  return topElements.length === 1 ? topElements[0] : 'balanced';
}

function chooseMobaElement(player, element) {
  if (!['fire', 'water', 'earth', 'wind'].includes(element)) return false;
  if (!player.pendingElementChoice) return false;
  player.elementHistory.push(element);
  player.pendingElementChoice = false;
  recalcMobaPassiveBonuses(player);
  // 剛好選完第3個元素（也就是升到3級）的當下，普攻合成類型就固定下來了，之後4~6級選的元素是給大招用的
  if (player.elementHistory.length === 3 && !player.attackSynthesis) {
    player.attackSynthesis = computeMobaAttackSynthesis(player.elementHistory);
  }
  // 選完第6個元素（升到6級），加速鍵正式變成大招
  if (player.elementHistory.length === 6 && !player.ultimateType) {
    player.ultimateType = computeMobaUltimateType(player.elementHistory);
  }
  return true;
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function randWorldPoint(margin = 60) {
  return {
    x: margin + Math.random() * (WORLD_W - margin * 2),
    y: margin + Math.random() * (WORLD_H - margin * 2),
  };
}

function dist2(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function normalizeAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// 計算 ISO 週數字串，例如 "2026-W30"，用來判斷「本週排行榜」的區間
function getWeekId(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function createRoom(hostSocketId, mode) {
  const code = randomCode();
  const room = {
    code,
    hostId: hostSocketId,
    mode: mode === 'timed' ? 'timed' : mode === 'moba' ? 'moba' : 'survival',
    players: new Map(),
    food: [],
    bullets: [],
    mobaBullets: [],
    structures: [],
    broadcastTickCounter: 0,
    eliminationOrder: [],
    status: 'lobby',
    loop: null,
    startedAt: null,
    botCount: 0,
    botDifficulty: 'normal',
  };
  rooms.set(code, room);
  return room;
}

function spawnStartPosition(index, total) {
  const n = Math.max(1, total || MAX_PLAYERS);
  const cx = WORLD_W / 2, cy = WORLD_H / 2;
  const angle = (index / n) * Math.PI * 2;
  const radius = Math.min(WORLD_W, WORLD_H) * 0.32;
  const x = cx + Math.cos(angle) * radius;
  const y = cy + Math.sin(angle) * radius;
  const facing = angle + Math.PI;
  return { x, y, angle: facing };
}

// 回合開始時的完整重置：位置、長度、分數、擊殺數全部歸零
// total 是這一局實際的參賽人數（真人+電腦蛇），角度會依這個人數平均分散一整圈，
// 不能用固定的 MAX_PLAYERS 去除，不然人數少的時候大家都會擠在同一小塊角度範圍內。
function resetPlayerForRound(player, index, total) {
  const spot = spawnStartPosition(index, total);
  player.x = spot.x;
  player.y = spot.y;
  player.angle = spot.angle;
  player.targetAngle = spot.angle;
  player.points = Array.from({ length: BASE_LENGTH }, (_, i) => ({
    x: spot.x - Math.cos(spot.angle) * BASE_SPEED * i,
    y: spot.y - Math.sin(spot.angle) * BASE_SPEED * i,
  }));
  player.length = BASE_LENGTH;
  player.alive = true;
  player.score = 0;
  player.kills = 0;
  player.respawnAt = null;
  player.boostUntil = 0;
  player.manualBoost = false;
  player.boostDrainCounter = 0;
  player.invincibleUntil = Date.now() + SPAWN_INVINCIBLE_MS;
  player.ready = false;
}

// 限時模式專用的重生：只重置位置/長度/狀態，分數跟擊殺數要保留繼續累計。
// 重生用完全隨機的角度（不受人數影響），這樣同時有人重生也不會全部生在同一個位置。
function respawnPlayer(player) {
  const cx = WORLD_W / 2, cy = WORLD_H / 2;
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.min(WORLD_W, WORLD_H) * (0.15 + Math.random() * 0.25);
  const spot = { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius, angle: angle + Math.PI };
  player.x = spot.x;
  player.y = spot.y;
  player.angle = spot.angle;
  player.targetAngle = spot.angle;
  player.points = Array.from({ length: BASE_LENGTH }, (_, i) => ({
    x: spot.x - Math.cos(spot.angle) * BASE_SPEED * i,
    y: spot.y - Math.sin(spot.angle) * BASE_SPEED * i,
  }));
  player.length = BASE_LENGTH;
  player.alive = true;
  player.respawnAt = null;
  player.boostUntil = 0;
  player.manualBoost = false;
  player.boostDrainCounter = 0;
  player.invincibleUntil = Date.now() + SPAWN_INVINCIBLE_MS;
}

// 依等級計算復活時間：1級3秒 ~ 6級15秒
function computeMobaRespawnDelay(level) {
  const clampedLevel = Math.max(1, Math.min(MOBA_MAX_LEVEL, level || 1));
  const step = (MOBA_RESPAWN_MAX_MS - MOBA_RESPAWN_MIN_MS) / (MOBA_MAX_LEVEL - 1);
  return MOBA_RESPAWN_MIN_MS + (clampedLevel - 1) * step;
}

// MOBA模式的復活：跟傳說對決一樣，死了不是出局，等一段時間會在自己主堡重生。
// 等級、經驗值、選過的元素、身體長度都會保留，只重置位置跟血量（血量會回滿）。
function respawnMobaPlayer(player) {
  const spot = mobaSpawnPosition(player.team, player.lane);
  player.x = spot.x;
  player.y = spot.y;
  player.angle = spot.angle;
  player.targetAngle = spot.angle;
  const len = Math.max(MOBA_BASE_LENGTH, Math.min(MOBA_LENGTH_CAP, player.length));
  player.points = Array.from({ length: len }, (_, i) => ({
    x: spot.x - Math.cos(spot.angle) * BASE_SPEED * i,
    y: spot.y - Math.sin(spot.angle) * BASE_SPEED * i,
  }));
  player.alive = true;
  player.hp = player.maxHp;
  player.respawnAt = null;
  player.boostUntil = 0;
  player.manualBoost = false;
  player.boostDrainCounter = 0;
  player.invincibleUntil = Date.now() + SPAWN_INVINCIBLE_MS; // 重生後一小段無敵，避免一出生就被堵在家門口
}

// 食物數量依地圖面積換算密度，地圖變大/變小的話這裡會自動跟著調整，不會再因為地圖放大而變稀疏
// 食物數量已經依地圖面積在 config.js 算好了（NORMAL_FOOD_TARGET / SUPER_FOOD_TARGET / SPEED_FOOD_TARGET）

function ensureFood(room) {
  const normalCount = room.food.filter(f => f.type === 'normal').length;
  for (let i = normalCount; i < NORMAL_FOOD_TARGET; i++) {
    const p = randWorldPoint(40);
    room.food.push({ ...p, type: 'normal', points: 10, growth: 4 });
  }
  const superCount = room.food.filter(f => f.type === 'super').length;
  for (let i = superCount; i < SUPER_FOOD_TARGET; i++) {
    if (Math.random() >= 0.05) break; // 每個空位都有機會生成，但不是每個tick都全部一次補滿
    const p = randWorldPoint(60);
    room.food.push({ ...p, type: 'super', points: 30, growth: 10, expiresAt: Date.now() + SUPER_FOOD_LIFETIME_MS });
  }
  const speedCount = room.food.filter(f => f.type === 'speed').length;
  for (let i = speedCount; i < SPEED_FOOD_TARGET; i++) {
    if (Math.random() >= 0.04) break;
    const p = randWorldPoint(60);
    room.food.push({ ...p, type: 'speed', points: 0, growth: 0, expiresAt: Date.now() + SUPER_FOOD_LIFETIME_MS });
  }
  room.food = room.food.filter(f => !f.expiresAt || f.expiresAt > Date.now());
}

function broadcastRoom(room) {
  // 電腦蛇數量不能超過剩餘空位（真人玩家數量隨時可能變動，這裡每次都重新校正一次）
  room.botCount = Math.min(room.botCount, Math.max(0, MAX_PLAYERS - room.players.size));
  io.to(room.code).emit('room_update', serializeRoomLobby(room));
}

function serializeRoomLobby(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    mode: room.mode,
    botCount: room.botCount,
    botDifficulty: room.botDifficulty,
    maxBotCount: Math.max(0, MAX_PLAYERS - room.players.size),
    players: Array.from(room.players.values()).map(p => ({
      id: p.id, name: p.name, color: p.color, ready: p.ready, isHost: p.id === room.hostId,
      disconnected: !!p.disconnected, team: p.team || null, lane: p.lane || null,
    })),
  };
}

function startCountdown(room) {
  if (room.status !== 'lobby') return;
  room.status = 'countdown';
  broadcastRoom(room);
  let count = 3;
  io.to(room.code).emit('countdown', count);
  const interval = setInterval(() => {
    count -= 1;
    io.to(room.code).emit('countdown', count);
    if (count <= 0) {
      clearInterval(interval);
      beginRound(room);
    }
  }, 800);
}

function beginRound(room) {
  room.status = 'playing';
  room.startedAt = Date.now();
  room.food = [];
  room.bullets = [];
  room.mobaBullets = [];
  room.mobaWinnerTeam = null;
  room.eliminationOrder = []; // 依照被淘汰的時間順序記錄玩家id，用來決定最終名次

  if (room.mode === 'moba') {
    // MOBA模式：出生在自己隊伍的主堡、依照分配到的路線面向敵方，不用電腦蛇（Phase 1還沒有MOBA用的AI）
    room.players.forEach(p => resetPlayerForMobaRound(p, p.team, p.lane));
    room.structures = generateMobaStructures();
    broadcastRoom(room);
    room.loop = setInterval(() => tickRoom(room), TICK_MS);
    return;
  }

  // 清掉上一輪殘留的電腦蛇，只留真人玩家
  for (const [id, p] of room.players.entries()) {
    if (p.isBot) room.players.delete(id);
  }

  const humanCount = room.players.size;
  const botsToSpawn = Math.max(0, Math.min(room.botCount, MAX_PLAYERS - humanCount));
  for (let i = 0; i < botsToSpawn; i++) {
    const botId = `bot_${Date.now()}_${i}_${Math.floor(Math.random() * 1000)}`;
    room.players.set(botId, {
      id: botId, uid: null, name: `電腦蛇 ${i + 1}`, sessionId: null,
      color: COLORS[(humanCount + i) % COLORS.length],
      ready: true,
      x: 0, y: 0, angle: 0, targetAngle: 0, points: [], length: BASE_LENGTH,
      alive: false, score: 0, kills: 0, respawnAt: null,
      boostUntil: 0, manualBoost: false, boostDrainCounter: 0,
      invincibleUntil: 0, disconnected: false, reconnectTimer: null,
      isBot: true, difficulty: room.botDifficulty, aiTickCounter: Math.floor(Math.random() * 6), skin: 'classic',
    });
  }

  let idx = 0;
  const totalCount = room.players.size;
  room.players.forEach(p => { resetPlayerForRound(p, idx, totalCount); idx += 1; });
  broadcastRoom(room);
  room.loop = setInterval(() => tickRoom(room), TICK_MS);
}

// 檢查蛇如果朝某個角度前進，沿途幾個取樣點會不會撞牆或撞到任何蛇身
function isSafeDirection(bot, room, angle, lookDistances) {
  for (const d of lookDistances) {
    const px = bot.x + Math.cos(angle) * d;
    const py = bot.y + Math.sin(angle) * d;
    if (px < 24 || px > WORLD_W - 24 || py < 24 || py > WORLD_H - 24) return false;
    for (const other of room.players.values()) {
      if (!other.alive || other.points.length === 0) continue;
      const skip = other.id === bot.id ? SELF_COLLIDE_SKIP : 0;
      const step = other.points.length > 120 ? 3 : 1;
      for (let i = skip; i < other.points.length; i += step) {
        const dx = px - other.points[i].x, dy = py - other.points[i].y;
        if (dx * dx + dy * dy < (BODY_RADIUS * 2.2) ** 2) return false;
      }
    }
  }
  return true;
}

// 電腦蛇的 AI 決策：找食物 / (困難難度)主動盯人 + 避開牆壁跟所有蛇身
function updateBotAI(bot, room) {
  const preset = BOT_PRESETS[bot.difficulty] || BOT_PRESETS.normal;
  bot.aiTickCounter = (bot.aiTickCounter || 0) + 1;
  if (bot.aiTickCounter % preset.updateEvery !== 0) return; // 還沒到重新決策的時機，維持原本方向

  const head = bot.points[0];
  let desiredAngle = bot.angle;
  let huntingTarget = null;

  if (preset.huntEnabled) {
    let bestDist = preset.huntRadius ** 2;
    for (const other of room.players.values()) {
      if (other.isBot || !other.alive || other.id === bot.id) continue;
      if (other.length >= bot.length) continue;
      if (Date.now() < other.invincibleUntil) continue;
      const d = dist2(head, other.points[0]);
      if (d < bestDist) { bestDist = d; huntingTarget = other; }
    }
  }

  if (huntingTarget) {
    // 不是直接衝向對方現在的位置，而是預判他前進的方向，瞄準前方一小段距離去堵
    const lead = 55;
    const aimX = huntingTarget.points[0].x + Math.cos(huntingTarget.angle) * lead;
    const aimY = huntingTarget.points[0].y + Math.sin(huntingTarget.angle) * lead;
    desiredAngle = Math.atan2(aimY - head.y, aimX - head.x);
  } else {
    let bestFood = null;
    let bestFoodDist = preset.foodSearchRadius ** 2;
    room.food.forEach(f => {
      const d = dist2(head, f);
      if (d < bestFoodDist) { bestFoodDist = d; bestFood = f; }
    });
    if (bestFood) {
      desiredAngle = Math.atan2(bestFood.y - head.y, bestFood.x - head.x);
    }
  }

  if (preset.angleError > 0) {
    desiredAngle = normalizeAngle(desiredAngle + (Math.random() - 0.5) * preset.angleError);
  }

  // 依序嘗試「理想方向」，不安全就慢慢左右偏移找一個安全的方向
  const offsets = [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9, 1.3, -1.3, 2.0, -2.0];
  let chosen = null;
  for (const off of offsets) {
    const candidate = normalizeAngle(desiredAngle + off);
    if (isSafeDirection(bot, room, candidate, preset.lookDist)) { chosen = candidate; break; }
  }
  bot.targetAngle = chosen === null ? normalizeAngle(bot.angle + Math.PI * 0.55) : chosen;

  if (preset.boostChance > 0 && bot.length > MIN_BOOST_LENGTH + 20 && Math.random() < preset.boostChance) {
    bot.manualBoost = true;
  } else if (Math.random() < 0.08) {
    bot.manualBoost = false;
  }

  // 困難難度：瞄準對象時，角度夠準又在射程內就主動開槍
  if (preset.canShoot && huntingTarget && bot.length > MIN_SHOOT_LENGTH + 20) {
    const targetHead = huntingTarget.points[0];
    const aimAngle = Math.atan2(targetHead.y - head.y, targetHead.x - head.x);
    const aimDiff = Math.abs(normalizeAngle(bot.angle - aimAngle));
    const distToTarget = Math.sqrt(dist2(head, targetHead));
    if (aimDiff < 0.2 && distToTarget < preset.shootRange && Math.random() < 0.35) {
      fireBullet(bot, room);
    }
  }
}

// 開槍：消耗自己一節長度，從頭部前方一小段距離生成一顆子彈
// ---------- MOBA 模式 Phase 3：自動鎖定普攻（無限量、不消耗身體，會造成HP傷害） ----------

// 找出範圍內最近的敵方玩家（Phase 3 還沒有塔，「推塔」優先權暫時沒有實際效果，之後Phase 5加塔才會用到）
// ---------- MOBA 模式 Phase 4：加速鍵大招 ----------

// 冷卻時間依等級線性遞增：1級5秒 ~ 6級20秒
function computeMobaBoostCooldown(level) {
  const clampedLevel = Math.max(1, Math.min(MOBA_MAX_LEVEL, level || 1));
  const step = (MOBA_BOOST_COOLDOWN_MAX_MS - MOBA_BOOST_COOLDOWN_MIN_MS) / (MOBA_MAX_LEVEL - 1);
  return MOBA_BOOST_COOLDOWN_MIN_MS + (clampedLevel - 1) * step;
}

// 按下加速鍵：冷卻中就沒反應；6級之前只是基礎衝刺，6級之後依主導元素變成對應大招
function useMobaBoost(player) {
  if (!player.alive) return false;
  const now = Date.now();
  if (now < (player.boostReadyAt || 0)) return false;
  player.boostReadyAt = now + computeMobaBoostCooldown(player.level);
  player.lastWaterTailAt = 0;

  if (player.level >= MOBA_MAX_LEVEL && player.ultimateType) {
    switch (player.ultimateType) {
      case 'fire':
        player.ultimateActiveUntil = now + MOBA_FIRE_DURATION_MS;
        player.ultimateSpeedMult = MOBA_FIRE_SPEED_MULT;
        player.activeUltimateEffect = 'fire';
        break;
      case 'water':
        player.ultimateActiveUntil = now + MOBA_WATER_DURATION_MS;
        player.ultimateSpeedMult = MOBA_WATER_SPEED_MULT;
        player.activeUltimateEffect = 'water';
        break;
      case 'earth':
        player.ultimateActiveUntil = now + MOBA_EARTH_DURATION_MS;
        player.ultimateSpeedMult = MOBA_EARTH_SPEED_MULT;
        player.activeUltimateEffect = 'earth';
        break;
      case 'wind':
        player.ultimateActiveUntil = now + MOBA_WIND_DURATION_MS;
        player.ultimateSpeedMult = MOBA_WIND_SPEED_MULT;
        player.activeUltimateEffect = 'wind';
        break;
      default: // balanced：四種元素平手或都選到，只有中等加速沒有特效
        player.ultimateActiveUntil = now + MOBA_BALANCED_DURATION_MS;
        player.ultimateSpeedMult = MOBA_BALANCED_SPEED_MULT;
        player.activeUltimateEffect = null;
    }
  } else {
    // 6級之前：純粹的基礎衝刺，沒有特殊效果
    player.ultimateActiveUntil = now + MOBA_BASIC_DASH_DURATION_MS;
    player.ultimateSpeedMult = MOBA_BASIC_DASH_SPEED_MULT;
    player.activeUltimateEffect = null;
  }
  return true;
}

// 水系大招的持續尾水傷害：檢查蛇尾附近有沒有敵人在追(不是每個tick都打，有間隔限制)
function updateMobaWaterTail(room, deadThisTick) {
  const now = Date.now();
  room.players.forEach((p) => {
    if (!p.alive || p.activeUltimateEffect !== 'water' || now >= p.ultimateActiveUntil) return;
    if (now - (p.lastWaterTailAt || 0) < MOBA_WATER_TAIL_TICK_INTERVAL_MS) return;
    const tail = p.points[p.points.length - 1];
    if (!tail) return;
    let hitSomeone = false;
    room.players.forEach((other) => {
      if (other.id === p.id || !other.alive || other.team === p.team) return;
      const head = other.points[0];
      if (!head) return;
      if (dist2(tail, head) < MOBA_WATER_TAIL_RANGE ** 2) {
        other.hp = Math.max(0, other.hp - MOBA_WATER_TAIL_DAMAGE);
        other.slowUntil = now + MOBA_WATER_SLOW_DURATION_MS;
        other.slowMultiplier = MOBA_WATER_SLOW_MULTIPLIER;
        hitSomeone = true;
        if (other.hp <= 0) {
          other.alive = false;
          deadThisTick.push(other);
          room.eliminationOrder.push(other.id);
          p.kills = (p.kills || 0) + 1;
          other.respawnAt = Date.now() + computeMobaRespawnDelay(other.level);
        }
      }
    });
    if (hitSomeone) p.lastWaterTailAt = now;
  });
}

function findMobaAttackTarget(attacker, room) {
  const head = attacker.points[0];

  let bestPlayer = null, bestPlayerDist = MOBA_ATTACK_RANGE ** 2;
  room.players.forEach((other) => {
    if (other.id === attacker.id || !other.alive || other.team === attacker.team) return;
    if (Date.now() < other.invincibleUntil) return;
    if (other.points.length === 0) return;
    const d = dist2(head, other.points[0]);
    if (d < bestPlayerDist) { bestPlayerDist = d; bestPlayer = other; }
  });

  let bestStructure = null, bestStructureDist = MOBA_ATTACK_RANGE ** 2;
  (room.structures || []).forEach((s) => {
    if (!s.alive || s.team === attacker.team) return;
    const d = dist2(head, s);
    if (d < bestStructureDist) { bestStructureDist = d; bestStructure = s; }
  });

  // 「優先推塔」的話先看有沒有塔/主堡在範圍內，沒有才打人；「優先殺人」反過來
  if (attacker.attackPriority === 'tower') return bestStructure || bestPlayer;
  return bestPlayer || bestStructure;
}

// 依攻速被動計算實際攻擊間隔，並判斷是否要開火
function updateMobaAutoAttack(room) {
  room.players.forEach((p) => {
    if (!p.alive || p.points.length === 0) return;
    const target = findMobaAttackTarget(p, room);
    if (!target) return;
    const interval = MOBA_BASE_ATTACK_INTERVAL_MS / (1 + (p.attackSpeedBonus || 0));
    if (Date.now() - (p.lastAttackAt || 0) < interval) return;
    p.lastAttackAt = Date.now();

    const head = p.points[0];
    const targetPos = target.points ? target.points[0] : target; // 玩家用頭部位置，建築物直接用自己的座標
    const angle = Math.atan2(targetPos.y - head.y, targetPos.x - head.x);
    room.mobaBullets.push({
      id: `mb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      ownerId: p.id,
      x: head.x + Math.cos(angle) * (BODY_RADIUS + 6),
      y: head.y + Math.sin(angle) * (BODY_RADIUS + 6),
      angle,
      traveled: 0,
      synthesis: p.attackSynthesis, // null(3級前用預設) 或 {type:'element'|'combo', id, name}
      damage: MOBA_BASE_ATTACK_DAMAGE + (p.attackBonus || 0),
    });
  });
}

// 計算屬性相剋倍率：只有雙方都已經合成「純元素」型普攻（不是combo、也不是null）才會套用相剋
function computeElementMultiplier(attackerSynthesis, defenderSynthesis) {
  if (!attackerSynthesis || attackerSynthesis.type !== 'element') return 1;
  if (!defenderSynthesis || defenderSynthesis.type !== 'element') return 1;
  if (MOBA_ELEMENT_COUNTERS[attackerSynthesis.id] === defenderSynthesis.id) return MOBA_ELEMENT_COUNTER_MULTIPLIER;
  return 1;
}

// 普攻子彈的移動與命中判定，扣血、血量歸零就死亡（跟原本消耗身體的射擊機制完全獨立）
function updateMobaBullets(room, deadThisTick, grid) {
  const remaining = [];
  for (const b of room.mobaBullets) {
    b.x += Math.cos(b.angle) * MOBA_ATTACK_BULLET_SPEED;
    b.y += Math.sin(b.angle) * MOBA_ATTACK_BULLET_SPEED;
    b.traveled += MOBA_ATTACK_BULLET_SPEED;

    if (b.traveled > MOBA_ATTACK_BULLET_RANGE || b.x < 0 || b.x > MOBA_WORLD_SIZE || b.y < 0 || b.y > MOBA_WORLD_SIZE) {
      continue;
    }

    let hit = false;
    const owner = room.players.get(b.ownerId);
    const nearby = queryNearbyPoints(grid, b.x, b.y);
    for (const pt of nearby) {
      if (pt.ownerId === b.ownerId) continue;
      const target = room.players.get(pt.ownerId);
      if (!target || !target.alive || (owner && target.team === owner.team)) continue;
      if (Date.now() < target.invincibleUntil) continue;
      const dx = b.x - pt.x, dy = b.y - pt.y;
      if (dx * dx + dy * dy >= (BULLET_RADIUS + BODY_RADIUS) ** 2) continue;

      const multiplier = computeElementMultiplier(b.synthesis, target.attackSynthesis);
      target.hp = Math.max(0, target.hp - Math.round(b.damage * multiplier));
      if (target.hp <= 0) {
        target.alive = false;
        deadThisTick.push(target);
        room.eliminationOrder.push(target.id);
        const killer = room.players.get(b.ownerId);
        if (killer) killer.kills = (killer.kills || 0) + 1;
        target.respawnAt = Date.now() + computeMobaRespawnDelay(target.level);
      }
      hit = true;
      break;
    }

    // 沒打到玩家的話，檢查有沒有打到塔或主堡（建築物沒有元素屬性，不會有相剋加成）
    if (!hit) {
      for (const s of room.structures || []) {
        if (!s.alive || (owner && s.team === owner.team)) continue;
        const dx = b.x - s.x, dy = b.y - s.y;
        if (dx * dx + dy * dy >= (MOBA_STRUCTURE_HIT_RADIUS + BULLET_RADIUS) ** 2) continue;
        s.hp = Math.max(0, s.hp - b.damage);
        if (s.hp <= 0) {
          s.alive = false;
          if (s.type === 'base') room.mobaWinnerTeam = owner ? owner.team : s.team === 'A' ? 'B' : 'A';
        }
        hit = true;
        break;
      }
    }

    if (!hit) remaining.push(b);
  }
  room.mobaBullets = remaining;
}

function fireBullet(p, room) {
  if (!p || !p.alive || p.points.length === 0) return;
  if (p.length <= MIN_SHOOT_LENGTH) return; // 長度不夠不能開槍
  p.length -= 1;
  const head = p.points[0];
  const spawnDist = BODY_RADIUS + BULLET_RADIUS + 6;
  room.bullets.push({
    id: `b_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ownerId: p.id,
    x: head.x + Math.cos(p.angle) * spawnDist,
    y: head.y + Math.sin(p.angle) * spawnDist,
    angle: p.angle,
    traveled: 0,
    color: p.color,
  });
}

// 子彈移動與命中判定：打中頭部直接死亡；打中身體扣節數，沒有保護下限，扣到快沒了一樣會死
function updateBullets(room, deadThisTick, grid) {
  const remaining = [];
  for (const b of room.bullets) {
    b.x += Math.cos(b.angle) * BULLET_SPEED;
    b.y += Math.sin(b.angle) * BULLET_SPEED;
    b.traveled += BULLET_SPEED;

    if (b.traveled > BULLET_RANGE || b.x < 0 || b.x > WORLD_W || b.y < 0 || b.y > WORLD_H) {
      continue; // 超出射程或飛出地圖，子彈消失
    }

    let hit = false;
    const nearby = queryNearbyPoints(grid, b.x, b.y);
    for (const pt of nearby) {
      if (pt.ownerId === b.ownerId) continue; // 不會打到自己
      const target = room.players.get(pt.ownerId);
      if (!target || !target.alive) continue;
      if (Date.now() < target.invincibleUntil) continue; // 無敵中不會被打
      const dx = b.x - pt.x, dy = b.y - pt.y;
      if (dx * dx + dy * dy >= (BULLET_RADIUS + BODY_RADIUS) ** 2) continue;

      const killTarget = () => {
        target.alive = false;
        deadThisTick.push(target);
        room.eliminationOrder.push(target.id);
        const killer = room.players.get(b.ownerId);
        if (killer) killer.kills = (killer.kills || 0) + 1;
        if (room.mode === 'timed') target.respawnAt = Date.now() + RESPAWN_DELAY_MS;
      };

      if (pt.isHead) {
        killTarget();
      } else {
        target.length -= BODY_HIT_SEGMENT_LOSS;
        if (target.length <= DEATH_LENGTH_THRESHOLD) killTarget();
      }
      hit = true;
      break;
    }

    if (!hit) remaining.push(b);
  }
  room.bullets = remaining;
}

// ---------- 空間網格：碰撞判定只跟「附近」的蛇比對，不用跟全地圖所有人比對 ----------
// COLLISION_CELL_SIZE 已經從 config.js 匯入了
function cellKeyOf(x, y) {
  return `${Math.floor(x / COLLISION_CELL_SIZE)},${Math.floor(y / COLLISION_CELL_SIZE)}`;
}
// 把所有活著的蛇的身體節點丟進網格，每格記錄「這個點屬於誰」
function buildCollisionGrid(room) {
  const grid = new Map();
  room.players.forEach((p) => {
    if (!p.alive || p.points.length === 0) return;
    const step = p.points.length > 120 ? 2 : 1;
    for (let i = 0; i < p.points.length; i += step) {
      const pt = p.points[i];
      const key = cellKeyOf(pt.x, pt.y);
      let arr = grid.get(key);
      if (!arr) { arr = []; grid.set(key, arr); }
      arr.push({ x: pt.x, y: pt.y, ownerId: p.id, isHead: i === 0 });
    }
  });
  return grid;
}
// 查詢某個座標附近（3x3 格）有哪些身體節點，取代「跟全部人的全部節點比對」
function queryNearbyPoints(grid, x, y) {
  const cx = Math.floor(x / COLLISION_CELL_SIZE);
  const cy = Math.floor(y / COLLISION_CELL_SIZE);
  const results = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const arr = grid.get(`${cx + dx},${cy + dy}`);
      if (arr) results.push(...arr);
    }
  }
  return results;
}

function tickRoom(room) {
  const { w: worldW, h: worldH } = worldDimsFor(room); // MOBA模式用專屬小地圖，其他模式維持原本大小不變
  const alivePlayers = Array.from(room.players.values()).filter(p => p.alive);
  if (alivePlayers.length === 0 && room.mode !== 'timed') return endRound(room);

  // 電腦蛇先做決策，決定好目標角度/要不要衝刺，後面移動邏輯就能跟真人玩家共用同一套
  alivePlayers.forEach(p => { if (p.isBot) updateBotAI(p, room); });

  // 手動加速：持續消耗長度，掉落的部分變成小食物
  alivePlayers.forEach(p => {
    const canBoost = p.manualBoost && p.length > MIN_BOOST_LENGTH;
    if (canBoost) {
      p.boostDrainCounter = (p.boostDrainCounter || 0) + 1;
      if (p.boostDrainCounter >= BOOST_DRAIN_INTERVAL_TICKS) {
        p.boostDrainCounter = 0;
        const tail = p.points[p.points.length - 1];
        if (tail) {
          room.food.push({
            x: tail.x, y: tail.y, type: 'normal', points: 3, growth: 1,
            expiresAt: Date.now() + 15000,
          });
        }
        p.length = Math.max(MIN_BOOST_LENGTH, p.length - BOOST_DRAIN_AMOUNT);
      }
    } else {
      p.boostDrainCounter = 0;
    }
  });

  alivePlayers.forEach(p => {
    const diff = normalizeAngle(p.targetAngle - p.angle);
    const turn = Math.max(-MAX_TURN_RATE, Math.min(MAX_TURN_RATE, diff));
    p.angle = normalizeAngle(p.angle + turn);
    const effectiveManualBoost = p.manualBoost && p.length > MIN_BOOST_LENGTH;
    const baseSpeedValue = (Date.now() < p.boostUntil || effectiveManualBoost) ? BOOST_SPEED : BASE_SPEED;
    const now = Date.now();
    const ultimateMult = now < (p.ultimateActiveUntil || 0) ? (p.ultimateSpeedMult || 1) : 1;
    const slowMult = now < (p.slowUntil || 0) ? (p.slowMultiplier || 1) : 1;
    const speed = baseSpeedValue * (1 + (p.moveSpeedBonus || 0)) * ultimateMult * slowMult;
    p.x += Math.cos(p.angle) * speed;
    p.y += Math.sin(p.angle) * speed;
    p.points.unshift({ x: p.x, y: p.y });
    while (p.points.length > p.length) p.points.pop();
  });

  const deadThisTick = [];

  // 這個 tick 的空間網格，碰撞判定跟子彈判定都共用，只需要建一次
  const collisionGrid = buildCollisionGrid(room);

  // 子彈移動與命中判定：要放在一般碰撞判定之前，被爆頭的玩家 alive 會馬上變 false，
  // 下面的迴圈開頭都會檢查 p.alive，就不會重複處理。
  updateBullets(room, deadThisTick, collisionGrid);

  // MOBA 模式：自動鎖定普攻（獨立於上面消耗身體的射擊機制，不會互相影響）
  if (room.mode === 'moba') {
    updateMobaAutoAttack(room);
    updateMobaBullets(room, deadThisTick, collisionGrid);
    updateMobaWaterTail(room, deadThisTick);
  }

  alivePlayers.forEach(p => {
    if (!p.alive) return;
    const invincible = Date.now() < p.invincibleUntil;
    if (invincible) return; // 出生保護時間內，無論如何都不會死
    const head = p.points[0];
    let dead = false;
    let killerId = null;
    if (head.x < 0 || head.x > worldW || head.y < 0 || head.y > worldH) {
      dead = true;
    }
    if (!dead && room.mode !== 'moba') {
      for (let i = SELF_COLLIDE_SKIP; i < p.points.length; i++) {
        if (dist2(head, p.points[i]) < (BODY_RADIUS * 1.1) ** 2) { dead = true; break; }
      }
    }
    if (!dead) {
      const isWindPhasing = room.mode === 'moba' && p.activeUltimateEffect === 'wind' && Date.now() < p.ultimateActiveUntil;
      const isFireRam = room.mode === 'moba' && p.activeUltimateEffect === 'fire' && Date.now() < p.ultimateActiveUntil;
      const isEarthPoise = room.mode === 'moba' && p.activeUltimateEffect === 'earth' && Date.now() < p.ultimateActiveUntil;

      if (!isWindPhasing) {
        const nearby = queryNearbyPoints(collisionGrid, head.x, head.y);
        for (const pt of nearby) {
          if (pt.ownerId === p.id) continue; // 自己的身體已經在上面另外判定過了
          const otherPlayer = room.players.get(pt.ownerId);
          if (room.mode === 'moba') {
            if (otherPlayer && otherPlayer.team === p.team) continue; // MOBA模式可以穿過隊友，不會互相碰撞
            // 風形幻影：無視碰撞體積，穿過它的身體不算碰撞
            if (otherPlayer && otherPlayer.activeUltimateEffect === 'wind' && Date.now() < otherPlayer.ultimateActiveUntil) continue;
          }
          if (dist2(head, pt) >= (BODY_RADIUS * 1.6) ** 2) continue;

          if (isFireRam && otherPlayer) {
            // 烈焰流星：撞到敵人不會讓自己死，改成造成高額爆炸傷害；擊殺對方會立刻重置冷卻
            // (不管對方這個tick是否已經因為別的原因死掉，火系本身都不會死於這次碰撞)
            if (otherPlayer.alive) {
              otherPlayer.hp = Math.max(0, otherPlayer.hp - MOBA_FIRE_EXPLOSION_DAMAGE);
              if (otherPlayer.hp <= 0) {
                otherPlayer.alive = false;
                deadThisTick.push(otherPlayer);
                room.eliminationOrder.push(otherPlayer.id);
                p.kills = (p.kills || 0) + 1;
                p.boostReadyAt = Date.now(); // 擊殺成功，加速立刻可以再用一次
                otherPlayer.respawnAt = Date.now() + computeMobaRespawnDelay(otherPlayer.level);
              }
            }
            continue; // 這一下不會讓自己死，繼續看還有沒有別的東西
          }
          if (isEarthPoise && otherPlayer) {
            // 大地護體：霸體不會死，還會把撞到的敵人擊退
            if (otherPlayer.alive && otherPlayer.points[0]) {
              const kbAngle = Math.atan2(otherPlayer.points[0].y - head.y, otherPlayer.points[0].x - head.x);
              otherPlayer.x += Math.cos(kbAngle) * MOBA_EARTH_KNOCKBACK_DIST;
              otherPlayer.y += Math.sin(kbAngle) * MOBA_EARTH_KNOCKBACK_DIST;
              otherPlayer.points[0].x = otherPlayer.x;
              otherPlayer.points[0].y = otherPlayer.y;
            }
            continue;
          }

          dead = true; killerId = pt.ownerId; break;
        }
      }
    }
    if (dead) {
      p.alive = false;
      deadThisTick.push(p);
      room.eliminationOrder.push(p.id);
      if (killerId) {
        const killer = room.players.get(killerId);
        if (killer) killer.kills = (killer.kills || 0) + 1;
      }
      if (room.mode === 'timed') p.respawnAt = Date.now() + RESPAWN_DELAY_MS;
      else if (room.mode === 'moba') p.respawnAt = Date.now() + computeMobaRespawnDelay(p.level);
    }
  });

  // 死亡瞬間，身體原地變成一堆跟自己顏色相同的食物，蛇本身立刻消失
  deadThisTick.forEach(p => {
    const step = Math.max(1, Math.floor(p.points.length / 18));
    for (let i = 0; i < p.points.length; i += step) {
      const pt = p.points[i];
      room.food.push({
        x: pt.x, y: pt.y, type: 'corpse', points: 8, growth: 3, color: p.color,
        expiresAt: Date.now() + 20000,
      });
    }
    p.points = [];
  });

  if (room.mode === 'moba') ensureMobaFood(room); else ensureFood(room);
  room.players.forEach(p => {
    if (!p.alive) return;
    const head = p.points[0];
    for (let i = room.food.length - 1; i >= 0; i--) {
      const f = room.food[i];
      if (dist2(head, f) < (FOOD_EAT_RADIUS + BODY_RADIUS) ** 2) {
        room.food.splice(i, 1);
        if (room.mode === 'moba') {
          gainMobaXp(p, f.points);
          p.length = Math.min(MOBA_LENGTH_CAP, p.length + f.growth);
        } else {
          p.score += f.points;
          if (f.type === 'speed') p.boostUntil = Date.now() + SPEED_BOOST_MS;
          else p.length += f.growth;
        }
      }
    }
  });

  // 限時模式：死亡的人時間到了就重生（分數/擊殺數保留）
  if (room.mode === 'timed') {
    room.players.forEach(p => {
      if (!p.alive && p.respawnAt && Date.now() >= p.respawnAt) respawnPlayer(p);
    });
  }

  // MOBA模式：死亡的人時間到了就在自己主堡重生（等級/經驗/元素/長度都保留，跟傳說對決一樣）
  if (room.mode === 'moba') {
    room.players.forEach(p => {
      if (!p.alive && p.respawnAt && Date.now() >= p.respawnAt) respawnMobaPlayer(p);
    });
  }

  let shouldEnd;
  let timeLeftMs = null;
  if (room.mode === 'timed') {
    timeLeftMs = Math.max(0, TIMED_MODE_DURATION_MS - (Date.now() - room.startedAt));
    shouldEnd = timeLeftMs <= 0;
  } else if (room.mode === 'moba') {
    // Phase 5：正式勝負條件，主堡血量歸零就結束（updateMobaBullets打中主堡時會設定room.mobaWinnerTeam）
    shouldEnd = !!room.mobaWinnerTeam;
  } else {
    const stillAlive = Array.from(room.players.values()).filter(p => p.alive);
    shouldEnd = (room.players.size > 1 && stillAlive.length <= 1) ||
      (room.players.size === 1 && stillAlive.length === 0);
  }

  // 送資料到前端這件事單獨節流成約15Hz，跟上面45ms的物理/碰撞判定分開，
  // 這樣省頻寬但完全不影響移動手感跟碰撞精準度（子彈判定還是用完整的45ms頻率在跑）。
  // 用「每3個tick送2次」的節奏（跳過第3次），平均下來 45ms*3/2=67.5ms ≈ 14.8Hz，比用時間戳記門檻更貼近15Hz
  // （時間戳記門檻會因為45ms的物理格子對不齊，直接跳到90ms=11Hz，反而偏離目標）。
  room.broadcastTickCounter = (room.broadcastTickCounter || 0) + 1;
  const shouldBroadcast = room.broadcastTickCounter % 3 !== 0;
  if (shouldBroadcast) {
    // 完整、未過濾的快照只用來給「斷線重連」使用（那個情境不常發生，直接給全部資料沒關係）
    const fullPlayersList = Array.from(room.players.values()).map(p => serializePlayerForClient(p, 'full'));
    const mobaBulletsForClient = room.mobaBullets.map(b => ({
      x: r1(b.x), y: r1(b.y), elementId: b.synthesis ? b.synthesis.id : null,
    }));
    const structuresForClient = (room.structures || []).map(s => ({
      id: s.id, team: s.team, type: s.type, tier: s.tier, lane: s.lane,
      x: r1(s.x), y: r1(s.y), hp: Math.round(s.hp), maxHp: s.maxHp, alive: s.alive,
    }));
    room.lastState = {
      world: { w: worldW, h: worldH },
      mode: room.mode,
      players: fullPlayersList,
      food: room.food,
      bullets: room.bullets.map(b => ({ x: r1(b.x), y: r1(b.y), color: b.color })),
      mobaBullets: mobaBulletsForClient,
      structures: structuresForClient,
      timeLeftMs,
      elapsedMs: Date.now() - room.startedAt,
    };

    // 一般 tick 廣播：改成「每個人只收到自己視野附近的東西」，不用整個地圖的食物/玩家資料都塞給每個人，
    // 地圖現在很大、食物又多，這一項是網路頻寬跟序列化成本最大的來源。
    const VIEW_CULL_MARGIN = 900; // 世界單位，比實際視野略大一點，留緩衝避免邊緣跳動
    room.players.forEach((viewer) => {
      if (viewer.isBot) return; // 電腦蛇不用送畫面資料給它

      // 死亡中的玩家可能正在拖曳畫面自由觀戰（生存模式），不知道他鏡頭實際在哪，
      // 乾脆直接給全地圖資料，反正同時間死掉在觀戰的人通常不多，這樣不會有「觀戰卻看不到東西」的問題。
      if (!viewer.alive) {
        io.to(viewer.id).emit('state_update', room.lastState);
        return;
      }

      const focus = viewer.points.length ? viewer.points[0] : { x: worldW / 2, y: worldH / 2 };
      const minX = focus.x - VIEW_CULL_MARGIN, maxX = focus.x + VIEW_CULL_MARGIN;
      const minY = focus.y - VIEW_CULL_MARGIN, maxY = focus.y + VIEW_CULL_MARGIN;
      const inView = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;

      const players = [];
      room.players.forEach((p) => {
        if (p.id === viewer.id) { players.push(serializePlayerForClient(p, 'full')); return; } // 自己一定要完整送
        if (p.points.length === 0) { players.push(serializePlayerForClient(p, 'near')); return; } // 已死亡，資料量本來就小
        const detail = inView(p.points[0].x, p.points[0].y) ? 'near' : 'far';
        players.push(serializePlayerForClient(p, detail));
      });

      const food = room.food.filter(f => inView(f.x, f.y)).map(f => ({
        x: r1(f.x), y: r1(f.y), type: f.type, color: f.color,
      }));
      const bullets = room.bullets.filter(b => inView(b.x, b.y)).map(b => ({ x: r1(b.x), y: r1(b.y), color: b.color }));
      const mobaBullets = room.mode === 'moba'
        ? mobaBulletsForClient.filter(b => inView(b.x, b.y))
        : [];

      io.to(viewer.id).emit('state_update', {
        world: { w: worldW, h: worldH },
        mode: room.mode,
        players,
        food,
        bullets,
        mobaBullets,
        structures: room.mode === 'moba' ? structuresForClient : [],
        timeLeftMs,
        elapsedMs: Date.now() - room.startedAt,
      });
    });
  }

  if (shouldEnd) endRound(room);

  // 小地圖專用廣播：跟上面「視野裁切」的主要畫面資料分開，這個是全地圖範圍、但頻率低很多（約每 0.5 秒一次），
  // 資料量很小（只有位置跟顏色），不會影響剛剛做的頻寬優化。
  room.minimapTickCounter = (room.minimapTickCounter || 0) + 1;
  if (room.minimapTickCounter >= 11) { // 45ms * 11 ≈ 0.5秒
    room.minimapTickCounter = 0;
    const minimapPlayers = Array.from(room.players.values())
      .filter(p => p.alive)
      .map(p => ({ id: p.id, x: r1(p.x), y: r1(p.y), color: p.color }));
    io.to(room.code).emit('minimap_update', { players: minimapPlayers });
  }
}

function r1(n) { return Math.round(n * 10) / 10; }

// 把玩家資料整理成要送給前端的格式。thin=true 的話身體節點會降低取樣密度（給「其他人」看的，
// 不需要跟自己那條蛇一樣精細），藉此縮小封包大小。
function serializePlayerForClient(p, detail) {
  // detail: 'full'(自己，完整送) / 'near'(視野內，長蛇的身體節點打折) / 'far'(視野外，直接不送身體座標省頻寬，
  // 但名字/分數/血量/等級這些排行榜跟HUD需要的欄位還是照送，不會讓排行榜看起來少人)
  let points = p.points;
  if (detail === 'far') {
    points = [];
  } else if (detail === 'near' && points.length > 30) {
    const out = [];
    for (let i = 0; i < points.length; i += 2) out.push(points[i]);
    points = out;
  }
  return {
    id: p.id, name: p.name, color: p.color, skin: p.skin || 'classic',
    points: points.map(pt => ({ x: r1(pt.x), y: r1(pt.y) })),
    alive: p.alive,
    score: p.score, kills: p.kills || 0,
    boosted: Date.now() < p.boostUntil || (p.manualBoost && p.length > MIN_BOOST_LENGTH),
    angle: Math.round(p.angle * 100) / 100,
    invincible: Date.now() < p.invincibleUntil, respawnAt: p.respawnAt || null,
    team: p.team || null, lane: p.lane || null,
    level: p.level || null, xp: p.xp || 0, hp: p.hp != null ? Math.round(p.hp) : null, maxHp: p.maxHp || null,
    attackSynthesis: p.attackSynthesis || null, attackPriority: p.attackPriority || 'kill',
    boostReadyAt: p.boostReadyAt || 0, ultimateType: p.ultimateType || null,
    ultimateActiveUntil: p.ultimateActiveUntil || 0,
  };
}

async function endRound(room) {
  if (room.status !== 'playing') return;
  room.status = 'ended';
  if (room.loop) { clearInterval(room.loop); room.loop = null; }

  if (room.mode === 'moba') {
    // Phase 5：用真正推掉的主堡決定勝負；金幣/戰績結算先保留給之後有需要再加，維持跟原本Phase 1~4一致的簡易結算
    const winner = room.mobaWinnerTeam || (Array.from(room.players.values()).some(p => p.team === 'A' && p.alive) ? 'A' : 'B');
    io.to(room.code).emit('moba_game_over', { winner });
    room.mobaWinnerTeam = null;
    setTimeout(() => {
      if (!rooms.has(room.code)) return;
      room.status = 'lobby';
      room.players.forEach(p => { p.ready = false; });
      broadcastRoom(room);
    }, 4000);
    return;
  }

  // 名次依模式決定：
  // 生存模式：還活著的人（通常是時間到才會有這種情況）排最前面，活著的人之間用分數排序；
  //          已淘汰的人接在後面，越晚被淘汰名次越前面（撐得越久名次越好）。
  // 限時模式：大家都會不斷重生，不看誰活著，直接依「擊殺數」排名，分數當同分時的第二排序依據。
  let orderedPlayers;
  if (room.mode === 'timed') {
    orderedPlayers = Array.from(room.players.values())
      .sort((a, b) => (b.kills || 0) - (a.kills || 0) || b.score - a.score);
  } else {
    const stillAlive = Array.from(room.players.values())
      .filter(p => p.alive)
      .sort((a, b) => b.score - a.score);
    const eliminatedOrdered = room.eliminationOrder
      .slice()
      .reverse()
      .map(id => room.players.get(id))
      .filter(Boolean);
    orderedPlayers = [...stillAlive, ...eliminatedOrdered];
  }

  const rankings = orderedPlayers.map((p, i) => ({
    id: p.id, uid: p.uid || null, name: p.name, score: p.score, kills: p.kills || 0, rank: i + 1,
  }));
  const rankById = new Map(rankings.map(r => [r.id, r.rank]));
  const totalRanked = orderedPlayers.length;

  io.to(room.code).emit('game_over', { rankings, mode: room.mode });

  if (db) {
    const currentWeekId = getWeekId();
    // 只算真人數量：跟電腦蛇打（不管幾隻）都不算「有其他人」，只有真的跟其他真人玩家一起玩才會發金幣
    const realHumanCount = Array.from(room.players.values()).filter(p => p.uid).length;
    const soloRound = realHumanCount <= 1;
    // 依 uid 去重：正常情況下不會有重複，這裡是防呆，避免萬一有殘留的重複連線紀錄導致同一個人被算兩次
    const seenUids = new Set();
    const uniquePlayersWithUid = Array.from(room.players.values()).filter((p) => {
      if (!p.uid) return false;
      if (seenUids.has(p.uid)) return false;
      seenUids.add(p.uid);
      return true;
    });
    const writes = uniquePlayersWithUid
      .map(async (p) => {
        const ref = db.collection('users').doc(p.uid);
        try {
          const rank = rankById.get(p.id) || totalRanked;
          const earnedCoins = soloRound ? 0 : computeRankCoins(rank, totalRanked);
          const newCoins = await db.runTransaction(async (tx) => {
            const doc = await tx.get(ref);
            const data = doc.exists ? doc.data() : {};
            const prevBest = data.highScore || 0;
            const gamesPlayed = data.gamesPlayed || 0;
            const prevWeeklyBest = data.weeklyWeekId === currentWeekId ? (data.weeklyHighScore || 0) : 0;
            const prevCoins = data.coins || 0;
            const updatedCoins = prevCoins + earnedCoins;
            const prevKills = data.totalKills || 0;
            const prevWins = data.wins || 0;
            const isWin = !soloRound && rank === 1;
            const looksLikePlaceholderName = /^訪客/.test(p.name || '');
            const writeData = {
              highScore: Math.max(prevBest, p.score),
              gamesPlayed: gamesPlayed + 1,
              lastPlayedAt: admin.firestore.FieldValue.serverTimestamp(),
              weeklyHighScore: Math.max(prevWeeklyBest, p.score),
              weeklyWeekId: currentWeekId,
              coins: updatedCoins,
              totalKills: prevKills + (p.kills || 0),
              wins: prevWins + (isWin ? 1 : 0),
            };
            // 防呆：名字看起來像「訪客XXXX」這種暫時佔位名的話，絕對不要拿去覆蓋 Firestore 裡原本存好的正確暱稱
            if (!looksLikePlaceholderName) writeData.displayName = p.name;
            tx.set(ref, writeData, { merge: true });
            return updatedCoins;
          });
          if (earnedCoins > 0) {
            io.to(p.id).emit('coins_earned', { earned: earnedCoins, total: newCoins });
          }
        } catch (e) {
          console.error('寫入分數失敗', p.uid, e.message);
        }
      });
    await Promise.all(writes);
  }

  setTimeout(() => {
    if (!rooms.has(room.code)) return;
    room.status = 'lobby';
    for (const [id, p] of room.players.entries()) {
      if (p.isBot) room.players.delete(id);
    }
    room.players.forEach(p => { p.ready = false; });
    broadcastRoom(room);
  }, 4000);
}

function removePlayerFromRoom(socketId) {
  for (const room of rooms.values()) {
    if (room.players.has(socketId)) {
      const p = room.players.get(socketId);
      if (p && p.reconnectTimer) clearTimeout(p.reconnectTimer);
      room.players.delete(socketId);
      if (room.players.size === 0) {
        if (room.loop) clearInterval(room.loop);
        rooms.delete(room.code);
      } else {
        if (room.hostId === socketId) {
          room.hostId = room.players.keys().next().value;
        }
        broadcastRoom(room);
      }
      return;
    }
  }
}

// 嘗試把這個新連線跟某個「還在斷線寬限期內」的舊玩家配對回去（用瀏覽器端存的 sessionId 比對）
function attemptReconnect(socket) {
  const sessionId = socket.data.sessionId;
  if (!sessionId) return false;
  for (const room of rooms.values()) {
    for (const [oldSocketId, p] of room.players.entries()) {
      if (p.sessionId === sessionId && p.disconnected) {
        room.players.delete(oldSocketId);
        if (p.reconnectTimer) clearTimeout(p.reconnectTimer);
        p.disconnected = false;
        p.reconnectTimer = null;
        p.id = socket.id;
        room.players.set(socket.id, p);
        if (room.hostId === oldSocketId) room.hostId = socket.id;

        socket.join(room.code);
        socket.data.roomCode = room.code;
        socket.data.uid = p.uid;
        socket.data.name = p.name;

        socket.emit('reconnected', {
          code: room.code,
          status: room.status,
          state: room.status === 'playing' ? room.lastState : null,
        });
        broadcastRoom(room);
        return true;
      }
    }
  }
  return false;
}


// ---------- 其他模組（socketHandlers.js / restRoutes.js）需要用到的東西 ----------
return {
  rooms,
  createRoom,
  startCountdown,
  removePlayerFromRoom,
  attemptReconnect,
  broadcastRoom,
  fireBullet,
  getWeekId,
  chooseMobaElement,
  useMobaBoost,
};
};
