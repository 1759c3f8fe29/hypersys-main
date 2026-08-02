import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getDatabase } from 'firebase/database';

const firebaseConfig = {
  apiKey: "AIzaSyB6_zj7NJoMOgbSo1bFy0XJpahL-V6uBM0",
  authDomain: "promptgenv1.firebaseapp.com",
  databaseURL: "https://promptgenv1-default-rtdb.firebaseio.com",
  projectId: "promptgenv1",
  storageBucket: "promptgenv1.firebasestorage.app",
  messagingSenderId: "328086208684",
  appId: "1:328086208684:web:3bc5656f1ec7db021c5f09"
};

// Initialize Firebase
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

export const auth = getAuth(app);
export const db = getFirestore(app);
export const rtdb = getDatabase(app);
export const googleProvider = new GoogleAuthProvider();

// Apply custom scopes if needed
googleProvider.addScope('email');
googleProvider.addScope('profile');
// Setting custom parameter to force select account
googleProvider.setCustomParameters({
  prompt: 'select_account'
});

