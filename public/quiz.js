// ===== 解題加強：答題換道具 =====
// 道具目錄跟伺服器 lib/config.js 的 POWERUP_CATALOG 保持一致(純顯示用，實際效果以伺服器套用為準)
const POWERUP_CATALOG_CLIENT = {
  extra_length: { name: '瞬間加長', desc: '啟動後立即增加10節身體長度', icon: '📏', questionCount: 3 },
  invincible_3s: { name: '短暫無敵', desc: '啟動後立即獲得3秒無敵，撞到人也不會死', icon: '🛡️', questionCount: 5 },
  free_boost_10s: { name: '加速不耗長度', desc: '啟動後10秒內，加速衝刺不會消耗身體長度', icon: '⚡', questionCount: 5 },
  revive_once: { name: '死亡保命', desc: '啟動後進入武裝狀態，下一次被殺會原地復活(保留一半長度)', icon: '❤️', questionCount: 8 },
  magnet: { name: '磁鐵吸引', desc: '啟動後8秒內，附近的食物會自動被吸過來', icon: '🧲', questionCount: 4 },
  score_double: { name: '分數加倍', desc: '啟動後10秒內，吃到的東西分數變成2倍', icon: '✨', questionCount: 4 },
};

let myPowerupBag = []; // [{id, name, icon}] 背包，目前手上已經拿到、還沒用掉的道具，可以同時持有多個
let quizQuestions = []; // 這一輪拿到的題目(不含正確答案)
let quizCurrentIndex = 0;

function showQuizView(view) {
  ['select', 'play', 'result'].forEach((v) => {
    document.getElementById(`quiz-view-${v}`).classList.toggle('hidden', v !== view);
  });
}

function renderPowerupList() {
  const list = document.getElementById('quiz-powerup-list');
  list.innerHTML = Object.entries(POWERUP_CATALOG_CLIENT).map(([id, p]) => `
    <div class="quiz-powerup-item" data-powerup-id="${id}">
      <div class="powerup-icon">${p.icon}</div>
      <div class="powerup-info">
        <div class="powerup-name">${p.name}</div>
        <div class="powerup-desc">${p.desc}</div>
      </div>
      <div class="powerup-count">${p.questionCount} 題</div>
    </div>
  `).join('');
  list.querySelectorAll('.quiz-powerup-item').forEach((el) => {
    el.addEventListener('click', () => {
      socket.emit('request_quiz', { powerupId: el.dataset.powerupId });
    });
  });
}

document.getElementById('btn-open-quiz').addEventListener('click', () => {
  showQuizView('select');
  renderPowerupList();
  document.getElementById('modal-quiz').classList.remove('hidden');
});
document.getElementById('btn-close-quiz-select').addEventListener('click', () => {
  document.getElementById('modal-quiz').classList.add('hidden');
});

socket.on('quiz_started', (data) => {
  quizQuestions = data.questions;
  quizCurrentIndex = 0;
  showQuizView('play');
  renderQuizQuestion();
});

function renderQuizQuestion() {
  const q = quizQuestions[quizCurrentIndex];
  document.getElementById('quiz-progress-text').textContent = `第 ${quizCurrentIndex + 1} / ${quizQuestions.length} 題`;
  document.getElementById('quiz-progress-fill').style.width = `${(quizCurrentIndex / quizQuestions.length) * 100}%`;
  document.getElementById('quiz-category').textContent = q.category || '常識';
  document.getElementById('quiz-question-text').textContent = q.q;
  const optionsEl = document.getElementById('quiz-options');
  delete optionsEl.dataset.locked;
  optionsEl.innerHTML = q.options.map((opt, i) => `
    <button type="button" class="quiz-option-btn" data-index="${i}">${opt}</button>
  `).join('');
  optionsEl.querySelectorAll('.quiz-option-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      // 這題已經答過了(避免使用者連點兩次搶跑)
      if (optionsEl.dataset.locked === '1') return;
      optionsEl.dataset.locked = '1';
      socket.emit('answer_quiz_question', { selectedIndex: parseInt(btn.dataset.index, 10) });
      window.__quizPickedIndex = parseInt(btn.dataset.index, 10);
    });
  });
}

// 伺服器批改完這一題，立刻顯示對錯(答對綠色、答錯紅色並標出正確答案)，停一下再進下一題
socket.on('quiz_answer_result', (result) => {
  const optionsEl = document.getElementById('quiz-options');
  const buttons = optionsEl.querySelectorAll('.quiz-option-btn');
  buttons.forEach((btn) => { btn.disabled = true; });
  const pickedIndex = window.__quizPickedIndex;
  if (result.correct) {
    buttons[pickedIndex].classList.add('correct');
    SoundFx.eat();
  } else {
    buttons[pickedIndex].classList.add('wrong');
    if (buttons[result.correctIndex]) buttons[result.correctIndex].classList.add('correct');
  }
  setTimeout(() => {
    if (result.isLast) return; // 最後一題不用再畫下一題，quiz_result會接著把畫面切到結果頁
    quizCurrentIndex++;
    renderQuizQuestion();
  }, 900);
});

