// ⚠️ 請到 Firebase 主控台 → 專案設定 → 一般 → 你的應用程式（Web），
// 複製你自己的設定值貼到下面。這組 config 是「公開」的沒關係，
// 真正的安全性是靠 Firestore 安全規則（firestore.rules）與伺服器端驗證 idToken 來保護。
const firebaseConfig = {
  apiKey: "AIzaSyC-riJATbVpaPkfQV7c1kBxNgia957iNwc",
  authDomain: "eat-snake.firebaseapp.com",
  projectId: "eat-snake",
  storageBucket: "eat-snake.firebasestorage.app",
  messagingSenderId: "946211745036",
  appId: "1:946211745036:web:48fc95517dd5ec5730ad29"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
