// ===== 音效（用 Web Audio API 直接產生音波，不需要額外音檔） =====
const SoundFx = (() => {
  let ctx = null;
  let muted = localStorage.getItem('snakeMuted') === '1';
  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  // 瀏覽器規定要有使用者互動才能播音效，第一次點擊/觸控時先解鎖
  ['pointerdown', 'keydown'].forEach(evt => {
    window.addEventListener(evt, () => ensureCtx(), { once: true });
  });

  function tone({ freq = 440, duration = 0.12, type = 'sine', volume = 0.15, sweepTo = null, delay = 0 }) {
    if (muted) return; // 靜音的話所有音效都從這裡統一擋掉
    try {
      const audio = ensureCtx();
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = type;
      const startAt = audio.currentTime + delay;
      osc.frequency.setValueAtTime(freq, startAt);
      if (sweepTo !== null) osc.frequency.exponentialRampToValueAtTime(sweepTo, startAt + duration);
      gain.gain.setValueAtTime(volume, startAt);
      gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
      osc.connect(gain).connect(audio.destination);
      osc.start(startAt);
      osc.stop(startAt + duration + 0.02);
    } catch (e) { /* 使用者尚未互動過，忽略即可 */ }
  }

  return {
    isMuted: () => muted,
    setMuted: (v) => { muted = v; localStorage.setItem('snakeMuted', v ? '1' : '0'); },
    eat: () => tone({ freq: 520, duration: 0.09, type: 'triangle', volume: 0.14 }),
    superEat: () => {
      tone({ freq: 660, duration: 0.1, type: 'triangle', volume: 0.16 });
      tone({ freq: 880, duration: 0.14, type: 'triangle', volume: 0.16, delay: 0.07 });
    },
    boost: () => tone({ freq: 220, sweepTo: 660, duration: 0.35, type: 'sawtooth', volume: 0.1 }),
    shoot: () => tone({ freq: 900, sweepTo: 260, duration: 0.09, type: 'square', volume: 0.13 }),
    death: () => tone({ freq: 300, sweepTo: 60, duration: 0.5, type: 'sawtooth', volume: 0.18 }),
    tick: () => tone({ freq: 440, duration: 0.08, type: 'square', volume: 0.12 }),
    go: () => {
      tone({ freq: 523, duration: 0.12, type: 'square', volume: 0.16 });
      tone({ freq: 784, duration: 0.22, type: 'square', volume: 0.16, delay: 0.1 });
    },
  };
})();

// ===== Socket.io 連線與遊戲邏輯（連續平滑移動版） =====
// ---------- 靜音鍵（大廳跟遊戲畫面各一顆，狀態共用） ----------
function refreshMuteButtons() {
  const icon = SoundFx.isMuted() ? '🔇' : '🔊';
  document.getElementById('btn-mute-lobby').textContent = icon;
  document.getElementById('btn-mute-game').textContent = icon;
}
function toggleMute() {
  SoundFx.setMuted(!SoundFx.isMuted());
  refreshMuteButtons();
}
document.getElementById('btn-mute-lobby').addEventListener('click', toggleMute);
document.getElementById('btn-mute-game').addEventListener('click', toggleMute);
refreshMuteButtons();

// ---------- 新手教學彈窗 ----------
function openTutorial() {
  document.getElementById('modal-tutorial').classList.remove('hidden');
}
document.getElementById('btn-open-tutorial').addEventListener('click', openTutorial);
document.getElementById('btn-close-tutorial').addEventListener('click', () => {
  if (document.getElementById('tutorial-dont-show').checked) {
    localStorage.setItem('snakeTutorialSeen', '1');
  }
  document.getElementById('modal-tutorial').classList.add('hidden');
});
// 第一次進大廳自動彈出教學（除非之前勾選過「不要再顯示」）
window.addEventListener('app-auth-ready', () => {
  if (localStorage.getItem('snakeTutorialSeen') !== '1') {
    setTimeout(openTutorial, 400);
  }
});

const socket = io();
let myId = null;
let currentRoomCode = null;
let isHost = false;
let latestWorld = { w: 2400, h: 1600 };
let latestState = null;

// 持久化的識別碼，存在 localStorage，重新整理網頁後還是同一個，
// 用來讓伺服器知道「這是同一個人重新連上來」。
function getSessionId() {
  let id = localStorage.getItem('snakeSessionId');
  if (!id) {
    id = 'sess_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('snakeSessionId', id);
  }
  return id;
}
const mySessionId = getSessionId();

const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const minimap = document.getElementById('minimap-canvas');
const minimapCtx = minimap.getContext('2d');