socket.on('quiz_result', (result) => {
  showQuizView('result');
  const title = document.getElementById('quiz-result-title');
  const detail = document.getElementById('quiz-result-detail');
  if (result.passed) {
    title.textContent = '🎉 通過了！道具已經放進背包';
    const p = POWERUP_CATALOG_CLIENT[result.powerupId];
    myPowerupBag.push({ id: result.powerupId, name: p ? p.name : result.powerupId, icon: p ? p.icon : '🎁' });
    updatePowerupButton();
  } else {
    title.textContent = '😅 差一點點，再試一次吧';
  }
  let text = `答對 ${result.correct} / ${result.total} 題（至少要對8成才能拿到道具）`;
  if (result.coinsEarned > 0) {
    text += `，獲得 ${result.coinsEarned} 金幣`;
    if (window.AppShop && result.coins != null) window.AppShop.coins = result.coins;
  }
  detail.textContent = text;
  renderQuizReview(result.history || []);
});

function renderQuizReview(history) {
  const list = document.getElementById('quiz-review-list');
  if (!history.length) { list.innerHTML = ''; return; }
  list.innerHTML = '<div class="quiz-review-title">📖 複習一下剛剛的題目</div>' + history.map((h) => `
    <div class="quiz-review-item ${h.correct ? 'is-correct' : 'is-wrong'}">
      <div class="quiz-review-q">${h.correct ? '✅' : '❌'} ${h.q}</div>
      <div class="quiz-review-a">你選了：${h.options[h.selectedIndex] ?? '（沒有作答）'}</div>
      ${h.correct ? '' : `<div class="quiz-review-a correct-answer">正確答案：${h.options[h.correctIndex]}</div>`}
    </div>
  `).join('');
}
document.getElementById('btn-quiz-result-ok').addEventListener('click', () => {
  document.getElementById('modal-quiz').classList.add('hidden');
});

// 遊戲內使用道具的按鈕：只有生存/限時模式才會顯示(MOBA不行)，背包有幾個就顯示幾個數字
function updatePowerupButton() {
  const btn = document.getElementById('btn-use-powerup');
  const inGame = document.getElementById('screen-game').classList.contains('active');
  const modeOk = latestState && (latestState.mode === 'survival' || latestState.mode === 'timed');
  if (myPowerupBag.length > 0 && inGame && modeOk) {
    btn.textContent = `🎒 背包 (${myPowerupBag.length})`;
    btn.classList.remove('hidden');
  } else {
    btn.classList.add('hidden');
  }
}
function renderBackpack(listElementId, interactive) {
  const list = document.getElementById(listElementId);
  if (myPowerupBag.length === 0) {
    list.innerHTML = '<p class="hint">背包裡空空的，去解題加強拿一些道具吧！</p>';
    return;
  }
  list.innerHTML = myPowerupBag.map((p, i) => `
    <div class="quiz-powerup-item backpack-item">
      <div class="powerup-icon">${p.icon}</div>
      <div class="powerup-info">
        <div class="powerup-name">${p.name}</div>
      </div>
      ${interactive ? `<button type="button" class="btn btn-primary backpack-use-btn" data-index="${i}">使用</button>` : ''}
    </div>
  `).join('');
  if (!interactive) return;
  list.querySelectorAll('.backpack-use-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const powerupId = myPowerupBag[parseInt(btn.dataset.index, 10)].id;
      socket.emit('activate_powerup', { powerupId });
    });
  });
}
document.getElementById('btn-use-powerup').addEventListener('click', () => {
  renderBackpack('backpack-list', true);
  document.getElementById('modal-backpack').classList.remove('hidden');
});
document.getElementById('btn-close-backpack').addEventListener('click', () => {
  document.getElementById('modal-backpack').classList.add('hidden');
});
document.getElementById('btn-open-backpack-lobby').addEventListener('click', () => {
  renderBackpack('backpack-list-lobby', false); // 大廳只能查看，不能直接使用道具(要在對局中才能用)
  document.getElementById('modal-backpack-lobby').classList.remove('hidden');
});
document.getElementById('btn-close-backpack-lobby').addEventListener('click', () => {
  document.getElementById('modal-backpack-lobby').classList.add('hidden');
});
socket.on('powerup_activated', ({ powerupId }) => {
  const idx = myPowerupBag.findIndex((p) => p.id === powerupId);
  if (idx !== -1) myPowerupBag.splice(idx, 1);
  updatePowerupButton();
  // 選完立刻關閉彈窗：彈窗是蓋滿全畫面的浮層，開著的話滑鼠事件會被它擋住，蛇沒辦法被滑鼠控制
  document.getElementById('modal-backpack').classList.add('hidden');
  SoundFx.superEat(); // 借用升級音效，聽起來像是有東西生效了
});
socket.on('my_powerup_status', (data) => {
  myPowerupBag = (data.bag || []).map((id) => {
    const p = POWERUP_CATALOG_CLIENT[id];
    return { id, name: p ? p.name : id, icon: p ? p.icon : '🎁' };
  });
  updatePowerupButton();
});
// 每次連上就順便問一次目前手上有沒有已經拿到但還沒用掉的道具(重新整理頁面後也看得到)
socket.emit('check_my_powerup');

