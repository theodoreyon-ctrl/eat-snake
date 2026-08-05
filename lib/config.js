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
const MOBA_BASE_A = { x: 430, y: MOBA_WORLD_SIZE - 430 };   // A隊主堡：左下角
const MOBA_BASE_B = { x: MOBA_WORLD_SIZE - 430, y: 430 };   // B隊主堡：右上角
// 三條路的路線點（給前端畫參考線用，也給重生/出生點定位用）：上路、中路、下路
const MOBA_LANES = {
  top: [
    { x: MOBA_BASE_A.x, y: MOBA_BASE_A.y },
    { x: 430, y: 430 },
    { x: MOBA_BASE_B.x, y: MOBA_BASE_B.y },
  ],
  mid: [
    { x: MOBA_BASE_A.x, y: MOBA_BASE_A.y },
    { x: MOBA_WORLD_SIZE / 2, y: MOBA_WORLD_SIZE / 2 },
    { x: MOBA_BASE_B.x, y: MOBA_BASE_B.y },
  ],
  bottom: [
    { x: MOBA_BASE_A.x, y: MOBA_BASE_A.y },
    { x: MOBA_WORLD_SIZE - 430, y: MOBA_WORLD_SIZE - 430 },
    { x: MOBA_BASE_B.x, y: MOBA_BASE_B.y },
  ],
};
const MOBA_TEAM_SIZE = 3; // 先做 3 打 3
const MOBA_MAX_LEVEL = 7; // 7級才能選滿6個元素(前3個決定普攻合成、後3個決定大招)，6級的話只能選到5個
const MOBA_LENGTH_CAP = 20; // 長度上限20節，吃到上限後一樣可以吃(只是不會再變長)
const MOBA_BASE_LENGTH = 8; // MOBA模式出生時比較短，之後靠吃果實長到上限20節
const MOBA_BASE_HP = 100;

// 升級所需經驗值：1→2級, 2→3級, 3→4級, 4→5級, 5→6級（越後面需要越多，符合MOBA遊戲的手感）
const MOBA_XP_THRESHOLDS = [30, 50, 80, 120, 170, 220];
const MOBA_FRUIT_XP = 5;   // 每顆果實給的經驗值(原本10，減半)
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
const MOBA_FIELD_MIN = 430; // 場地邊界矩形：(430,3570)(430,430)(3570,430)(3570,3570)
const MOBA_FIELD_MAX = 3570;
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
const MOBA_MAIN_BASE_POSITION = 0.12; // 主堡結構往內縮一點，不要正好卡在地圖最角落
const MOBA_HIGHLAND_TOWER_POSITION = 0.30;
const MOBA_OUTER_TOWER_1_POSITION = 0.52;
const MOBA_OUTER_TOWER_2_POSITION = 0.72;

// 死亡後的重生時間：等級越高、重生越久（1級3秒 ~ 6級15秒），跟傳說對決一樣的設計邏輯
const MOBA_RESPAWN_MIN_MS = 3000;
const MOBA_RESPAWN_MAX_MS = 15000;

