import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyAiSuFfU8KnhoXIatUmSBij7ysh0dwvzDQ",
  authDomain: "openagent-market.firebaseapp.com",
  projectId: "openagent-market",
  storageBucket: "openagent-market.firebasestorage.app",
  messagingSenderId: "1009313780",
  appId: "1:1009313780:web:162dbc47b3a8569ff3fba1",
  measurementId: "G-N9H2WY6VFZ",
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp, "pets");
export const storage = getStorage(firebaseApp);
