// ===== 登入 / 註冊 / 訪客模式 =====
window.AppAuth = {
  currentUser: null, // { uid, name, idToken, isGuest }
};

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function setFormError(id, message) {
  document.getElementById(id).textContent = message || '';
}

// --- Tabs ---
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('form-login').classList.toggle('hidden', tab !== 'login');
    document.getElementById('form-register').classList.toggle('hidden', tab !== 'register');
    document.getElementById('form-forgot').classList.add('hidden');
  });
});

// --- 忘記密碼 ---
document.getElementById('btn-toggle-forgot').addEventListener('click', () => {
  document.getElementById('form-login').classList.add('hidden');
  document.getElementById('form-forgot').classList.remove('hidden');
  document.getElementById('forgot-success').classList.add('hidden');
});
document.getElementById('btn-back-to-login').addEventListener('click', () => {
  document.getElementById('form-forgot').classList.add('hidden');
  document.getElementById('form-login').classList.remove('hidden');
});
document.getElementById('form-forgot').addEventListener('submit', async (e) => {
  e.preventDefault();
  setFormError('forgot-error', '');
  document.getElementById('forgot-success').classList.add('hidden');
  const email = document.getElementById('forgot-email').value.trim();
  try {
    await auth.sendPasswordResetEmail(email);
    document.getElementById('forgot-success').classList.remove('hidden');
  } catch (err) {
    setFormError('forgot-error', translateAuthError(err));
  }
});

// --- 註冊 ---
document.getElementById('form-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  setFormError('register-error', '');
  const name = document.getElementById('register-name').value.trim();
  const email = document.getElementById('register-email').value.trim();
  const password = document.getElementById('register-password').value;
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName: name });
    cred.user.sendEmailVerification().catch(() => {}); // 寄驗證信失敗不影響註冊流程本身
    // 建立自己的 Firestore 個人資料（只允許建立自己的 displayName，highScore 固定從 0 開始）
    await onUserSignedIn(cred.user, name);
  } catch (err) {
    setFormError('register-error', translateAuthError(err));
  }
});

// --- 登入 ---
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  setFormError('login-error', '');
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  try {
    const cred = await auth.signInWithEmailAndPassword(email, password);
    await onUserSignedIn(cred.user, cred.user.displayName);
  } catch (err) {
    setFormError('login-error', translateAuthError(err));
  }
});

// --- Google 登入 ---
document.getElementById('btn-google').addEventListener('click', async () => {
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    const cred = await auth.signInWithPopup(provider);
    await onUserSignedIn(cred.user, cred.user.displayName);
  } catch (err) {
    if (err.code === 'auth/popup-closed-by-user') return; // 使用者自己關掉視窗，不用顯示錯誤
    setFormError('login-error', translateAuthError(err));
  }
});

// --- 訪客模式（不使用 Firebase Auth，只在本次連線期間有效，不記錄排行榜） ---
document.getElementById('btn-guest').addEventListener('click', () => {
  const guestName = `訪客${Math.floor(Math.random() * 9000 + 1000)}`;
  window.AppAuth.currentUser = { uid: null, name: guestName, idToken: null, isGuest: true };
  enterLobby();
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  try { await auth.signOut(); } catch (e) { /* ignore */ }
  window.AppAuth.currentUser = null;
  showScreen('screen-auth');
});

async function onUserSignedIn(firebaseUser, fallbackName) {
  const idToken = await firebaseUser.getIdToken();
  const name = fallbackName || firebaseUser.email.split('@')[0];
  window.AppAuth.currentUser = { uid: firebaseUser.uid, name, idToken, isGuest: false };

  // 嘗試建立/更新自己的 displayName（受 firestore.rules 限制，安全）
  try {
    const db = firebase.firestore ? firebase.firestore() : null;
    if (db) {
      await db.collection('users').doc(firebaseUser.uid).set(
        { displayName: name, highScore: 0, gamesPlayed: 0 },
        { merge: true }
      );
    }
  } catch (e) {
    // 文件已存在時 highScore:0 的 create 規則會被擋下，這是正常情況，忽略即可
  }

  enterLobby();
}

function translateAuthError(err) {
  const map = {
    'auth/email-already-in-use': '這個信箱已經被註冊過了',
    'auth/invalid-email': '信箱格式不正確',
    'auth/weak-password': '密碼至少需要 6 個字元',
    'auth/user-not-found': '找不到這個帳號',
    'auth/wrong-password': '密碼錯誤',
    'auth/invalid-credential': '帳號或密碼錯誤',
    'auth/too-many-requests': '嘗試次數過多，請稍後再試',
    'auth/popup-blocked': '瀏覽器擋住了登入視窗，請允許彈出視窗後再試一次',
    'auth/operation-not-allowed': 'Google 登入尚未在 Firebase 主控台啟用，請聯絡管理員設定',
  };
  return map[err.code] || `發生錯誤：${err.message}`;
}

function enterLobby() {
  document.getElementById('lobby-username').textContent = window.AppAuth.currentUser.name;
  showScreen('screen-lobby');
  window.dispatchEvent(new CustomEvent('app-auth-ready', { detail: window.AppAuth.currentUser }));
  if (window.refreshMyStats) window.refreshMyStats();

  // Email 驗證提醒：訪客跟 Google 登入（本來就已驗證過）不會看到這個橫幅
  const banner = document.getElementById('verify-email-banner');
  const fbUser = auth.currentUser;
  const needsVerify = fbUser && !fbUser.emailVerified && !window.AppAuth.currentUser.isGuest
    && fbUser.providerData.some(p => p.providerId === 'password');
  banner.classList.toggle('hidden', !needsVerify);
}
document.getElementById('btn-resend-verify').addEventListener('click', async () => {
  const btn = document.getElementById('btn-resend-verify');
  if (!auth.currentUser) return;
  btn.disabled = true;
  btn.textContent = '寄送中...';
  try {
    await auth.currentUser.sendEmailVerification();
    btn.textContent = '✅ 已寄出，請去信箱收信';
  } catch (e) {
    btn.textContent = '寄送失敗，稍後再試';
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = '重新發送驗證信'; }, 6000);
});

// 網頁重新整理/重新開啟時，Firebase 其實還記得使用者上次登入過（瀏覽器本地有存），
// 這裡負責把畫面狀態（window.AppAuth.currentUser）跟 Firebase 實際的登入狀態同步起來，
// 不然商店等地方會因為「畫面以為你是訪客」而誤判，而且每次重新整理都要重新輸入帳密。
auth.onAuthStateChanged((firebaseUser) => {
  if (firebaseUser && !window.AppAuth.currentUser) {
    onUserSignedIn(firebaseUser, firebaseUser.displayName).catch(() => {
      // 自動恢復登入失敗（例如網路問題），就讓使用者留在登入畫面手動登入即可
    });
  }
});