// 固定的「邏輯視野」尺寸：不管實際螢幕/canvas解析度多大（全螢幕、手機、電腦都不一樣），
// 玩家實際看到的地圖範圍永遠是這個固定大小，避免螢幕越大反而看到越多地圖的不公平情況。
// canvas 的實際像素解析度（resizeCanvas 設定的）只是拿來讓畫面更清晰，不影響看到的範圍。
const VIEW_W = 600;
// MOBA 地圖的石頭資料，跟伺服器 lib/config.js 的 MOBA_ROCKS 保持完全一致，
// 拉到外層讓主畫面(drawGame)跟小地圖(drawMinimap)都能共用同一份，不用各自重複定義。
const MOBA_ROCK_SEEDS_CLIENT = [
      [[2073, 2194], [1849, 2408], [1909, 2532], [2102, 2572], [2162, 2353]],
      [[1806, 1927], [1592, 2151], [1468, 2091], [1428, 1898], [1647, 1838]],
      [[2194, 2073], [2408, 1849], [2532, 1909], [2572, 2102], [2353, 2162]],
      [[1927, 1806], [2151, 1592], [2091, 1468], [1898, 1428], [1838, 1647]],
      [[994, 3297], [1302, 2989], [1456, 2905], [1566, 2934], [1645, 3153], [1809, 3287], [1740, 3302]],
      [[703, 3006], [1011, 2698], [1095, 2544], [1066, 2434], [847, 2355], [713, 2191], [698, 2260]],
      [[3297, 994], [2989, 1302], [2905, 1456], [2934, 1566], [3153, 1645], [3287, 1809], [3302, 1740]],
      [[3006, 703], [2698, 1011], [2544, 1095], [2434, 1066], [2355, 847], [2191, 713], [2260, 698]],
      [[1615, 2741], [1730, 2567], [1948, 2800], [1933, 2900], [1819, 2910], [1680, 2855]],
      [[1259, 2385], [1433, 2270], [1200, 2052], [1100, 2067], [1090, 2181], [1145, 2320]],
      [[2741, 1615], [2567, 1730], [2800, 1948], [2900, 1933], [2910, 1819], [2855, 1680]],
      [[2385, 1259], [2270, 1433], [2052, 1200], [2067, 1100], [2181, 1090], [2320, 1145]],
      [[1953, 3128], [1988, 3267], [2684, 3277], [2773, 3188], [2555, 3103], [2266, 3059]],
      [[872, 2047], [733, 2012], [723, 1316], [812, 1227], [897, 1445], [941, 1734]],
      [[3128, 1953], [3267, 1988], [3277, 2684], [3188, 2773], [3103, 2555], [3059, 2266]],
      [[2047, 872], [2012, 733], [1316, 723], [1227, 812], [1445, 897], [1734, 941]],
      [[2903, 3267], [3141, 3262], [3042, 3168], [2927, 3168]],
      [[733, 1097], [738, 859], [832, 958], [832, 1073]],
      [[3267, 2903], [3262, 3141], [3168, 3042], [3168, 2927]],
      [[1097, 733], [859, 738], [958, 832], [1073, 832]],
      [[2371, 2552], [2599, 2716], [2768, 2984], [2525, 2915], [2326, 2790], [2286, 2691]],
      [[1448, 1629], [1284, 1401], [1016, 1232], [1085, 1475], [1210, 1674], [1309, 1714]],
      [[2552, 2371], [2716, 2599], [2984, 2768], [2915, 2525], [2790, 2326], [2691, 2286]],
      [[1629, 1448], [1401, 1284], [1232, 1016], [1475, 1085], [1674, 1210], [1714, 1309]],
      [[1806, 1927], [1592, 2151], [1468, 2091], [1428, 1898], [1647, 1838]],
      [[2073, 2194], [1849, 2408], [1909, 2532], [2102, 2572], [2162, 2353]],
      [[1927, 1806], [2151, 1592], [2091, 1468], [1898, 1428], [1838, 1647]],
      [[2194, 2073], [2408, 1849], [2532, 1909], [2572, 2102], [2353, 2162]],
      [[703, 3006], [1011, 2698], [1095, 2544], [1066, 2434], [847, 2355], [713, 2191], [698, 2260]],
      [[994, 3297], [1302, 2989], [1456, 2905], [1566, 2934], [1645, 3153], [1809, 3287], [1740, 3302]],
      [[3006, 703], [2698, 1011], [2544, 1095], [2434, 1066], [2355, 847], [2191, 713], [2260, 698]],
      [[3297, 994], [2989, 1302], [2905, 1456], [2934, 1566], [3153, 1645], [3287, 1809], [3302, 1740]],
      [[1259, 2385], [1433, 2270], [1200, 2052], [1100, 2067], [1090, 2181], [1145, 2320]],
      [[1615, 2741], [1730, 2567], [1948, 2800], [1933, 2900], [1819, 2910], [1680, 2855]],
      [[2385, 1259], [2270, 1433], [2052, 1200], [2067, 1100], [2181, 1090], [2320, 1145]],
      [[2741, 1615], [2567, 1730], [2800, 1948], [2900, 1933], [2910, 1819], [2855, 1680]],
      [[872, 2047], [733, 2012], [723, 1316], [812, 1227], [897, 1445], [941, 1734]],
      [[1953, 3128], [1988, 3267], [2684, 3277], [2773, 3188], [2555, 3103], [2266, 3059]],
      [[2047, 872], [2012, 733], [1316, 723], [1227, 812], [1445, 897], [1734, 941]],
      [[3128, 1953], [3267, 1988], [3277, 2684], [3188, 2773], [3103, 2555], [3059, 2266]],
      [[733, 1097], [738, 859], [832, 958], [832, 1073]],
      [[2903, 3267], [3141, 3262], [3042, 3168], [2927, 3168]],
      [[1097, 733], [859, 738], [958, 832], [1073, 832]],
      [[3267, 2903], [3262, 3141], [3168, 3042], [3168, 2927]],
      [[1448, 1629], [1284, 1401], [1016, 1232], [1085, 1475], [1210, 1674], [1309, 1714]],
      [[2371, 2552], [2599, 2716], [2768, 2984], [2525, 2915], [2326, 2790], [2286, 2691]],
      [[1629, 1448], [1401, 1284], [1232, 1016], [1475, 1085], [1674, 1210], [1714, 1309]],
      [[2552, 2371], [2716, 2599], [2984, 2768], [2915, 2525], [2790, 2326], [2691, 2286]],
];
const MOBA_ROCKS_CLIENT = MOBA_ROCK_SEEDS_CLIENT.map(pts => pts.map(([x, y]) => ({ x, y })));
// MOBA 地圖的草叢資料，跟伺服器 lib/config.js 的 MOBA_BUSHES 保持完全一致，拉到外層跟石頭一樣共用。
const MOBA_BUSHES_ARRAY = [
  [{ x: 1613, y: 2735 }, { x: 1678, y: 2849 }, { x: 1683, y: 2874 }, { x: 1668, y: 2879 }, { x: 1628, y: 2869 }, { x: 1608, y: 2824 }, { x: 1594, y: 2784 }, { x: 1584, y: 2750 }],
  [{ x: 1265, y: 2387 }, { x: 1151, y: 2322 }, { x: 1126, y: 2317 }, { x: 1121, y: 2332 }, { x: 1131, y: 2372 }, { x: 1176, y: 2392 }, { x: 1216, y: 2406 }, { x: 1250, y: 2416 }],
  [{ x: 2735, y: 1613 }, { x: 2849, y: 1678 }, { x: 2874, y: 1683 }, { x: 2879, y: 1668 }, { x: 2869, y: 1628 }, { x: 2824, y: 1608 }, { x: 2784, y: 1594 }, { x: 2750, y: 1584 }],
  [{ x: 2387, y: 1265 }, { x: 2322, y: 1151 }, { x: 2317, y: 1126 }, { x: 2332, y: 1121 }, { x: 2372, y: 1131 }, { x: 2392, y: 1176 }, { x: 2406, y: 1216 }, { x: 2416, y: 1250 }],
  [{ x: 1906, y: 2521 }, { x: 1886, y: 2556 }, { x: 1971, y: 2591 }, { x: 2030, y: 2586 }, { x: 2090, y: 2591 }, { x: 2100, y: 2566 }],
  [{ x: 1479, y: 2094 }, { x: 1444, y: 2114 }, { x: 1409, y: 2029 }, { x: 1414, y: 1970 }, { x: 1409, y: 1910 }, { x: 1434, y: 1900 }],
  [{ x: 2521, y: 1906 }, { x: 2556, y: 1886 }, { x: 2591, y: 1971 }, { x: 2586, y: 2030 }, { x: 2591, y: 2090 }, { x: 2566, y: 2100 }],
  [{ x: 2094, y: 1479 }, { x: 2114, y: 1444 }, { x: 2029, y: 1409 }, { x: 1970, y: 1414 }, { x: 1910, y: 1409 }, { x: 1900, y: 1434 }],
  [{ x: 1653, y: 3142 }, { x: 1683, y: 3107 }, { x: 1747, y: 3132 }, { x: 1802, y: 3181 }, { x: 1817, y: 3221 }, { x: 1822, y: 3256 }, { x: 1807, y: 3286 }],
  [{ x: 858, y: 2347 }, { x: 893, y: 2317 }, { x: 868, y: 2253 }, { x: 819, y: 2198 }, { x: 779, y: 2183 }, { x: 744, y: 2178 }, { x: 714, y: 2193 }],
  [{ x: 3142, y: 1653 }, { x: 3107, y: 1683 }, { x: 3132, y: 1747 }, { x: 3181, y: 1802 }, { x: 3221, y: 1817 }, { x: 3256, y: 1822 }, { x: 3286, y: 1807 }],
  [{ x: 2347, y: 858 }, { x: 2317, y: 893 }, { x: 2253, y: 868 }, { x: 2198, y: 819 }, { x: 2183, y: 779 }, { x: 2178, y: 744 }, { x: 2193, y: 714 }],
  [{ x: 427, y: 585 }, { x: 501, y: 590 }, { x: 511, y: 789 }, { x: 417, y: 799 }],
  [{ x: 3415, y: 3573 }, { x: 3410, y: 3499 }, { x: 3211, y: 3489 }, { x: 3201, y: 3583 }],
  [{ x: 585, y: 427 }, { x: 590, y: 501 }, { x: 789, y: 511 }, { x: 799, y: 417 }],
  [{ x: 3573, y: 3415 }, { x: 3499, y: 3410 }, { x: 3489, y: 3211 }, { x: 3583, y: 3201 }],
  [{ x: 422, y: 2208 }, { x: 486, y: 2204 }, { x: 491, y: 2362 }, { x: 422, y: 2377 }],
  [{ x: 1792, y: 3578 }, { x: 1796, y: 3514 }, { x: 1638, y: 3509 }, { x: 1623, y: 3578 }],
  [{ x: 2208, y: 422 }, { x: 2204, y: 486 }, { x: 2362, y: 491 }, { x: 2377, y: 422 }],
  [{ x: 3578, y: 1792 }, { x: 3514, y: 1796 }, { x: 3509, y: 1638 }, { x: 3578, y: 1623 }],
  [{ x: 2972, y: 3162 }, { x: 2957, y: 3127 }, { x: 3017, y: 3117 }, { x: 3032, y: 3122 }, { x: 3086, y: 3152 }],
  [{ x: 838, y: 1028 }, { x: 873, y: 1043 }, { x: 883, y: 983 }, { x: 878, y: 968 }, { x: 848, y: 914 }],
  [{ x: 3162, y: 2972 }, { x: 3127, y: 2957 }, { x: 3117, y: 3017 }, { x: 3122, y: 3032 }, { x: 3152, y: 3086 }],
  [{ x: 1028, y: 838 }, { x: 1043, y: 873 }, { x: 983, y: 883 }, { x: 968, y: 878 }, { x: 914, y: 848 }],
  [{ x: 3033, y: 3148 }, { x: 3133, y: 3253 }, { x: 3152, y: 3238 }, { x: 3103, y: 3163 }, { x: 3068, y: 3133 }],
  [{ x: 852, y: 967 }, { x: 747, y: 867 }, { x: 762, y: 848 }, { x: 837, y: 897 }, { x: 867, y: 932 }],
  [{ x: 3148, y: 3033 }, { x: 3253, y: 3133 }, { x: 3238, y: 3152 }, { x: 3163, y: 3103 }, { x: 3133, y: 3068 }],
  [{ x: 967, y: 852 }, { x: 867, y: 747 }, { x: 848, y: 762 }, { x: 897, y: 837 }, { x: 932, y: 867 }],
  [{ x: 2190, y: 2072 }, { x: 2260, y: 2116 }, { x: 2250, y: 2136 }, { x: 2205, y: 2106 }, { x: 2175, y: 2091 }],
  [{ x: 1928, y: 1810 }, { x: 1884, y: 1740 }, { x: 1864, y: 1750 }, { x: 1894, y: 1795 }, { x: 1909, y: 1825 }],
  [{ x: 2072, y: 2190 }, { x: 2116, y: 2260 }, { x: 2136, y: 2250 }, { x: 2106, y: 2205 }, { x: 2091, y: 2175 }],
  [{ x: 1810, y: 1928 }, { x: 1740, y: 1884 }, { x: 1750, y: 1864 }, { x: 1795, y: 1894 }, { x: 1825, y: 1909 }],
  [{ x: 2260, y: 3053 }, { x: 2260, y: 3023 }, { x: 2374, y: 3038 }, { x: 2389, y: 3053 }, { x: 2379, y: 3063 }, { x: 2359, y: 3073 }],
  [{ x: 947, y: 1740 }, { x: 977, y: 1740 }, { x: 962, y: 1626 }, { x: 947, y: 1611 }, { x: 937, y: 1621 }, { x: 927, y: 1641 }],
  [{ x: 3053, y: 2260 }, { x: 3023, y: 2260 }, { x: 3038, y: 2374 }, { x: 3053, y: 2389 }, { x: 3063, y: 2379 }, { x: 3073, y: 2359 }],
  [{ x: 1740, y: 947 }, { x: 1740, y: 977 }, { x: 1626, y: 962 }, { x: 1611, y: 947 }, { x: 1621, y: 937 }, { x: 1641, y: 927 }],
  [{ x: 1569, y: 1560 }, { x: 1584, y: 1550 }, { x: 1609, y: 1545 }, { x: 1629, y: 1560 }, { x: 1674, y: 1585 }, { x: 1698, y: 1639 }, { x: 1688, y: 1654 }, { x: 1669, y: 1669 }, { x: 1644, y: 1689 }, { x: 1604, y: 1684 }, { x: 1564, y: 1664 }, { x: 1564, y: 1635 }, { x: 1554, y: 1610 }],
  [{ x: 2440, y: 2431 }, { x: 2450, y: 2416 }, { x: 2455, y: 2391 }, { x: 2440, y: 2371 }, { x: 2415, y: 2326 }, { x: 2361, y: 2302 }, { x: 2346, y: 2312 }, { x: 2331, y: 2331 }, { x: 2311, y: 2356 }, { x: 2316, y: 2396 }, { x: 2336, y: 2436 }, { x: 2365, y: 2436 }, { x: 2390, y: 2446 }],
  [{ x: 1560, y: 1569 }, { x: 1550, y: 1584 }, { x: 1545, y: 1609 }, { x: 1560, y: 1629 }, { x: 1585, y: 1674 }, { x: 1639, y: 1698 }, { x: 1654, y: 1688 }, { x: 1669, y: 1669 }, { x: 1689, y: 1644 }, { x: 1684, y: 1604 }, { x: 1664, y: 1564 }, { x: 1635, y: 1564 }, { x: 1610, y: 1554 }],
  [{ x: 2431, y: 2440 }, { x: 2416, y: 2450 }, { x: 2391, y: 2455 }, { x: 2371, y: 2440 }, { x: 2326, y: 2415 }, { x: 2302, y: 2361 }, { x: 2312, y: 2346 }, { x: 2331, y: 2331 }, { x: 2356, y: 2311 }, { x: 2396, y: 2316 }, { x: 2436, y: 2336 }, { x: 2436, y: 2365 }, { x: 2446, y: 2390 }],
];



// MOBA 模式用：升級所需經驗值，要跟伺服器 lib/config.js 的 MOBA_XP_THRESHOLDS 保持一致
const MOBA_XP_THRESHOLDS = [30, 50, 80, 120, 170, 220];
const VIEW_H = 400;

// vv The server now sends each snake's body as a flat integer array [x0,y0,x1,y1,...]
// to keep the packets small. Convert it back to [{x,y},...] right here at the entry
// point, so every other piece of client code keeps working with point objects.
// (Tolerates the old object format too, in case of a version mismatch during deploy.)
function decodeStatePoints(state) {
  if (!state || !state.players) return state;
  state.players.forEach((p) => {
    if (Array.isArray(p.points) && (p.points.length === 0 || typeof p.points[0] === 'number')) {
      const pts = [];
      for (let i = 0; i + 1 < p.points.length; i += 2) pts.push({ x: p.points[i], y: p.points[i + 1] });
      p.points = pts;
    }
  });
  return state;
}

socket.on('connect', () => {
  myId = socket.id;
  socket.emit('identify', { sessionId: mySessionId });
  // 重新連線時（例如網路短暫斷線後自動重連）也要重新驗證身分，
  // 這樣「同帳號只能一個裝置在線」的偵測才不會因為網路波動而失效。
  if (typeof auth !== 'undefined' && auth.currentUser) {
    auth.currentUser.getIdToken().then(idToken => socket.emit('auth', { idToken })).catch(() => {});
  }
});

// 斷線後又重新連上時，伺服器如果找到同一個 sessionId 的舊玩家資料，
// 就會直接把我們接回原本的房間 / 遊戲畫面，不用重新排隊。
socket.on('reconnected', ({ code, status, state }) => {
  currentRoomCode = code;
  if (status === 'playing' && state) {
    decodeStatePoints(state);
    enterGameScreen();
    latestWorld = state.world;
    latestState = state;
    drawGame(state);
    renderScoreboard(state.players, state.mode);
    renderTime(state);
    drawMinimap(state.players.filter(p => p.points && p.points.length).map(p => ({
      id: p.id, x: p.points[0].x, y: p.points[0].y, color: p.color, alive: p.alive,
    })));
  } else if (status === 'countdown') {
    showScreen('screen-room');
  } else {
    showScreen('screen-room');
  }
});

window.addEventListener('app-auth-ready', (e) => {
  const user = e.detail;
  if (user.idToken) socket.emit('auth', { idToken: user.idToken });
  socket.emit('set_name', user.name);
});

socket.on('auth_error', (data) => alert(data.message));

// 同一個帳號在別的裝置登入時，這邊會被伺服器強制登出
socket.on('force_logout', ({ message }) => {
  alert(message);
  currentRoomCode = null;
  if (typeof auth !== 'undefined') auth.signOut().catch(() => {});
  window.AppAuth.currentUser = null;
  showScreen('screen-auth');
});

