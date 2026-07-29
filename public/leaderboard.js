// ===== 排行榜 / 個人最高紀錄 =====
window.refreshMyStats = async function refreshMyStats() {
  const user = window.AppAuth.currentUser;
  const bestEl = document.getElementById('my-best');
  const gamesEl = document.getElementById('my-games');
  if (!user || user.isGuest || !user.uid) {
    bestEl.textContent = '訪客';
    gamesEl.textContent = '不記錄';
    return;
  }
  try {
    const res = await fetch(`/api/me/${user.uid}`);
    const data = await res.json();
    bestEl.textContent = data.enabled ? data.highScore : '--';
    gamesEl.textContent = data.enabled ? data.gamesPlayed : '--';
  } catch (e) {
    bestEl.textContent = '--';
    gamesEl.textContent = '--';
  }
};

async function loadLeaderboard(period = 'all') {
  const list = document.getElementById('leaderboard-list');
  list.innerHTML = '<li>載入中...</li>';
  try {
    const res = await fetch(`/api/leaderboard?period=${period}`);
    const data = await res.json();
    if (!data.enabled) {
      list.innerHTML = '<li>伺服器尚未設定 Firebase，排行榜暫時無法使用</li>';
      return;
    }
    if (data.leaderboard.length === 0) {
      list.innerHTML = period === 'week'
        ? '<li>本週還沒有人上榜，快去玩一局搶頭香！</li>'
        : '<li>還沒有人上榜，快去玩一局搶頭香！</li>';
      return;
    }
    list.innerHTML = data.leaderboard.map(row => `
      <li><span>#${row.rank} ${escapeHtml(row.name)}</span><span>${row.highScore} 分</span></li>
    `).join('');
  } catch (e) {
    list.innerHTML = '<li>載入排行榜失敗</li>';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

document.getElementById('btn-open-leaderboard').addEventListener('click', () => {
  document.getElementById('modal-leaderboard').classList.remove('hidden');
  const activeBtn = document.querySelector('.period-btn.active');
  loadLeaderboard(activeBtn ? activeBtn.dataset.period : 'all');
});
document.getElementById('btn-close-leaderboard').addEventListener('click', () => {
  document.getElementById('modal-leaderboard').classList.add('hidden');
});

document.querySelectorAll('.period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadLeaderboard(btn.dataset.period);
  });
});
