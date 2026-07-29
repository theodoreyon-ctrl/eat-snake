// ⚠️ 請到 Firebase 主控台 → 專案設定 → 一般 → 你的應用程式（Web），
// 複製你自己的設定值貼到下面。這組 config 是「公開」的沒關係，
// 真正的安全性是靠 Firestore 安全規則（firestore.rules）與伺服器端驗證 idToken 來保護。
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
