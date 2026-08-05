// ===== 造型商店 =====
// 跟伺服器的 SKIN_CATALOG 對應（名稱/價格僅供顯示，實際扣款以伺服器驗證為準）
const SKIN_CATALOG = [
  { id: 'classic', name: '經典', price: 0 },
  { id: 'watermelon', name: '西瓜', price: 760 },
  { id: 'orange', name: '橘子', price: 760 },
  { id: 'apple', name: '蘋果', price: 760 },
  { id: 'basketball', name: '籃球', price: 800 },
  { id: 'baseball', name: '棒球', price: 800 },
  { id: 'soccer', name: '足球', price: 800 },
  { id: 'tennis', name: '網球', price: 800 },
  { id: 'coin', name: '金幣', price: 900 },
];

window.AppShop = {
  coins: 0,
  ownedSkins: ['classic'],
  equippedSkin: 'classic',
};

function updateCoinDisplays() {
  const lobbyEl = document.getElementById('my-coins');
  if (lobbyEl) lobbyEl.textContent = window.AppAuth.currentUser && !window.AppAuth.currentUser.isGuest ? window.AppShop.coins : '訪客';
  const shopEl = document.getElementById('shop-coin-balance');
  if (shopEl) shopEl.textContent = window.AppShop.coins;
}

function renderShopGrid() {
  const grid = document.getElementById('shop-grid');
  const isGuest = !window.AppAuth.currentUser || window.AppAuth.currentUser.isGuest;
  document.getElementById('shop-guest-hint').classList.toggle('hidden', !isGuest);
  grid.classList.toggle('hidden', isGuest);
  if (isGuest) { grid.innerHTML = ''; return; }

  grid.innerHTML = '';
  SKIN_CATALOG.forEach(item => {
    const owned = window.AppShop.ownedSkins.includes(item.id);
    const equipped = window.AppShop.equippedSkin === item.id;
    const canAfford = window.AppShop.coins >= item.price;

    const card = document.createElement('div');
    card.className = 'shop-item';

    const canvas = document.createElement('canvas');
    canvas.width = 56; canvas.height = 56;
    const c2d = canvas.getContext('2d');
    if (item.id === 'classic' || !window.drawSkinBead(c2d, 28, 28, 22, item.id)) {
      c2d.fillStyle = '#FF6B81';
      c2d.beginPath(); c2d.arc(28, 28, 22, 0, Math.PI * 2); c2d.fill();
    }
    card.appendChild(canvas);

    const nameEl = document.createElement('div');
    nameEl.className = 'shop-item-name';
    nameEl.textContent = item.name;
    card.appendChild(nameEl);

    const priceEl = document.createElement('div');
    priceEl.className = 'shop-item-price';
    priceEl.textContent = item.price === 0 ? '免費' : `💰 ${item.price}`;
    card.appendChild(priceEl);

    const btn = document.createElement('button');
    btn.type = 'button';
    if (equipped) {
      btn.textContent = '✅ 已裝備';
      btn.className = 'shop-item-btn equipped';
      btn.disabled = true;
    } else if (owned) {
      btn.textContent = '裝備';
      btn.className = 'shop-item-btn equip';
      btn.addEventListener('click', () => socket.emit('equip_skin', item.id));
    } else {
      btn.textContent = canAfford ? '購買' : '金幣不足';
      btn.className = 'shop-item-btn buy';
      btn.disabled = !canAfford;
      btn.addEventListener('click', () => socket.emit('buy_skin', item.id));
    }
    card.appendChild(btn);

    grid.appendChild(card);
  });
}

document.getElementById('btn-open-shop').addEventListener('click', () => {
  document.getElementById('modal-shop').classList.remove('hidden');
  updateCoinDisplays();
  renderShopGrid();
});
document.getElementById('btn-close-shop').addEventListener('click', () => {
  document.getElementById('modal-shop').classList.add('hidden');
});

// 一登入完成（含訪客）就先更新一次金幣欄位顯示；已登入帳號的正確金額稍後 auth_ok 回來會再更新一次
window.addEventListener('app-auth-ready', () => updateCoinDisplays());

// ---------- 接收伺服器的商店相關事件 ----------
// socket 是 game.js 建立的全域變數（const 宣告，但同頁面的後載入 script 仍可直接存取），
// shop.js 的 <script> 標籤在 index.html 裡排在 game.js 之後，所以這裡一定拿得到。
function wireShopSocketEvents() {
  socket.on('auth_ok', (data) => {
    window.AppShop.coins = data.coins || 0;
    window.AppShop.ownedSkins = data.ownedSkins || ['classic'];
    window.AppShop.equippedSkin = data.equippedSkin || 'classic';
    updateCoinDisplays();
  });

  socket.on('shop_update', (data) => {
    if (typeof data.coins === 'number') window.AppShop.coins = data.coins;
    if (Array.isArray(data.ownedSkins)) window.AppShop.ownedSkins = data.ownedSkins;
    if (typeof data.equippedSkin === 'string') window.AppShop.equippedSkin = data.equippedSkin;
    updateCoinDisplays();
    renderShopGrid();
  });

  socket.on('shop_error', (data) => {
    alert(data.message);
  });

  socket.on('coins_earned', ({ earned, total }) => {
    window.AppShop.coins = total;
    updateCoinDisplays();
    const line = document.getElementById('coins-earned-line');
    if (line) {
      line.textContent = `💰 這局獲得了 ${earned} 金幣！目前共有 ${total} 金幣`;
      line.classList.remove('hidden');
    }
  });
}

// socket 由 game.js 建立，這支檔案在它之後載入，此時 window.socket 已經可以用了
if (typeof socket !== 'undefined') {
  wireShopSocketEvents();
}
