// ---------- 遊戲參數（連續座標，平滑移動） ----------
// 這個檔案只放常數設定，內容從原本 server.js 原封不動搬過來，數值完全沒有變動。
const WORLD_W = 8000;
const WORLD_H = 5000;
const TICK_MS = 45; // 約 22 次/秒（移動/碰撞判定用這個頻率，維持精準手感）
// 畫面資料送出的頻率改用tick計數器控制(每3個tick送2次≈14.8Hz)，詳見gameEngine.js的tickRoom
const MAX_PLAYERS = 100;
const TIMED_MODE_DURATION_MS = 3 * 60 * 1000; // 限時模式：固定3分鐘
const RESPAWN_DELAY_MS = 3000;                 // 限時模式：死亡後幾秒重生

const BASE_SPEED = 4.4;
const BOOST_SPEED = 8.4;
const MAX_TURN_RATE = 0.16;
const BODY_RADIUS = 9;
const SELF_COLLIDE_SKIP = 16;
const BASE_LENGTH = 42;
const FOOD_EAT_RADIUS = 16;
const SPEED_BOOST_MS = 5000;
const SUPER_FOOD_LIFETIME_MS = 9000;
const SPAWN_INVINCIBLE_MS = 2500; // 新手出生保護時間
const MIN_BOOST_LENGTH = BASE_LENGTH; // 長度低於這個值就不能手動加速
const BOOST_DRAIN_INTERVAL_TICKS = 3; // 每幾個 tick 消耗一次長度
const BOOST_DRAIN_AMOUNT = 1; // 每次消耗的長度
const RECONNECT_GRACE_MS = 20000; // 斷線後的重連寬限時間
const REPORT_THRESHOLD = 5; // 同一人被檢舉幾次後自動限制
const RESTRICTION_DURATION_MS = 24 * 60 * 60 * 1000; // 限制持續24小時（禁止建立房間）

const BULLET_SPEED = 15;       // 子彈每個 tick 前進的像素數（比蛇快很多）
const BULLET_RANGE = 480;      // 子彈最大飛行距離，超過就消失
const BULLET_RADIUS = 6;
const MIN_SHOOT_LENGTH = BASE_LENGTH; // 長度要超過這個值才能開槍（開槍會消耗1節）
const BODY_HIT_SEGMENT_LOSS = 2;      // 打中身體扣幾節（沒有下限保護，扣到快沒了就會死）
const DEATH_LENGTH_THRESHOLD = 3;     // 長度被打到低於這個值就直接死亡

// 造型商店：純外觀，不影響任何遊戲數值
const SKIN_CATALOG = {
  classic: { name: '經典', price: 0 },
  watermelon: { name: '西瓜', price: 760 },
  orange: { name: '橘子', price: 760 },
  apple: { name: '蘋果', price: 760 },
  basketball: { name: '籃球', price: 800 },
  baseball: { name: '棒球', price: 800 },
  soccer: { name: '足球', price: 800 },
  tennis: { name: '網球', price: 800 },
  coin: { name: '金幣', price: 900 },
};
// 依名次發放金幣（不看分數/吃的數量），第1名拿最多，依序遞減；名次超出表格範圍就是 0
const COIN_BY_RANK = [50, 35, 25, 18, 12, 8, 5, 3];
function computeRankCoins(rank) {
  return COIN_BY_RANK[rank - 1] || 0;
}

// 電腦蛇難度預設：updateEvery=每幾個tick才重新決策一次(數字越大反應越慢)，
// lookDist=避障時往前看的距離點，huntEnabled=是否會主動盯人，
// angleError=決策時加入的隨機誤差(數字越大越容易手殘)，boostChance=每次決策時衝刺的機率
const BOT_PRESETS = {
  easy: { updateEvery: 6, lookDist: [20, 36, 52], huntEnabled: false, angleError: 0.5, foodSearchRadius: 320, huntRadius: 0, boostChance: 0, canShoot: false },
  normal: { updateEvery: 3, lookDist: [22, 44, 66], huntEnabled: false, angleError: 0.15, foodSearchRadius: 480, huntRadius: 0, boostChance: 0.02, canShoot: false },
  hard: { updateEvery: 1, lookDist: [26, 52, 80, 110], huntEnabled: true, angleError: 0, foodSearchRadius: 700, huntRadius: 450, boostChance: 0.06, canShoot: true, shootRange: 420 },
};

const COLORS = ['#FF6B81', '#4FD1C5', '#FFC857', '#7C83FD', '#8AC926',
  '#FF9F1C', '#B983FF', '#3AB0FF'];

// 空間網格：碰撞判定用
const COLLISION_CELL_SIZE = 120;

