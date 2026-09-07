// Firebase 콘솔(console.firebase.google.com) > 프로젝트 설정 > 내 앱 > 웹 앱의
// firebaseConfig 값. 이 프로젝트(fire-inspection)는 팀 전체가 공유하는 온라인 저장소로,
// 거래처/점검기록/지적사항/스케줄 자료가 여기 저장되어 누가 접속하든 같은 자료를 봅니다.

const firebaseConfig = {
  apiKey: "AIzaSyAPAjnqrugCS2kuNlbVg8IJAjcbKYAdisI",
  authDomain: "fire-inspection-cec4b.firebaseapp.com",
  databaseURL: "https://fire-inspection-cec4b-default-rtdb.firebaseio.com",
  projectId: "fire-inspection-cec4b",
  storageBucket: "fire-inspection-cec4b.firebasestorage.app",
  messagingSenderId: "606633256475",
  appId: "1:606633256475:web:d7539c83467d69cdc33abe",
};

firebase.initializeApp(firebaseConfig);
