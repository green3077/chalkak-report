// 로그인 - Firebase Authentication(이메일/비밀번호)을 사용한다. 모든 자료(거래처·지적사항)가
// 팀 공용 온라인 저장소(Firebase)에 있고, 그 저장소는 로그인한 사람만 읽고 쓸 수 있도록 규칙이
// 걸려 있어서, 어디서 접속하든 로그인이 항상 필요하다.
//
// 여러 소방공사업체가 이 앱 하나를 같이 쓰되 서로 다른 회사 자료는 보이지 않아야 하므로,
// 계정마다 소속 회사(companyId)를 같이 적어둔다 - 자료는 Firebase 안에서 회사별로 나뉘어
// 저장되고(db.js), 실제 접근 제한은 Firebase 보안규칙이 강제한다(README.md의 안내 참고).
//
// 새 회사를 추가하려면:
// 1) Firebase 콘솔 > Authentication에서 이메일/비밀번호로 계정을 추가하고 UID를 확인한다.
// 2) Firebase 콘솔 > Realtime Database에서 chalkak/companyAccess/<UID> 값을 그 회사의
//    companyId(영문/숫자, 예: "greenfire")로 저장한다 - 이 매핑이 있어야 보안규칙이 통과된다.
// 3) 아래 ACCOUNTS에 "아이디": { email, companyId } 한 줄을 추가한다. 같은 회사 사람이
//    여러 명이면 companyId만 같게 맞추고 email/아이디는 각자 새로 만들면 된다.
(function (global) {
  "use strict";

  const ACCOUNTS = {
    virus4646: { email: "virus4646@fireinspection.app", companyId: "green307" },
    green307: { email: "green307@fireinspection.app", companyId: "green307" },
  };

  let currentUser = null;
  let currentCompanyId = null;

  function getDisplayName() {
    if (!currentUser || !currentUser.email) return "";
    return currentUser.email.split("@")[0];
  }

  function getCompanyId() {
    return currentCompanyId;
  }

  function isLoggedIn() {
    return !!currentUser;
  }

  async function tryLogin(username, password) {
    const account = ACCOUNTS[String(username || "").trim()];
    if (!account) return false;
    try {
      const cred = await firebase.auth().signInWithEmailAndPassword(account.email, password);
      currentUser = cred.user;
      currentCompanyId = account.companyId;
      return true;
    } catch (err) {
      return false;
    }
  }

  function logout() {
    currentUser = null;
    currentCompanyId = null;
    firebase.auth().signOut();
  }

  // 이메일로 ACCOUNTS에서 companyId를 되찾는다 - Firebase가 기억한 로그인 상태를 복원할 때는
  // tryLogin에서 쓴 "아이디"를 다시 알 수 없고 이메일만 주어지므로, 이메일로 역매핑한다.
  function companyIdForEmail(email) {
    const entry = Object.values(ACCOUNTS).find((a) => a.email === email);
    return entry ? entry.companyId : null;
  }

  // 앱 시작 시 한 번, Firebase가 기억하고 있는 로그인 상태(기기별로 유지됨)를 확인한다.
  // 로그인돼 있으면 다시 로그인할 필요 없이 바로 앱을 사용할 수 있다.
  // Firebase 스크립트 로드 실패 등으로 여기서 예외가 나면 로그인 화면조차 뜨지 않고 앱이
  // 먹통이 될 수 있으므로, 실패해도 반드시 "로그인 안 됨"으로 resolve해서 로그인 화면이 뜨게 한다.
  // 이메일이 ACCOUNTS 목록에 없으면(예: 콘솔에서 직접 만들었지만 이 파일에는 아직 안 적어둔
  // 계정) 소속 회사를 알 수 없으므로 로그아웃 처리해 안전한 쪽으로 되돌린다.
  function onReady() {
    return new Promise((resolve) => {
      try {
        const unsubscribe = firebase.auth().onAuthStateChanged(
          (user) => {
            unsubscribe();
            const companyId = user ? companyIdForEmail(user.email) : null;
            if (user && !companyId) {
              firebase.auth().signOut();
              resolve(false);
              return;
            }
            currentUser = user;
            currentCompanyId = companyId;
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
    getCompanyId,
    onReady,
  };
})(window);