// ---------- 地形限制：不能亂走，只能沿著河道走 ----------
// 石頭資料目前是空的，用 tools/rock-editor.html 這個編輯器手動擺放後，
// 把匯出的座標貼到這裡取代這個空陣列即可。
const MOBA_ROCKS = [
  { points: [{ x: 2073, y: 2194 }, { x: 1849, y: 2408 }, { x: 1909, y: 2532 }, { x: 2102, y: 2572 }, { x: 2162, y: 2353 }] },
  { points: [{ x: 1806, y: 1927 }, { x: 1592, y: 2151 }, { x: 1468, y: 2091 }, { x: 1428, y: 1898 }, { x: 1647, y: 1838 }] },
  { points: [{ x: 2194, y: 2073 }, { x: 2408, y: 1849 }, { x: 2532, y: 1909 }, { x: 2572, y: 2102 }, { x: 2353, y: 2162 }] },
  { points: [{ x: 1927, y: 1806 }, { x: 2151, y: 1592 }, { x: 2091, y: 1468 }, { x: 1898, y: 1428 }, { x: 1838, y: 1647 }] },
  { points: [{ x: 994, y: 3297 }, { x: 1302, y: 2989 }, { x: 1456, y: 2905 }, { x: 1566, y: 2934 }, { x: 1645, y: 3153 }, { x: 1809, y: 3287 }, { x: 1740, y: 3302 }] },
  { points: [{ x: 703, y: 3006 }, { x: 1011, y: 2698 }, { x: 1095, y: 2544 }, { x: 1066, y: 2434 }, { x: 847, y: 2355 }, { x: 713, y: 2191 }, { x: 698, y: 2260 }] },
  { points: [{ x: 3297, y: 994 }, { x: 2989, y: 1302 }, { x: 2905, y: 1456 }, { x: 2934, y: 1566 }, { x: 3153, y: 1645 }, { x: 3287, y: 1809 }, { x: 3302, y: 1740 }] },
  { points: [{ x: 3006, y: 703 }, { x: 2698, y: 1011 }, { x: 2544, y: 1095 }, { x: 2434, y: 1066 }, { x: 2355, y: 847 }, { x: 2191, y: 713 }, { x: 2260, y: 698 }] },
  { points: [{ x: 1615, y: 2741 }, { x: 1730, y: 2567 }, { x: 1948, y: 2800 }, { x: 1933, y: 2900 }, { x: 1819, y: 2910 }, { x: 1680, y: 2855 }] },
  { points: [{ x: 1259, y: 2385 }, { x: 1433, y: 2270 }, { x: 1200, y: 2052 }, { x: 1100, y: 2067 }, { x: 1090, y: 2181 }, { x: 1145, y: 2320 }] },
  { points: [{ x: 2741, y: 1615 }, { x: 2567, y: 1730 }, { x: 2800, y: 1948 }, { x: 2900, y: 1933 }, { x: 2910, y: 1819 }, { x: 2855, y: 1680 }] },
  { points: [{ x: 2385, y: 1259 }, { x: 2270, y: 1433 }, { x: 2052, y: 1200 }, { x: 2067, y: 1100 }, { x: 2181, y: 1090 }, { x: 2320, y: 1145 }] },
  { points: [{ x: 1953, y: 3128 }, { x: 1988, y: 3267 }, { x: 2684, y: 3277 }, { x: 2773, y: 3188 }, { x: 2555, y: 3103 }, { x: 2266, y: 3059 }] },
  { points: [{ x: 872, y: 2047 }, { x: 733, y: 2012 }, { x: 723, y: 1316 }, { x: 812, y: 1227 }, { x: 897, y: 1445 }, { x: 941, y: 1734 }] },
  { points: [{ x: 3128, y: 1953 }, { x: 3267, y: 1988 }, { x: 3277, y: 2684 }, { x: 3188, y: 2773 }, { x: 3103, y: 2555 }, { x: 3059, y: 2266 }] },
  { points: [{ x: 2047, y: 872 }, { x: 2012, y: 733 }, { x: 1316, y: 723 }, { x: 1227, y: 812 }, { x: 1445, y: 897 }, { x: 1734, y: 941 }] },
  { points: [{ x: 2903, y: 3267 }, { x: 3141, y: 3262 }, { x: 3042, y: 3168 }, { x: 2927, y: 3168 }] },
  { points: [{ x: 733, y: 1097 }, { x: 738, y: 859 }, { x: 832, y: 958 }, { x: 832, y: 1073 }] },
  { points: [{ x: 3267, y: 2903 }, { x: 3262, y: 3141 }, { x: 3168, y: 3042 }, { x: 3168, y: 2927 }] },
  { points: [{ x: 1097, y: 733 }, { x: 859, y: 738 }, { x: 958, y: 832 }, { x: 1073, y: 832 }] },
  { points: [{ x: 2371, y: 2552 }, { x: 2599, y: 2716 }, { x: 2768, y: 2984 }, { x: 2525, y: 2915 }, { x: 2326, y: 2790 }, { x: 2286, y: 2691 }] },
  { points: [{ x: 1448, y: 1629 }, { x: 1284, y: 1401 }, { x: 1016, y: 1232 }, { x: 1085, y: 1475 }, { x: 1210, y: 1674 }, { x: 1309, y: 1714 }] },
  { points: [{ x: 2552, y: 2371 }, { x: 2716, y: 2599 }, { x: 2984, y: 2768 }, { x: 2915, y: 2525 }, { x: 2790, y: 2326 }, { x: 2691, y: 2286 }] },
  { points: [{ x: 1629, y: 1448 }, { x: 1401, y: 1284 }, { x: 1232, y: 1016 }, { x: 1475, y: 1085 }, { x: 1674, y: 1210 }, { x: 1714, y: 1309 }] },
  { points: [{ x: 1806, y: 1927 }, { x: 1592, y: 2151 }, { x: 1468, y: 2091 }, { x: 1428, y: 1898 }, { x: 1647, y: 1838 }] },
  { points: [{ x: 2073, y: 2194 }, { x: 1849, y: 2408 }, { x: 1909, y: 2532 }, { x: 2102, y: 2572 }, { x: 2162, y: 2353 }] },
  { points: [{ x: 1927, y: 1806 }, { x: 2151, y: 1592 }, { x: 2091, y: 1468 }, { x: 1898, y: 1428 }, { x: 1838, y: 1647 }] },
  { points: [{ x: 2194, y: 2073 }, { x: 2408, y: 1849 }, { x: 2532, y: 1909 }, { x: 2572, y: 2102 }, { x: 2353, y: 2162 }] },
  { points: [{ x: 703, y: 3006 }, { x: 1011, y: 2698 }, { x: 1095, y: 2544 }, { x: 1066, y: 2434 }, { x: 847, y: 2355 }, { x: 713, y: 2191 }, { x: 698, y: 2260 }] },
  { points: [{ x: 994, y: 3297 }, { x: 1302, y: 2989 }, { x: 1456, y: 2905 }, { x: 1566, y: 2934 }, { x: 1645, y: 3153 }, { x: 1809, y: 3287 }, { x: 1740, y: 3302 }] },
  { points: [{ x: 3006, y: 703 }, { x: 2698, y: 1011 }, { x: 2544, y: 1095 }, { x: 2434, y: 1066 }, { x: 2355, y: 847 }, { x: 2191, y: 713 }, { x: 2260, y: 698 }] },
  { points: [{ x: 3297, y: 994 }, { x: 2989, y: 1302 }, { x: 2905, y: 1456 }, { x: 2934, y: 1566 }, { x: 3153, y: 1645 }, { x: 3287, y: 1809 }, { x: 3302, y: 1740 }] },
  { points: [{ x: 1259, y: 2385 }, { x: 1433, y: 2270 }, { x: 1200, y: 2052 }, { x: 1100, y: 2067 }, { x: 1090, y: 2181 }, { x: 1145, y: 2320 }] },
  { points: [{ x: 1615, y: 2741 }, { x: 1730, y: 2567 }, { x: 1948, y: 2800 }, { x: 1933, y: 2900 }, { x: 1819, y: 2910 }, { x: 1680, y: 2855 }] },
  { points: [{ x: 2385, y: 1259 }, { x: 2270, y: 1433 }, { x: 2052, y: 1200 }, { x: 2067, y: 1100 }, { x: 2181, y: 1090 }, { x: 2320, y: 1145 }] },
  { points: [{ x: 2741, y: 1615 }, { x: 2567, y: 1730 }, { x: 2800, y: 1948 }, { x: 2900, y: 1933 }, { x: 2910, y: 1819 }, { x: 2855, y: 1680 }] },
  { points: [{ x: 872, y: 2047 }, { x: 733, y: 2012 }, { x: 723, y: 1316 }, { x: 812, y: 1227 }, { x: 897, y: 1445 }, { x: 941, y: 1734 }] },
  { points: [{ x: 1953, y: 3128 }, { x: 1988, y: 3267 }, { x: 2684, y: 3277 }, { x: 2773, y: 3188 }, { x: 2555, y: 3103 }, { x: 2266, y: 3059 }] },
  { points: [{ x: 2047, y: 872 }, { x: 2012, y: 733 }, { x: 1316, y: 723 }, { x: 1227, y: 812 }, { x: 1445, y: 897 }, { x: 1734, y: 941 }] },
  { points: [{ x: 3128, y: 1953 }, { x: 3267, y: 1988 }, { x: 3277, y: 2684 }, { x: 3188, y: 2773 }, { x: 3103, y: 2555 }, { x: 3059, y: 2266 }] },
  { points: [{ x: 733, y: 1097 }, { x: 738, y: 859 }, { x: 832, y: 958 }, { x: 832, y: 1073 }] },
  { points: [{ x: 2903, y: 3267 }, { x: 3141, y: 3262 }, { x: 3042, y: 3168 }, { x: 2927, y: 3168 }] },
  { points: [{ x: 1097, y: 733 }, { x: 859, y: 738 }, { x: 958, y: 832 }, { x: 1073, y: 832 }] },
  { points: [{ x: 3267, y: 2903 }, { x: 3262, y: 3141 }, { x: 3168, y: 3042 }, { x: 3168, y: 2927 }] },
  { points: [{ x: 1448, y: 1629 }, { x: 1284, y: 1401 }, { x: 1016, y: 1232 }, { x: 1085, y: 1475 }, { x: 1210, y: 1674 }, { x: 1309, y: 1714 }] },
  { points: [{ x: 2371, y: 2552 }, { x: 2599, y: 2716 }, { x: 2768, y: 2984 }, { x: 2525, y: 2915 }, { x: 2326, y: 2790 }, { x: 2286, y: 2691 }] },
  { points: [{ x: 1629, y: 1448 }, { x: 1401, y: 1284 }, { x: 1232, y: 1016 }, { x: 1475, y: 1085 }, { x: 1674, y: 1210 }, { x: 1714, y: 1309 }] },
  { points: [{ x: 2552, y: 2371 }, { x: 2716, y: 2599 }, { x: 2984, y: 2768 }, { x: 2915, y: 2525 }, { x: 2790, y: 2326 }, { x: 2691, y: 2286 }] },
];
// 草叢：不擋路，但站在裡面對敵人隱形（除非敵人也站在同一叢草裡）。用 tools/rock-editor.html 編輯。
const MOBA_BUSHES = [
  { points: [{ x: 1613, y: 2735 }, { x: 1678, y: 2849 }, { x: 1683, y: 2874 }, { x: 1668, y: 2879 }, { x: 1628, y: 2869 }, { x: 1608, y: 2824 }, { x: 1594, y: 2784 }, { x: 1584, y: 2750 }] },
  { points: [{ x: 1265, y: 2387 }, { x: 1151, y: 2322 }, { x: 1126, y: 2317 }, { x: 1121, y: 2332 }, { x: 1131, y: 2372 }, { x: 1176, y: 2392 }, { x: 1216, y: 2406 }, { x: 1250, y: 2416 }] },
  { points: [{ x: 2735, y: 1613 }, { x: 2849, y: 1678 }, { x: 2874, y: 1683 }, { x: 2879, y: 1668 }, { x: 2869, y: 1628 }, { x: 2824, y: 1608 }, { x: 2784, y: 1594 }, { x: 2750, y: 1584 }] },
  { points: [{ x: 2387, y: 1265 }, { x: 2322, y: 1151 }, { x: 2317, y: 1126 }, { x: 2332, y: 1121 }, { x: 2372, y: 1131 }, { x: 2392, y: 1176 }, { x: 2406, y: 1216 }, { x: 2416, y: 1250 }] },
  { points: [{ x: 1906, y: 2521 }, { x: 1886, y: 2556 }, { x: 1971, y: 2591 }, { x: 2030, y: 2586 }, { x: 2090, y: 2591 }, { x: 2100, y: 2566 }] },
  { points: [{ x: 1479, y: 2094 }, { x: 1444, y: 2114 }, { x: 1409, y: 2029 }, { x: 1414, y: 1970 }, { x: 1409, y: 1910 }, { x: 1434, y: 1900 }] },
  { points: [{ x: 2521, y: 1906 }, { x: 2556, y: 1886 }, { x: 2591, y: 1971 }, { x: 2586, y: 2030 }, { x: 2591, y: 2090 }, { x: 2566, y: 2100 }] },
  { points: [{ x: 2094, y: 1479 }, { x: 2114, y: 1444 }, { x: 2029, y: 1409 }, { x: 1970, y: 1414 }, { x: 1910, y: 1409 }, { x: 1900, y: 1434 }] },
  { points: [{ x: 1653, y: 3142 }, { x: 1683, y: 3107 }, { x: 1747, y: 3132 }, { x: 1802, y: 3181 }, { x: 1817, y: 3221 }, { x: 1822, y: 3256 }, { x: 1807, y: 3286 }] },
  { points: [{ x: 858, y: 2347 }, { x: 893, y: 2317 }, { x: 868, y: 2253 }, { x: 819, y: 2198 }, { x: 779, y: 2183 }, { x: 744, y: 2178 }, { x: 714, y: 2193 }] },
  { points: [{ x: 3142, y: 1653 }, { x: 3107, y: 1683 }, { x: 3132, y: 1747 }, { x: 3181, y: 1802 }, { x: 3221, y: 1817 }, { x: 3256, y: 1822 }, { x: 3286, y: 1807 }] },
  { points: [{ x: 2347, y: 858 }, { x: 2317, y: 893 }, { x: 2253, y: 868 }, { x: 2198, y: 819 }, { x: 2183, y: 779 }, { x: 2178, y: 744 }, { x: 2193, y: 714 }] },
  { points: [{ x: 427, y: 585 }, { x: 501, y: 590 }, { x: 511, y: 789 }, { x: 417, y: 799 }] },
  { points: [{ x: 3415, y: 3573 }, { x: 3410, y: 3499 }, { x: 3211, y: 3489 }, { x: 3201, y: 3583 }] },
  { points: [{ x: 585, y: 427 }, { x: 590, y: 501 }, { x: 789, y: 511 }, { x: 799, y: 417 }] },
  { points: [{ x: 3573, y: 3415 }, { x: 3499, y: 3410 }, { x: 3489, y: 3211 }, { x: 3583, y: 3201 }] },
  { points: [{ x: 422, y: 2208 }, { x: 486, y: 2204 }, { x: 491, y: 2362 }, { x: 422, y: 2377 }] },
  { points: [{ x: 1792, y: 3578 }, { x: 1796, y: 3514 }, { x: 1638, y: 3509 }, { x: 1623, y: 3578 }] },
  { points: [{ x: 2208, y: 422 }, { x: 2204, y: 486 }, { x: 2362, y: 491 }, { x: 2377, y: 422 }] },
  { points: [{ x: 3578, y: 1792 }, { x: 3514, y: 1796 }, { x: 3509, y: 1638 }, { x: 3578, y: 1623 }] },
  { points: [{ x: 2972, y: 3162 }, { x: 2957, y: 3127 }, { x: 3017, y: 3117 }, { x: 3032, y: 3122 }, { x: 3086, y: 3152 }] },
  { points: [{ x: 838, y: 1028 }, { x: 873, y: 1043 }, { x: 883, y: 983 }, { x: 878, y: 968 }, { x: 848, y: 914 }] },
  { points: [{ x: 3162, y: 2972 }, { x: 3127, y: 2957 }, { x: 3117, y: 3017 }, { x: 3122, y: 3032 }, { x: 3152, y: 3086 }] },
  { points: [{ x: 1028, y: 838 }, { x: 1043, y: 873 }, { x: 983, y: 883 }, { x: 968, y: 878 }, { x: 914, y: 848 }] },
  { points: [{ x: 3033, y: 3148 }, { x: 3133, y: 3253 }, { x: 3152, y: 3238 }, { x: 3103, y: 3163 }, { x: 3068, y: 3133 }] },
  { points: [{ x: 852, y: 967 }, { x: 747, y: 867 }, { x: 762, y: 848 }, { x: 837, y: 897 }, { x: 867, y: 932 }] },
  { points: [{ x: 3148, y: 3033 }, { x: 3253, y: 3133 }, { x: 3238, y: 3152 }, { x: 3163, y: 3103 }, { x: 3133, y: 3068 }] },
  { points: [{ x: 967, y: 852 }, { x: 867, y: 747 }, { x: 848, y: 762 }, { x: 897, y: 837 }, { x: 932, y: 867 }] },
  { points: [{ x: 2190, y: 2072 }, { x: 2260, y: 2116 }, { x: 2250, y: 2136 }, { x: 2205, y: 2106 }, { x: 2175, y: 2091 }] },
  { points: [{ x: 1928, y: 1810 }, { x: 1884, y: 1740 }, { x: 1864, y: 1750 }, { x: 1894, y: 1795 }, { x: 1909, y: 1825 }] },
  { points: [{ x: 2072, y: 2190 }, { x: 2116, y: 2260 }, { x: 2136, y: 2250 }, { x: 2106, y: 2205 }, { x: 2091, y: 2175 }] },
  { points: [{ x: 1810, y: 1928 }, { x: 1740, y: 1884 }, { x: 1750, y: 1864 }, { x: 1795, y: 1894 }, { x: 1825, y: 1909 }] },
  { points: [{ x: 2260, y: 3053 }, { x: 2260, y: 3023 }, { x: 2374, y: 3038 }, { x: 2389, y: 3053 }, { x: 2379, y: 3063 }, { x: 2359, y: 3073 }] },
  { points: [{ x: 947, y: 1740 }, { x: 977, y: 1740 }, { x: 962, y: 1626 }, { x: 947, y: 1611 }, { x: 937, y: 1621 }, { x: 927, y: 1641 }] },
  { points: [{ x: 3053, y: 2260 }, { x: 3023, y: 2260 }, { x: 3038, y: 2374 }, { x: 3053, y: 2389 }, { x: 3063, y: 2379 }, { x: 3073, y: 2359 }] },
  { points: [{ x: 1740, y: 947 }, { x: 1740, y: 977 }, { x: 1626, y: 962 }, { x: 1611, y: 947 }, { x: 1621, y: 937 }, { x: 1641, y: 927 }] },
  { points: [{ x: 1569, y: 1560 }, { x: 1584, y: 1550 }, { x: 1609, y: 1545 }, { x: 1629, y: 1560 }, { x: 1674, y: 1585 }, { x: 1698, y: 1639 }, { x: 1688, y: 1654 }, { x: 1669, y: 1669 }, { x: 1644, y: 1689 }, { x: 1604, y: 1684 }, { x: 1564, y: 1664 }, { x: 1564, y: 1635 }, { x: 1554, y: 1610 }] },
  { points: [{ x: 2440, y: 2431 }, { x: 2450, y: 2416 }, { x: 2455, y: 2391 }, { x: 2440, y: 2371 }, { x: 2415, y: 2326 }, { x: 2361, y: 2302 }, { x: 2346, y: 2312 }, { x: 2331, y: 2331 }, { x: 2311, y: 2356 }, { x: 2316, y: 2396 }, { x: 2336, y: 2436 }, { x: 2365, y: 2436 }, { x: 2390, y: 2446 }] },
  { points: [{ x: 1560, y: 1569 }, { x: 1550, y: 1584 }, { x: 1545, y: 1609 }, { x: 1560, y: 1629 }, { x: 1585, y: 1674 }, { x: 1639, y: 1698 }, { x: 1654, y: 1688 }, { x: 1669, y: 1669 }, { x: 1689, y: 1644 }, { x: 1684, y: 1604 }, { x: 1664, y: 1564 }, { x: 1635, y: 1564 }, { x: 1610, y: 1554 }] },
  { points: [{ x: 2431, y: 2440 }, { x: 2416, y: 2450 }, { x: 2391, y: 2455 }, { x: 2371, y: 2440 }, { x: 2326, y: 2415 }, { x: 2302, y: 2361 }, { x: 2312, y: 2346 }, { x: 2331, y: 2331 }, { x: 2356, y: 2311 }, { x: 2396, y: 2316 }, { x: 2436, y: 2336 }, { x: 2436, y: 2365 }, { x: 2446, y: 2390 }] },
];

