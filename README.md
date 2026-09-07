# 찰칵보고서

지적사항 사진을 찍고 이행완료보고서(PDF/HWPX)를 만드는 소방시설 점검용 웹앱입니다.

## 기능

- **지적사항**: 거래처를 직접 입력하거나 자료(엑셀·워드·PDF·한글·사진)를 올려 자동으로 등록하고, 방문 회차별로 지적사항과 이행 전/후 사진을 관리합니다.
- **설정**: 소방공사업체 정보(업체명/사업자번호/대표이사/전화번호/소재지)를 저장합니다.
- 회차별 관련서류 업로드, 이행완료보고서 PDF/HWPX 생성 및 공유, 구글 드라이브 자동 백업.

## 실행

정적 파일이라 별도 빌드 없이 바로 서비스할 수 있습니다.

```bash
python3 serve.py
```

## 데이터 저장

- 거래처/지적사항/회차 등 공유 자료: Firebase Realtime Database (로그인 필요, `chalkak/` 경로 아래에 저장되어 다른 프로젝트와 데이터가 섞이지 않습니다)
- 사진/관련서류 등 용량이 큰 자료: 기기별 IndexedDB (필요 시 구글 드라이브에 자동 백업)

## 여러 회사가 함께 쓰기 (멀티테넌트)

이 앱 하나를 여러 소방공사업체가 각자 계정으로 로그인해서 쓸 수 있습니다. 각 계정은 소속
회사(`companyId`)를 가지고 있고, Firebase 자료는 `chalkak/companies/<companyId>/` 아래로
회사별로 나뉘어 저장됩니다. 실제 접근 제한은 앱 코드가 아니라 Firebase 보안규칙이 강제하므로,
아래 규칙을 반드시 Firebase 콘솔에 등록해야 회사 간 자료가 안전하게 분리됩니다.

### 1) Firebase 보안규칙 등록 (최초 1회)

[Firebase 콘솔](https://console.firebase.google.com/) → 이 프로젝트(`fire-inspection-cec4b`) →
**Realtime Database → 규칙(Rules)** 탭에 아래 내용을 붙여넣고 **게시(Publish)**:

```json
{
  "rules": {
    "chalkak": {
      "companyAccess": {
        ".read": "auth != null",
        "$uid": { ".write": false }
      },
      "companies": {
        "$companyId": {
          ".read": "auth != null && root.child('chalkak/companyAccess').child(auth.uid).val() === $companyId",
          ".write": "auth != null && root.child('chalkak/companyAccess').child(auth.uid).val() === $companyId"
        }
      }
    }
  }
}
```

`companyAccess/<uid>`는 어떤 로그인 계정(uid)이 어느 회사(companyId) 소속인지 적어두는
표이고, 클라이언트(앱)는 절대 스스로 쓸 수 없게 `.write: false`로 막혀 있습니다 - 반드시
Firebase 콘솔에서 운영자가 직접 입력해야만 하며, 그래야 사용자가 브라우저 개발자도구로
자신을 다른 회사로 위장시킬 수 없습니다. sobang1004(소방점검 관리) 앱은 `chalkak/` 바깥의
다른 경로를 쓰므로 이 규칙과 무관하며 그대로 동작합니다.

### 2) 새 회사(고객사) 추가하기

1. Firebase 콘솔 → **Authentication → Users → Add user**로 이메일/비밀번호 계정을 만들고,
   생성된 **UID**를 복사해둔다.
2. Firebase 콘솔 → **Realtime Database → 데이터(Data)** 탭에서
   `chalkak/companyAccess/<위에서 복사한 UID>` 값을 그 회사의 `companyId`
   (영문/숫자, 예: `greenfire`)로 저장한다.
3. 저장소의 `auth.js`를 열어 `ACCOUNTS`에 한 줄을 추가한다:
   ```js
   회사아이디: { email: "1번에서 만든 이메일", companyId: "2번과 같은 companyId" },
   ```
4. 커밋 후 배포하면, 그 아이디로 로그인한 사람은 자기 회사 자료만 보고 씁니다.

같은 회사에 사람이 여러 명이면 1~3번을 반복하되 `companyId`만 같게 맞추면 됩니다.

### 알아둘 점

- 구글 드라이브 자동 백업(사진, 관련서류, 이행완료보고서, 백업 zip)도 파일 경로/이름에 회사
  태그를 붙여 회사끼리 섞이지 않게 했지만, 이 파일들은 모두 같은 구글 드라이브 계정(사장님
  계정) 안에 저장됩니다 - 그 계정 자체에 접근할 수 있는 사람은 폴더를 직접 뒤져 다른 회사
  파일을 볼 수 있습니다(앱 화면상으로는 걸러져 보이지 않습니다).
