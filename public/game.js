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

// MOBA 模式用：升級所需經驗值，要跟伺服器 lib/config.js 的 MOBA_XP_THRESHOLDS 保持一致
const MOBA_XP_THRESHOLDS = [30, 50, 80, 120, 170];
const VIEW_H = 400;

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

document.getElementById('btn-toggle-ready').addEventListener('click', () => socket.emit('toggle_ready'));
document.getElementById('btn-start-game').addEventListener('click', () => socket.emit('start_game'));

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
}

socket.on('countdown', (count) => {
  const el = document.getElementById('countdown-display');
  el.classList.remove('hidden');
  el.textContent = count > 0 ? count : 'GO!';
  if (count > 0) SoundFx.tick(); else SoundFx.go();
  if (count === 0) {
    myPrevScore = 0; myPrevAlive = true; myPrevBoosted = false;
    isSpectating = false; spectatorCam = null; mouseSpectatePos = null;
    document.getElementById('spectator-hint').classList.add('hidden');
    document.getElementById('modal-element-choice').classList.add('hidden');
    document.getElementById('modal-moba-gameover').classList.add('hidden');
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
    mouseBoostHeld = true;
    recomputeBoosting();
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
});
joystickBase.addEventListener('pointermove', (e) => {
  if (e.pointerId !== joystickPointerId) return;
  updateJoystick(e.clientX, e.clientY);
});
function releaseJoystick(e) {
  if (e.pointerId !== joystickPointerId) return;
  joystickPointerId = null;
  joystickKnob.style.transform = 'translate(0px, 0px)'; // 放開後蛇會維持放開前的最後方向，不會自己彈回去
}
joystickBase.addEventListener('pointerup', releaseJoystick);
joystickBase.addEventListener('pointercancel', releaseJoystick);

// ---------- 手機專用加速按鈕（跟搖桿轉向操作互相獨立，可以同時用兩根手指） ----------
const boostBtn = document.getElementById('btn-boost');
['pointerdown'].forEach(evt => boostBtn.addEventListener(evt, (e) => {
  e.preventDefault();
  buttonBoostHeld = true;
  recomputeBoosting();
}));
['pointerup', 'pointercancel', 'pointerleave'].forEach(evt => boostBtn.addEventListener(evt, () => {
  buttonBoostHeld = false;
  recomputeBoosting();
}));

// ---------- 射擊：空白鍵（電腦）/ 右下角按鈕（手機） ----------
function shoot() {
  socket.emit('shoot');
  SoundFx.shoot();
}
function mobaUseBoost() {
  socket.emit('moba_use_boost');
  SoundFx.boost();
}
function primaryActionKey() {
  if (latestState && latestState.mode === 'moba') mobaUseBoost();
  else shoot();
}
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat) return;
  const focusedTag = document.activeElement && document.activeElement.tagName;
  if (focusedTag === 'INPUT' || focusedTag === 'TEXTAREA') return; // 不要擋掉打字用的空白鍵
  if (!document.getElementById('screen-game').classList.contains('active')) return; // 只有在遊戲畫面才生效
  e.preventDefault();
  primaryActionKey();
});
const shootBtn = document.getElementById('btn-shoot');
shootBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  primaryActionKey();
});

// ---------- 全螢幕按鈕（全螢幕的是整個遊戲畫面區塊，不是整個網頁） ----------
const gameScreenEl = document.getElementById('screen-game');
const fullscreenBtn = document.getElementById('btn-fullscreen');

