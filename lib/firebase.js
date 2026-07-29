// ---------- Firebase Admin 初始化 ----------
// 內容從原本 server.js 搬過來，邏輯完全沒變，只有 serviceAccountKey.json 的相對路徑
// 因為這個檔案現在放在 lib/ 資料夾裡，所以從 './' 改成 '../'（金鑰檔案還是放在專案根目錄）。
const admin = require('firebase-admin');

let serviceAccount = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (e) {
    console.error('❌ FIREBASE_SERVICE_ACCOUNT 不是合法的 JSON，請檢查 .env 設定');
  }
} else {
  try {
    serviceAccount = require('../serviceAccountKey.json');
  } catch (e) {
    // 沒放金鑰檔案也沒關係，先讓伺服器啟動，但登入/排行榜功能會失效
  }
}

let db = null;
let authEnabled = false;
if (serviceAccount) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  authEnabled = true;
  console.log('✅ Firebase Admin 已初始化，登入 / 排行榜功能已啟用');
} else {
  console.warn('⚠️ 尚未設定 Firebase 金鑰，登入與排行榜功能將無法使用（遊戲仍可用訪客身分連線測試）');
}

module.exports = { admin, db, authEnabled };