// ---------- 建立 / 加入房間 ----------
document.getElementById('btn-create-room').addEventListener('click', () => {
  document.getElementById('modal-mode-select').classList.remove('hidden');
});
document.getElementById('btn-close-mode-select').addEventListener('click', () => {
  document.getElementById('modal-mode-select').classList.add('hidden');
});
document.getElementById('mode-survival').addEventListener('click', () => {
  document.getElementById('modal-mode-select').classList.add('hidden');
  socket.emit('create_room', { mode: 'survival' });
});
document.getElementById('mode-timed').addEventListener('click', () => {
  document.getElementById('modal-mode-select').classList.add('hidden');
  socket.emit('create_room', { mode: 'timed' });
});
document.getElementById('mode-moba').addEventListener('click', () => {
  document.getElementById('modal-mode-select').classList.add('hidden');
  socket.emit('create_room', { mode: 'moba' });
});

// ---------- 隱藏的單人測試模式：連按20次才觸發，用假人補滿隊伍，方便一個人測試MOBA ----------
let testModeClickCount = 0;
let testModeClickTimer = null;
document.getElementById('btn-test-mode').addEventListener('click', () => {
  testModeClickCount++;
  clearTimeout(testModeClickTimer);
  testModeClickTimer = setTimeout(() => { testModeClickCount = 0; }, 2000); // 2秒內沒有繼續點就重置
  if (testModeClickCount >= 20) {
    testModeClickCount = 0;
    socket.emit('test_solo_moba');
  }
});

document.getElementById('btn-toggle-join').addEventListener('click', () => {
  document.getElementById('join-row').classList.toggle('hidden');
});

// ---------- MOBA 模式：選隊伍 ----------
document.getElementById('btn-join-team-a').addEventListener('click', () => socket.emit('select_team', { team: 'A' }));
document.getElementById('btn-join-team-b').addEventListener('click', () => socket.emit('select_team', { team: 'B' }));

let currentAttackPriority = 'kill';
document.getElementById('btn-attack-priority').addEventListener('click', () => {
  currentAttackPriority = currentAttackPriority === 'kill' ? 'tower' : 'kill';
  socket.emit('set_attack_priority', { priority: currentAttackPriority });
});

// ---------- MOBA 戰績彈窗（右上角按鈕點開，跟傳說對決的介面一樣） ----------
const ELEMENT_ICONS_SB = { fire: '🔥', water: '💧', earth: '🌍', wind: '🌪️' };
function renderMobaScoreboard() {
  if (!latestState || latestState.mode !== 'moba') return;
  const players = latestState.players || [];
  const teamA = players.filter(p => p.team === 'A');
  const teamB = players.filter(p => p.team === 'B');
  const sumKills = (list) => list.reduce((sum, p) => sum + (p.kills || 0), 0);
  document.getElementById('moba-score-a-num').textContent = sumKills(teamA);
  document.getElementById('moba-score-b-num').textContent = sumKills(teamB);

  const ULTIMATE_NAMES_SB = {
    fire: '🔥烈焰流星', water: '💧激流迴旋', earth: '🌍大地護體', wind: '🌪️風形幻影', balanced: '⚡衝刺',
  };
  const renderRow = (p, teamClass) => {
    const elements = (p.elementHistory || []).map(el => `<span class="element-mini">${ELEMENT_ICONS_SB[el] || ''}</span>`).join('');
    const synthesisName = p.attackSynthesis ? (p.attackSynthesis.name || '') : '一般彈';
    const ultimateName = p.ultimateType ? (ULTIMATE_NAMES_SB[p.ultimateType] || '') : (p.level >= 7 ? '' : '尚未確定');
    return `
      <div class="moba-scoreboard-row ${teamClass}">
        <span class="player-name">${escapeHtml(p.name)}${p.id === myId ? '（你）' : ''}</span>
        <span>${p.level || 1}</span>
        <span>${p.kills || 0}/${p.deaths || 0}/${p.assists || 0}</span>
        <span>${elements}<span class="synthesis-name">${synthesisName}</span><span class="ultimate-name">${ultimateName}</span></span>
      </div>`;
  };
  document.getElementById('moba-scoreboard-body-a').innerHTML = teamA.map(p => renderRow(p, 'team-a')).join('');
  document.getElementById('moba-scoreboard-body-b').innerHTML = teamB.map(p => renderRow(p, 'team-b')).join('');
}
document.getElementById('btn-moba-scoreboard').addEventListener('click', () => {
  renderMobaScoreboard();
  document.getElementById('modal-moba-scoreboard').classList.remove('hidden');
});
document.getElementById('btn-close-moba-scoreboard').addEventListener('click', () => {
  document.getElementById('modal-moba-scoreboard').classList.add('hidden');
});

// ---------- 首頁顯示目前開放中的房間 ----------
async function loadOpenRooms() {
  const list = document.getElementById('open-room-list');
  try {
    const myUid = window.AppAuth.currentUser && !window.AppAuth.currentUser.isGuest ? window.AppAuth.currentUser.uid : '';
    const res = await fetch(`/api/rooms${myUid ? `?uid=${encodeURIComponent(myUid)}` : ''}`);
    const data = await res.json();
    if (!data.rooms || data.rooms.length === 0) {
      list.innerHTML = '<li class="open-room-empty">目前沒有開放中的房間，當第一個開房間的人吧！</li>';
      return;
    }
    list.innerHTML = data.rooms.map(r => `
      <li>
        <span class="open-room-mode">${r.mode === 'timed' ? '⏱️ 限時' : '🏆 生存'}</span>
        <span class="open-room-info">${escapeHtml(r.hostName)} 的房間
          <small>房間代碼 ${r.code}・已有 ${r.playerCount} 人</small>
        </span>
        <button type="button" class="open-room-join-btn" data-code="${r.code}">加入</button>
      </li>
    `).join('');
    list.querySelectorAll('.open-room-join-btn').forEach(btn => {
      btn.addEventListener('click', () => socket.emit('join_room', { code: btn.dataset.code }));
    });
  } catch (e) {
    list.innerHTML = '<li class="open-room-empty">載入房間列表失敗</li>';
  }
}
setInterval(() => {
  if (document.getElementById('screen-lobby').classList.contains('active')) loadOpenRooms();
}, 4000);
window.addEventListener('app-auth-ready', () => setTimeout(loadOpenRooms, 300));

document.getElementById('btn-join-room').addEventListener('click', () => {
  const code = document.getElementById('join-code-input').value.trim().toUpperCase();
  if (code.length !== 4) return alert('請輸入 4 碼房間代碼');
  socket.emit('join_room', { code });
});

socket.on('join_error', (data) => alert(data.message));
socket.on('room_created', ({ code }) => { currentRoomCode = code; });

document.getElementById('btn-leave-room').addEventListener('click', () => {
  socket.emit('leave_room');
  currentRoomCode = null;
  showScreen('screen-lobby');
  loadOpenRooms();
});

// ---------- 房間狀態更新（大廳中） ----------
const MODE_BADGE_TEXT = {
  timed: '⏱️ 限時模式（3分鐘）',
  moba: '🏰 MOBA 對決（測試中，3v3）',
  survival: '🏆 生存模式（無時間限制）',
};
socket.on('room_update', (room) => {
  currentRoomCode = room.code;
  isHost = room.hostId === myId;
  document.getElementById('room-code-display').textContent = room.code;
  document.getElementById('room-mode-badge').textContent = MODE_BADGE_TEXT[room.mode] || MODE_BADGE_TEXT.survival;
  document.getElementById('player-count').textContent = `已加入 ${room.players.length} 人（不需湊滿即可開始）`;

  const isMoba = room.mode === 'moba';
  document.getElementById('player-list').classList.toggle('hidden', isMoba);
  document.getElementById('bot-settings').classList.toggle('hidden', isMoba);
  document.getElementById('moba-team-panel').classList.toggle('hidden', !isMoba);
  document.getElementById('moba-controls-help').classList.toggle('hidden', !isMoba);
  document.getElementById('normal-controls-help').classList.toggle('hidden', isMoba);

  const me = room.players.find(p => p.id === myId);

  if (isMoba) {
    const teamA = room.players.filter(p => p.team === 'A');
    const teamB = room.players.filter(p => p.team === 'B');
    const laneLabel = { top: '上路', mid: '中路', bottom: '下路' };
    const renderTeamList = (team) => team.map(p => `
      <li>
        <span>${escapeHtml(p.name)}${p.id === myId ? '（你）' : ''}</span>
        <span class="lane-tag">${laneLabel[p.lane] || ''}</span>
        <span class="player-ready">${p.ready ? '✅' : '⌛'}</span>
      </li>
    `).join('') || '<li style="opacity:.5">還沒有人</li>';
    document.getElementById('moba-team-a-list').innerHTML = renderTeamList(teamA);
    document.getElementById('moba-team-b-list').innerHTML = renderTeamList(teamB);

    const btnA = document.getElementById('btn-join-team-a');
    const btnB = document.getElementById('btn-join-team-b');
    btnA.disabled = teamA.length >= 3 || (me && me.team === 'A');
    btnB.disabled = teamB.length >= 3 || (me && me.team === 'B');
    btnA.textContent = me && me.team === 'A' ? '已在 A 隊' : `加入 A 隊 (${teamA.length}/3)`;
    btnB.textContent = me && me.team === 'B' ? '已在 B 隊' : `加入 B 隊 (${teamB.length}/3)`;
  } else {
    const list = document.getElementById('player-list');
    list.innerHTML = room.players.map(p => `
      <li>
        <span class="player-dot" style="background:${p.color}"></span>
        <span>${escapeHtml(p.name)}</span>
        ${p.isHost ? '<span class="player-host">房主</span>' : ''}
        <span class="player-ready">${p.disconnected ? '📡 斷線重連中...' : (p.ready ? '✅ 已準備' : '⌛ 未準備')}</span>
      </li>
    `).join('');
  }

  document.getElementById('btn-start-game').classList.toggle('hidden', !isHost);
  document.getElementById('btn-toggle-ready').textContent = me && me.ready ? '❌ 取消準備' : '✅ 準備好了';

  // 電腦對手設定同步（MOBA模式沒有電腦蛇，這段對它沒有意義但不影響)
  currentMaxBotCount = room.maxBotCount;
  currentBotCount = room.botCount;
  document.getElementById('bot-count-display').textContent = room.botCount;
  document.querySelectorAll('#bot-difficulty-tabs .diff-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.diff === room.botDifficulty);
  });
  document.getElementById('bot-settings').classList.toggle('readonly', !isHost);
  const diffLabel = { easy: '簡單', normal: '普通', hard: '困難' }[room.botDifficulty] || '普通';
  document.getElementById('bot-settings-hint').textContent = isHost
    ? `目前空位還可以加 ${room.maxBotCount} 隻電腦蛇`
    : (room.botCount > 0 ? `這場有 ${room.botCount} 隻電腦蛇（${diffLabel}難度）` : '');

  let allReady;
  if (isMoba) {
    const teamACount = room.players.filter(p => p.team === 'A').length;
    const teamBCount = room.players.filter(p => p.team === 'B').length;
    allReady = teamACount === 3 && teamBCount === 3 && room.players.every(p => p.ready);
  } else {
    allReady = room.players.length > 0 && room.players.every(p => p.ready);
  }
  document.getElementById('btn-start-game').disabled = !allReady;
  document.getElementById('room-hint').textContent = isMoba
    ? (isHost
      ? (allReady ? '兩隊都滿員準備好了，按下開始遊戲吧！' : '等待兩隊都湊滿 3 人並按下「準備好了」...')
      : '等待房主開始遊戲...')
    : (isHost
      ? (allReady ? '準備完成，按下開始遊戲吧！（不用湊滿人，1 人也能玩）' : '等待所有玩家按下「準備好了」（不用湊滿人，你自己準備好房主就能開局）...')
      : '等待房主開始遊戲...');

  if (room.status === 'lobby') {
    document.getElementById('countdown-display').classList.add('hidden');
    showScreen('screen-room');
  }
});