// ---------- 解題加強：答對一定比例的題目可以換取道具，只有生存/限時模式能用 ----------
// questionCount：需要抽幾題來測驗（題數越多代表道具越強）
// passRatio：至少要答對這個比例才算通過（0.8 = 8成）
const QUIZ_PASS_RATIO = 0.8;
const POWERUP_CATALOG = {
  extra_length: {
    name: '瞬間加長', desc: '啟動後立即增加10節身體長度', icon: '📏',
    questionCount: 3, extraLength: 10,
  },
  invincible_3s: {
    name: '短暫無敵', desc: '啟動後立即獲得3秒無敵，撞到人也不會死', icon: '🛡️',
    questionCount: 5, durationMs: 3000,
  },
  free_boost_10s: {
    name: '加速不耗長度', desc: '啟動後10秒內，加速衝刺不會消耗身體長度', icon: '⚡',
    questionCount: 5, durationMs: 10000,
  },
  revive_once: {
    name: '死亡保命', desc: '啟動後進入武裝狀態，下一次被殺會原地復活(保留一半長度)，效果持續到整局結束或觸發一次為止', icon: '❤️',
    questionCount: 8,
  },
  magnet: {
    name: '磁鐵吸引', desc: '啟動後8秒內，附近的食物會自動被吸過來', icon: '🧲',
    questionCount: 4, durationMs: 8000, radius: 220,
  },
};

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
  MOBA_ATTACK_RANGE, MOBA_FIELD_MIN, MOBA_FIELD_MAX, MOBA_BASE_ATTACK_INTERVAL_MS, MOBA_BASE_ATTACK_DAMAGE,
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
  MOBA_HIGHLAND_TOWER_POSITION, MOBA_OUTER_TOWER_1_POSITION, MOBA_OUTER_TOWER_2_POSITION, MOBA_MAIN_BASE_POSITION,
  MOBA_RESPAWN_MIN_MS, MOBA_RESPAWN_MAX_MS,
  MOBA_ROCKS, MOBA_BUSHES,
  QUIZ_PASS_RATIO, POWERUP_CATALOG,
};
