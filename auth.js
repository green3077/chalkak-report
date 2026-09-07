// 로그인 - Firebase Authentication(이메일/비밀번호)을 사용한다. 모든 자료(거래처·점검기록·
// 지적사항·스케줄)가 이제 팀 공용 온라인 저장소(Firebase)에 있고, 그 저장소는 로그인한
// 사람만 읽고 쓸 수 있도록 규칙이 걸려 있어서, 예전처럼 "사무실 LAN/로컬은 그냥 통과"가
// 불가능하다 - 어디서 접속하든 로그인이 항상 필요하다.
(function (global) {
  "use strict";

  // 아이디(사람이 외우기 쉬운 이름) -> Firebase 로그인용 이메일 매핑.
  // 계정을 늘리려면 Firebase 콘솔 > Authentication에서 이메일/비밀번호로 사용자를 추가하고,
  // 여기에도 아이디 매핑을 한 줄 추가하면 된다.
  const ACCOUNTS = {
    virus4646: "virus4646@fireinspection.app",
    green307: "green307@fireinspection.app",
  };

  let currentUser = null;

  function getDisplayName() {
    if (!currentUser || !currentUser.email) return "";
    return currentUser.email.split("@")[0];
  }

  function isLoggedIn() {
    return !!currentUser;
  }

  async function tryLogin(username, password) {
    const email = ACCOUNTS[String(username || "").trim()];
    if (!email) return false;
    try {
      const cred = await firebase.auth().signInWithEmailAndPassword(email, password);
      currentUser = cred.user;
      return true;
    } catch (err) {
      return false;
    }
  }

  function logout() {
    currentUser = null;
    firebase.auth().signOut();
  }

  // 앱 시작 시 한 번, Firebase가 기억하고 있는 로그인 상태(기기별로 유지됨)를 확인한다.
  // 로그인돼 있으면 다시 로그인할 필요 없이 바로 앱을 사용할 수 있다.
  // Firebase 스크립트 로드 실패 등으로 여기서 예외가 나면 로그인 화면조차 뜨지 않고 앱이
  // 먹통이 될 수 있으므로, 실패해도 반드시 "로그인 안 됨"으로 resolve해서 로그인 화면이 뜨게 한다.
  function onReady() {
    return new Promise((resolve) => {
      try {
        const unsubscribe = firebase.auth().onAuthStateChanged(
          (user) => {
            unsubscribe();
            currentUser = user;
            resolve(!!user);
          },
          () => resolve(false)
        );
      } catch (err) {
        resolve(false);
      }
    });
  }

  global.Auth = {
    isLoggedIn,
    tryLogin,
    logout,
    getDisplayName,
    onReady,
  };
})(window);