document.getElementById('btn-toggle-ready').addEventListener('click', () => { socket.emit('toggle_ready'); tryEnterFullscreen(); });
document.getElementById('btn-start-game').addEventListener('click', () => { socket.emit('start_game'); tryEnterFullscreen(); });

// ---------- 電腦對手設定（只有房主的操作會真的送出去，非房主畫面是唯讀的） ----------
let currentMaxBotCount = 0;
let currentBotCount = 0;

document.getElementById('bot-count-minus').addEventListener('click', () => {
  if (!isHost) return;
  currentBotCount = Math.max(0, currentBotCount - 1);
  socket.emit('set_bot_count', currentBotCount);
});
document.getElementById('bot-count-plus').addEventListener('click', () => {
  if (!isHost) return;
  currentBotCount = Math.min(currentMaxBotCount, currentBotCount + 1);
  socket.emit('set_bot_count', currentBotCount);
});
document.querySelectorAll('#bot-difficulty-tabs .diff-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!isHost) return;
    socket.emit('set_bot_difficulty', btn.dataset.diff);
  });
});

// ---------- 倒數計時 ----------
// 切換到遊戲畫面時，畫布從 display:none 變成看得見，此時的實際位置才是準的，
// 用 requestAnimationFrame 確保是瀏覽器排版完成後的下一幀才量測（resizeCanvas 是函式宣告，這裡呼叫沒問題）
function enterGameScreen() {
  showScreen('screen-game');
  requestAnimationFrame(() => resizeCanvas());
  tryEnterFullscreen(); // 遊戲開始預設全螢幕、橫向(手機上)，失敗就算了不用管
}

socket.on('countdown', (count) => {
  const el = document.getElementById('countdown-display');
  el.classList.remove('hidden');
  el.textContent = count > 0 ? count : 'GO!';
  if (count > 0) SoundFx.tick(); else SoundFx.go();
  if (count === 0) {
    myPrevScore = 0; myPrevAlive = true; myPrevBoosted = false; mobaMoving = true;
    isSpectating = false; spectatorCam = null; mouseSpectatePos = null;
    document.getElementById('spectator-hint').classList.add('hidden');
    document.getElementById('modal-element-choice').classList.add('hidden');
    document.getElementById('modal-moba-gameover').classList.add('hidden');
    document.getElementById('modal-moba-scoreboard').classList.add('hidden');
    setTimeout(() => enterGameScreen(), 400);
  }
});

// ---------- 操控：滑鼠 / 觸控（Pointer Events 統一處理），蛇會朝指標方向轉 ----------
let pointerAngle = null; // 相對畫布中心的角度（自己的蛇頭永遠畫在畫布中心）

let isSpectating = false;   // 自己死掉時為 true，可以拖曳畫面自由觀戰
let spectatorCam = null;    // 觀戰時的攝影機焦點（世界座標）
let isDraggingSpectator = false;
let dragPointerId = null;
let dragLastX = 0, dragLastY = 0;

// 快取畫布的位置資訊，避免每次手指滑動（pointermove 觸發非常頻繁）都重新計算，
// 這在手機上是造成畫面卡頓的主要原因之一。只有版面真的可能改變時才重新量測。
let cachedCanvasRect = canvas.getBoundingClientRect();
function refreshCanvasRect() { cachedCanvasRect = canvas.getBoundingClientRect(); }

function updatePointerAngle(clientX, clientY) {
  const px = clientX - cachedCanvasRect.left;
  const py = clientY - cachedCanvasRect.top;
  const cx = cachedCanvasRect.width / 2, cy = cachedCanvasRect.height / 2;
  pointerAngle = Math.atan2(py - cy, px - cx);
}

let mouseSpectatePos = null; // 滑鼠觀戰時：滑鼠相對畫布中心的位置，用來做「移到邊緣自動平移」
let mobaMoving = true; // MOBA模式專用：是否在移動，預設是移動中，桌面點左鍵切換/手機放開搖桿就停

canvas.style.touchAction = 'none';
canvas.addEventListener('pointermove', (e) => {
  if (isSpectating) {
    if (e.pointerType === 'mouse') {
      // 滑鼠觀戰：只要移動滑鼠就會平移，不用按住，跟活著時的轉向操作手感一致
      mouseSpectatePos = { x: e.clientX - cachedCanvasRect.left, y: e.clientY - cachedCanvasRect.top };
      return;
    }
    if (isDraggingSpectator && e.pointerId === dragPointerId) {
      const dxClient = e.clientX - dragLastX;
      const dyClient = e.clientY - dragLastY;
      dragLastX = e.clientX;
      dragLastY = e.clientY;
      if (!spectatorCam) spectatorCam = { x: latestWorld.w / 2, y: latestWorld.h / 2 };
      const worldDx = dxClient * (VIEW_W / cachedCanvasRect.width);
      const worldDy = dyClient * (VIEW_H / cachedCanvasRect.height);
      spectatorCam.x = Math.max(0, Math.min(latestWorld.w, spectatorCam.x - worldDx));
      spectatorCam.y = Math.max(0, Math.min(latestWorld.h, spectatorCam.y - worldDy));
    }
    return;
  }
  if (e.pointerType === 'mouse') updatePointerAngle(e.clientX, e.clientY);
});
canvas.addEventListener('pointerdown', (e) => {
  if (isSpectating) {
    if (e.pointerType !== 'mouse') {
      // 手機/觸控：用拖曳的方式平移（觸控沒有懸浮狀態，拖曳才是自然的操作方式）
      isDraggingSpectator = true;
      dragPointerId = e.pointerId;
      dragLastX = e.clientX;
      dragLastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    }
    return;
  }
  if (e.pointerType === 'mouse') {
    updatePointerAngle(e.clientX, e.clientY);
    if (latestState && latestState.mode === 'moba') {
      // MOBA模式：點左鍵切換走/停（要能停下來才躲得進草叢），不是按住加速
      mobaMoving = !mobaMoving;
      socket.emit('set_moving', mobaMoving);
    } else {
      mouseBoostHeld = true;
      recomputeBoosting();
    }
  }
});
window.addEventListener('pointerup', (e) => {
  if (e.pointerId === dragPointerId) { isDraggingSpectator = false; dragPointerId = null; }
  if (e.pointerType === 'mouse') { mouseBoostHeld = false; recomputeBoosting(); }
});
window.addEventListener('pointercancel', (e) => {
  if (e.pointerId === dragPointerId) { isDraggingSpectator = false; dragPointerId = null; }
  if (e.pointerType === 'mouse') { mouseBoostHeld = false; recomputeBoosting(); }
});

let isBoosting = false;
let mouseBoostHeld = false;
let buttonBoostHeld = false;
function recomputeBoosting() {
  setBoosting(mouseBoostHeld || buttonBoostHeld);
}
function setBoosting(v) {
  if (v === isBoosting) return;
  isBoosting = v;
  socket.emit('set_boost', v);
}

// ---------- 手機專用左側搖桿（用來轉向，跟右下角的加速鍵是雙手操作） ----------
const joystickBase = document.getElementById('joystick-base');
const joystickKnob = document.getElementById('joystick-knob');
const JOYSTICK_MAX_RADIUS = 40;
const JOYSTICK_DEADZONE = 8;
let joystickPointerId = null;
let joystickCenter = { x: 0, y: 0 };

function updateJoystick(clientX, clientY) {
  const dx = clientX - joystickCenter.x;
  const dy = clientY - joystickCenter.y;
  const rawDist = Math.hypot(dx, dy);
  const dist = Math.min(JOYSTICK_MAX_RADIUS, rawDist);
  const angle = Math.atan2(dy, dx);
  joystickKnob.style.transform = `translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist}px)`;
  if (rawDist > JOYSTICK_DEADZONE) pointerAngle = angle; // 太靠近中心視為手指還沒真的推出方向，避免手抖誤轉彎
}

joystickBase.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  joystickPointerId = e.pointerId;
  joystickBase.setPointerCapture(e.pointerId);
  const rect = joystickBase.getBoundingClientRect();
  joystickCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  updateJoystick(e.clientX, e.clientY);
  if (latestState && latestState.mode === 'moba' && !mobaMoving) {
    mobaMoving = true;
    socket.emit('set_moving', true);
  }
});
joystickBase.addEventListener('pointermove', (e) => {
  if (e.pointerId !== joystickPointerId) return;
  updateJoystick(e.clientX, e.clientY);
});
function releaseJoystick(e) {
  if (e.pointerId !== joystickPointerId) return;
  joystickPointerId = null;
  joystickKnob.style.transform = 'translate(0px, 0px)'; // 放開後蛇會維持放開前的最後方向，不會自己彈回去
  if (latestState && latestState.mode === 'moba' && mobaMoving) {
    mobaMoving = false;
    socket.emit('set_moving', false);
  }
}
joystickBase.addEventListener('pointerup', releaseJoystick);
joystickBase.addEventListener('pointercancel', releaseJoystick);

// ---------- 手機專用加速按鈕（跟搖桿轉向操作互相獨立，可以同時用兩根手指） ----------
const boostBtn = document.getElementById('btn-boost');
['pointerdown'].forEach(evt => boostBtn.addEventListener(evt, (e) => {
  e.preventDefault();
  if (latestState && latestState.mode === 'moba') { mobaUseBoost(); return; } // MOBA模式是單次觸發的大招，不是按住加速
  buttonBoostHeld = true;
  recomputeBoosting();
}));
['pointerup', 'pointercancel', 'pointerleave'].forEach(evt => boostBtn.addEventListener(evt, () => {
  if (latestState && latestState.mode === 'moba') return; // MOBA模式沒有「放開」這個動作
  buttonBoostHeld = false;
  recomputeBoosting();
}));