// 食物數量依地圖面積換算密度，地圖變大/變小的話這裡會自動跟著調整，不會再因為地圖放大而變稀疏
const FOOD_DENSITY_AREA_PER_ITEM = 85000; // 大約每這麼多平方像素放一顆一般食物
const NORMAL_FOOD_TARGET = Math.round((WORLD_W * WORLD_H) / FOOD_DENSITY_AREA_PER_ITEM);
const SUPER_FOOD_TARGET = Math.max(3, Math.round(NORMAL_FOOD_TARGET / 40));
const SPEED_FOOD_TARGET = Math.max(2, Math.round(NORMAL_FOOD_TARGET / 55));

// ---------- MOBA 模式（推塔對決）專屬設定 ----------
// 正方形地圖，左下到右上對角線佈局，三條路連接兩邊主堡，模仿MOBA遊戲但規則不完全相同
const MOBA_WORLD_SIZE = 4000;
const MOBA_BASE_A = { x: 420, y: MOBA_WORLD_SIZE - 420 };   // A隊主堡：左下角
const MOBA_BASE_B = { x: MOBA_WORLD_SIZE - 420, y: 420 };   // B隊主堡：右上角
// 三條路的路線點（給前端畫參考線用，也給重生/出生點定位用）：上路、中路、下路
const MOBA_LANES = {
  top: [
    { x: MOBA_BASE_A.x, y: MOBA_BASE_A.y },
    { x: 420, y: 420 },
    { x: MOBA_BASE_B.x, y: MOBA_BASE_B.y },
  ],
  mid: [
    { x: MOBA_BASE_A.x, y: MOBA_BASE_A.y },
    { x: MOBA_WORLD_SIZE / 2, y: MOBA_WORLD_SIZE / 2 },
    { x: MOBA_BASE_B.x, y: MOBA_BASE_B.y },
  ],
  bottom: [
    { x: MOBA_BASE_A.x, y: MOBA_BASE_A.y },
    { x: MOBA_WORLD_SIZE - 420, y: MOBA_WORLD_SIZE - 420 },
    { x: MOBA_BASE_B.x, y: MOBA_BASE_B.y },
  ],
};
const MOBA_TEAM_SIZE = 3; // 先做 3 打 3
const MOBA_MAX_LEVEL = 6;
const MOBA_LENGTH_CAP = 20; // 長度上限20節，吃到上限後一樣可以吃(只是不會再變長)
const MOBA_BASE_LENGTH = 8; // MOBA模式出生時比較短，之後靠吃果實長到上限20節
const MOBA_BASE_HP = 100;

// 升級所需經驗值：1→2級, 2→3級, 3→4級, 4→5級, 5→6級（越後面需要越多，符合MOBA遊戲的手感）
const MOBA_XP_THRESHOLDS = [30, 50, 80, 120, 170];
const MOBA_FRUIT_XP = 10;   // 每顆果實給的經驗值
const MOBA_FRUIT_GROWTH = 1; // 每顆果實增加的長度（吃到20節上限後不會再變長）
const MOBA_FRUIT_TARGET = 70; // 地圖上同時維持的果實數量

// 四元素被動加成：每級選1個，永久生效（就算之後合成技能，屬性還是繼續加）
const MOBA_ELEMENT_BONUS = {
  fire: { attack: 4 },        // 火：+攻擊
  water: { attackSpeed: 0.08 }, // 水：+攻速（8%）
  earth: { hp: 20 },           // 土：+血量
  wind: { moveSpeed: 0.05 },   // 風：+跑速（5%）
};

// ---------- Phase 3：自動鎖定普攻 / 屬性相剋 / 3級技能合成 ----------
const MOBA_ATTACK_RANGE = 260;        // 自動鎖定的範圍，範圍內有目標就自動打
const MOBA_BASE_ATTACK_INTERVAL_MS = 700; // 基礎攻擊間隔，水元素的攻速會縮短這個時間
const MOBA_BASE_ATTACK_DAMAGE = 8;
const MOBA_ATTACK_BULLET_SPEED = 14;
const MOBA_ATTACK_BULLET_RANGE = 300;
const MOBA_ELEMENT_COUNTER_MULTIPLIER = 1.5; // 屬性相剋多造成的傷害倍率
// 相剋關係：水剋火、火剋風、地剋水、風剋地（key 剋 value）
const MOBA_ELEMENT_COUNTERS = { water: 'fire', fire: 'wind', earth: 'water', wind: 'earth' };
// 3級技能合成：3個都選同一元素 -> 強化版該元素球；2+1混合 -> 取數量較多的元素；
// 3個都不同 -> 合成特殊組合技（跟任何人都不相剋）
const MOBA_COMBO_ATTACKS = {
  'earth+fire+water': { id: 'mudball', name: '沸泥彈' },
  'fire+water+wind': { id: 'steamball', name: '蒸汽彈' },
  'earth+fire+wind': { id: 'sandball', name: '沙彈' },
  'earth+water+wind': { id: 'iceball', name: '寒冰彈' },
};