fullscreenBtn.addEventListener('click', async () => {
  try {
    const isFs = document.fullscreenElement || document.webkitFullscreenElement;
    if (!isFs) {
      if (gameScreenEl.requestFullscreen) await gameScreenEl.requestFullscreen();
      else if (gameScreenEl.webkitRequestFullscreen) gameScreenEl.webkitRequestFullscreen();
      else gameScreenEl.classList.add('is-fullscreen'); // 不支援全螢幕API的瀏覽器，退回用CSS模擬
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
let shakeUntil = 0;

socket.on('state_update', (state) => {
  latestWorld = state.world;
  latestState = state;
  document.getElementById('game-message').classList.add('hidden');

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

      // MOBA模式：射擊鍵改成大招鍵(顯示冷卻)，舊的身體消耗型加速鍵隱藏(MOBA不用那套機制)
      document.getElementById('btn-boost').classList.add('hidden');
      const shootBtnEl = document.getElementById('btn-shoot');
      const cooldownLeft = Math.max(0, (me.boostReadyAt || 0) - Date.now());
      if (cooldownLeft > 0) {
        shootBtnEl.textContent = `⏳${Math.ceil(cooldownLeft / 1000)}s`;
        shootBtnEl.disabled = true;
      } else {
        shootBtnEl.textContent = me.level >= 6 && me.ultimateType ? '💥大招' : '⚡加速';
        shootBtnEl.disabled = false;
      }
    } else {
      document.getElementById('moba-hud').classList.add('hidden');
      document.getElementById('btn-boost').classList.remove('hidden');
      const shootBtnEl = document.getElementById('btn-shoot');
      shootBtnEl.innerHTML = '🔫<br>射擊';
      shootBtnEl.disabled = false;
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

  // 背景棋盤格（讓移動感更明顯）
  ctx.fillStyle = '#12A8FF';
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  const grid = 40;
  const offX = ((-camX) % grid + grid) % grid;
  const offY = ((-camY) % grid + grid) % grid;
  ctx.beginPath();
  for (let x = offX; x < VIEW_W; x += grid) { ctx.moveTo(x, 0); ctx.lineTo(x, VIEW_H); }
  for (let y = offY; y < VIEW_H; y += grid) { ctx.moveTo(0, y); ctx.lineTo(VIEW_W, y); }
  ctx.stroke();

  // 世界邊界
  const tl = toScreen(0, 0), br = toScreen(latestWorld.w, latestWorld.h);
  ctx.strokeStyle = '#FF9F1C';
  ctx.lineWidth = 4;
  ctx.setLineDash([10, 8]);
  ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  ctx.setLineDash([]);

  // MOBA 模式：畫三條路的參考線 + 用伺服器送來的真實資料畫塔跟主堡（含血條）
  if (state.mode === 'moba') {
    const baseA = { x: 420, y: 3580 }, baseB = { x: 3580, y: 420 }, mid = { x: 2000, y: 2000 };
    const lanes = [
      [baseA, { x: 420, y: 420 }, baseB],
      [baseA, mid, baseB],
      [baseA, { x: 3580, y: 3580 }, baseB],
    ];
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 3;
    lanes.forEach(lane => {
      ctx.beginPath();
      lane.forEach((pt, i) => {
        const s = toScreen(pt.x, pt.y);
        i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();
    });

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
      ctx.fillText(st.type === 'base' ? '🏰' : '🗼', s.x, s.y + 1);
      // 血條
      const barW = radius * 2.2, barH = 5;
      const barX = s.x - barW / 2, barY = s.y - radius - 10;
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = teamColor;
      ctx.fillRect(barX, barY, barW * Math.max(0, st.hp / st.maxHp), barH);
    });
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
  const ELEMENT_COLORS = { fire: '#FF6B4A', water: '#3AB0FF', earth: '#A6813F', wind: '#4FD1C5' };
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
    ctx.globalAlpha = p.alive ? flicker : 0.25;

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
  ctx.restore();
}

let latestMinimapPlayers = [];
function drawMinimap(players) {
  minimapCtx.clearRect(0, 0, minimap.width, minimap.height);
  const scaleX = minimap.width / latestWorld.w;
  const scaleY = minimap.height / latestWorld.h;

  players.forEach(p => {
    const mx = p.x * scaleX, my = p.y * scaleY;
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