// ---------- 射擊/攻擊：空白鍵（電腦）/ 右下角按鈕（手機） ----------
function shoot() {
  socket.emit('shoot');
  SoundFx.shoot();
}
function mobaAttack() {
  socket.emit('moba_attack');
  SoundFx.shoot();
}
function mobaUseBoost() {
  socket.emit('moba_use_boost');
  SoundFx.boost();
}
function primaryActionKey() {
  if (latestState && latestState.mode === 'moba') mobaAttack();
  else shoot();
}
window.addEventListener('keydown', (e) => {
  const focusedTag = document.activeElement && document.activeElement.tagName;
  if (focusedTag === 'INPUT' || focusedTag === 'TEXTAREA') return; // 不要擋掉打字用的按鍵
  if (!document.getElementById('screen-game').classList.contains('active')) return; // 只有在遊戲畫面才生效
  const isMoba = latestState && latestState.mode === 'moba';

  if (e.code === 'Space' && !e.repeat) {
    e.preventDefault();
    primaryActionKey();
  } else if (e.code === 'KeyE' && !e.repeat && isMoba && !isElementChoiceOpen()) {
    // MOBA模式專用：E鍵觸發加速/大招（空白鍵是攻擊，兩個是分開的按鍵）
    // 但如果正在選元素，E被QWER那組佔用了(選土)，不能同時搶加速鍵
    e.preventDefault();
    mobaUseBoost();
  } else if (e.code === 'KeyF' && !e.repeat && isMoba) {
    e.preventDefault();
    const scoreboardModal = document.getElementById('modal-moba-scoreboard');
    if (scoreboardModal.classList.contains('hidden')) {
      document.getElementById('btn-moba-scoreboard').click();
    } else {
      document.getElementById('btn-close-moba-scoreboard').click();
    }
  } else if (e.code === 'KeyI' && !e.repeat && !isMoba) {
    // 生存/限時模式專用：I鍵打開背包(可能有多個道具，開背包選要用哪一個)，按鈕沒顯示就不會有反應
    const powerupBtn = document.getElementById('btn-use-powerup');
    if (!powerupBtn.classList.contains('hidden')) {
      e.preventDefault();
      powerupBtn.click();
    }
  } else if (isBackpackOpen() && !e.repeat && /^Digit[1-9]$/.test(e.code)) {
    // 背包開著的時候，按數字鍵1/2/3...對應清單由上到下第幾個道具，不用滑鼠點
    e.preventDefault();
    const index = parseInt(e.code.slice(5), 10) - 1;
    const btn = document.querySelector(`#backpack-list .backpack-use-btn[data-index="${index}"]`);
    if (btn) btn.click();
  } else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
    if (!e.repeat && isMoba) {
      e.preventDefault();
      document.getElementById('btn-attack-priority').click();
    }
  } else if (isMoba && isElementChoiceOpen() && !e.repeat) {
    // 選元素畫面開著的時候，QWER對應畫面上從左到右的火水土風，不用滑鼠點(不然滑鼠移過去蛇會亂轉向)
    const KEY_TO_ELEMENT = { KeyQ: 'fire', KeyW: 'water', KeyE: 'earth', KeyR: 'wind' };
    const element = KEY_TO_ELEMENT[e.code];
    if (element) {
      e.preventDefault();
      const btn = document.querySelector(`#modal-element-choice .element-btn[data-element="${element}"]`);
      if (btn) btn.click();
    }
  }
});
function isElementChoiceOpen() {
  return !document.getElementById('modal-element-choice').classList.contains('hidden');
}
function isBackpackOpen() {
  return !document.getElementById('modal-backpack').classList.contains('hidden');
}
const shootBtn = document.getElementById('btn-shoot');
shootBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  primaryActionKey();
});
// iOS Safari有時候光靠touch-action:none防不住雙擊縮放，額外攔截dblclick保險
shootBtn.addEventListener('dblclick', (e) => e.preventDefault());
boostBtn.addEventListener('dblclick', (e) => e.preventDefault());

// ---------- 全螢幕按鈕（全螢幕的是整個遊戲畫面區塊，不是整個網頁） ----------
const gameScreenEl = document.getElementById('screen-game');
const fullscreenBtn = document.getElementById('btn-fullscreen');

async function tryEnterFullscreen() {
  const isFs = document.fullscreenElement || document.webkitFullscreenElement;
  if (isFs) return;
  // 全螢幕的對象改成整個網頁(document.documentElement)，不要只對#screen-game，
  // 不然像背包這種彈窗、或是遊戲還沒開始、畫面還在房間頁面時，都會因為#screen-game本身
  // 還沒顯示或彈窗不在裡面而出問題。整個網頁進全螢幕，裡面不管長怎樣都不受影響。
  const target = document.documentElement;
  try {
    if (target.requestFullscreen) await target.requestFullscreen();
    else if (target.webkitRequestFullscreen) target.webkitRequestFullscreen();
    else gameScreenEl.classList.add('is-fullscreen'); // 不支援全螢幕API的瀏覽器，退回用CSS模擬
  } catch (e) {
    // 瀏覽器支援全螢幕API、但實際呼叫失敗(常見於不是直接來自使用者手勢的情況)，
    // 一定要退回CSS模擬全螢幕，不然畫面會卡在小尺寸、旁邊露出底色。
    gameScreenEl.classList.add('is-fullscreen');
  }
  // 手機上順便鎖定橫向，桌機沒有screen.orientation.lock或會被瀏覽器拒絕都沒關係，安靜失敗即可
  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock('landscape').catch(() => {});
  }
  requestAnimationFrame(() => resizeCanvas());
  setTimeout(resizeCanvas, 150);
  setTimeout(resizeCanvas, 500);
}

fullscreenBtn.addEventListener('click', async () => {
  try {
    const isFs = document.fullscreenElement || document.webkitFullscreenElement;
    if (!isFs) {
      await tryEnterFullscreen();
    } else {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      else gameScreenEl.classList.remove('is-fullscreen');
    }
  } catch (e) {
    // 部分瀏覽器（例如某些版本的 iOS Safari）不支援全螢幕 API，安靜地失敗即可
  }
});

function onFullscreenChange() {
  const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  fullscreenBtn.textContent = isFs ? '⛶ 離開全螢幕' : '⛶ 全螢幕';
  // 不管是真的全螢幕API成功、還是CSS模擬，統一都用.is-fullscreen這個class來驅動版面樣式，
  // 全螢幕對象現在是整個網頁，#screen-game本身不會有:fullscreen這個偽類別可以用了，
  // 所以改成用JS主動同步這個class，畫面版面的CSS規則全部只認這個class，不認:fullscreen偽類別。
  gameScreenEl.classList.toggle('is-fullscreen', isFs);
  // 手機進出全螢幕常常有版面轉換動畫（網址列收合等），量測太早容易抓到過渡中的錯誤尺寸，
  // 這裡量兩次：快的那次先讓畫面不要空白，晚一點再校正一次確保最終尺寸正確。
  setTimeout(resizeCanvas, 100);
  setTimeout(resizeCanvas, 400);
}
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

// ---------- 讓 canvas 的實際繪圖解析度跟著容器大小走（全螢幕時才能真的看到更大範圍，而不是被拉伸放大） ----------
function isInFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement || gameScreenEl.classList.contains('is-fullscreen'));
}

function resizeCanvas() {
  if (isInFullscreen()) {
    // 全螢幕時，.canvas-wrap 的大小由 CSS flex 版面決定（跟 canvas 內容無關），
    // 直接量測那個實際可用空間，讓 canvas 的繪圖解析度撐滿它。
    const wrap = canvas.parentElement;
    const w = Math.max(200, Math.floor(wrap.clientWidth));
    const h = Math.max(150, Math.floor(wrap.clientHeight));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  } else {
    // 非全螢幕維持原本固定的 600x400（畫面顯示大小則交給 CSS 的 max-width:92vw 縮放）
    if (canvas.width !== 600 || canvas.height !== 400) { canvas.width = 600; canvas.height = 400; }
  }
  if (latestState) drawGame(latestState); // 立刻用新的尺寸重繪一次，避免畫面短暫空白
  refreshCanvasRect();
}
window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 200));

// 每隔一小段時間把目前指標角度送給伺服器（節流，避免洗爆連線）
setInterval(() => {
  if (pointerAngle !== null && currentRoomCode) {
    socket.emit('set_angle', pointerAngle);
  }
}, 50);

// ---------- 遊戲畫面渲染 ----------
let myPrevScore = 0;
let myPrevAlive = true;
let myPrevBoosted = false;
let lastKnownHead = {}; // playerId -> { x, y, color }（記錄死亡前最後位置，因為死亡當下伺服器會把body清空）
let prevAliveMap = {};  // playerId -> 上一次是否存活
let deathEffects = [];  // { x, y, color, start }
let ultimateBurstEffects = []; // { x, y, color, start } 大招觸發瞬間的爆發特效
let prevUltimateActiveUntil = {}; // playerId -> 上一次收到的ultimateActiveUntil，用來偵測「剛剛觸發」的那個瞬間
let shakeUntil = 0;

socket.on('state_update', (state) => {
  decodeStatePoints(state);
  latestWorld = state.world;
  // structures 現在只有真的變化(被打/被摧毀)時伺服器才會送，沒送代表沒變化，沿用上一次收到的資料
  if (!state.structures && latestState && latestState.structures) {
    state.structures = latestState.structures;
  }
  latestState = state;
  document.getElementById('game-message').classList.add('hidden');

  const ULTIMATE_FX_COLORS = { fire: '#FF6B4A', water: '#3AB0FF', earth: '#A6813F', wind: '#4FD1C5', balanced: '#FFC857' };
  if (state.mode === 'moba') {
    state.players.forEach(p => {
      if (!p.points || p.points.length === 0) return;
      const activeUntil = p.ultimateActiveUntil || 0;
      const prevActiveUntil = prevUltimateActiveUntil[p.id] || 0;
      // 這次的啟用時間比上次「更晚」而且現在正在生效中，代表剛剛觸發了一次新的大招/加速
      if (activeUntil > prevActiveUntil && activeUntil > Date.now()) {
        const color = ULTIMATE_FX_COLORS[p.ultimateType] || '#FFFFFF';
        ultimateBurstEffects.push({ x: p.points[0].x, y: p.points[0].y, color, start: Date.now() });
      }
      prevUltimateActiveUntil[p.id] = activeUntil;
    });
  }

  const me = state.players.find(p => p.id === myId);
  if (me) {
    if (me.score > myPrevScore) {
      const gained = me.score - myPrevScore;
      if (gained >= 30) SoundFx.superEat(); else SoundFx.eat();
    }
    if (me.boosted && !myPrevBoosted) SoundFx.boost();
    if (myPrevAlive && !me.alive) {
      SoundFx.death();
      const lastPos = lastKnownHead[myId];
      spectatorCam = lastPos ? { x: lastPos.x, y: lastPos.y } : { x: latestWorld.w / 2, y: latestWorld.h / 2 };
    }
    if (!myPrevAlive && me.alive) { spectatorCam = null; mouseSpectatePos = null; } // 重生/開新一局了，鏡頭改回跟隨自己
    isSpectating = state.mode !== 'timed' && state.mode !== 'moba' && !me.alive; // 觀戰只在生存模式開放，限時/MOBA死了都會重生不需要
    document.getElementById('spectator-hint').classList.toggle('hidden', !isSpectating);
    myPrevScore = me.score;
    myPrevAlive = me.alive;
    myPrevBoosted = me.boosted;

    // 限時/MOBA模式死掉的時候，畫面顯示精確的重生倒數（伺服器會自動在時間到時重生，不用自己操作）
    if ((state.mode === 'timed' || state.mode === 'moba') && !me.alive) {
      const msg = document.getElementById('game-message');
      const remainingSec = me.respawnAt ? Math.max(0, Math.ceil((me.respawnAt - Date.now()) / 1000)) : null;
      msg.textContent = remainingSec !== null ? `💀 ${remainingSec} 秒後重生` : '💀 被淘汰了，即將重生...';
      msg.classList.remove('hidden');
    }

    // MOBA 模式：更新左下角的等級/血量/經驗值 HUD
    if (state.mode === 'moba' && me.level) {
      const hud = document.getElementById('moba-hud');
      hud.classList.remove('hidden');
      document.getElementById('moba-scoreboard-corner').classList.remove('hidden');
      document.getElementById('btn-use-powerup').classList.add('hidden');
      document.getElementById('moba-my-kda').textContent = `${me.kills || 0}/${me.deaths || 0}/${me.assists || 0}`;
      document.getElementById('moba-hud-level-num').textContent = me.level;
      const hpPct = me.maxHp ? Math.max(0, Math.min(100, (me.hp / me.maxHp) * 100)) : 100;
      document.getElementById('moba-hud-hp-fill').style.width = `${hpPct}%`;
      const xpNeeded = MOBA_XP_THRESHOLDS[me.level - 1];
      const xpPct = xpNeeded ? Math.max(0, Math.min(100, (me.xp / xpNeeded) * 100)) : 100;
      document.getElementById('moba-hud-xp-fill').style.width = `${xpPct}%`;
      const priorityBtn = document.getElementById('btn-attack-priority');
      currentAttackPriority = me.attackPriority || 'kill';
      priorityBtn.textContent = me.attackPriority === 'tower' ? '🏰 優先推塔' : '🗡️ 優先殺人';
      priorityBtn.classList.toggle('priority-tower', me.attackPriority === 'tower');

      // 已選的元素小圖示（不管桌面/手機都看得到，不用藏在按鈕文字裡）
      const ELEMENT_ICONS = { fire: '🔥', water: '💧', earth: '🌍', wind: '🌪️' };
      document.getElementById('moba-hud-elements').innerHTML = (me.elementHistory || [])
        .map(el => `<span class="element-chip">${ELEMENT_ICONS[el] || '?'}</span>`).join('');

      // 攻擊/加速的狀態顯示，桌面版跟手機版都看得到（之前藏在手機限定按鈕裡，桌面版完全看不到）
      const attackChip = document.getElementById('moba-attack-chip');
      attackChip.classList.remove('cooling'); // 攻擊本身沒有明顯冷卻感，先不特別標示避免畫面閃爍

      const boostChip = document.getElementById('moba-boost-chip');
      const boostCooldownLeft = Math.max(0, (me.boostReadyAt || 0) - Date.now());
      const ULTIMATE_NAMES = {
        fire: '🔥烈焰流星', water: '💧激流迴旋', earth: '🌍大地護體', wind: '🌪️風形幻影', balanced: '⚡衝刺',
      };
      const boostLabel = me.level >= 7 && me.ultimateType ? (ULTIMATE_NAMES[me.ultimateType] || '💥大招') : '⚡加速';
      if (boostCooldownLeft > 0) {
        boostChip.innerHTML = `⏳ ${Math.ceil(boostCooldownLeft / 1000)}s<span class="moba-key-hint">(E)</span>`;
        boostChip.classList.remove('ready'); boostChip.classList.add('cooling');
      } else {
        boostChip.innerHTML = `${boostLabel}<span class="moba-key-hint">(E)</span>`;
        boostChip.classList.add('ready'); boostChip.classList.remove('cooling');
      }
    } else {
      document.getElementById('moba-hud').classList.add('hidden');
      document.getElementById('moba-scoreboard-corner').classList.add('hidden');
      document.getElementById('btn-boost').classList.remove('hidden');
      const shootBtnEl = document.getElementById('btn-shoot');
      shootBtnEl.innerHTML = '🔫<br>射擊';
      shootBtnEl.disabled = false;
      if (typeof updatePowerupButton === 'function') updatePowerupButton();
    }
  }

  trackDeathEffects(state);
  drawGame(state);
  renderScoreboard(state.players, state.mode);
  renderTime(state);
});

