import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getAnalytics } from "firebase/analytics";

const firebaseConfig = {
  apiKey: "AIzaSyC3LXVOH2rrnCHw0ONQYaJn3cl0Om-FU_k",
  authDomain: "live-simulation-interview.firebaseapp.com",
  projectId: "live-simulation-interview",
  storageBucket: "live-simulation-interview.firebasestorage.app",
  messagingSenderId: "615341063115",
  appId: "1:615341063115:web:2a4963b14776c82f5ad44e",
  measurementId: "G-N52ZXCMBT6"
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const analytics = getAnalytics(app);
export const googleProvider = new GoogleAuthProvider();
