// ===== 好友 / 戰績 / 封鎖名單 =====
// socket 是 game.js 建立的全域變數，這支檔案在 index.html 裡排在 game.js 之後載入，一定拿得到。

function isLoggedIn() {
  return window.AppAuth.currentUser && !window.AppAuth.currentUser.isGuest;
}

// ---------- 好友彈窗 ----------
function refreshFriendsModal() {
  const guest = !isLoggedIn();
  document.getElementById('friends-guest-hint').classList.toggle('hidden', !guest);
  document.getElementById('friends-body').classList.toggle('hidden', guest);
  if (guest) return;
  socket.emit('get_friends');
  socket.emit('get_blocked_list');
}

document.getElementById('btn-open-friends').addEventListener('click', () => {
  document.getElementById('modal-friends').classList.remove('hidden');
  refreshFriendsModal();
});
document.getElementById('btn-close-friends').addEventListener('click', () => {
  document.getElementById('modal-friends').classList.add('hidden');
});

document.getElementById('btn-friend-search').addEventListener('click', doFriendSearch);
document.getElementById('friend-search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); doFriendSearch(); }
});
function doFriendSearch() {
  const q = document.getElementById('friend-search-input').value.trim();
  if (!q) return;
  socket.emit('search_users', q);
}

socket.on('user_search_results', ({ results }) => {
  const list = document.getElementById('friend-search-results');
  if (!results || results.length === 0) {
    list.innerHTML = '<li class="social-empty">找不到符合的玩家</li>';
    return;
  }
  list.innerHTML = results.map(r => `
    <li>
      <span class="social-name">${escapeHtml(r.name)}</span>
      <button type="button" class="btn-add" data-uid="${r.uid}" data-name="${escapeHtml(r.name)}">加好友</button>
    </li>
  `).join('');
  list.querySelectorAll('.btn-add').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('send_friend_request', { targetUid: btn.dataset.uid, targetName: btn.dataset.name });
      btn.textContent = '已送出';
      btn.disabled = true;
    });
  });
});

socket.on('friends_data', ({ friends, incoming }) => {
  const incomingTitle = document.getElementById('friend-incoming-title');
  const incomingList = document.getElementById('friend-incoming-list');
  const badge = document.getElementById('friend-request-badge');

  if (incoming && incoming.length > 0) {
    incomingTitle.classList.remove('hidden');
    badge.classList.remove('hidden');
    incomingList.innerHTML = incoming.map(r => `
      <li>
        <span class="social-name">${escapeHtml(r.name)}</span>
        <button type="button" class="btn-accept" data-uid="${r.uid}" data-name="${escapeHtml(r.name)}">接受</button>
        <button type="button" class="btn-decline" data-uid="${r.uid}">拒絕</button>
      </li>
    `).join('');
    incomingList.querySelectorAll('.btn-accept').forEach(btn => {
      btn.addEventListener('click', () => socket.emit('respond_friend_request', { fromUid: btn.dataset.uid, fromName: btn.dataset.name, accept: true }));
    });
    incomingList.querySelectorAll('.btn-decline').forEach(btn => {
      btn.addEventListener('click', () => socket.emit('respond_friend_request', { fromUid: btn.dataset.uid, accept: false }));
    });
  } else {
    incomingTitle.classList.add('hidden');
    badge.classList.add('hidden');
    incomingList.innerHTML = '';
  }

  const friendList = document.getElementById('friend-list');
  if (!friends || friends.length === 0) {
    friendList.innerHTML = '<li class="social-empty">還沒有好友，搜尋暱稱或在遊戲結算畫面加好友看看！</li>';
    return;
  }
  friendList.innerHTML = friends.map(f => `
    <li>
      <span class="social-name">${escapeHtml(f.name)}</span>
      <button type="button" class="btn-remove" data-uid="${f.uid}">刪除</button>
    </li>
  `).join('');
  friendList.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('確定要刪除這位好友嗎？')) socket.emit('remove_friend', { targetUid: btn.dataset.uid });
    });
  });
});

socket.on('blocked_list', ({ blocked }) => {
  const list = document.getElementById('blocked-list');
  if (!blocked || blocked.length === 0) {
    list.innerHTML = '<li class="social-empty">目前沒有封鎖任何人</li>';
    return;
  }
  list.innerHTML = blocked.map(b => `
    <li>
      <span class="social-name">${escapeHtml(b.name)}</span>
      <button type="button" class="btn-unblock" data-uid="${b.uid}">解除封鎖</button>
    </li>
  `).join('');
  list.querySelectorAll('.btn-unblock').forEach(btn => {
    btn.addEventListener('click', () => socket.emit('unblock_player', { targetUid: btn.dataset.uid }));
  });
});

// 好友申請幾乎每次登入/開好友清單就會拿到一次，這裡順便在還沒開彈窗前也偷看一次有沒有新邀請，
// 讓左側「好友」按鈕上可以顯示紅點提醒
window.addEventListener('app-auth-ready', () => {
  if (isLoggedIn()) socket.emit('get_friends');
});

// ---------- 通用的操作結果提示 ----------
socket.on('social_ok', (data) => {
  alert(data.message);
  // 操作完之後如果好友彈窗還開著，順便刷新一次畫面
  if (!document.getElementById('modal-friends').classList.contains('hidden')) refreshFriendsModal();
});
socket.on('social_error', (data) => {
  alert(data.message);
});

// ---------- 戰績彈窗 ----------
document.getElementById('btn-open-stats').addEventListener('click', async () => {
  document.getElementById('modal-stats').classList.remove('hidden');
  const guest = !isLoggedIn();
  document.getElementById('stats-guest-hint').classList.toggle('hidden', !guest);
  document.getElementById('stats-grid').classList.toggle('hidden', guest);
  if (guest) return;
  try {
    const res = await fetch(`/api/me/${window.AppAuth.currentUser.uid}`);
    const data = await res.json();
    document.getElementById('stats-highscore').textContent = data.enabled ? data.highScore : '--';
    document.getElementById('stats-games').textContent = data.enabled ? data.gamesPlayed : '--';
    document.getElementById('stats-wins').textContent = data.enabled ? data.wins : '--';
    document.getElementById('stats-kills').textContent = data.enabled ? data.totalKills : '--';
    document.getElementById('stats-coins').textContent = data.enabled ? (window.AppShop ? window.AppShop.coins : data.coins) : '--';
  } catch (e) {
    ['stats-highscore', 'stats-games', 'stats-wins', 'stats-kills', 'stats-coins'].forEach(id => {
      document.getElementById(id).textContent = '--';
    });
  }
});
document.getElementById('btn-close-stats').addEventListener('click', () => {
  document.getElementById('modal-stats').classList.add('hidden');
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