// 偵測「這個 tick 剛死掉」的玩家，在他死前最後的位置生成爆散粒子效果
function trackDeathEffects(state) {
  state.players.forEach(p => {
    const wasAlive = prevAliveMap[p.id] !== false;
    if (wasAlive && !p.alive) {
      const head = lastKnownHead[p.id];
      if (head) {
        deathEffects.push({ x: head.x, y: head.y, color: head.color, start: Date.now() });
        if (p.id === myId) shakeUntil = Date.now() + 350;
      }
    }
    prevAliveMap[p.id] = p.alive;
    if (p.points && p.points.length > 0) {
      lastKnownHead[p.id] = { x: p.points[0].x, y: p.points[0].y, color: p.color };
    }
  });
}

let lastCountdownTickSecond = null;

function renderTime(state) {
  const el = document.getElementById('time-left');
  if (state.mode === 'timed' && typeof state.timeLeftMs === 'number') {
    const totalSec = Math.ceil(state.timeLeftMs / 1000);
    const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    el.textContent = `⏱ ${m}:${s}`;

    // 最後 10 秒加上醒目的紅色跳動樣式，每跨過一秒就「嗶」一聲提醒快結束了
    const isFinalCountdown = totalSec <= 10 && totalSec > 0;
    el.classList.toggle('countdown-warning', isFinalCountdown);
    if (isFinalCountdown && totalSec !== lastCountdownTickSecond) {
      SoundFx.tick();
      lastCountdownTickSecond = totalSec;
    }
    if (!isFinalCountdown) lastCountdownTickSecond = null;
  } else {
    el.classList.remove('countdown-warning');
    // 生存模式沒有時間限制，改成顯示「已經撐了多久」
    const totalSec = Math.floor((state.elapsedMs || 0) / 1000);
    const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    el.textContent = `⏱ 已撐 ${m}:${s}`;
  }
}

function renderScoreboard(players, mode) {
  const list = document.getElementById('score-list');
  if (mode === 'moba') { list.innerHTML = ''; return; } // MOBA模式已經有專屬的戰績彈窗，不需要這個
  const isTimed = mode === 'timed';
  const sorted = [...players].sort((a, b) => isTimed
    ? ((b.kills || 0) - (a.kills || 0))
    : (b.score - a.score));
  const myIndex = sorted.findIndex(p => p.id === myId);

  // 只顯示「自己 + 前一名 + 後一名」，玩家多的時候比較好一眼看出跟誰在拼名次
  let indices;
  if (myIndex === -1) {
    indices = sorted.slice(0, 3).map((_, i) => i); // 還沒抓到自己資料前，先退回顯示前三名
  } else {
    indices = [myIndex - 1, myIndex, myIndex + 1].filter(i => i >= 0 && i < sorted.length);
  }

  list.innerHTML = indices.map(i => {
    const p = sorted[i];
    const isMe = p.id === myId;
    const statText = isTimed ? `${p.kills || 0} 擊殺` : `${p.score}`;
    return `
    <li class="${p.alive ? '' : 'dead'} ${isMe ? 'score-me' : ''}">
      <span class="score-dot" style="background:${p.color}"></span>
      #${i + 1} ${escapeHtml(p.name)}：${statText}${p.boosted ? ' ⚡' : ''}${p.invincible ? ' 🛡️' : ''}${isMe ? '（你）' : ''}
    </li>`;
  }).join('');
}