// ===== 每日簽到題 =====
function showDailyView(view) {
  ['intro', 'play', 'result'].forEach((v) => {
    document.getElementById(`daily-view-${v}`).classList.toggle('hidden', v !== view);
  });
}
document.getElementById('btn-open-daily').addEventListener('click', () => {
  showDailyView('intro');
  document.getElementById('modal-daily').classList.remove('hidden');
});
document.getElementById('btn-close-daily-intro').addEventListener('click', () => {
  document.getElementById('modal-daily').classList.add('hidden');
});
document.getElementById('btn-daily-start').addEventListener('click', () => {
  socket.emit('request_daily_checkin');
});

// 登入完成後自動偷看一次今天簽到過沒，還沒簽到的話直接跳出來，不用使用者自己找按鈕
window.addEventListener('app-auth-ready', (e) => {
  if (e.detail && e.detail.isGuest) return; // 訪客不會被打擾
  setTimeout(() => socket.emit('peek_daily_checkin'), 500);
});
socket.on('daily_checkin_peek_result', (data) => {
  if (data.done) return;
  document.getElementById('daily-checkin-badge').classList.remove('hidden');
  showDailyView('intro');
  document.getElementById('modal-daily').classList.remove('hidden');
});

socket.on('daily_checkin_unavailable', (data) => {
  if (data && data.reason === 'no_firebase') {
    alert('伺服器目前還沒設定好帳號系統，暫時沒辦法使用每日簽到，請稍後再試。');
  } else {
    alert('要先登入帳號才能玩每日簽到題喔（訪客身分沒辦法用）');
  }
});
socket.on('daily_checkin_status', (data) => {
  if (data.alreadyDone) {
    showDailyView('result');
    document.getElementById('daily-result-title').textContent = '✅ 今天已經簽到過了';
    document.getElementById('daily-result-detail').textContent = '明天再來吧！';
    document.getElementById('modal-daily').classList.remove('hidden');
    document.getElementById('daily-checkin-badge').classList.add('hidden');
  }
});
socket.on('daily_checkin_question', (q) => {
  showDailyView('play');
  document.getElementById('daily-category').textContent = q.category || '常識';
  document.getElementById('daily-question-text').textContent = q.q;
  const optionsEl = document.getElementById('daily-options');
  delete optionsEl.dataset.locked;
  optionsEl.innerHTML = q.options.map((opt, i) => `
    <button type="button" class="quiz-option-btn" data-index="${i}">${opt}</button>
  `).join('');
  optionsEl.querySelectorAll('.quiz-option-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (optionsEl.dataset.locked === '1') return;
      optionsEl.dataset.locked = '1';
      window.__dailyPickedIndex = parseInt(btn.dataset.index, 10);
      socket.emit('submit_daily_checkin', { selectedIndex: window.__dailyPickedIndex });
    });
  });
});
socket.on('daily_checkin_result', (result) => {
  const optionsEl = document.getElementById('daily-options');
  const buttons = optionsEl.querySelectorAll('.quiz-option-btn');
  buttons.forEach((btn) => { btn.disabled = true; });
  const pickedIndex = window.__dailyPickedIndex;
  if (result.correct) {
    buttons[pickedIndex].classList.add('correct');
  } else {
    buttons[pickedIndex].classList.add('wrong');
    if (buttons[result.correctIndex]) buttons[result.correctIndex].classList.add('correct');
  }
  setTimeout(() => {
    showDailyView('result');
    document.getElementById('daily-result-title').textContent = result.correct ? '🎉 答對了！' : '😅 答錯了，明天再試一次';
    let detail = result.correct
      ? `獲得 ${result.coinsEarned} 金幣（目前共 ${result.coins} 枚）` : '今天已經算簽到過了，明天再來挑戰。';
    detail += `\n🔥 連續簽到 ${result.streak} 天`;
    if (result.milestoneBonus > 0) detail += `，滿7天額外獎勵 +${result.milestoneBonus} 金幣！`;
    document.getElementById('daily-result-detail').style.whiteSpace = 'pre-line';
    document.getElementById('daily-result-detail').textContent = detail;
    document.getElementById('daily-checkin-badge').classList.add('hidden');
    if (window.AppShop) window.AppShop.coins = result.coins;
  }, 900);
});
document.getElementById('btn-daily-result-ok').addEventListener('click', () => {
  document.getElementById('modal-daily').classList.add('hidden');
});