// ---------- Phase 4：4~6級選的元素決定加速鍵變成什麼大招 ----------
const MOBA_BOOST_COOLDOWN_MIN_MS = 5000;  // 1級的冷卻時間
const MOBA_BOOST_COOLDOWN_MAX_MS = 20000; // 6級的冷卻時間

// 6級之前按加速鍵：只是基礎衝刺，沒有特殊效果
const MOBA_BASIC_DASH_SPEED_MULT = 1.4;
const MOBA_BASIC_DASH_DURATION_MS = 1500;

// 【火系主導】烈焰流星：中等爆發速度，撞到敵人造成高額爆炸傷害且不會讓自己死，擊殺後立刻重置冷卻
const MOBA_FIRE_DURATION_MS = 2000;
const MOBA_FIRE_SPEED_MULT = 1.7;
const MOBA_FIRE_EXPLOSION_DAMAGE = 45;

// 【水系主導】激流迴旋：穩定加速，蛇尾持續對後方敵人造成傷害跟微幅減速
const MOBA_WATER_DURATION_MS = 2500;
const MOBA_WATER_SPEED_MULT = 1.3;
const MOBA_WATER_TAIL_RANGE = 55;
const MOBA_WATER_TAIL_DAMAGE = 4;
const MOBA_WATER_TAIL_TICK_INTERVAL_MS = 300; // 水花傷害的間隔，不會每個tick都打
const MOBA_WATER_SLOW_MULTIPLIER = 0.65;
const MOBA_WATER_SLOW_DURATION_MS = 900;

// 【土系主導】大地護體：小幅加速+霸體(免疫碰撞死亡)，撞到敵人會把對方擊退
const MOBA_EARTH_DURATION_MS = 2500;
const MOBA_EARTH_SPEED_MULT = 1.15;
const MOBA_EARTH_KNOCKBACK_DIST = 45;

// 【風系主導】風形幻影：全遊戲最快速度，無視碰撞體積(可以穿過小兵/塔/敵方蛇身)
const MOBA_WIND_DURATION_MS = 2000;
const MOBA_WIND_SPEED_MULT = 2.0;

// 四種元素選得不夠集中(平手或四種都有)：只有中等加速，沒有特殊效果
const MOBA_BALANCED_DURATION_MS = 2500;
const MOBA_BALANCED_SPEED_MULT = 1.25;

// ---------- Phase 5：塔與主堡 ----------
// 每條路（上/中/下）各有 2 個外塔 + 1 個高地塔，兩隊各9座塔，加上各自1座主堡
const MOBA_OUTER_TOWER_HP = 300;
const MOBA_HIGHLAND_TOWER_HP = 500;
const MOBA_MAIN_BASE_HP = 800;
const MOBA_STRUCTURE_HIT_RADIUS = 40; // 塔/主堡的判定半徑(子彈打中的範圍)
// 塔沿著「自己主堡 -> 該路線中繼點」這條線內插生成，0=在主堡上，1=在中繼點上
const MOBA_HIGHLAND_TOWER_POSITION = 0.15;
const MOBA_OUTER_TOWER_1_POSITION = 0.38;
const MOBA_OUTER_TOWER_2_POSITION = 0.6;

// 死亡後的重生時間：等級越高、重生越久（1級3秒 ~ 6級15秒），跟傳說對決一樣的設計邏輯
const MOBA_RESPAWN_MIN_MS = 3000;
const MOBA_RESPAWN_MAX_MS = 15000;

module.exports = {
  WORLD_W, WORLD_H, TICK_MS, MAX_PLAYERS, TIMED_MODE_DURATION_MS, RESPAWN_DELAY_MS,
  BASE_SPEED, BOOST_SPEED, MAX_TURN_RATE, BODY_RADIUS, SELF_COLLIDE_SKIP, BASE_LENGTH,
  FOOD_EAT_RADIUS, SPEED_BOOST_MS, SUPER_FOOD_LIFETIME_MS, SPAWN_INVINCIBLE_MS,
  MIN_BOOST_LENGTH, BOOST_DRAIN_INTERVAL_TICKS, BOOST_DRAIN_AMOUNT, RECONNECT_GRACE_MS,
  REPORT_THRESHOLD, RESTRICTION_DURATION_MS, BULLET_SPEED, BULLET_RANGE, BULLET_RADIUS,
  MIN_SHOOT_LENGTH, BODY_HIT_SEGMENT_LOSS, DEATH_LENGTH_THRESHOLD, SKIN_CATALOG,
  COIN_BY_RANK, computeRankCoins, BOT_PRESETS, COLORS, COLLISION_CELL_SIZE,
  FOOD_DENSITY_AREA_PER_ITEM, NORMAL_FOOD_TARGET, SUPER_FOOD_TARGET, SPEED_FOOD_TARGET,
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
};