function drawGame(state) {
  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // 等比例縮放（X、Y 用同一個比例），避免螢幕長寬比跟遊戲原本的 3:2 不一樣時畫面被拉伸壓扁；
  // 比例不足的軸會自動置中，多出來的邊界會露出畫布本身的背景色，視覺上是無縫的。
  const scale = Math.min(canvas.width / VIEW_W, canvas.height / VIEW_H);
  const offsetX = (canvas.width - VIEW_W * scale) / 2;
  const offsetY = (canvas.height - VIEW_H * scale) / 2;
  ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);

  if (Date.now() < shakeUntil) {
    const remaining = shakeUntil - Date.now();
    const amp = 6 * (remaining / 350);
    ctx.translate((Math.random() - 0.5) * amp, (Math.random() - 0.5) * amp);
  }

  // 滑鼠觀戰：滑鼠離畫布中心越遠，往那個方向平移得越快（不用按住），觸控拖曳已經在pointermove直接改spectatorCam了
  if (isSpectating && mouseSpectatePos && !isDraggingSpectator) {
    if (!spectatorCam) spectatorCam = { x: latestWorld.w / 2, y: latestWorld.h / 2 };
    const dx = mouseSpectatePos.x - cachedCanvasRect.width / 2;
    const dy = mouseSpectatePos.y - cachedCanvasRect.height / 2;
    const dist = Math.hypot(dx, dy);
    const maxDist = Math.min(cachedCanvasRect.width, cachedCanvasRect.height) / 2 || 1;
    const deadZone = 24;
    if (dist > deadZone) {
      const strength = Math.min(1, (dist - deadZone) / (maxDist - deadZone));
      const panSpeed = strength * 14; // 世界單位/每次繪製
      spectatorCam.x = Math.max(0, Math.min(latestWorld.w, spectatorCam.x + (dx / dist) * panSpeed));
      spectatorCam.y = Math.max(0, Math.min(latestWorld.h, spectatorCam.y + (dy / dist) * panSpeed));
    }
  }

  // 攝影機：永遠讓自己的蛇頭在畫面正中央；如果自己已死亡/尚未加入，就看整體中心
  const me = state.players.find(p => p.id === myId);
  const focus = (me && me.points.length) ? me.points[0] : (spectatorCam || { x: latestWorld.w / 2, y: latestWorld.h / 2 });
  const camX = focus.x - VIEW_W / 2;
  const camY = focus.y - VIEW_H / 2;
  const toScreen = (wx, wy) => ({ x: wx - camX, y: wy - camY });

  // 背景棋盤格（讓移動感更明顯）；MOBA模式改用石頭色背景，路面等一下另外疊上淺色地面
  ctx.fillStyle = state.mode === 'moba' ? '#4A4536' : '#12A8FF';
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  if (state.mode !== 'moba') {
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    const grid = 40;
    const offX = ((-camX) % grid + grid) % grid;
    const offY = ((-camY) % grid + grid) % grid;
    ctx.beginPath();
    for (let x = offX; x < VIEW_W; x += grid) { ctx.moveTo(x, 0); ctx.lineTo(x, VIEW_H); }
    for (let y = offY; y < VIEW_H; y += grid) { ctx.moveTo(0, y); ctx.lineTo(VIEW_W, y); }
    ctx.stroke();
  }

  // 世界邊界（MOBA模式用圓角矩形，範圍是(430,430)-(3570,3570)，其他模式維持原本的直角不動）
  const tl = state.mode === 'moba' ? toScreen(430, 430) : toScreen(0, 0);
  const br = state.mode === 'moba' ? toScreen(3570, 3570) : toScreen(latestWorld.w, latestWorld.h);
  ctx.strokeStyle = '#FF9F1C';
  ctx.lineWidth = 4;
  ctx.setLineDash([10, 8]);
  if (state.mode === 'moba') {
    const r = 60; // 圓角半徑(世界單位)，用latestWorld的比例換算成螢幕像素不用另外處理，因為toScreen是純平移沒有縮放
    ctx.beginPath();
    ctx.moveTo(tl.x + r, tl.y);
    ctx.lineTo(br.x - r, tl.y);
    ctx.arcTo(br.x, tl.y, br.x, tl.y + r, r);
    ctx.lineTo(br.x, br.y - r);
    ctx.arcTo(br.x, br.y, br.x - r, br.y, r);
    ctx.lineTo(tl.x + r, br.y);
    ctx.arcTo(tl.x, br.y, tl.x, br.y - r, r);
    ctx.lineTo(tl.x, tl.y + r);
    ctx.arcTo(tl.x, tl.y, tl.x + r, tl.y, r);
    ctx.closePath();
    ctx.stroke();
  } else {
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  }
  ctx.setLineDash([]);

  // MOBA 模式：整張地圖幾乎都能走（草地），只有散落的石頭是障礙物，不是三條隔開的通道
  if (state.mode === 'moba') {
    const baseA = { x: 430, y: 3570 }, baseB = { x: 3570, y: 430 }, mid = { x: 2000, y: 2000 };
    const lanes = [
      [baseA, { x: 430, y: 430 }, baseB],
      [baseA, mid, baseB],
      [baseA, { x: 3570, y: 3570 }, baseB],
    ];

    // 場地邊界固定矩形：(430,3570)(430,430)(3570,430)(3570,3570)，單一矩形直接用clip()裁切，不會有路徑纏繞問題
    ctx.save();
    const rTL = toScreen(430, 430), rBR = toScreen(3570, 3570);
    ctx.beginPath();
    ctx.rect(rTL.x, rTL.y, rBR.x - rTL.x, rBR.y - rTL.y);
    ctx.clip();

    // 1. 整張地圖範圍先鋪滿草地（大部分都能走）—— 一定要最先畫，不然會蓋掉之後畫的石頭/草叢
    ctx.fillStyle = '#7A8C5C';
    const mapTL = toScreen(0, 0), mapBR = toScreen(latestWorld.w, latestWorld.h);
    ctx.fillRect(mapTL.x, mapTL.y, mapBR.x - mapTL.x, mapBR.y - mapTL.y);

    // 2. 河道：沿著左上(0,0)到右下(4000,4000)這條線的藍色河，不是主堡連線（那條是中路）
    ctx.strokeStyle = 'rgba(58,176,255,0.55)';
    ctx.lineWidth = 170 * 2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(toScreen(0, 0).x, toScreen(0, 0).y);
    ctx.lineTo(toScreen(4000, 4000).x, toScreen(4000, 4000).y);
    ctx.stroke();

    // 3. 路的中線參考線，方便看清楚建議路線（但不是強制走廊，可以繞石頭去別條路）
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.setLineDash([12, 10]);
    lanes.forEach(lane => {
      ctx.beginPath();
      lane.forEach((pt, i) => {
        const s = toScreen(pt.x, pt.y);
        i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();
    });
    ctx.setLineDash([]);

    // 4. 石頭（棕灰色，擋路）
    const rocks = MOBA_ROCKS_CLIENT;
    rocks.forEach(rockPts => {
      ctx.fillStyle = '#6B6255';
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      rockPts.forEach((pt, i) => {
        const s = toScreen(pt.x, pt.y);
        i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    });

    // 5. 草叢（深綠色，不擋路，畫在石頭之上避免顏色混淆）
    // 草叢資料要跟伺服器 lib/config.js 的 MOBA_BUSHES 保持完全一致
    const bushes = MOBA_BUSHES_ARRAY;
    bushes.forEach(bushPts => {
      ctx.fillStyle = 'rgba(18,66,28,0.92)';
      ctx.strokeStyle = 'rgba(8,40,16,0.95)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      bushPts.forEach((pt, i) => {
        const s = toScreen(pt.x, pt.y);
        i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    });

    // 6. 塔跟主堡
    (state.structures || []).forEach(st => {
      if (!st.alive) return; // 被摧毀的塔/主堡不畫
      const s = toScreen(st.x, st.y);
      const teamColor = st.team === 'A' ? '#FF6B81' : '#3AB0FF';
      const radius = st.type === 'base' ? 32 : (st.tier === 'highland' ? 22 : 17);
      ctx.fillStyle = teamColor;
      ctx.strokeStyle = 'rgba(43,58,58,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(s.x, s.y, radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      // 主堡/塔的圖示
      ctx.fillStyle = 'white';
      ctx.font = `${radius}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(st.type === 'base' ? '🏰' : '🌳', s.x, s.y + 1);
      // 血條
      const barW = radius * 2.2, barH = 5;
      const barX = s.x - barW / 2, barY = s.y - radius - 10;
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = teamColor;
      ctx.fillRect(barX, barY, barW * Math.max(0, st.hp / st.maxHp), barH);
    });

    ctx.restore();
  }

  // 食物
  state.food.forEach(f => {
    const { x: cx, y: cy } = toScreen(f.x, f.y);
    if (cx < -30 || cx > VIEW_W + 30 || cy < -30 || cy > VIEW_H + 30) return;
    if (f.type === 'normal') {
      ctx.fillStyle = '#FF6B81';
      ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#8AC926';
      ctx.fillRect(cx - 1.5, cy - 12, 3, 6);
    } else if (f.type === 'super') {
      drawStar(cx, cy, 12, '#FFC857');
    } else if (f.type === 'speed') {
      ctx.font = '20px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('⚡', cx, cy + 1);
    } else if (f.type === 'corpse') {
      ctx.fillStyle = f.color || '#B983FF';
      ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (f.type === 'fruit') {
      ctx.fillStyle = '#FFC857';
      ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#8AC926';
      ctx.fillRect(cx - 1.5, cy - 11, 3, 5);
    }
  });

  // 子彈
  (state.bullets || []).forEach(b => {
    const { x: cx, y: cy } = toScreen(b.x, b.y);
    if (cx < -20 || cx > VIEW_W + 20 || cy < -20 || cy > VIEW_H + 20) return;
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  // MOBA 普攻子彈：依元素類型顯示不同顏色
  const ELEMENT_COLORS = {
    fire: '#FF6B4A', water: '#3AB0FF', earth: '#A6813F', wind: '#4FD1C5',
    mudball: '#8B6F47', steamball: '#D9D9D9', sandball: '#E8C97A', iceball: '#A8E6F0',
  };
  (state.mobaBullets || []).forEach(b => {
    const { x: cx, y: cy } = toScreen(b.x, b.y);
    if (cx < -20 || cx > VIEW_W + 20 || cy < -20 || cy > VIEW_H + 20) return;
    ctx.fillStyle = ELEMENT_COLORS[b.elementId] || '#FFFFFF';
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(43,58,58,0.6)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  // 蛇：用平滑線條畫出身體，頭部畫圓形加眼睛
  state.players.forEach(p => {
    if (!p.points || p.points.length === 0) return;
    if (state.mode === 'moba' && p.team) {
      p.color = p.team === 'A' ? '#FF6B81' : '#3AB0FF'; // A隊紅、B隊藍，方便分辨敵我
    }
    const flicker = p.invincible ? (0.45 + 0.35 * Math.sin(Date.now() / 90)) : 1;
    const bushAlpha = p.inBush ? 0.55 : 1; // 躲在草叢裡半透明，提示自己/隊友「現在是隱形狀態」
    ctx.globalAlpha = p.alive ? flicker * bushAlpha : 0.25;

    // 大招/加速啟用中：頭部畫一個脈動的光環，讓效果整段時間都看得出來，不是只有觸發那一瞬間
    if (state.mode === 'moba' && p.alive && (p.ultimateActiveUntil || 0) > Date.now()) {
      const ULTIMATE_GLOW_COLORS = { fire: '#FF6B4A', water: '#3AB0FF', earth: '#A6813F', wind: '#4FD1C5', balanced: '#FFC857' };
      const glowColor = ULTIMATE_GLOW_COLORS[p.ultimateType] || '#FFFFFF';
      const headS = toScreen(p.points[0].x, p.points[0].y);
      const pulse = 0.65 + 0.35 * Math.sin(Date.now() / 80);
      ctx.save();
      ctx.globalAlpha = pulse * bushAlpha;
      ctx.strokeStyle = glowColor;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(headS.x, headS.y, BODY_RADIUS_PX + 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (p.invincible) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = BODY_RADIUS_PX * 2 + 8;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      p.points.forEach((pt, i) => {
        const s = toScreen(pt.x, pt.y);
        i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();
      ctx.restore();
    }

    ctx.strokeStyle = p.color;
    ctx.lineWidth = BODY_RADIUS_PX * 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const isSkinned = p.skin && p.skin !== 'classic';
    if (isSkinned) {
      // 造型模式：畫成一顆顆球體，長度越長點越密，這裡動態抓 stride 讓每條蛇最多畫 40 顆左右，避免長蛇拖慢效能
      const stride = Math.max(4, Math.ceil(p.points.length / 40));
      for (let i = p.points.length - 1; i >= 0; i -= stride) {
        const s = toScreen(p.points[i].x, p.points[i].y);
        drawSkinBead(ctx, s.x, s.y, BODY_RADIUS_PX, p.skin);
      }
    } else {
      ctx.beginPath();
      p.points.forEach((pt, i) => {
        const s = toScreen(pt.x, pt.y);
        i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();
    }

    // 頭部與眼睛
    const head = toScreen(p.points[0].x, p.points[0].y);
    if (isSkinned) {
      drawSkinBead(ctx, head.x, head.y, BODY_RADIUS_PX + 1, p.skin);
    } else {
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(head.x, head.y, BODY_RADIUS_PX + 1, 0, Math.PI * 2); ctx.fill();
    }

    const ang = p.angle || 0;
    const eyeOffset = 6;
    const perpX = -Math.sin(ang) * eyeOffset, perpY = Math.cos(ang) * eyeOffset;
    const forwardX = Math.cos(ang) * 4, forwardY = Math.sin(ang) * 4;
    ctx.fillStyle = '#2B3A3A';
    [1, -1].forEach(side => {
      ctx.beginPath();
      ctx.arc(head.x + perpX * side + forwardX, head.y + perpY * side + forwardY, 2.6, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.globalAlpha = 1;
  });

  drawDeathEffects(toScreen);
  drawUltimateBurstEffects(toScreen);
  ctx.restore();
}

let latestMinimapPlayers = [];
function drawMinimap(players) {
  // MOBA 模式的世界是正方形(4000x4000)，小地圖畫布也要跟著是正方形，不然會被壓縮變形；
  // 其他模式維持原本 150x100（世界是8000x5000，比例接近）。
  const isMoba = latestState && latestState.mode === 'moba';
  const targetW = isMoba ? 120 : 150, targetH = isMoba ? 120 : 100;
  if (minimap.width !== targetW || minimap.height !== targetH) {
    minimap.width = targetW;
    minimap.height = targetH;
  }
  minimapCtx.clearRect(0, 0, minimap.width, minimap.height);
  const FIELD_MIN = 430, FIELD_MAX = 3570; // 要跟 lib/config.js 的 MOBA_FIELD_MIN/MAX 一致
  const scaleX = isMoba ? minimap.width / (FIELD_MAX - FIELD_MIN) : minimap.width / latestWorld.w;
  const scaleY = isMoba ? minimap.height / (FIELD_MAX - FIELD_MIN) : minimap.height / latestWorld.h;
  const toMinimapX = (x) => isMoba ? (x - FIELD_MIN) * scaleX : x * scaleX;
  const toMinimapY = (y) => isMoba ? (y - FIELD_MIN) * scaleY : y * scaleY;

  // MOBA 模式：先畫石頭（用本地已經有的資料，不需要額外從伺服器拿）
  if (latestState && latestState.mode === 'moba') {
    minimapCtx.fillStyle = 'rgba(92,88,80,0.9)';
    MOBA_ROCKS_CLIENT.forEach(rockPts => {
      minimapCtx.beginPath();
      rockPts.forEach((pt, i) => {
        const mx = toMinimapX(pt.x), my = toMinimapY(pt.y);
        i === 0 ? minimapCtx.moveTo(mx, my) : minimapCtx.lineTo(mx, my);
      });
      minimapCtx.closePath();
      minimapCtx.fill();
    });
  }

  players.forEach(p => {
    const mx = toMinimapX(p.x), my = toMinimapY(p.y);
    const isMe = p.id === myId;
    minimapCtx.fillStyle = p.color;
    minimapCtx.globalAlpha = 1;
    minimapCtx.beginPath();
    minimapCtx.arc(mx, my, isMe ? 4 : 2.5, 0, Math.PI * 2);
    minimapCtx.fill();
    if (isMe) {
      minimapCtx.strokeStyle = '#FFFFFF';
      minimapCtx.lineWidth = 1.5;
      minimapCtx.stroke();
    }
  });
  minimapCtx.globalAlpha = 1;
}
socket.on('minimap_update', (data) => {
  latestMinimapPlayers = data.players || [];
  drawMinimap(latestMinimapPlayers);
});
const BODY_RADIUS_PX = 9;

const DEATH_FX_DURATION = 500;
function drawDeathEffects(toScreen) {
  const now = Date.now();
  deathEffects = deathEffects.filter(e => now - e.start < DEATH_FX_DURATION);
  deathEffects.forEach(e => {
    const t = (now - e.start) / DEATH_FX_DURATION;
    const s = toScreen(e.x, e.y);
    const particleCount = 10;
    for (let i = 0; i < particleCount; i++) {
      const ang = (i / particleCount) * Math.PI * 2;
      const dist = t * 46;
      const px = s.x + Math.cos(ang) * dist;
      const py = s.y + Math.sin(ang) * dist;
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = e.color;
      ctx.beginPath();
      ctx.arc(px, py, 4 * (1 - t * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = (1 - t) * 0.6;
    ctx.strokeStyle = e.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 22 * t, 0, Math.PI * 2);
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
}

const ULTIMATE_FX_DURATION = 550;
function drawUltimateBurstEffects(toScreen) {
  const now = Date.now();
  ultimateBurstEffects = ultimateBurstEffects.filter(e => now - e.start < ULTIMATE_FX_DURATION);
  ultimateBurstEffects.forEach(e => {
    const t = (now - e.start) / ULTIMATE_FX_DURATION;
    const s = toScreen(e.x, e.y);
    // 向外擴散的雙層光環
    [1, 0.6].forEach((scale, i) => {
      ctx.globalAlpha = (1 - t) * (i === 0 ? 0.8 : 0.5);
      ctx.strokeStyle = e.color;
      ctx.lineWidth = 4 - i * 1.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, t * 55 * scale, 0, Math.PI * 2);
      ctx.stroke();
    });
    // 星芒狀的放射線條，方向感更明顯
    const rayCount = 8;
    for (let i = 0; i < rayCount; i++) {
      const ang = (i / rayCount) * Math.PI * 2;
      const innerR = t * 14, outerR = t * 55;
      ctx.globalAlpha = (1 - t) * 0.6;
      ctx.strokeStyle = e.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s.x + Math.cos(ang) * innerR, s.y + Math.sin(ang) * innerR);
      ctx.lineTo(s.x + Math.cos(ang) * outerR, s.y + Math.sin(ang) * outerR);
      ctx.stroke();
    }
  });
  ctx.globalAlpha = 1;
}

// 造型繪製：把蛇身畫成一顆顆對應圖案的球體。回傳 false 代表是「經典」或未知造型，
// 呼叫端應該改用原本的連續線條畫法。也暴露給商店預覽小圖示共用同一套畫法。
function drawSkinBead(bctx, cx, cy, r, skinId) {
  switch (skinId) {
    case 'basketball':
      bctx.fillStyle = '#E8722C'; bctx.beginPath(); bctx.arc(cx, cy, r, 0, Math.PI * 2); bctx.fill();
      bctx.strokeStyle = '#3B2314'; bctx.lineWidth = Math.max(1, r * 0.14);
      bctx.beginPath(); bctx.moveTo(cx - r, cy); bctx.lineTo(cx + r, cy); bctx.stroke();
      bctx.beginPath(); bctx.moveTo(cx, cy - r); bctx.lineTo(cx, cy + r); bctx.stroke();
      return true;
    case 'baseball':
      bctx.fillStyle = '#FFF7EC'; bctx.beginPath(); bctx.arc(cx, cy, r, 0, Math.PI * 2); bctx.fill();
      bctx.strokeStyle = '#D64545'; bctx.lineWidth = Math.max(1, r * 0.12);
      bctx.beginPath(); bctx.arc(cx, cy, r * 0.7, 0.3, 1.6); bctx.stroke();
      bctx.beginPath(); bctx.arc(cx, cy, r * 0.7, Math.PI + 0.3, Math.PI + 1.6); bctx.stroke();
      return true;
    case 'soccer':
      bctx.fillStyle = '#FFFFFF'; bctx.beginPath(); bctx.arc(cx, cy, r, 0, Math.PI * 2); bctx.fill();
      bctx.fillStyle = '#2B3A3A';
      bctx.beginPath(); bctx.arc(cx, cy, r * 0.4, 0, Math.PI * 2); bctx.fill();
      return true;
    case 'tennis':
      bctx.fillStyle = '#D6F23C'; bctx.beginPath(); bctx.arc(cx, cy, r, 0, Math.PI * 2); bctx.fill();
      bctx.strokeStyle = '#FFFFFF'; bctx.lineWidth = Math.max(1, r * 0.14);
      bctx.beginPath(); bctx.arc(cx - r * 0.3, cy, r * 0.8, -1.1, 1.1); bctx.stroke();
      bctx.beginPath(); bctx.arc(cx + r * 0.3, cy, r * 0.8, Math.PI - 1.1, Math.PI + 1.1); bctx.stroke();
      return true;
    case 'badminton':
      // 先鋪一層淺灰當底，不然羽毛跟球心都是白色系，疊在遊戲淺色背景上會完全看不見
      bctx.fillStyle = '#E9E9EC';
      bctx.beginPath(); bctx.arc(cx, cy, r, 0, Math.PI * 2); bctx.fill();
      // 白色羽毛，加一圈灰色外框線讓邊緣看得出來
      bctx.fillStyle = '#FFFFFF';
      bctx.strokeStyle = '#B8B8BE';
      bctx.lineWidth = Math.max(1, r * 0.07);
      for (let i = 0; i < 6; i++) {
        const ang = -Math.PI / 2 + i * (Math.PI * 2 / 6);
        bctx.beginPath();
        bctx.moveTo(cx, cy);
        bctx.lineTo(cx + Math.cos(ang - 0.22) * r * 0.95, cy + Math.sin(ang - 0.22) * r * 0.95);
        bctx.lineTo(cx + Math.cos(ang + 0.22) * r * 0.95, cy + Math.sin(ang + 0.22) * r * 0.95);
        bctx.closePath();
        bctx.fill();
        bctx.stroke();
      }
      // 軟木球頭（跟羽毛的白色系有明顯區別）
      bctx.fillStyle = '#F4C77A';
      bctx.strokeStyle = '#C99A4A';
      bctx.lineWidth = Math.max(1, r * 0.08);
      bctx.beginPath(); bctx.arc(cx, cy, r * 0.32, 0, Math.PI * 2); bctx.fill(); bctx.stroke();
      return true;
    case 'watermelon':
      bctx.fillStyle = '#3FA34D'; bctx.beginPath(); bctx.arc(cx, cy, r, 0, Math.PI * 2); bctx.fill();
      bctx.strokeStyle = '#1F6B2C'; bctx.lineWidth = Math.max(1, r * 0.18);
      for (let i = -1; i <= 1; i++) {
        bctx.beginPath();
        bctx.moveTo(cx + i * r * 0.55, cy - r);
        bctx.quadraticCurveTo(cx + i * r * 0.8, cy, cx + i * r * 0.55, cy + r);
        bctx.stroke();
      }
      return true;
    case 'orange':
      bctx.fillStyle = '#FF9F1C'; bctx.beginPath(); bctx.arc(cx, cy, r, 0, Math.PI * 2); bctx.fill();
      bctx.strokeStyle = 'rgba(0,0,0,0.18)'; bctx.lineWidth = 1;
      bctx.beginPath(); bctx.moveTo(cx - r, cy); bctx.lineTo(cx + r, cy); bctx.stroke();
      bctx.beginPath(); bctx.moveTo(cx, cy - r); bctx.lineTo(cx, cy + r); bctx.stroke();
      return true;
    case 'apple':
      bctx.fillStyle = '#FF4B4B'; bctx.beginPath(); bctx.arc(cx, cy, r, 0, Math.PI * 2); bctx.fill();
      bctx.fillStyle = 'rgba(255,255,255,0.5)';
      bctx.beginPath(); bctx.ellipse(cx - r * 0.35, cy - r * 0.35, r * 0.25, r * 0.15, -0.6, 0, Math.PI * 2); bctx.fill();
      return true;
    case 'coin':
      bctx.fillStyle = '#FFD23F'; bctx.beginPath(); bctx.arc(cx, cy, r, 0, Math.PI * 2); bctx.fill();
      bctx.strokeStyle = '#C99A1F'; bctx.lineWidth = Math.max(1, r * 0.16);
      bctx.beginPath(); bctx.arc(cx, cy, r * 0.65, 0, Math.PI * 2); bctx.stroke();
      return true;
    default:
      return false; // classic：呼叫端改用原本的連續線條畫法
  }
}
window.drawSkinBead = drawSkinBead;

function drawStar(cx, cy, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const ang = (Math.PI / 5) * i - Math.PI / 2;
    const radius = i % 2 === 0 ? r : r * 0.45;
    const x = cx + Math.cos(ang) * radius;
    const y = cy + Math.sin(ang) * radius;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

// ---------- 遊戲結束 ----------
// MOBA 模式 Phase 1 的簡易勝負公告（之後 Phase 5 做塔會換成正式結算畫面）
// MOBA 模式：升級選元素
document.getElementById('modal-element-choice').querySelectorAll('.element-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    socket.emit('choose_element', { element: btn.dataset.element });
    document.getElementById('modal-element-choice').classList.add('hidden');
  });
});
socket.on('moba_level_up', ({ level }) => {
  document.getElementById('element-choice-level').textContent = level;
  document.getElementById('modal-element-choice').classList.remove('hidden');
  SoundFx.superEat(); // 借用現有的升級音效，聽起來蠻搭的
});

socket.on('moba_game_over', ({ winner }) => {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }
  document.getElementById('screen-game').classList.remove('is-fullscreen');
  document.getElementById('btn-fullscreen').textContent = '⛶ 全螢幕';

  const teamLabel = winner === 'A' ? '🔴 A 隊' : '🔵 B 隊';
  document.getElementById('moba-result-title').textContent = `🏁 ${teamLabel} 獲勝！`;
  document.getElementById('modal-moba-gameover').classList.remove('hidden');
});
document.getElementById('btn-moba-back-lobby').addEventListener('click', () => {
  document.getElementById('modal-moba-gameover').classList.add('hidden');
  showScreen('screen-room');
});

socket.on('game_over', ({ rankings, mode }) => {
  // 結算彈窗在 DOM 結構上是放在遊戲畫面「外面」的，全螢幕模式下瀏覽器只會畫出全螢幕元素本身，
  // 彈窗會變成看不到也按不到，所以這裡先自動退出全螢幕再顯示結算。
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }
  document.getElementById('screen-game').classList.remove('is-fullscreen');
  document.getElementById('btn-fullscreen').textContent = '⛶ 全螢幕';

  const isTimed = mode === 'timed';
  const list = document.getElementById('rankings-list');
  const myUid = window.AppAuth.currentUser && !window.AppAuth.currentUser.isGuest ? window.AppAuth.currentUser.uid : null;
  list.innerHTML = rankings.map(r => {
    const statText = isTimed ? `${r.kills} 擊殺` : `${r.score} 分`;
    const canActOn = myUid && r.uid && r.uid !== myUid; // 只對「別的真人玩家」顯示互動按鈕，自己/電腦蛇/訪客都不顯示
    const actions = canActOn ? `
      <div class="player-actions">
        <button type="button" class="btn-add-friend" data-uid="${r.uid}" data-name="${escapeHtml(r.name)}">加好友</button>
        <button type="button" class="btn-block-player" data-uid="${r.uid}" data-name="${escapeHtml(r.name)}">封鎖</button>
        <button type="button" class="btn-report-player" data-uid="${r.uid}" data-name="${escapeHtml(r.name)}">🚩</button>
      </div>` : '';
    return `<li><span>#${r.rank} ${escapeHtml(r.name)}${r.id === myId ? '（你）' : ''}</span><span>${statText}</span>${actions}</li>`;
  }).join('');
  list.querySelectorAll('.btn-add-friend').forEach(btn => {
    btn.addEventListener('click', () => socket.emit('send_friend_request', { targetUid: btn.dataset.uid, targetName: btn.dataset.name }));
  });
  list.querySelectorAll('.btn-block-player').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm(`確定要封鎖 ${btn.dataset.name} 嗎？之後不會被分到同一個房間。`)) {
        socket.emit('block_player', { targetUid: btn.dataset.uid, targetName: btn.dataset.name });
      }
    });
  });
  list.querySelectorAll('.btn-report-player').forEach(btn => {
    btn.addEventListener('click', () => {
      const reason = prompt(`要檢舉 ${btn.dataset.name} 嗎？可以簡單說明原因（選填）：`);
      if (reason === null) return; // 使用者按取消
      socket.emit('report_player', { targetUid: btn.dataset.uid, targetName: btn.dataset.name, reason });
    });
  });
  document.getElementById('coins-earned-line').classList.add('hidden'); // 金幣結算稍後才會到，先藏起來
  document.getElementById('modal-gameover').classList.remove('hidden');
  if (window.refreshMyStats) window.refreshMyStats();
});

document.getElementById('btn-back-lobby').addEventListener('click', () => {
  document.getElementById('modal-gameover').classList.add('hidden');
  showScreen('screen-room');
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
