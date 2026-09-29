// 찰칵보고서 앱 메인 로직
(() => {
  let editingSiteId = null;
  let activeObjectUrls = [];
  // 지적사항 허브(업체별) 정렬/지역/최신순/상태 필터 상태.
  // sortMode: "name"(가나다순) | "region"(지역별) | "recent"(최신순 - 점검완료일 기준)
  // filters: "pending"|"none"|"open"|"resolved" 상태 필터 칩 중 선택된 것들 (OR 조건)
  function createSiteStatusHubState() {
    return { sortMode: "name", selectedRegion: null, filters: new Set() };
  }
  const defHubState = createSiteStatusHubState();

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function isNativeApp() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  }
  // 이 프로젝트는 번들러를 쓰지 않아 @capacitor/core 전체가 아니라 가벼운 native-bridge.js만 로드된다
  // (window.Capacitor.registerPlugin은 없다) - 대신 native-bridge.js가 실제로 제공하는 저수준
  // nativePromise(pluginName, methodName, options)로 아무 네이티브 플러그인이나 직접 호출한다.
  function callNativePlugin(pluginName, method, options) {
    return window.Capacitor.nativePromise(pluginName, method, options);
  }

  // 지적사항 사진 촬영 시 휴대폰 갤러리에도 저장할지 여부 - 기본은 켜짐(기존 동작 유지), 설정
  // 화면에서 끌 수 있다("중복 저장/용량 부담" 사용자 요청, 2026-09-02).
  const PHOTO_SAVE_TO_GALLERY_KEY = "fireinspect_photo_save_to_gallery";
  function isPhotoSaveToGalleryEnabled() {
    const v = localStorage.getItem(PHOTO_SAVE_TO_GALLERY_KEY);
    return v === null ? true : v === "1";
  }
  function setPhotoSaveToGalleryEnabled(v) {
    localStorage.setItem(PHOTO_SAVE_TO_GALLERY_KEY, v ? "1" : "0");
  }
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result; // "data:<mime>;base64,XXXX"
        const idx = result.indexOf(",");
        resolve(idx >= 0 ? result.slice(idx + 1) : result);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  // 네이티브 앱(APK) 안의 WebView는 Web Share API(navigator.share)를 지원하지 않는 경우가 많아
  // "공유" 버튼을 눌러도 아무 앱 선택 화면 없이 조용히 실패하거나 다운로드로만 대체됐다 - 안드로이드의
  // 진짜 공유 시트(어느 앱으로 보낼지 아이콘이 뜨는 화면)를 확실히 띄우려면 @capacitor/filesystem으로
  // 파일을 앱 캐시에 저장한 뒤 그 파일의 uri를 넘겨야 한다.
  // 처음엔 @capacitor/share의 share()를 썼는데, 그 플러그인은 MIME 타입을 파일 확장자로 추측한다
  // (MimeTypeMap.getMimeTypeFromExtension) - 안드로이드는 .hwpx 같은 비표준 확장자를 몰라서 항상
  // "*/*"로 넘어가고, 카카오톡 등 일부 앱은 그렇게 애매한 타입으로 온 첨부를 사용자가 골라도 조용히
  // 전송하지 않는다(실제 사용자가 겪은 문제: "카카오톡으로 전송이 안됨"). 그래서 확장자 추측에 기대지
  // 않고 우리가 이미 알고 있는 정확한 MIME 타입을 직접 넘기는 자체 FileSaver.shareFiles를 쓴다.
  async function nativeShareFiles(blobsWithNames, title) {
    const uris = [];
    for (const { blob, name } of blobsWithNames) {
      const base64 = await blobToBase64(blob);
      const result = await callNativePlugin("Filesystem", "writeFile", {
        path: name,
        data: base64,
        directory: "CACHE",
        recursive: true,
      });
      uris.push(result.uri);
    }
    const mimeType = (blobsWithNames[0] && blobsWithNames[0].blob.type) || "*/*";
    await callNativePlugin("FileSaver", "shareFiles", {
      uris,
      mimeType,
      title,
      dialogTitle: "공유할 앱을 선택하세요",
    });
  }
  // "다운로드한 파일이 어디에 저장되는지 모르겠다"는 요청으로 추가 - 공유 화면과 달리 이건 다른 앱으로
  // 넘기지 않고, 안드로이드 표준 "다운로드" 폴더(파일 관리자 앱에서 바로 보이는 곳)에 직접 저장하고
  // 그 위치를 그대로 돌려준다. 네이티브 FileSaver 플러그인(이 프로젝트가 직접 만든 것, android/app/src/
  // main/java/.../FileSaver.java) 사용.
  async function nativeSaveToDownloads(blob, filename, mimeType) {
    const base64 = await blobToBase64(blob);
    // { location, uri, mimeType } - uri는 저장 직후 "어떤 프로그램으로 열지" 선택 화면을 띄우는 데 쓴다.
    return callNativePlugin("FileSaver", "saveToDownloads", {
      filename,
      data: base64,
      mimeType,
    });
  }
  // 저장된 파일이 실제로 정상 파일인지, 한글 등 원하는 프로그램에서 잘 열리는지 그 자리에서 바로
  // 확인할 수 있도록 안드로이드의 "다음으로 열기" 앱 선택 화면을 띄운다. 열 수 있는 앱이 없어도
  // (예: 한글 앱 미설치) 조용히 무시한다 - 파일은 이미 다운로드 폴더에 저장되어 있으므로 실패로 볼 일은 아니다.
  async function nativeOfferToOpen(uri, mimeType) {
    try {
      await callNativePlugin("FileSaver", "openFile", { uri, mimeType });
    } catch (e) {
      // 열 앱이 없는 경우 등 - 파일 저장 자체는 이미 성공했으므로 조용히 넘어간다.
    }
  }

  // 업로드/생성되는 파일을 구글 드라이브(사장님 계정, 중앙 백업 프록시)에 저장 - 꺼져 있거나
  // 실패해도 절대 호출부의 저장/UI 흐름을 막지 않는다(항상 조용히 무시, throw하지 않음).
  // 반환하는 프로미스는 uploadToSite의 결과를 그대로 넘기므로(꺼져있거나 실패하면 null),
  // 완료를 기다리고 싶은 호출부(await backupToDrive(...))나 실패를 사용자에게 알려야 하는 곳
  // (예: 지적사항 사진)에서 쓸 수 있고, 정말 기다릴 필요 없는 곳은 그냥 호출만 하고 무시해도 안전하다.
  // sobang1004(소방점검 관리)와 같은 구글 드라이브 계정/프록시를 공유하고, 이 앱 안에서도 여러
  // 소방공사업체(회사)가 계정만 나눠 함께 쓰므로, 카테고리 이름 앞에 "앱_회사" 태그를 붙여
  // 같은 이름의 거래처가 있어도(다른 앱이든, 같은 앱의 다른 회사든) 파일 경로가 섞이지 않게 한다.
  // "이행완료보고서"만 예외로 카테고리는 그대로 두고 회사 태그를 파일명 쪽에 붙인다 - "보고서
  // 모아보기" 화면이 쓰는 구글 드라이브 프록시의 list-reports가 이 카테고리 이름을 그대로 찾는
  // 것으로 보여서, 카테고리에 태그를 붙이면 이 앱에서 생성한 보고서가 목록에 아예 안 뜰 위험이
  // 있다(업로드/조회 양쪽을 다 통제할 수 없는 외부 프록시라 안전한 쪽으로 둠) - 대신 파일명에
  // 붙인 회사 태그로 renderReportsHub에서 다른 회사 보고서를 걸러낸다.
  const DRIVE_APP_TAG = "찰칵보고서";
  function companyDriveTag() {
    return (window.Auth && Auth.getCompanyId && Auth.getCompanyId()) || "미지정회사";
  }
  function backupToDrive(siteId, category, filename, blob) {
    if (!blob) return Promise.resolve(null);
    const taggedCategory = category === "이행완료보고서" ? category : `${DRIVE_APP_TAG}_${companyDriveTag()}_${category}`;
    return (siteId ? FireDB.getSite(siteId) : Promise.resolve(null))
      .then((site) => DriveBackup.uploadToSite(site ? site.name : null, taggedCategory, filename, blob))
      .catch(() => null);
  }

  // 사진은 기기별 IndexedDB에만 저장된다 - 다른 사용자/기기(예: 휴대폰으로 찍어 올린 사진)에서 올린
  // 것은 이 기기 로컬 저장소엔 원본이 없어 photoMap에 빠질 수 있다(실제 사용자가 겪은 문제: "지적사항
  // 클릭해서 들어가면 다른 사람이 올린 사진이 안 보임"). 이미 구글 드라이브에 자동 백업된 사본이
  // 있으면 그걸로 photoMap을 채운다 - 파일명 규칙은 backupToDrive가 지적사항 사진을 올릴 때 쓰는 것과
  // 동일(이행전_<id>.jpg / 이행후_<id>.jpg). 이행완료보고서 생성(openCompletionReport)에서만 쓰던
  // 로직인데, 지적사항 목록 화면(renderDeficiencies)의 사진 썸네일에도 똑같이 필요해서 공용 함수로
  // 뺐다 - 찾은 사진은 로컬에도 저장해둬서(FireDB.addPhoto, 기존 id 그대로) 다음부터는 다시 내려받지
  // 않고 오프라인에서도 보이게 한다.
  async function fillMissingPhotosFromDrive(siteId, defs, photoMap) {
    const site = await FireDB.getSite(siteId);
    if (!site || !site.name) return;
    const missing = [];
    defs.forEach((def) => {
      (def.beforePhotoIds || []).forEach((id) => { if (!photoMap.has(id)) missing.push({ id, prefix: "이행전", role: "before", def }); });
      (def.afterPhotoIds || []).forEach((id) => { if (!photoMap.has(id)) missing.push({ id, prefix: "이행후", role: "after", def }); });
    });
    if (missing.length === 0) return;
    await Promise.all(missing.map(async ({ id, prefix, role, def }) => {
      const blob = await DriveBackup.fetchFile(site.name, `${DRIVE_APP_TAG}_${companyDriveTag()}_지적사항_사진`, `${prefix}_${id}.jpg`);
      if (!blob) return;
      photoMap.set(id, { id, blob });
      FireDB.addPhoto({ id, siteId, itemId: def.id, role, blob, createdAt: new Date().toISOString() }).catch(() => {});
    }));
  }


  // 지적사항 이행전/이행후 사진을 모바일에서 올릴 때 너무 오래 걸린다는 사용자 리포트(2026-08-22) -
  // 원인은 압축 없이 폰 카메라 원본(보통 3000~4000px, 수 MB)을 그대로 IndexedDB에 저장하고 그대로
  // 구글 드라이브까지 업로드하고 있었기 때문(느린 건 로컬 저장이 아니라 모바일 회선으로 원본 전체를
  // 올리는 네트워크 구간). 화면/보고서 어디에도 원본 해상도가 필요 없으므로(hwpx-export.js도 최종
  // 인쇄용으로 훨씬 작은 해상도로 다시 인코딩해서 씀) 저장/업로드 전에 긴 변을 최대 1600px로 줄이고
  // JPEG 85%로 재인코딩한다. <img> 디코딩은 EXIF Orientation을 반영해서 그려주므로 회전 문제도 없다.
  // HEIC 등 디코딩 자체가 안 되는 파일은 원본을 그대로 쓴다(느리더라도 안 올리는 것보다 낫다).
  async function compressPhotoForUpload(file, maxDim, quality) {
    try {
      const url = URL.createObjectURL(file);
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
      });
      const { naturalWidth: w, naturalHeight: h } = image;
      const scale = Math.min(1, (maxDim || 1600) / Math.max(w, h));
      if (scale >= 1) { URL.revokeObjectURL(url); return file; }
      const targetW = Math.round(w * scale);
      const targetH = Math.round(h * scale);
      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, targetW, targetH);
      ctx.drawImage(image, 0, 0, targetW, targetH);
      URL.revokeObjectURL(url);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas_encode_failed"))), "image/jpeg", quality || 0.85);
      });
      return new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" });
    } catch (e) {
      return file;
    }
  }

  function todayISO() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  }

  // "01031308364" 처럼 하이픈 없이 입력/저장된 번호를 11자리는 000-0000-0000, 10자리는 000-000-0000
  // (서울 02는 02-0000-0000)으로 포맷. 사용자가 하이픈(-)을 직접 넣은 값은 그대로 둔다(사용자 요청,
  // 2026-09-29). 형식을 알 수 없는 값도 원본 그대로 둔다(잘못 자르지 않기 위해).
  function formatPhone(raw) {
    if ((raw || "").includes("-")) return raw;
    const digits = (raw || "").replace(/[^0-9]/g, "");
    if (!digits) return raw || "";
    if (digits.length === 11) return digits.replace(/(\d{3})(\d{4})(\d{4})/, "$1-$2-$3");
    if (digits.length === 10) {
      return digits.startsWith("02")
        ? digits.replace(/(\d{2})(\d{4})(\d{4})/, "$1-$2-$3")
        : digits.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3");
    }
    if (digits.length === 9 && digits.startsWith("02")) return digits.replace(/(\d{2})(\d{3})(\d{4})/, "$1-$2-$3");
    return raw || "";
  }

  // 점검번호는 "숫자-알파벳-세자리숫자"(예: "1-A-001") 형식 - 지적사항 하나가 점검표 항목 2개에 걸쳐있으면
  // 원본 표/AI 인식 과정에서 구분자 없이 그대로 붙어(예: "1-A-0012-B-002") 들어오는 경우가 있어, 그 안에서
  // 이 형식에 맞는 코드를 모두 찾아 쉼표로 이어붙인다. 코드가 하나뿐이거나 이 형식이 전혀 안 보이면
  // (예: 문서마다 다른 자체 번호 체계) 원본을 그대로 둔다 - 잘못 잘라내지 않기 위함.
  function normalizeInspectionCode(raw) {
    if (!raw) return raw || "";
    const matches = raw.match(/\d-[A-Za-z]-\d{3}/g);
    return matches && matches.length > 1 ? matches.join(", ") : raw;
  }

  // 탐색기/다른 폴더에서 파일을 끌어다 놓아도 기존 파일 선택(input[type=file]) 방식과 똑같이
  // 동작하도록 하는 공통 헬퍼 - dragover 중엔 el에 "drag-over" 클래스로 시각적 표시를 주고,
  // 놓인 파일 중 첫 번째만 onFile로 넘긴다(기존 파일 입력도 한 번에 한 개만 다뤘으므로 동일하게 맞춤).
  // dragenter/dragleave는 자식 요소를 넘나들 때마다도 반복 발생하므로 depth 카운터로 묶어서
  // 전체 영역을 벗어날 때만 표시를 지운다.
  function setupFileDropZone(el, onFile) {
    if (!el) return;
    let dragDepth = 0;
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    el.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dragDepth++;
      el.classList.add("drag-over");
    });
    el.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) el.classList.remove("drag-over");
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      el.classList.remove("drag-over");
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) onFile(file);
    });
  }

  function revokeObjectUrls() {
    activeObjectUrls.forEach((u) => URL.revokeObjectURL(u));
    activeObjectUrls = [];
  }

  // ---------- 거래처 지역 분류 (가나다순/지역별 정렬용) ----------
  // 대구는 구/군 단위까지, 그 외 지역은 도/광역시 단위까지만 분류한다(사용자 요청).
  // "달서구"는 "서구"를 부분 문자열로 포함하므로 반드시 먼저 검사해야 오분류를 피할 수 있다.
  const DAEGU_DISTRICTS = ["달서구", "달성군", "군위군", "수성구", "동구", "서구", "남구", "북구", "중구"];
  const PROVINCE_PATTERNS = [
    [/^대구/, "대구"],
    [/^서울/, "서울"],
    [/^부산/, "부산"],
    [/^인천/, "인천"],
    [/^광주/, "광주"],
    [/^대전/, "대전"],
    [/^울산/, "울산"],
    [/^세종/, "세종"],
    [/^경기/, "경기"],
    [/^강원/, "강원"],
    [/^충청북|^충북/, "충북"],
    [/^충청남|^충남/, "충남"],
    [/^전라북|^전북/, "전북"],
    [/^전라남|^전남/, "전남"],
    [/^경상북|^경북/, "경북"],
    [/^경상남|^경남/, "경남"],
    [/^제주/, "제주"]
  ];
  // 시/군/구 단위 이름만으로는(예: "영천시") 어느 광역시·도 소속인지 헷갈린다(사용자 요청,
  // 2026-09-07) - 그래서 항상 앞에 광역시/도 이름(도는 "경북"처럼 축약형)을 붙인다. 시/군/구
  // 이름은 주소 토큰 중 "시/군/구"로 끝나는 첫 토큰을 쓴다 - 광역시는 그 아래 구/군(예: "달서구"),
  // 도는 그 아래 시/군(예: "영천시")이 이 규칙 하나로 뽑힌다. "특별시"/"광역시"/"특별자치시"/
  // "특별자치도" 자체와, PROVINCE_PATTERNS의 시/도 이름 자체("대구"는 우연히 "구"로 끝나 이
  // 규칙에 잘못 걸릴 수 있어 별도 제외)는 후보에서 뺀다.
  const PROVINCE_LABELS = PROVINCE_PATTERNS.map(([, label]) => label);
  function extractDistrictToken(addr) {
    const tokens = addr.split(/\s+/);
    for (const raw of tokens) {
      const t = raw.replace(/[^가-힣]/g, "");
      if (!t || PROVINCE_LABELS.includes(t)) continue;
      // {1,}(2글자 이상 전체) - "중구"/"동구"처럼 한 글자 이름 뒤에 "구"만 붙는 구도 있어(서울/부산/
      // 대구/인천/광주/대전/울산에 흔함) {2,}(3글자 이상)로 하면 이런 구들이 빠진다.
      if (/^[가-힣]{1,}(시|군|구)$/.test(t) && !/(특별시|광역시|특별자치시|특별자치도)$/.test(t)) {
        return t;
      }
    }
    return null;
  }
  function classifyRegion(address) {
    const addr = (address || "").trim();
    if (!addr) return "지역 미상";
    for (const [re, label] of PROVINCE_PATTERNS) {
      if (!re.test(addr)) continue;
      const district = extractDistrictToken(addr);
      return district ? `${label} ${district}` : `${label} 기타`;
    }
    return "지역 미상";
  }
  // 요약줄의 "N개 지역" 개수용 - 버튼 그리드는 시/군/구 단위까지 쪼개서 보여주지만,
  // 이 개수는 광역시/도 단위로만 세어 한 광역시/도의 여러 구/시가 지역 개수를 부풀리지 않게 한다.
  function classifyBroadRegion(address) {
    const addr = (address || "").trim();
    if (!addr) return "지역 미상";
    for (const [re, label] of PROVINCE_PATTERNS) {
      if (re.test(addr)) return label;
    }
    return "지역 미상";
  }

  // "대구 달서구"/"부산 중구"/"경북 영천시" 같은 지역 라벨(classifyRegion 결과)들을 화면에
  // 나열할 순서 - PROVINCE_PATTERNS 선언 순서(대구→서울→부산→...)로 묶고, 묶음 안에서는
  // 가나다순, "OO 기타"(시/군/구를 못 뽑아낸 주소)는 그 묶음 맨 뒤, "지역 미상"은 전체 맨
  // 뒤에 둔다. 거래처 목록/지적사항 허브/스케줄 관리 업체선택, 지역별 정렬을 쓰는 화면
  // 셋이 이 함수 하나를 공유한다.
  function orderRegionLabels(counts) {
    const ordered = [];
    PROVINCE_LABELS.forEach((label) => {
      const inGroup = Array.from(counts.keys()).filter((r) => r.startsWith(label + " "));
      inGroup.sort((a, b) => {
        const aEtc = a === `${label} 기타`;
        const bEtc = b === `${label} 기타`;
        if (aEtc !== bEtc) return aEtc ? 1 : -1;
        return a.localeCompare(b, "ko");
      });
      ordered.push(...inGroup);
    });
    if (counts.has("지역 미상")) ordered.push("지역 미상");
    return ordered;
  }

  // 이행완료 보고서의 "○○ 소방본부장ㆍ소방서장 귀하"를 실제 관할소방서 이름으로 채우기 위한 최선 추정.
  // 정확한 관할 구역은 소방서마다 다르고 공식 API가 없어 완전히 보장할 수 없으므로, 확실히 아는 대구 구/군과
  // 창원(마산/창원/진해로 나뉨) 특례만 정확히 매핑하고, 나머지는 "OO시/군소방서" 일반 규칙으로 추정한다.
  // 현장 등록 화면의 "관할소방서" 칸은 직접 입력할 수 없는 읽기 전용 칸이라, 이 추정값이 곧 저장되는 값이다.
  // 2026-08-29: daegu.go.kr 소방안전본부의 소방서별 "관내현황" 페이지를 구/군마다 직접 확인해서
  // 대구 전체를 다시 검증했다 - 예전 매핑은 "남구→남부소방서"였는데, 실제로는 대구남부소방서가
  // 아직 개서조차 안 된 계획 단계 소방서라(부지 물색 중) 현재 남구 전지역은 중부소방서 관내현황
  // 페이지에 대명동/봉덕동/이천동이 그대로 나열돼 있는 걸로 봐서 중부소방서가 관할한다. 군위군은
  // 2023-07-01 대구 편입 후 강북소방서가 관할(별도 군위소방서도 아직 계획 단계). 동구/서구/수성구는
  // 관내현황에 "OO구 전지역"으로 명시돼 있어 구 전체가 그대로 매핑된다.
  const DAEGU_FIRE_STATION = {
    "중구": "중부소방서", "동구": "동부소방서", "서구": "서부소방서", "남구": "중부소방서",
    "북구": "북부소방서", "수성구": "수성소방서", "달서구": "달서소방서", "달성군": "달성소방서",
    "군위군": "강북소방서"
  };
  // 북구는 2023-04-17 강북소방서 개서로 두 소방서가 나눠 관할한다 - 북부소방서 관할이 "북구지역
  // (칠곡 지역 제외)"라고 명시돼 있어, 신도심인 칠곡지구 동(학정동 등)은 북부소방서가 아니라
  // 강북소방서가 맞다(사용자 리포트: "대구 북구 학정동로10"의 관할소방서가 오타로 나온다, 2026-08-29).
  const DAEGU_BUK_GU_GANGBUK_DONGS = [
    "학정동", "관음동", "구암동", "국우동", "도남동", "동호동", "동천동", "읍내동", "태전동",
    "동변동", "서변동", "연경동", "조야동", "금호동", "노곡동", "매천동", "사수동", "팔달동"
  ];
  // 달서구는 관내현황에 "달서구(이곡동, 신당동 제외)"라고 명시돼 있다 - 이 두 동만 강서소방서 관할이고
  // 나머지(죽전동 포함, 2023-01-01부로 강서→달서로 재이관)는 전부 달서소방서 관할. 실제 행정동명은
  // "이곡1동"/"이곡2동"처럼 번호가 붙으므로("이곡동"은 부분 문자열로 안 들어있음) 번호 붙은 이름도 같이 둔다.
  const DAEGU_DALSEO_GU_GANGSEO_DONGS = ["이곡동", "이곡1동", "이곡2동", "신당동", "갈산동"];
  // 달성군은 관내현황에 "달성군(다사,하빈,가창 제외)"라고 명시돼 있다 - 다사읍/하빈면은 강서소방서,
  // 가창면은(수성소방서 관내현황에 "수성구 일원, 달성군 가창면 일원"으로 명시) 수성소방서 관할이고
  // 나머지 읍/면(현풍읍/유가읍/논공읍/구지면/옥포읍 등)만 달성소방서 관할. 읍/면 이름 자체 말고 그
  // 안의 법정리/동 이름만 적는 지번 주소도 있어서(사용자 리포트: "서재리 1118"만 입력하면 관할소방서가
  // 안 나온다, 2026-08-29 - "서재리"는 다사읍 소속 법정리인데 "다사읍"이란 글자가 주소에 없었음)
  // daegu.go.kr 강서소방서 관내현황에 나온 리/동 이름도 그대로 매칭 목록에 포함한다.
  const DAEGU_DALSEONG_GUN_GANGSEO_AREAS = [
    "다사읍", "호산동", "호림동", "파호동", "서재리", "죽곡리", "세천리", "방천리",
    "하빈면", "문산리", "부곡리", "매곡리", "문양리", "이천리", "달천리", "박곡리"
  ];
  const DAEGU_DALSEONG_GUN_SUSEONG_EUPMYEON = ["가창면"];
  const CHANGWON_FIRE_STATION = {
    "마산합포구": "마산소방서", "마산회원구": "마산소방서",
    "성산구": "창원소방서", "의창구": "창원소방서",
    "진해구": "진해소방서"
  };

  // ---------- 부산광역시 관할소방서 ----------
  // 출처: "부산광역시 행정기구 설치 조례 시행규칙" 별표1(제24조제4항 관련, law.go.kr 자치법규에서 직접
  // 확인, 2026-09-01, 제4232호 2026.7.29 일부개정 기준) - 아래 BUSAN_119_CENTERS의 각 소방서별
  // 관할동 목록에서 구 단위로 집계한 값. 부산은 소방서 정식 명칭에 전부 "부산" 접두어가 붙는다
  // (예: "부산중부소방서") - 대구/경북 소방서와 이름이 겹치는 걸 막기 위해서도(대구에 이미
  // "중부소방서"/"북부소방서"/"강서소방서"가 있음, FIRE_119_CENTERS 병합 시 키가 겹치면 안 됨) 아래
  // 값들은 항상 "부산" 접두어를 붙인 정식 명칭 그대로 쓴다.
  // 구/군 기본 관할 외에, 구 경계와 다르게 넘어가는 동은 guessFireStation()에서 별도로 먼저 처리한다
  // (동구 초량동→중부, 부산진구 양정동→동래, 동래구 명장2동→금정, 남구 문현동→부산진, 해운대구
  // 송정동→기장 - 아래 guessFireStation 본문 참고. 해운대구 반송동은 별표1상 해운대소방서 자체
  // 관할이라 예외가 아니다).
  // "강서구"는 "서구"를 부분 문자열로 포함하므로("강**서구**") 반드시 "강서구"가 "서구"보다
  // 배열에서 앞에 와야 한다 - find()가 배열 순서대로 첫 매치를 쓰기 때문(대구 목록의 "달서구"/"서구"도
  // 같은 이유로 이미 그렇게 정렬돼 있음).
  const BUSAN_DISTRICTS = [
    "강서구", "중구", "서구", "동구", "영도구", "부산진구", "동래구", "남구", "북구", "해운대구",
    "사하구", "금정구", "연제구", "수영구", "사상구", "기장군"
  ];
  const BUSAN_FIRE_STATION = {
    "중구": "부산중부소방서", "서구": "부산중부소방서",
    "동구": "부산진소방서", "부산진구": "부산진소방서",
    "동래구": "부산동래소방서", "연제구": "부산동래소방서",
    "남구": "부산남부소방서", "수영구": "부산남부소방서",
    "북구": "부산북부소방서",
    "해운대구": "부산해운대소방서",
    "사하구": "부산사하소방서",
    "금정구": "부산금정소방서",
    "강서구": "부산강서소방서",
    "사상구": "부산사상소방서",
    "영도구": "부산항만소방서",
    "기장군": "부산기장소방서"
  };

  // ---------- 관할119안전센터 (daegu.go.kr 소방서별 "관내현황" 페이지, 2026-08-29 확인) ----------
  // 소방서(station) 산하 안전센터(center)별 관할 법정동/리/읍 목록 - 이 값으로 관할소방서뿐 아니라
  // 관할119안전센터까지 주소만으로 추정한다. 같은 동 이름이 대구 안에서 다른 구에 또 있어도(예: "이천동"이
  // 남구 봉덕동 옆에도, 수성구 만촌 쪽에도 있음) 안전센터는 항상 guessFireStation()으로 먼저 정확한
  // 소방서를 확정한 다음 그 소방서 소속 목록 안에서만 동 이름을 찾으므로(findFireCenterInStation) 다른
  // 구에 있는 동명(同名) 동과 절대 섞이지 않는다 - 그래서 "도원동"처럼 중구/달서구 양쪽에 다 있는
  // 이름도 안전하게 같이 넣을 수 있다. 남구 대명동 일대만 예외 - 소방서 자체 관내현황에도 "대명2·3·7·8동
  // 일부"처럼 동 하나가 번지수로 갈라져 있어(중부소방서 명덕/성명/대명 안전센터가 겹쳐 관할) 동 이름만으로는
  // 어느 안전센터인지 확정할 수 없어서 이 부분만 비워둔다. 북부소방서는 daegu.go.kr에 안전센터별 상세
  // 관할이 없어(구 단위 요약만 있음) 예전 자료(나무위키, 2023 강북소방서 개서 이전 버전으로 추정)를
  // 최대한 활용했고, 그마저 없는 산격1동/산격4동만 비워뒀다 - 확실치 않은 것보다 비워두는 쪽을 택함
  // (이 칸은 읽기전용이 아니라서 사용자가 직접 고치거나 채울 수 있다).
  const DAEGU_119_CENTERS = {
    "중부소방서": [
      { center: "남산", areas: ["남산2동", "남산3동", "남산4동", "봉산동", "동성로3가동", "계산1가동", "계산2가동", "계산동", "덕산동"] },
      { center: "서문로", areas: ["북성로1가동", "포정동", "사일동", "화전동", "동성로1가동", "동성로2가동", "용덕동", "서내동", "대안동", "향촌동", "북내동", "장관동", "상서동", "북성로2가동", "종로1가동", "종로2가동", "동일동", "남일동", "서문로1가동", "서문로2가동", "태평로2가동", "태평로3가동", "수동", "전동", "수창동", "하서동", "서성로1동", "서성로2동", "남성로동", "도원동", "인교동", "서야동"] },
      { center: "봉덕", areas: ["봉덕1동", "봉덕2동", "봉덕3동", "봉덕동", "이천동"] },
      { center: "대신", areas: ["대신동", "시장북로동", "동산동", "달성동"] },
      { center: "삼덕", areas: ["대봉1동", "공평동", "동문동", "상덕동", "교동", "완전동", "문화동", "태평로1가동", "삼덕1가동", "삼덕2가동", "삼덕3가동", "동인1가동", "동인2가동", "동인3가동", "동인4가동"] },
      { center: "명덕", areas: ["남산1동", "대봉2동"] }
    ],
    "북부소방서": [
      { center: "칠성", areas: ["칠성동", "고성동"] },
      { center: "침산", areas: ["침산동"] },
      { center: "노원", areas: ["노원동"] },
      { center: "대현", areas: ["대현동", "산격3동"] },
      { center: "산격", areas: ["검단동", "산격2동", "복현동"] }
    ],
    "동부소방서": [
      { center: "혁신", areas: ["신기동", "율하동", "상매동", "매여동", "율암동", "부동", "둔산동", "용계동"] },
      { center: "신천", areas: ["신천동", "효목동", "신암동"] },
      { center: "동촌", areas: ["방촌동", "입석동", "검사동", "신평동"] },
      { center: "안심", areas: ["서호동", "동호동", "각산동", "신서동", "동내동", "괴전동", "금강동", "대림동", "사복동", "숙천동", "내곡동"] },
      { center: "불로봉무", areas: ["불로동", "지저동", "봉무동", "도동", "평광동"] },
      { center: "공산", areas: ["능성동", "진인동", "도학동", "백안동", "미곡동", "용수동", "신무동", "미대동", "내동", "지묘동", "덕곡동", "송정동", "신용동", "중대동"] }
    ],
    "서부소방서": [
      { center: "평리", areas: ["평리1동", "평리3동", "평리5동", "평리6동", "비산5동", "비산7동"] },
      { center: "이현", areas: ["이현동", "중리동", "상리동"] },
      { center: "내당", areas: ["내당동", "평리2동", "평리4동"] },
      { center: "비산", areas: ["비산1동", "비산2동", "비산3동", "비산4동", "비산6동", "원대1가동", "원대2가동", "원대3가동", "원대동"] }
    ],
    // 출처: 수성소방서 산하 안전센터별 관할현황(사용자 제공 스크린샷, 2026-09-07 확인) - 대부분
    // 기존 표와 일치했고 "삼덕"(삼덕동)만 범물 관할에서 빠져있어 추가했다. 참고: "범어동"(행정동
    // 번호 없는 법정동 표기)은 이 표에서 대구 내 유일하게 한 동 이름이 안전센터 세 곳(범어1·3동→
    // 수성, 범어2동→무열로, 범어4동→만촌)으로 갈리는 사례라, 번지만으로는 어느 행정동인지 알 수
    // 없어 자동 추정이 불가능하다(guessFireCenter119가 이 경우 항상 빈 값을 준다 - 사용자가
    // 관할119안전센터 칸에 직접 입력해야 함). "지산1동"도 일부 번지(910~1073-21)만 황금 관할로
    // 갈리지만 아주 일부라 기존처럼 범물(대다수 번지)로 그대로 둔다.
    "수성소방서": [
      { center: "범물", areas: ["범물1동", "범물2동", "삼덕동", "지산1동", "지산2동", "지산동", "두산동"] },
      { center: "만촌", areas: ["범어4동", "만촌3동", "이천동", "연호동", "고모동"] },
      { center: "황금", areas: ["황금1동", "황금2동", "황금동", "중동"] },
      { center: "상동", areas: ["상동", "파동"] },
      { center: "수성", areas: ["범어1동", "범어3동", "수성1가", "수성2가", "수성3가", "수성4가"] },
      { center: "무열로", areas: ["만촌1동", "만촌2동", "범어2동"] },
      { center: "고산", areas: ["고산1동", "고산2동", "고산3동", "고산동", "신매동", "사월동", "욱수동", "노변동", "매호동", "성동", "시지동", "대흥동", "가천동"] },
      { center: "가창", areas: ["가창면"] }
    ],
    "달서소방서": [
      { center: "월성", areas: ["월성1동", "월성2동", "월성동", "본동"] },
      { center: "본리", areas: ["본리동", "성당동", "두류1동", "두류2동", "두류3동", "두류동"] },
      { center: "송현", areas: ["상인1동", "상인2동", "상인3동", "상인동", "송현1동", "송현2동", "송현동"] },
      { center: "도원", areas: ["도원동", "대곡동", "유천동", "진천동"] },
      { center: "죽전", areas: ["장기동", "용산1동", "용산2동", "용산동", "죽전동", "감삼동"] }
    ],
    "달성소방서": [
      { center: "현풍", areas: ["현풍읍", "유가읍"] },
      { center: "옥포", areas: ["옥포읍", "금포리", "노이리", "삼리리", "위천리"] },
      { center: "논공", areas: ["논공읍", "상리", "하리", "남리", "북리", "본리리"] },
      { center: "구지", areas: ["구지면"] }
    ],
    "강서소방서": [
      { center: "다사", areas: ["다사읍", "호산동", "호림동", "파호동", "서재리", "죽곡리", "세천리", "방천리"] },
      { center: "성서", areas: ["이곡동", "이곡1동", "이곡2동", "갈산동", "신당동"] },
      { center: "대천", areas: ["장동", "월암동", "대천동"] },
      { center: "매곡", areas: ["하빈면", "문산리", "부곡리", "매곡리", "문양리", "이천리", "달천리", "박곡리"] }
    ],
    "강북소방서": [
      { center: "구암", areas: ["구암동", "동천동", "국우동", "도남동"] },
      { center: "읍내", areas: ["읍내동", "관음동", "학정동", "동호동"] },
      { center: "태전", areas: ["태전동", "노곡동", "매천동"] },
      { center: "무태", areas: ["조야동", "동변동", "서변동", "연경동"] },
      { center: "금호", areas: ["금호동", "팔달동", "사수동"] },
      { center: "군위", areas: ["군위읍", "소보면", "효령면"] },
      { center: "의흥", areas: ["우보면", "의흥면", "산성면", "삼국유사면", "부계면"] }
    ]
  };

  // ---------- 경상북도 119안전센터·119지역대 관할구역 ----------
  // 출처: "[별표 2] 119안전센터ㆍ119지역대의 명칭ㆍ위치, 센터장직급 및 관할구역(경상북도 행정기구
  // 설치 조례 시행규칙)" 2026.8.3 개정본(사용자 제공 hwpx, F:\소방어플\ 저장분) - 대구와 달리 경북은
  // 광역자치단체 조례 시행규칙 별표에 동/리 단위 관할구역이 공식적으로 고시돼 있어 daegu.go.kr
  // 관내현황 페이지보다도 더 확실한 1차 출처다. 원문은 "119안전센터"(상급, 정식 인력 배치)와
  // "119지역대"(하급, 안전센터 산하 출장소격) 두 급으로 나뉘는데, 화면의 "관할119안전센터" 칸은
  // 문자 그대로 "119안전센터"를 요구하므로 119지역대 관할구역은 전부 그 상급 안전센터 항목에
  // 합쳐 넣었다(즉 아래 목록에는 119지역대 자체 항목이 없다 - 지역대 관할이면 그냥 상급 센터 이름이 뜬다).
  // 포항시는 북구/남구로 소방서 자체가 갈리고(포항북부/포항남부), 울릉군은 별도 소방서 없이
  // 포항남부소방서 산하로 관할되는 특례라 guessFireStation()에 별도 분기로 처리한다(아래 참고).
  // 관할구역이 "OO읍/면 일부(제외:...)"처럼 번지·리 단위로만 갈리는 경우 리 이름까지 확인되면 그
  // 리 이름으로, 안 되면 대구 사례(대명동)처럼 어느 한쪽에 몰아주고 남겨뒀다 - 정확한 목록은 아래
  // 각 항목 옆 주석 참고. 배열 안에서 더 구체적인(리 단위) 항목이 더 넓은(읍/면 단위) 항목보다
  // 앞에 오도록 순서를 맞춰뒀다 - guessFireCenter119가 배열 순서대로 첫 매치를 쓰기 때문.
  const GYEONGBUK_119_CENTERS = {
    "포항북부소방서": [
      { center: "덕산", areas: ["대흥동", "신흥동", "남빈동", "상원동", "여천동", "중앙동", "덕산동", "덕수동", "동빈로1가", "동빈로2가", "용흥동", "죽도동", "득량동", "학잠동"] },
      { center: "두호", areas: ["두호동", "우현동", "창포동", "항구동", "학산동", "대신동"] },
      { center: "흥해", areas: ["흥해읍"] },
      { center: "청하", areas: ["신광면", "청하면", "송라면"] },
      { center: "장량", areas: ["장성동", "양덕동", "환호동", "여남동"] },
      { center: "기계", areas: ["기계면", "기북면", "죽장면"] }
    ],
    "포항남부소방서": [
      { center: "일월", areas: ["청림동", "일월동", "인덕동", "동촌동", "송정동", "송내동", "동해면"] },
      { center: "제철", areas: ["괴동동", "장흥동", "호동", "대송면"] },
      { center: "해도", areas: ["상도동", "해도동", "송도동", "대도동"] },
      { center: "효자", areas: ["효자동", "지곡동", "대잠동", "이동"] },
      { center: "구룡포", areas: ["구룡포읍", "호미곶면"] },
      { center: "오천", areas: ["오천읍", "장기면"] },
      { center: "연일", areas: ["연일읍"] },
      { center: "울릉", areas: ["울릉군"] }
    ],
    "경주소방서": [
      { center: "황오", areas: ["황오동", "성동동", "동천동", "구황동", "배반동", "인왕동", "교동", "동방동", "남산동", "내남면"] },
      { center: "동부", areas: ["동부동", "서부동", "북부동", "석장동", "노동동", "노서동", "성건동", "사정동", "탑동", "충효동", "서악동", "효현동", "광명동", "황남동", "율동", "배동"] },
      { center: "보문", areas: ["천군동", "암곡동", "손곡동", "북군동", "황용동", "덕동", "보문동", "신평동", "천북면"] },
      { center: "불국사", areas: ["진현동", "마동", "하동", "구정동", "조양동", "도지동", "시래동", "서동", "평동"] },
      { center: "용황", areas: ["용강동", "황성동", "현곡면"] },
      { center: "안강", areas: ["안강읍", "강동면", "양동마을"] },
      { center: "외동", areas: ["외동읍"] },
      { center: "감포", areas: ["감포읍", "문무대왕면", "양남면"] },
      { center: "건천", areas: ["건천읍", "산내면", "서면"] }
    ],
    "김천소방서": [
      { center: "양금", areas: ["감호동", "용두동", "모암동", "성내동", "평화동", "남산동", "황금동", "지좌동", "덕곡동", "양천동", "감천면"] },
      { center: "다수", areas: ["부곡동", "다수동", "백옥동", "교동", "삼락동", "문당동", "대항면", "봉산면"] },
      { center: "대광", areas: ["신음동", "대광동", "응명동", "어모면", "개령면"] },
      { center: "지례", areas: ["조마면", "구성면", "지례면", "부항면", "대덕면", "증산면"] },
      { center: "율곡", areas: ["율곡동", "농소면"] },
      { center: "아포", areas: ["아포읍", "남면", "감문면"] }
    ],
    "안동소방서": [
      // 원문 관할구역은 행정동 이름(강남동/안기동/평화동/태화동/서구동/명륜동/중구동)인데, 실제
      // 도로명주소 조회는 그 행정동이 관할하는 개별 법정동 이름을 돌려준다(사용자 리포트: "경상북도
      // 안동시 대안로 177"이 안 잡힘 - juso.go.kr 응답은 "운흥동"인데 이건 중구동 행정동 소속 법정동이라
      // 목록에 "중구동"만 있으면 매칭이 안 됨, 2026-09-01). 위키 안동시 행정구역 문서로 확인한 각
      // 행정동의 법정동 목록을 별칭으로 추가했다 - 다른 행정동과 "일부"로 겹치는 법정동(수하동/옥동)은
      // 빼고, 안 겹치는 것만 추가했다.
      { center: "법흥", areas: [
        "강남동", "안기동", "평화동", "태화동", "서구동", "명륜동", "중구동", "일직면", "남후면",
        // 중구동의 법정동
        "남문동", "남부동", "동부동", "동문동", "목성동", "법흥동", "북문동", "삼산동", "서부동", "신세동", "옥정동", "운흥동", "율세동", "천리동",
        // 명륜동의 법정동
        "상아동", "신안동", "안막동",
        // 안기동의 법정동
        "이천동",
        // 서구동의 법정동
        "광석동", "금곡동", "당북동", "대석동", "법상동", "안흥동", "옥야동", "화성동",
        // 강남동의 법정동(수하동ㆍ옥동 일부는 옥동119안전센터와 겹쳐 제외)
        "수상동", "정상동", "정하동",
        // 평화동ㆍ태화동이 나눠 관할하는 운안동(어느 쪽이든 법흥 관할이라 안전하게 추가)
        "운안동"
      ] },
      { center: "용상", areas: ["용상동", "성곡동", "석동동", "송천동", "임동면", "임하면", "길안면", "남선면"] },
      { center: "풍산", areas: ["풍산읍", "풍천면", "하회마을"] },
      { center: "옥동", areas: [
        "옥동", "송하동", "서후면", "북후면",
        // 송하동의 법정동
        "노하동", "송현동"
      ] },
      { center: "도산", areas: ["도산면", "와룡면", "예안면", "녹전면"] }
    ],
    "구미소방서": [
      { center: "공단", areas: ["공단동", "신평동", "비산동"] },
      { center: "송정", areas: ["송정동", "남통동", "형곡동"] },
      { center: "원평", areas: ["원평동", "지산동", "도량동", "양호동"] },
      { center: "봉곡", areas: ["봉곡동", "부곡동", "선기동", "수점동"] },
      { center: "인동", areas: ["인의동", "황상동", "신동", "구평동", "진평동", "시미동", "임수동"] },
      { center: "선산", areas: ["선산읍", "무을면", "옥성면"] },
      // 옥계는 산동읍 중 "봉산리" 하나만 관할, 해평이 산동읍 나머지 전부 - 리 단위 항목(옥계)이
      // 배열에서 더 넓은 항목(해평)보다 앞에 있어야 봉산리 주소가 옥계로 정확히 잡힌다.
      { center: "옥계", areas: ["옥계동", "구포동", "금전동", "거의동", "봉산리"] },
      { center: "해평", areas: ["해평면", "도개면", "장천면", "산동읍"] },
      { center: "상림", areas: ["상모동", "사곡동", "임은동", "오태동", "광평동"] },
      { center: "고아", areas: ["고아읍"] }
    ],
    "영주소방서": [
      { center: "문수", areas: ["휴천동", "조암동", "적서동", "문정동", "문수면", "평은면", "이산면", "가흥1동"] },
      { center: "가흥", areas: ["상망동", "하망동", "영주1동", "영주2동", "가흥2동", "장수면", "안정면"] },
      { center: "풍기", areas: ["풍기읍", "봉현면", "순흥면", "단산면", "부석면"] }
    ],
    // 출처: 영천소방서 홈페이지 관할현황(gb119.go.kr, 사용자 제공 스크린샷 대조, 2026-09-07 확인) -
    // 기존엔 행정동(동부동/중앙동/서부동/완산동/남부동) 이름만 있어서, 도로명주소에 괄호로 붙는
    // 법정동 이름(예: "시청남1길 15(문외동)")은 못 잡았다(사용자 리포트: 영천 문외동 주소에서
    // 관할119안전센터가 안 나온다, 2026-09-07). 행정동 산하 법정동을 전부 추가했다 - 지번주소 등
    // 행정동 이름을 그대로 쓰는 주소도 여전히 잡히도록 행정동 이름 자체도 그대로 남겨뒀다.
    "영천소방서": [
      { center: "동부", areas: [
        "동부동", "망정동", "야사동", "조교동", "언하동", "신기동",
        "중앙동", "문외동", "문내동", "창구동", "오미동", "녹전동", "도림동", "매산동",
        "서부동", "교촌동", "성내동", "화룡동", "오수동", "생계동", "대전동", "서산동",
        "화북면", "화남면", "자양면", "임고면", "고경면"
      ] },
      { center: "남부", areas: [
        "완산동",
        "남부동", "작산동", "금노동", "범어동", "도동", "봉동", "도남동", "본촌동", "채신동", "괴연동",
        "북안면"
      ] },
      { center: "금호", areas: ["금호읍", "대창면"] },
      { center: "신녕", areas: ["신녕면", "화산면", "청통면"] }
    ],
    "상주소방서": [
      { center: "만산", areas: ["남원동", "북문동", "계림동", "동문동", "동성동", "신흥동", "사벌면", "내서면", "외서면"] },
      { center: "함창", areas: ["함창읍", "은척면", "공검면", "이안면"] },
      { center: "낙동", areas: ["낙동면", "중동면"] },
      { center: "청리", areas: ["청리면", "공성면", "외남면"] },
      { center: "화서", areas: ["화동면", "화서면", "화북면", "화남면", "모동면", "모서면"] }
    ],
    "문경소방서": [
      { center: "점촌", areas: ["점촌1동", "점촌2동", "점촌3동", "영순면", "호계면"] },
      { center: "모전", areas: ["점촌4동", "점촌5동"] },
      { center: "가은", areas: ["가은읍", "농암면"] },
      { center: "문경", areas: ["문경읍", "마성면"] },
      { center: "산북", areas: ["산북면", "산양면", "동로면"] }
    ],
    "경산소방서": [
      { center: "압량", areas: ["대정동", "임당동", "대평동", "조영동", "갑제동", "대동", "압량읍"] },
      { center: "중앙", areas: ["삼남동", "서상동", "신교동", "상방동", "백천동", "삼북동", "중방동", "남방동", "내동", "여천동", "유곡동", "신천동", "점촌동", "평산동", "사동", "삼풍동", "계양동"] },
      { center: "중산", areas: ["옥곡동", "사정동", "옥산동", "중산동", "정평동", "남천면"] },
      { center: "하양", areas: ["하양읍", "와촌면"] },
      { center: "진량", areas: ["진량읍"] },
      { center: "자인", areas: ["자인면", "남산면", "용성면"] }
    ],
    "의성소방서": [
      { center: "봉양", areas: ["봉양면", "안평면", "신평면", "비안면", "금성면", "가음면", "춘산면"] },
      { center: "의성", areas: ["의성읍", "단촌면", "점곡면", "옥산면", "사곡면"] },
      { center: "안계", areas: ["안계면", "안사면", "단밀면", "단북면", "다인면", "구천면"] }
    ],
    "청송소방서": [
      { center: "청송", areas: ["청송읍", "주왕산면"] },
      { center: "진보", areas: ["진보면", "파천면"] },
      { center: "안덕", areas: ["안덕면", "현동면", "현서면", "부남면"] }
    ],
    "영양소방서": [
      { center: "영양", areas: ["영양읍", "일월면", "수비면"] },
      { center: "입암", areas: ["입암면", "석보면", "청기면"] }
    ],
    "영덕소방서": [
      { center: "영덕", areas: ["영덕읍", "달산면", "지품면"] },
      { center: "강구", areas: ["강구면", "남정면"] },
      { center: "영해", areas: ["영해면", "병곡면", "창수면", "축산면"] }
    ],
    "청도소방서": [
      { center: "청도", areas: ["청도읍", "화양읍"] },
      { center: "풍각", areas: ["각남면", "각북면", "풍각면", "이서면"] },
      { center: "금천", areas: ["금천면", "운문면", "매전면"] }
    ],
    "고령소방서": [
      // 원문은 "고령군 일원(제외:다산면,성산면)"뿐이라 대가야읍/덕곡면/운수면/쌍림면은
      // 원문에 개별 명시가 없다 - 고령군 나머지 행정구역 전체이므로 보충해서 채웠다.
      { center: "대가야", areas: ["대가야읍", "덕곡면", "운수면", "쌍림면", "개진면", "우곡면"] },
      { center: "다산", areas: ["다산면", "성산면"] }
    ],
    "성주소방서": [
      { center: "성주", areas: ["성주읍", "벽진면", "초전면", "월항면"] },
      { center: "가천", areas: ["수륜면", "가천면", "금수강산면", "대가면"] },
      { center: "선남", areas: ["선남면", "용암면"] }
    ],
    "칠곡소방서": [
      // 왜관읍은 리 단위로 갈린다: 금산리·금남리·삼청리·낙산리만 왜관119안전센터, 나머지 왜관읍
      // 전부(+기산면)는 기산119안전센터 - 리 단위 항목(왜관)이 배열에서 기산보다 앞에 있어야 한다.
      { center: "왜관", areas: ["금산리", "금남리", "삼청리", "낙산리"] },
      { center: "기산", areas: ["기산면", "왜관읍"] },
      { center: "북삼", areas: ["북삼읍", "약목면"] },
      { center: "석적", areas: ["석적읍"] },
      { center: "지천", areas: ["지천면"] },
      { center: "동명", areas: ["동명면"] },
      { center: "가산", areas: ["가산면"] }
    ],
    "예천소방서": [
      { center: "예천", areas: ["예천읍", "감천면", "보문면"] },
      { center: "용문", areas: ["용문면", "효자면", "은풍면", "유천면"] },
      { center: "지보", areas: ["지보면", "풍양면", "개포면", "용궁면"] },
      { center: "도청", areas: ["호명읍"] }
    ],
    "봉화소방서": [
      { center: "봉화", areas: ["봉화읍", "물야면", "상운면"] },
      { center: "춘양", areas: ["춘양면", "법전면", "소천면", "석포면"] },
      { center: "명호", areas: ["명호면", "재산면", "봉성면"] }
    ],
    "울진소방서": [
      { center: "울진", areas: ["울진읍", "금강송면", "근남면", "매화면"] },
      { center: "북면", areas: ["북면"] },
      { center: "온정", areas: ["온정면"] },
      { center: "죽변", areas: ["죽변면"] },
      { center: "후포", areas: ["후포면", "평해읍", "기성면"] }
    ]
  };

  // ---------- 부산광역시 119안전센터 관할구역 ----------
  // 출처: "부산광역시 행정기구 설치 조례 시행규칙" 별표1(119안전센터ㆍ구조대ㆍ소방정대ㆍ119지역대의
  // 명칭ㆍ소재지 및 관할구역, 제24조제4항 관련) - law.go.kr 자치법규 검색 → 해당 조례 시행규칙 →
  // 별표/서식 탭에서 PDF/HWP로 직접 내려받아 확인한 공식 고시 원문(2026.9.1 확인, 제4232호 2026.7.29
  // 일부개정 기준) - 경북(GYEONGBUK_119_CENTERS)과 동급의 1차 출처다. 이전 버전(namu.wiki + 소방서
  // 홈페이지 대조)은 이 원문 확인 후 전면 재작성했다 - 특히 "반송동은 금정소방서 관할"이라던 이전 값은
  // 틀렸다(원문상 반송119안전센터는 해운대소방서 소속 그대로).
  // 구조대ㆍ소방정대ㆍ119지역대 항목은 여기 넣지 않는다 - 관할119안전센터 칸은 문자 그대로 "119안전센터"만
  // 받으므로(구조대/소방정대는 안전센터가 아님), 119지역대(가덕도ㆍ길천)는 그 상급 안전센터(녹산ㆍ장안)의
  // 관할구역에 이미 포함돼 있어 별도 행이 필요 없다(경북 방식과 동일, GYEONGBUK_119_CENTERS 주석 참고).
  // 원문이 "OO동 일부(XX 제외한다)"처럼 같은 동을 두 안전센터가 나눠 관할한다고 명시한 곳(예: 중앙동,
  // 초량2ㆍ3동, 범일1ㆍ2동, 범천2동, 문현4동, 우2동, 재송1동, 우암동, 강동동, 명지동 등 - 대부분 도로명
  // 등 번지 단위 경계라 동 이름만으로는 절대 못 가른다)은 대구 대명동 사례와 같은 원칙으로 그 동을
  // 어느 목록에도 넣지 않고 비웠다 - 관할119안전센터 칸은 읽기전용이 아니라서 사용자가 직접 채우거나
  // 고칠 수 있다.
  const BUSAN_119_CENTERS = {
    "부산중부소방서": [
      // 원문은 "중앙동(항만소방서 관할구역을 제외한다)"이라 어느 가(街)가 항만 소속인지 안 적혀있어
      // bare "중앙동"은 뺐지만, "중앙동4가"는 중앙119안전센터 소재지 자체가 그 안에 있어("부산광역시
      // 중구 중앙대로 110(중앙동4가)") 안전하게 포함(사용자 리포트: "충장대로 7(중앙동4가)"가 안 잡힘,
      // 2026-09-01).
      { center: "중앙", areas: ["동광동", "광복동", "영주동", "대청동1가", "대청동4가", "남포동1가", "남포동2가", "남포동4가", "중앙동4가"] },
      { center: "부민", areas: ["동대신동", "서대신동", "부민동", "아미동", "보수동"] },
      { center: "충무", areas: ["남부민동", "충무동", "암남동", "초장동", "남포동3가", "남포동5가", "남포동6가"] },
      { center: "창선", areas: ["창선동", "부평동", "신창동", "대청동2가", "대청동3가"] },
      { center: "초량", areas: ["초량1동", "초량6동"] }
    ],
    "부산진소방서": [
      { center: "부전", areas: ["부전동", "전포동"] },
      { center: "수정", areas: ["수정1동", "수정2동", "수정4동", "좌천동"] },
      { center: "가야", areas: ["가야동", "개금1동", "개금2동", "당감2동"] },
      { center: "부암", areas: ["부암1동", "연지동", "초읍동"] },
      { center: "당감", areas: ["당감1동", "당감4동", "부암3동", "개금3동"] },
      { center: "범일", areas: ["범천1동", "문현1동", "문현2동", "문현3동"] },
      { center: "안창", areas: ["수정5동"] }
    ],
    "부산동래소방서": [
      { center: "연산", areas: ["연산1동", "연산3동", "연산4동", "연산6동", "연산8동", "연산9동", "안락1동", "안락2동"] },
      { center: "수안", areas: ["수민동", "복산동", "명륜동", "명장1동", "거제1동"] },
      { center: "양정", areas: ["양정동", "연산2동", "연산5동"] },
      { center: "온천", areas: ["온천동"] },
      { center: "사직", areas: ["사직동", "거제2동", "거제3동", "거제4동"] }
    ],
    "부산북부소방서": [
      { center: "금곡", areas: ["금곡동"] },
      { center: "구포", areas: ["구포동", "덕천동"] },
      { center: "화명", areas: ["화명동"] },
      { center: "만덕", areas: ["만덕동"] }
    ],
    "부산사상소방서": [
      { center: "삼락", areas: ["삼락동", "덕포동", "괘법동"] },
      { center: "감전", areas: ["감전동"] },
      { center: "주례", areas: ["주례동"] },
      { center: "모라", areas: ["모라동"] },
      { center: "학장", areas: ["학장동", "엄궁동"] }
    ],
    "부산사하소방서": [
      { center: "신평", areas: ["신평동", "장림동", "구평동"] },
      { center: "괴정", areas: ["괴정동"] },
      { center: "하단", areas: ["당리동", "하단동"] },
      { center: "다대", areas: ["다대동"] },
      { center: "감천", areas: ["감천동"] }
    ],
    "부산해운대소방서": [
      // 우2동/재송1동은 벡스코ㆍ센텀시티산단 경계로 우동/센텀 두 센터가 나눠 관할 - 우1동만 안전하게 포함.
      { center: "우동", areas: ["우1동"] },
      { center: "중동", areas: ["중동"] },
      { center: "반여", areas: ["반여동", "재송2동"] },
      { center: "좌동", areas: ["좌동"] },
      { center: "반송", areas: ["반송동"] }
      // 센텀119안전센터: 관할구역 전체가 우2동/재송1동의 일부(벡스코/산단 구역)뿐이라 안전하게 넣을 동이 없다.
    ],
    "부산금정소방서": [
      { center: "부곡", areas: ["부곡1동", "부곡2동", "부곡3동", "구서1동", "장전동"] },
      // "명장2"(동래구, 원문 그대로) - guessFireStation의 "동래구+명장2동" 예외로 이미 이 소방서로 확정된다.
      { center: "서동", areas: ["명장2동", "부곡4동", "서동"] },
      { center: "남산", areas: ["선두구동", "청룡동", "노포동", "남산동", "구서2동"] },
      { center: "산성", areas: ["금성동"] },
      { center: "회동", areas: ["금사동", "회동동"] }
    ],
    "부산남부소방서": [
      { center: "광안", areas: ["광안동", "민락동"] },
      { center: "감만", areas: ["감만동", "대연4동"] },
      { center: "대연", areas: ["대연동", "남천동"] },
      { center: "용당", areas: ["용호동", "용당동"] },
      { center: "망미", areas: ["망미동", "수영동"] }
    ],
    "부산강서소방서": [
      { center: "녹산", areas: ["송정동", "녹산동", "화전동", "성북동", "동선동", "눌차동", "천성동", "대항동"] },
      { center: "대저", areas: ["대저1동"] },
      { center: "신호", areas: ["신호동"] },
      { center: "강동", areas: ["죽림동", "식만동", "죽동동", "봉림동"] },
      { center: "지사", areas: ["지사동", "범방동", "미음동", "생곡동", "구랑동"] },
      { center: "공항", areas: ["대저2동"] }
      // 강동동(대저/강동 경계)ㆍ명지동(신호/공항 경계)은 낙동남ㆍ북로 기준으로 갈려 동 이름만으로 못 가른다.
    ],
    "부산항만소방서": [
      { center: "영선", areas: ["영선동", "남항동", "신선동", "봉래1동"] },
      { center: "청학", areas: ["청학동", "봉래2동"] },
      { center: "동삼", areas: ["동삼동"] }
      // 부두119안전센터: 관할구역(범일2동ㆍ초량2ㆍ3동ㆍ중앙동ㆍ우암동ㆍ문현4동)이 전부 다른 소방서와
      // 겹치는 "일부" 구역뿐이라 안전하게 넣을 동이 없다.
    ],
    // 기장군은 기장읍/철마면/일광면이 리 단위로 여러 센터에 걸쳐 갈린다 - 배열 순서가 중요하다: 리
    // 단위로 특정된 항목(송정ㆍ정관)이 먼저 와야, "그 나머지 전부"를 받는 일광/장안의 넓은 항목
    // (기장읍/철마면/일광면·읍)에 앞서 매치된다. 예) "기장군 일광면 용천리"는 정관(용천리)에 먼저
    // 걸려야 하고, 장안의 "일광면" 문자열에 앞서 걸리면 안 된다.
    "부산기장소방서": [
      { center: "송정", areas: ["내리", "시랑리", "석산리", "당사리", "송정동"] },
      { center: "정관", areas: ["정관읍", "용천리", "송정리", "임기리", "백길리", "웅천리"] },
      { center: "일광", areas: ["이천리", "횡계리", "삼성리", "학리", "기장읍", "철마면"] },
      { center: "장안", areas: ["장안읍", "일광면", "일광읍"] }
    ]
  };

  function guessFireStation(address) {
    const addr = (address || "").trim();
    if (!addr) return "";
    // 지번 주소는 사용자가 "대구광역시"뿐 아니라 구/군, 심지어 읍/면까지 생략하고 리·동부터 바로
    // 적는 경우가 있다(사용자 리포트: "서재리 1118"만 입력하면 관할소방서가 안 나온다, 2026-08-29 -
    // "서재리"는 "대구", "달성군", "다사읍" 중 어느 것도 안 붙어있었음). "대구"가 문자열 어디에든
    // 있으면 대구로 보고, "대구"가 아예 없어도 "달성군"/"군위군"은 전국에서 대구에만 있는 이름이라
    // (다른 시/도에 동명 구/군 없음) 그 자체로 대구로 판단할 수 있다. 그 밑의 법정리/동 이름들
    // (DAEGU_BUK_GU_GANGBUK_DONGS/DAEGU_DALSEO_GU_GANGSEO_DONGS/DAEGU_DALSEONG_GUN_GANGSEO_AREAS -
    // daegu.go.kr 관내현황에서 확인한 실제 동/리명)도 대구 밖에서는 거의 안 쓰이는 이름들이라 이걸로도
    // 대구로 판단한다. 반면 "중구"/"동구"/"서구"/"남구"/"북구" 같은 흔한 구 이름은 부산/인천/대전/
    // 광주/울산 등에도 있어 "대구" 표시 없이는 오판할 위험이 있으므로 그대로 둔다.
    // 대구 달성군의 법정리 이름 중 일부(예: "이천리")가 부산 기장군 일광면의 리 이름과 우연히 같아서
    // (사용자 리포트 前 자체 테스트로 발견: "부산 기장군 일광면 이천리"가 대구 강서소방서로 오판됨,
    // 2026-09-01), 주소에 "부산"이 있으면 이 리·동 이름 기반 대구 추정 전체를 건너뛴다 - "대구"가
    // 명시된 진짜 대구 주소는 어차피 "부산"을 포함하지 않으므로 안전하다. 같은 이유로 대구 북구의
    // "도남동"이 영천시 남부동 관할의 "도남동"과도 우연히 같아서(사용자 리포트: 영천시 도남동
    // 주소가 대구 강북소방서로 잘못 잡힘, 2026-09-07) "영천"이 있을 때도 건너뛴다.
    const isBusan = addr.includes("부산");
    const isYeongcheon = addr.includes("영천");
    const hasKnownDaeguArea = !isBusan && !isYeongcheon && (
      DAEGU_BUK_GU_GANGBUK_DONGS.some((a) => addr.includes(a)) ||
      DAEGU_DALSEO_GU_GANGSEO_DONGS.some((a) => addr.includes(a)) ||
      DAEGU_DALSEONG_GUN_GANGSEO_AREAS.some((a) => addr.includes(a))
    );
    // 부산 해운대구는 "해운대구" 안에 "대구"가 부분 문자열로 들어있어(해운"대구") 바로 아래 "대구"
    // 포함 여부 검사에 그대로 걸리면 해운대구 주소가 전부 대구로 오판된다 - "해운대"가 있으면 제외.
    const looksLikeDaegu = addr.includes("대구") && !addr.includes("해운대");
    if (looksLikeDaegu || (!isBusan && (addr.includes("달성군") || addr.includes("군위군"))) || hasKnownDaeguArea) {
      const gu = DAEGU_DISTRICTS.find((g) => addr.includes(g));
      // 이 동 이름 목록들은 daegu.go.kr 관내현황에서 확인한, 해당 소방서에만 있는 동/리명이라 - "북구"/
      // "달서구"가 주소에 같이 안 적혀 있어도(리·동 이름만 적는 지번 주소, 위 hasKnownDaeguArea 참고)
      // 이름 자체만으로 그 소방서로 판단해도 안전하다.
      if (DAEGU_BUK_GU_GANGBUK_DONGS.some((dong) => addr.includes(dong))) {
        return "강북소방서";
      }
      if (DAEGU_DALSEO_GU_GANGSEO_DONGS.some((dong) => addr.includes(dong))) {
        return "강서소방서";
      }
      if (DAEGU_DALSEONG_GUN_GANGSEO_AREAS.some((a) => addr.includes(a))) return "강서소방서";
      if (gu === "달성군" && DAEGU_DALSEONG_GUN_SUSEONG_EUPMYEON.some((em) => addr.includes(em))) return "수성소방서";
      return (gu && DAEGU_FIRE_STATION[gu]) || "";
    }
    if (addr.includes("창원시")) {
      const gu = Object.keys(CHANGWON_FIRE_STATION).find((g) => addr.includes(g));
      if (gu) return CHANGWON_FIRE_STATION[gu];
    }
    if (addr.includes("부산")) {
      const gu = BUSAN_DISTRICTS.find((g) => addr.includes(g));
      // 구 경계와 다르게 넘어가는 동(부산광역시 행정기구 설치 조례 시행규칙 별표1 기준, BUSAN_119_CENTERS
      // 주석 참고) - 반드시 gu를 먼저 확인한 뒤 판단해야, 강서구 송정동(녹산센터 관할)처럼 다른 구에
      // 있는 동명(同名) 동과 안 섞인다(예: 해운대구 송정동만 기장소방서로 넘어가고, 강서구 송정동은
      // 그대로 강서소방서). 해운대구 반송동은 별표1상 해운대소방서 자체 관할(반송119안전센터)이라
      // 예외 처리하지 않는다 - 예전에 여기 있던 "반송→금정" 예외는 1차 출처 확인 전 잘못된 값이었다.
      if (gu === "동구" && addr.includes("초량")) return "부산중부소방서";
      if (gu === "부산진구" && addr.includes("양정")) return "부산동래소방서";
      if (gu === "동래구" && addr.includes("명장2동")) return "부산금정소방서";
      if (gu === "남구" && addr.includes("문현")) return "부산진소방서";
      if (gu === "해운대구" && addr.includes("송정")) return "부산기장소방서";
      return (gu && BUSAN_FIRE_STATION[gu]) || "";
    }
    // 포항시는 북구/남구로 소방서 자체가 갈리고(포항북부/포항남부소방서), 울릉군은 별도 소방서 없이
    // 포항남부소방서가 관할한다(경상북도 행정기구 설치 조례 시행규칙 별표2 기준) - 아래 일반 규칙
    // ("OO시/군소방서")을 타면 각각 "포항소방서"/"울릉소방서"라는 실재하지 않는 이름이 나오므로 먼저 처리한다.
    if (addr.includes("포항")) {
      if (addr.includes("북구")) return "포항북부소방서";
      if (addr.includes("남구")) return "포항남부소방서";
    }
    if (addr.includes("울릉군")) return "포항남부소방서";
    // i=1부터(첫 토큰 건너뜀) 시작하면 "경상북도"/"경북" 같은 시/도 접두어 없이 "안동시 육사로301"처럼
    // 시/군 이름이 주소 맨 앞 토큰으로 바로 오는 입력에서 그 토큰을 통째로 건너뛰어 관할소방서가 아예
    // 안 나오는 버그가 있었다(사용자 리포트: 안동이 119안전센터가 안 나온다, 2026-09-01 - 실제로는
    // 소방서부터 못 잡고 있었음). i=0부터 검사해도 "경상북도"/"OO광역시"는 애초에 이 정규식에 안 걸리므로
    // (뒤 필터가 광역시/특별시 등을 걸러내고, "OO도"는 애초에 시/군 접미사가 아니라 안 걸림) 안전하다.
    const tokens = addr.split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i].replace(/[^가-힣]/g, "");
      if (/^[가-힣]{2,}(시|군)$/.test(t) && !/(특별시|광역시|특별자치시|특별자치도)$/.test(t)) {
        // 실제 소방서 명칭은 "OO시소방서"가 아니라 "시/군" 접미사를 뗀 "OO소방서" 형태이므로
        // (예: "경산시" -> "경산소방서", "경산시소방서" 아님) 여기서 접미사를 제거한다.
        return `${t.replace(/(시|군)$/, "")}소방서`;
      }
    }
    // 위 정규식은 "시"/"군" 접미사가 붙어 있어야만 잡는다 - 그런데 실제로는 접미사를 생략하고
    // "경북 영천 OO동"처럼 지역명만 적는 경우가 있다(사용자 리포트: 경북 영천 주소에서 관할119안전센터가
    // 안 채워지는 곳이 있다, 2026-09-07). 경북 시/군 이름은 흔한 일반 단어와 겹치지 않아 접미사 없이
    // 이름만으로 판단해도 안전하므로, GYEONGBUK_119_CENTERS의 소방서 키(예: "영천소방서")에서
    // "소방서"를 뗀 이름이 주소에 포함돼 있으면 그 소방서로 본다(마지막 폴백).
    const gbStation = Object.keys(GYEONGBUK_119_CENTERS).find((k) => addr.includes(k.replace(/소방서$/, "")));
    if (gbStation) return gbStation;
    return "";
  }

  // 대구/경북/부산은 소방서 이름이 겹치지 않으므로(부산은 전부 "부산" 접두어) 그냥 합친다.
  const FIRE_119_CENTERS = { ...DAEGU_119_CENTERS, ...GYEONGBUK_119_CENTERS, ...BUSAN_119_CENTERS };

  // 관할119안전센터 - 반드시 guessFireStation()으로 소방서를 먼저 확정한 뒤 그 소방서 소속 안전센터
  // 목록 안에서만 동/리 이름을 찾는다(위 DAEGU_119_CENTERS 주석 참고 - 동명이동 오매칭 방지).
  function guessFireCenter119(address) {
    const station = guessFireStation(address);
    const centers = FIRE_119_CENTERS[station];
    if (!centers) return "";
    const addr = (address || "").trim();
    for (const { center, areas } of centers) {
      if (areas.some((a) => addr.includes(a))) return `${center}119안전센터`;
    }
    return "";
  }


  function showScreen(id) {
    $$(".screen").forEach((s) => s.classList.remove("active"));
    $("#" + id).classList.add("active");
    $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === id));
  }

  // 헤더의 "← 뒤로" 버튼은 화면마다 원래 있던 개별 뒤로가기 버튼을 그대로 대신 눌러준다 -
  // (그 버튼들이 이미 각 화면에 맞는 재조회/상태 정리를 다 하고 있으므로 로직을 중복시키지 않는다)
  // 매핑에 없는 화면(홈, 거래처보기/일정관리/설정/지적사항 허브 같은 최상위 탭 화면)은 홈으로 이동한다.
  const BACK_DELEGATE = {
    "screen-site-form": "btnCancelSiteForm",
    "screen-deficiency-rounds": "btnBackFromRounds",
    "screen-deficiencies": "btnBackFromDeficiencies",
    "screen-completion-report": "btnBackFromCompletionReport"
  };

  // ---------- 홈 ----------
  const WEEKDAY_LABEL = ["일", "월", "화", "수", "목", "금", "토"];

  // 날짜(캘린더 일자) 기준으로 연속되는 항목들을 그룹으로 묶는다 - 점검 이력/지적사항 회차
  // 목록 둘 다 "며칠 연속 방문"을 테두리 하나로 보여주는 데 같이 쓴다(사용자 요청, 종합/작동
  // 점검이 하루에 안 끝나고 2일 이상 걸리는 경우가 있어서). items는 이미 날짜 내림차순
  // 정렬되어 있어야 하고, dateOf(item)은 그 항목의 "YYYY-MM-DD" 날짜 문자열을 반환해야 한다.
  function groupConsecutiveByDate(items, dateOf) {
    const groups = [];
    let current = [];
    items.forEach((item) => {
      const prev = current[current.length - 1];
      const prevDateStr = prev ? dateOf(prev) : null;
      const curDateStr = dateOf(item);
      const prevD = prevDateStr ? new Date(prevDateStr + "T00:00:00") : null;
      const curD = curDateStr ? new Date(curDateStr + "T00:00:00") : null;
      const isConsecutive = prevD && curD && !isNaN(prevD) && !isNaN(curD) && (prevD - curD) === 86400000;
      if (!isConsecutive && current.length > 0) { groups.push(current); current = []; }
      current.push(item);
    });
    if (current.length > 0) groups.push(current);
    return groups;
  }

  function goHome() {
    showScreen("screen-home");
  }

  $("#appHeaderTitle").addEventListener("click", goHome);
  $("#btnHeaderHome").addEventListener("click", goHome);
  $("#btnHeaderBack").addEventListener("click", () => {
    const current = $(".screen.active");
    const delegateId = current && BACK_DELEGATE[current.id];
    if (delegateId) $("#" + delegateId).click();
    else goHome();
  });

  // ---------- 안드로이드 하드웨어 뒤로가기 버튼 ----------
  // @capacitor/app 플러그인이 없으면 웹뷰 기본 동작(뒤로 갈 브라우저 히스토리가 없으면 그냥 앱 종료)이
  // 그대로 발동해 어느 화면에서 눌러도 앱이 꺼져버렸다(실제 사용자가 겪은 문제) - 이 리스너가 화면
  // 전환/모달 닫기로 대신 처리하고("← 뒤로" 헤더 버튼과 완전히 같은 경로, BACK_DELEGATE 재사용),
  // 정말 홈 화면일 때만 실제 종료로 넘긴다.
  if (isNativeApp() && window.Capacitor.addListener) {
    window.Capacitor.addListener("App", "backButton", () => {
      const openModal = $$(".modal-overlay:not(.hidden)")[0];
      if (openModal) {
        const closeBtn = openModal.querySelector("#confirmCancelBtn, #shareFormatCancelBtn");
        if (closeBtn) { closeBtn.click(); return; }
      }
      const current = $(".screen.active");
      if (current && current.id === "screen-home") {
        callNativePlugin("App", "exitApp", {});
        return;
      }
      $("#btnHeaderBack").click();
    });
  }
  // "지적사항" 홈 타일 - 지적사항 허브(등록 방법 선택 + 거래처 목록)를 연다.
  $("#btnHomeDeficiency").addEventListener("click", () => {
    renderDeficiencyHub().catch(reportLoadFailure);
    showScreen("screen-deficiency-hub");
  });
  $("#btnHomeSettings").addEventListener("click", () => {
    renderSettings().catch(reportLoadFailure);
    showScreen("screen-settings");
  });

  // ---------- 탭 ----------
  // 자료를 불러오다 실패/시간초과되면(예: 불안정한 네트워크) 화면은 바뀌었는데 내용은 계속
  // 비어있는 채로 남아 "눌러도 반응 없음"처럼 보일 수 있다 - 실패를 토스트로 반드시 보여준다.
  function reportLoadFailure(err) {
    toast((err && err.message) || "자료를 불러오지 못했습니다. 네트워크를 확인해주세요.", "error");
  }
  $$(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      if (tab === "screen-deficiency-hub") renderDeficiencyHub().catch(reportLoadFailure);
      if (tab === "screen-reports-hub") renderReportsHub().catch(reportLoadFailure);
      if (tab === "screen-settings") renderSettings().catch(reportLoadFailure);
      showScreen(tab);
    });
  });

  // 홈 화면의 버전 표시(.app-version-tag)가 탭바 바로 위에 오려면 실제 탭바 높이를 알아야 한다 -
  // 예전에는 44px로 고정해뒀는데, 그 뒤 탭바 폰트/아이콘 크기를 키우면서 탭바가 더 높아져 버전
  // 표시가 탭바 밑에 깔려 잘려 보이는 원인이 됐다(실제 사용자가 겪은 문제). 기기별 폰트 렌더링에
  // 따라 탭바 높이가 달라질 수 있어 고정값 대신 실제 렌더링된 높이를 CSS 변수로 넘긴다.
  function syncTabBarHeightVar() {
    const bar = $(".tab-bar");
    if (bar) document.documentElement.style.setProperty("--tab-bar-height", bar.offsetHeight + "px");
  }
  syncTabBarHeightVar();
  window.addEventListener("resize", syncTabBarHeightVar);

  // ================= 현장 =================
  // 카드를 다시 그릴 때(정렬/지역 전환 등) 이전에 열려 있던 카드메뉴가 고아 상태로 남지 않도록,
  // 열려 있는 메뉴는 항상 문서 전역에서 하나만 추적하고 다른 곳을 클릭하면 닫는다.
  let openSiteCardMenu = null;
  function closeSiteCardMenu() {
    if (openSiteCardMenu) openSiteCardMenu.classList.add("hidden");
    openSiteCardMenu = null;
  }
  document.addEventListener("click", closeSiteCardMenu);

  const SITE_FORM_FIELDS = [
    "siteName", "siteBuildingType", "siteContactName", "siteContactPhone",
    "siteFireManagerName", "siteFireManagerPhone", "siteAddress"
  ];

  // 전화번호 칸은 입력을 마치고 칸을 벗어나면 바로 하이픈 형식으로 바꿔 보여준다.
  ["siteContactPhone", "siteFireManagerPhone"].forEach((id) => {
    $("#" + id).addEventListener("blur", (e) => { e.target.value = formatPhone(e.target.value.trim()); });
  });

  function openBlankSiteForm() {
    editingSiteId = null;
    $("#siteFormTitle").textContent = "거래처 정보";
    SITE_FORM_FIELDS.forEach((id) => { $("#" + id).value = ""; });
    $("#siteFireStation").value = "";
    $("#siteStation119").value = "";
    $("#importSummary").classList.add("hidden");
    showScreen("screen-site-form");
  }

  $("#btnEntryManual").addEventListener("click", openBlankSiteForm);
  $("#btnEntryImport").addEventListener("click", () => $("#clientImportInput").click());

  // 파일 입력 change 이벤트와 드래그앤드롭(handleClientImportDrop) 양쪽에서 재사용하도록 File
  // 객체를 직접 받는 함수로 분리했다.
  async function handleClientImportFile(file) {
    if (!file) return;
    ImportLoading.show(AiFill.isEnabled() ? "AI가 자료를 분석하고 있습니다." : "자료를 분석하고 있습니다.");
    ImportLoading.startSimulated();
    // 분석하는 동안 백그라운드로 같이 진행시키고, 함수를 빠져나가기 직전(finally)에 끝났는지 확인한다 -
    // 화면 전환 전에 실제로 완료됐다는 보장 없이 그냥 던져두면(fire-and-forget) 조용히 끊길 수 있다.
    let driveBackupPromise = Promise.resolve(null);
    try {
      let result = null;
      if (AiFill.isEnabled()) {
        try {
          // 구 HWP는 AiFill이 직접 다루지 못하므로(isSupportedExt에 없음), 여기서 먼저 hwpx로
          // 변환해서 넘겨준다 - 그래야 스프링클러설비 체크 여부(AI 분석 전용 필드, 종합점검대상
          // 자동판단에 쓰임)도 hwp 파일에서 인식된다. 변환 실패 시 원본 그대로 넘기면 AiFill이
          // unsupported 처리하고 기존 정규식 폴백으로 자연스럽게 이어진다.
          let aiFile = file;
          if (file.name.split(".").pop().toLowerCase() === "hwp") {
            const convertedHwpx = await ClientImport.convertHwpToHwpxViaService(file);
            if (convertedHwpx) aiFile = new File([convertedHwpx], file.name.replace(/\.hwp$/i, ".hwpx"));
          }
          const aiResult = await AiFill.analyzeClientFile(aiFile, (msg) => ImportLoading.setStatusText(msg));
          if (!aiResult.unsupported) result = aiResult;
        } catch (aiErr) {
          result = null; // AI 분석 실패 시 기존 방식으로 폴백
        }
      }
      if (!result) {
        result = await ClientImport.parseClientFile(file, (percent) =>
          ImportLoading.setProgress(percent, "사진에서 글자를 인식하고 있습니다.")
        );
      }
      // 담당자/소방안전관리자 성명은 원본 자료에 "이 홍 기"처럼 글자 사이 띄어쓰기가 있어도
      // 항상 붙여서 저장한다(사용자 요청, 2026-09-07) - 정규식 추출(client-import.js)은 이미
      // 붙여서 뽑아내지만, AI 추출(ai-fill.js)은 문서에 있는 띄어쓰기를 그대로 돌려줄 수 있어
      // 여기서 경로에 상관없이 한 번 더 확실히 붙인다.
      if (result && result.fields) {
        if (result.fields.contactName) result.fields.contactName = result.fields.contactName.replace(/\s+/g, "");
        if (result.fields.fireManagerName) result.fields.fireManagerName = result.fields.fireManagerName.replace(/\s+/g, "");
      }
      {
        const guessName = (result.fields && result.fields.name) || file.name.replace(/\.[^.]+$/, "");
        driveBackupPromise = DriveBackup.uploadToSite(guessName, `${DRIVE_APP_TAG}_${companyDriveTag()}_거래처_등록자료`, file.name, file).catch(() => null);
      }
      if (result.unsupported) {
        toast(`지원하지 않는 파일 형식입니다 (.xlsx, .docx, .pdf, .hwp, .hwpx, 사진).`, "error");
        return;
      }
      openBlankSiteForm();
      if (result.failed) {
        $("#importSummary").classList.remove("hidden");
        $("#importSummary").textContent = `${result.typeLabel}에서 자동으로 인식된 항목이 없습니다. 아래 내용을 직접 입력해주세요.`;
        toast(`${result.typeLabel}에서 인식된 정보가 없습니다. 직접 입력해주세요.`, "error");
        return;
      }
      const map = {
        name: "siteName", address: "siteAddress",
        contactName: "siteContactName", contactPhone: "siteContactPhone",
        fireManagerName: "siteFireManagerName", fireManagerPhone: "siteFireManagerPhone",
        buildingType: "siteBuildingType"
      };
      let filledCount = 0;
      Object.entries(map).forEach(([field, id]) => {
        if (result.fields[field]) { $("#" + id).value = id.endsWith("Phone") ? formatPhone(result.fields[field]) : result.fields[field]; filledCount++; }
      });
      $("#importSummary").classList.remove("hidden");
      $("#importSummary").textContent = `${result.typeLabel}에서 ${filledCount}개 항목을 자동으로 채웠습니다.${result.lowConfidence ? " 인식 품질이 낮을 수 있으니 내용을 꼭 확인해주세요." : " 내용을 확인 후 저장해주세요."}`;
      toast(`${result.typeLabel}에서 ${filledCount}개 항목을 채웠습니다. 내용을 확인해주세요.`);
      if (result.fields.address) autoSuggestFireStation(result.fields.address);
    } catch (err) {
      toast("파일을 분석하는 중 오류가 발생했습니다. 직접 입력해주세요.", "error");
      openBlankSiteForm();
    } finally {
      await driveBackupPromise;
      ImportLoading.hide();
    }
  }
  $("#clientImportInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    handleClientImportFile(file);
  });
  // 탐색기/다른 폴더에서 파일을 끌어다 놓아도 "업체 자료 올리기" 버튼을 누른 것과 똑같이 동작하도록
  // 지적사항 허브 화면 전체를 드롭 영역으로 둔다.
  setupFileDropZone($("#screen-deficiency-hub"), handleClientImportFile);

  $("#btnCancelSiteForm").addEventListener("click", () => {
    if (editingSiteId) openSiteRounds(editingSiteId);
    else { renderDeficiencyHub().catch(reportLoadFailure); showScreen("screen-deficiency-hub"); }
  });

  // 주소가 같은 현장은 새로 만들지 않고 기존 현장에 합친다 - 공백 차이 정도만 무시하는 단순 정규화 비교.
  function normalizeAddress(addr) {
    return (addr || "").replace(/\s+/g, "").trim();
  }

  // 새로 입력/인식된 값 중 실제로 뭔가 채워진 것만 기존 현장 위에 덮어쓴다 - 새 값이 비어 있으면
  // (예: 이번엔 그 항목이 인식/입력되지 않음) 기존에 저장돼 있던 값을 그대로 유지한다.
  function mergeSiteData(oldSite, newData) {
    const merged = { ...oldSite };
    for (const key of Object.keys(newData)) {
      const nv = newData[key];
      if (nv !== undefined && nv !== null && String(nv).trim() !== "") merged[key] = nv;
    }
    return merged;
  }

  $("#btnSaveSite").addEventListener("click", async () => {
    const name = $("#siteName").value.trim();
    if (!name) { toast("대상물명칭(상호)을 입력해주세요.", "error"); return; }
    const data = {
      name,
      address: $("#siteAddress").value.trim(),
      // 관계인/소방안전관리자 성명은 "이 홍 기"처럼 띄어쓰기가 섞여 입력돼도 항상 붙여서
      // 저장한다(사용자 요청, 2026-09-07).
      contactName: $("#siteContactName").value.replace(/\s+/g, ""),
      contactPhone: formatPhone($("#siteContactPhone").value.trim()),
      fireStation: $("#siteFireStation").value.trim(),
      station119: $("#siteStation119").value.trim(),
      buildingType: $("#siteBuildingType").value.trim(),
      fireManagerName: $("#siteFireManagerName").value.replace(/\s+/g, ""),
      fireManagerPhone: formatPhone($("#siteFireManagerPhone").value.trim())
    };
    if (editingSiteId) {
      await FireDB.updateSite(editingSiteId, data);
      openSiteRounds(editingSiteId);
      return;
    }
    const normAddr = normalizeAddress(data.address);
    const existing = normAddr ? (await FireDB.getAllSites()).find((s) => normalizeAddress(s.address) === normAddr) : null;
    if (existing) {
      const merged = mergeSiteData(existing, data);
      await FireDB.updateSite(existing.id, merged);
      toast("소재지가 같은 기존 거래처를 찾아 정보를 갱신했습니다.", "success");
      openSiteRounds(existing.id);
    } else {
      data.createdAt = new Date().toISOString();
      const site = await FireDB.addSite(data);
      openSiteRounds(site.id);
    }
  });

  // 관할소방서/관할119안전센터는 화면에 노출하지 않고, 소재지 입력만으로 항상 자동 계산해 숨은
  // 입력칸(#siteFireStation/#siteStation119)에 채워둔다 - 이행완료보고서 생성 시 쓰이는 값
  // (site.fireStation)과 완전히 같은 guessFireStation() 결과다.
  function autoSuggestFireStation(address) {
    $("#siteFireStation").value = guessFireStation(address) || "";
    const center119 = guessFireCenter119(address);
    if (center119) $("#siteStation119").value = center119;
  }

  $("#siteAddress").addEventListener("input", () => {
    autoSuggestFireStation($("#siteAddress").value.trim());
  });

  // 거래처 카드메뉴의 "수정"이 여기로 들어온다.
  async function openSiteEditForm(id) {
    const site = await FireDB.getSite(id);
    editingSiteId = id;
    $("#siteFormTitle").textContent = "거래처 정보 수정";
    $("#siteName").value = site.name || "";
    $("#siteBuildingType").value = site.buildingType || "";
    $("#siteContactName").value = site.contactName || "";
    $("#siteContactPhone").value = site.contactPhone || "";
    $("#siteFireManagerName").value = site.fireManagerName || "";
    $("#siteFireManagerPhone").value = site.fireManagerPhone || "";
    $("#siteAddress").value = site.address || "";
    autoSuggestFireStation(site.address || "");
    $("#importSummary").classList.add("hidden");
    showScreen("screen-site-form");
  }

  // ================= 지적사항 / 이행완료 (점검 기록과 완전히 분리, 현장에만 귀속) =================
  // 지적사항은 "회차"(deficiencyRounds) 단위로 묶인다 - 업체 하나를 여러 날짜에 방문할 때마다
  // 방문 날짜별로 독립된 지적사항 묶음(=그 날짜의 이행완료보고서)이 남아, 나중에 업체를 클릭하면
  // 날짜별 목록이 보이고 어느 것이든 다시 열어 수정할 수 있다(사용자 요청, 2026-08-22). 회차는
  // 점검(inspections)과는 별개의 가벼운 개념이다 - "점검이 먼저 있어야 지적사항을 추가할 수 있다"는
  // 예전 마찰(2026-08-11에 지적사항을 점검에서 완전히 분리했던 이유)을 되풀이하지 않기 위함.
  let currentDeficiencySiteId = null;
  let currentRoundId = null;
  let currentDeficiencies = [];

  // 이행완료 보고서의 "이행조치 일자" 시작/종료 날짜 - 회차(지적사항 화면)를 새로 열 때마다 오늘 날짜로
  // 초기화하고(openRoundDeficiencies), 목록 안에서 항목을 추가/수정해 화면이 다시 그려져도(renderDeficiencies)
  // 사용자가 이미 골라둔 값은 그대로 유지한다 - 그래서 이 초기화는 renderDeficiencies가 아니라
  // openRoundDeficiencies에서만 한다.
  let completionDateStart = todayISO();
  let completionDateEnd = todayISO();

  // "YYYY-MM-DD" -> "YYYY. M. D." (공식 서식의 ". . . ~ . . ." 자리에 맞는 표기).
  function formatDateDot(iso) {
    const m = (iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return iso || "";
    return `${m[1]}. ${parseInt(m[2], 10)}. ${parseInt(m[3], 10)}.`;
  }

  function renderCompletionDateRangeButtons() {
    $("#btnCompletionDateStart").textContent = formatDateDot(completionDateStart);
    $("#btnCompletionDateEnd").textContent = formatDateDot(completionDateEnd);
  }

  $("#btnCompletionDateStart").addEventListener("click", async () => {
    const picked = await promptDate("이행조치 시작 날짜", completionDateStart);
    if (!picked) return;
    completionDateStart = picked;
    renderCompletionDateRangeButtons();
  });

  $("#btnCompletionDateEnd").addEventListener("click", async () => {
    const picked = await promptDate("이행조치 종료 날짜", completionDateEnd);
    if (!picked) return;
    completionDateEnd = picked;
    renderCompletionDateRangeButtons();
  });

  function findDeficiency(defId) {
    return currentDeficiencies.find((d) => d.id === defId);
  }

  function newDeficiency(fields) {
    return {
      id: FireDB.genId(),
      siteId: fields.siteId || currentDeficiencySiteId,
      roundId: fields.roundId || currentRoundId,
      category: fields.category || "",
      floor: fields.floor || "",
      location: fields.location || "",
      code: normalizeInspectionCode(fields.code || ""),
      description: fields.description || "",
      beforePhotoIds: [],
      afterPhotoIds: [],
      resolved: false,
      createdAt: new Date().toISOString()
    };
  }

  // ---------- 지적사항 허브 (현장별) ----------
  // ================= 보고서 모아보기 =================
  // 이행완료보고서는 로컬에 따로 저장되지 않고 생성될 때마다 구글 드라이브(현장별 "이행완료보고서"
  // 폴더)로 백업되므로, 그 드라이브가 그대로 "지금까지 만든 보고서" 목록의 원본이다 - 프록시의
  // list-reports가 모든 현장 폴더를 돌며 모아준다.
  async function renderReportsHub() {
    const list = $("#reportsHubList");
    list.innerHTML = `<div class="empty-state">불러오는 중...</div>`;
    let files;
    try {
      files = await DriveBackup.listReports();
    } catch (err) {
      list.innerHTML = `<div class="empty-state">보고서 목록을 불러오지 못했습니다.<br>네트워크를 확인해주세요.</div>`;
      return;
    }
    // list-reports는 이 구글 드라이브 계정을 쓰는 모든 앱/회사의 보고서를 구분 없이 돌려주므로,
    // 파일명에 붙은 이 회사 태그([companyId])로 우리 회사 보고서만 걸러서 보여준다.
    const companyPrefix = `[${companyDriveTag()}]`;
    files = files.filter((f) => f.name.startsWith(companyPrefix));
    if (files.length === 0) {
      list.innerHTML = `<div class="empty-state">아직 생성된 이행완료보고서가 없습니다.</div>`;
      return;
    }
    list.innerHTML = files.map((f) => `
      <div class="report-row" data-id="${f.id}" data-name="${escapeHtml(f.name)}">
        <span class="report-row-site">${escapeHtml(f.siteName)}</span>
        <span class="report-row-file">${escapeHtml(f.name.slice(companyPrefix.length))}</span>
      </div>
    `).join("");
    $$("#reportsHubList .report-row").forEach((el) => {
      el.addEventListener("click", async () => {
        if (el.classList.contains("report-row-loading")) return;
        el.classList.add("report-row-loading");
        try {
          const blob = await DriveBackup.downloadFile(el.dataset.id);
          const rawName = el.dataset.name;
          const name = rawName.startsWith(`[${companyDriveTag()}]`) ? rawName.slice(`[${companyDriveTag()}]`.length) : rawName;
          const mimeType = name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/hwp+zip";
          await shareOrDownloadFile(blob, name, mimeType);
        } catch (err) {
          toast("파일을 여는 데 실패했습니다: " + (err && err.message ? err.message : "알 수 없는 오류"), "error");
        } finally {
          el.classList.remove("report-row-loading");
        }
      });
    });
  }

  // 지적사항이 하나도 없는 현장은 "확인해봤는데 정말 없음"(최신 회차의 noDeficiency로 명시적으로
  // 표시함)과 "신규 등록이라 아직 확인 전"을 구분한다 - 둘 다 그냥 "지적사항 없음"이라고
  // 하면 아직 검토 안 한 신규 거래처도 이미 확인 끝난 것처럼 보여서 놓치기 쉽다.
  function deficiencySiteStatuses(c, s) {
    const statuses = [];
    if (c.open > 0) statuses.push("open");
    if (c.resolved > 0) statuses.push("resolved");
    if (c.open === 0 && c.resolved === 0) statuses.push(c.noDeficiency ? "none" : "pending");
    return statuses;
  }

  // 회차(날짜) 하나의 지적사항 진행 상태를 검토중/미해결/해결/지적사항 없음 중 하나로 나타낸다
  // (사용자 요청) - 지적사항이 등록되지 않았으면 검토중, 미해결 항목이 하나라도 있으면 미해결,
  // 전부 이행완료됐으면 해결, "지적사항 없음"으로 표시해둔 회차면 지적사항 없음. 지적사항 허브의
  // 업체 배지와 회차 목록의 날짜별 배지가 같은 기준을 쓰도록 공용 함수로 뺐다.
  function roundStatusBadge(round, openCount, resolvedCount) {
    if (round && round.noDeficiency) return { label: "지적사항 없음", cls: "badge-scheduled" };
    if (openCount > 0) return { label: "미해결", cls: "badge-open" };
    if (resolvedCount > 0) return { label: "해결", cls: "badge-resolved" };
    return { label: "검토중", cls: "badge-pending" };
  }

  function siteStatusHubCardHtml(s, c) {
    // 업체 배지는 미해결/해결을 같이 보여주지 않고 최신 회차 기준 단일 상태 하나만 보여준다
    // (사용자 요청) - 미해결이 하나라도 있으면 그게 우선.
    const status = roundStatusBadge({ noDeficiency: c.noDeficiency }, c.open, c.resolved);
    const badges = `<span class="badge ${status.cls}">${status.label}</span>`;
    return `
      <div class="list-card" data-site="${s.id}">
        <div class="list-card-title">
          <span class="list-card-title-main">${escapeHtml(s.name)}</span>
          <span class="list-card-title-right">
            <span class="list-card-badges">${badges}</span>
            <button type="button" class="list-card-menu-btn" data-menu-btn>⋯</button>
          </span>
        </div>
        <div class="site-card-menu hidden" data-menu>
          <button type="button" data-menu-edit>수정</button>
          <button type="button" class="danger" data-menu-delete>삭제</button>
        </div>
        <div class="list-card-sub">${escapeHtml(s.address || "")}</div>
      </div>
    `;
  }

  function bindSiteStatusHubCardClicks(container, onCardClick, rerender) {
    Array.from(container.querySelectorAll(".list-card")).forEach((el) => {
      const id = el.dataset.site;
      el.addEventListener("click", () => onCardClick(id));
      const menuBtn = el.querySelector("[data-menu-btn]");
      const menu = el.querySelector("[data-menu]");
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const wasOpen = menu === openSiteCardMenu;
        closeSiteCardMenu();
        if (!wasOpen) { menu.classList.remove("hidden"); openSiteCardMenu = menu; }
      });
      menu.addEventListener("click", (e) => e.stopPropagation());
      menu.querySelector("[data-menu-edit]").addEventListener("click", () => {
        closeSiteCardMenu();
        openSiteEditForm(id);
      });
      menu.querySelector("[data-menu-delete]").addEventListener("click", async () => {
        closeSiteCardMenu();
        const ok = await confirmDialog("거래처를 삭제 하시겠습니까?");
        if (!ok) return;
        await FireDB.deleteSite(id);
        rerender();
      });
    });
  }

  function renderSiteStatusHubByRegion(sites, countsBySite, state, ids, onCardClick, rerender) {
    const list = $("#" + ids.list);
    if (state.selectedRegion) {
      const inRegion = sites.filter((s) => classifyRegion(s.address) === state.selectedRegion);
      const backBtnHtml = `<button class="btn btn-secondary region-back-row" type="button">← 지역 목록으로 (${escapeHtml(state.selectedRegion)})</button>`;
      if (inRegion.length === 0) {
        list.innerHTML = `${backBtnHtml}<div class="empty-state">이 지역에 해당하는 거래처가 없습니다.</div>`;
      } else {
        list.innerHTML = backBtnHtml + inRegion.map((s) => siteStatusHubCardHtml(s, countsBySite.get(s.id) || { open: 0, resolved: 0 })).join("");
        bindSiteStatusHubCardClicks(list, onCardClick, rerender);
      }
      list.querySelector(".region-back-row").addEventListener("click", () => { state.selectedRegion = null; rerender(); });
      return;
    }
    const counts = new Map();
    sites.forEach((s) => {
      const region = classifyRegion(s.address);
      counts.set(region, (counts.get(region) || 0) + 1);
    });
    const orderedRegions = orderRegionLabels(counts);

    list.innerHTML = `<div class="region-grid">${orderedRegions.map((r) => `
      <button class="region-btn" data-region="${escapeHtml(r)}">
        <span class="region-btn-name">${escapeHtml(r)}</span>
        <span class="region-btn-count">${counts.get(r)}개</span>
      </button>
    `).join("")}</div>`;
    Array.from(list.querySelectorAll(".region-btn")).forEach((btn) => {
      btn.addEventListener("click", () => { state.selectedRegion = btn.dataset.region; rerender(); });
    });
  }

  // 업체 카드의 미해결/해결 배지는 방문 회차가 여러 개여도 전체를 합산하지 않고, 가장 최근 회차
  // (날짜 기준)만 반영한다(사용자 요청, 2026-08-22 - "옛날 방문 결과까지 다 더해서 보이면 지금
  // 상태를 바로 알기 어렵다"는 취지). 아직 회차로 마이그레이션되지 않은 옛 지적사항(roundId 없음)만
  // 있는 업체는 그 전체를 하나의 암묵적 회차로 보고 그대로 합산한다 - 회차 화면을 한 번도 열어보지
  // 않은 업체의 배지가 갑자기 "0건"으로 비어 보이는 회귀를 막기 위함.
  function latestRoundCountsBySite(sites, defs, rounds) {
    const roundsBySite = new Map();
    rounds.forEach((r) => {
      const arr = roundsBySite.get(r.siteId) || [];
      arr.push(r);
      roundsBySite.set(r.siteId, arr);
    });
    const countsBySite = new Map();
    sites.forEach((s) => {
      const siteRounds = roundsBySite.get(s.id) || [];
      let latestRound = null;
      if (siteRounds.length > 0) {
        siteRounds.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
        latestRound = siteRounds[0];
      }
      const latestRoundId = latestRound ? latestRound.id : null;
      const c = { open: 0, resolved: 0 };
      defs.forEach((d) => {
        if (d.siteId !== s.id) return;
        const inLatest = latestRoundId ? d.roundId === latestRoundId : !d.roundId;
        if (!inLatest) return;
        d.resolved ? c.resolved++ : c.open++;
      });
      // "지적사항 없음"은 회차마다 따로 기록된다(round.noDeficiency) - 회차가 하나도 없는
      // 옛 현장(레거시)만 예외적으로 site.deficiencyReviewed를 그대로 본다.
      c.noDeficiency = latestRound ? !!latestRound.noDeficiency : !!s.deficiencyReviewed;
      // "최신순" 정렬(점검완료일 기준)에 쓸 마지막 회차 날짜 - 회차가 없으면 null(정렬 시 맨 뒤로).
      c.date = latestRound ? latestRound.date : null;
      countsBySite.set(s.id, c);
    });
    return countsBySite;
  }

  // 지적사항 허브와 공사팀 업체 목록이 공유하는 렌더러 - state/ids/onCardClick만 다르게 넘기면
  // 정렬(가나다순/지역별/최신순)·월 필터(이번달/다음달/지난달)·상태 필터 칩·업체 배지까지
  // 완전히 같은 화면을 그린다(사용자 요청, 2026-09-07).
  async function renderSiteStatusHub(state, ids, onCardClick) {
    const rerender = () => renderSiteStatusHub(state, ids, onCardClick);
    $("#" + ids.sortName).classList.toggle("active", state.sortMode === "name");
    $("#" + ids.sortRegion).classList.toggle("active", state.sortMode === "region");
    $("#" + ids.sortRecent).classList.toggle("active", state.sortMode === "recent");

    const [sites, defs, rounds] = await Promise.all([FireDB.getAllSites(), FireDB.getAllDeficiencies(), FireDB.getAllRounds()]);
    sites.sort((a, b) => a.name.localeCompare(b.name, "ko"));
    const countsBySite = latestRoundCountsBySite(sites, defs, rounds);
    const list = $("#" + ids.list);
    if (sites.length === 0) {
      list.innerHTML = `<div class="empty-state">등록된 현장이 없습니다.</div>`;
      return;
    }

    let filtered = state.filters.size === 0
      ? sites
      : sites.filter((s) => {
        const c = countsBySite.get(s.id) || { open: 0, resolved: 0 };
        return deficiencySiteStatuses(c, s).some((st) => state.filters.has(st));
      });

    if (filtered.length === 0) {
      list.innerHTML = `<div class="empty-state">선택한 조건에 맞는 거래처가 없습니다.</div>`;
      return;
    }

    const effectiveSortMode = state.sortMode;

    if (effectiveSortMode === "recent") {
      // 점검완료일(최근 회차 날짜) 기준 최신순 - 날짜가 없는 거래처는 맨 뒤로 보낸다.
      filtered = [...filtered].sort((a, b) => {
        const da = (countsBySite.get(a.id) || {}).date || "";
        const db = (countsBySite.get(b.id) || {}).date || "";
        return db.localeCompare(da);
      });
    }

    if (effectiveSortMode === "region") {
      renderSiteStatusHubByRegion(filtered, countsBySite, state, ids, onCardClick, rerender);
      return;
    }
    list.innerHTML = filtered.map((s) => siteStatusHubCardHtml(s, countsBySite.get(s.id) || { open: 0, resolved: 0 })).join("");
    bindSiteStatusHubCardClicks(list, onCardClick, rerender);
  }

  function wireSiteStatusHubToolbar(state, ids, onCardClick) {
    const rerender = () => renderSiteStatusHub(state, ids, onCardClick);
    $("#" + ids.sortName).addEventListener("click", () => {
      state.sortMode = "name";
      state.selectedRegion = null;
      rerender();
    });
    $("#" + ids.sortRegion).addEventListener("click", () => {
      state.sortMode = "region";
      rerender();
    });
    $("#" + ids.sortRecent).addEventListener("click", () => {
      state.sortMode = "recent";
      state.selectedRegion = null;
      rerender();
    });
    $$("#" + ids.filterToolbar + " .filter-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.filter;
        if (state.filters.has(key)) { state.filters.delete(key); btn.classList.remove("active"); }
        else { state.filters.add(key); btn.classList.add("active"); }
        state.selectedRegion = null;
        rerender();
      });
    });
  }

  const DEF_HUB_IDS = {
    list: "deficiencyHubList", filterToolbar: "defFilterToolbar",
    sortName: "btnDefSortByName", sortRegion: "btnDefSortByRegion", sortRecent: "btnDefSortByRecent"
  };
  // 지적사항 화면의 "등록된 거래처" 목록은 사용자 요청으로 제거됨(2026-09-28) - 화면에
  // 목록 요소가 없으므로 그리지 않는다. 등록된 데이터 자체는 그대로 남아 있다.
  function renderDeficiencyHub() {
    if (!$("#" + DEF_HUB_IDS.list)) return Promise.resolve();
    return renderSiteStatusHub(defHubState, DEF_HUB_IDS, openSiteRounds);
  }
  if ($("#" + DEF_HUB_IDS.list)) wireSiteStatusHubToolbar(defHubState, DEF_HUB_IDS, openSiteRounds);

  // 회차 도입 전(2026-08-22 이전)에 만들어진 지적사항은 roundId가 아예 없다 - 그런 현장을 처음
  // 열 때 딱 한 번, 그 기존 지적사항 전체를 회차 하나로 묶어준다(가장 이른 생성일을 회차 날짜로
  // 사용). 이미 회차가 하나라도 있으면 마이그레이션할 게 없으므로 그냥 통과.
  async function ensureRoundsForSite(siteId) {
    const rounds = await FireDB.getRoundsBySite(siteId);
    if (rounds.length > 0) return rounds;
    const legacyDefs = (await FireDB.getDeficienciesBySite(siteId)).filter((d) => !d.roundId);
    if (legacyDefs.length === 0) return rounds;
    legacyDefs.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
    const date = (legacyDefs[0].createdAt || new Date().toISOString()).slice(0, 10);
    const round = await FireDB.addRound({ siteId, date, label: "", createdAt: new Date().toISOString() });
    for (const def of legacyDefs) {
      await FireDB.updateDeficiency(def.id, { roundId: round.id });
    }
    return [round];
  }

  // 거래처 상세에서 "방문 완료 처리"를 누른 날짜를, 지적사항 메뉴에도 같은 날짜의 회차로 자동
  // 만들어준다(사용자 요청) - 방문을 마쳤으면 보통 그 자리에서 지적사항도 확인하므로, "+ 새 점검
  // 거래처 입력 후 "다음"을 누르면 회차 목록("+ 등록" 화면)을 거치지 않고 바로 지적사항
  // 화면(직접 추가/자료 올리기/전체삭제)으로 간다(사용자 요청, 2026-09-28). 오늘 날짜 회차가
  // 이미 있으면 그걸 이어서 쓰고, 없으면 오늘 날짜로 새로 만든다.
  async function openSiteRounds(siteId) {
    currentDeficiencySiteId = siteId;
    const rounds = await ensureRoundsForSite(siteId);
    const today = todayISO();
    let round = rounds.find((r) => r.date === today);
    if (!round) round = await FireDB.addRound({ siteId, date: today, label: "", createdAt: new Date().toISOString() });
    await openRoundDeficiencies(siteId, round.id);
  }

  async function renderDeficiencyRounds() {
    const site = await FireDB.getSite(currentDeficiencySiteId);
    const rounds = await FireDB.getRoundsBySite(currentDeficiencySiteId);
    rounds.sort((a, b) => (b.date || "").localeCompare(a.date || "")); // 최근 방문이 위로

    $("#deficiencyRoundsHeader").innerHTML = `
      <h2>${escapeHtml(site ? site.name : "")} · 지적사항 회차</h2>
      <div class="report-meta-row"><span class="label">주소</span><span>${escapeHtml(site && site.address ? site.address : "-")}</span></div>
    `;
    // "모든 지적 내역 삭제"는 회차 안에 지운 지적사항이 있어야 의미가 있으므로, 등록된 회차가
    // 하나도 없으면(=지울 게 없으면) 숨긴다.
    $("#btnDeleteAllSiteDeficiencies").classList.toggle("hidden", rounds.length === 0);

    const list = $("#deficiencyRoundsList");
    if (rounds.length === 0) {
      list.innerHTML = `<div class="empty-state">${site && site.deficiencyReviewed
        ? "지적사항 없음으로 확인된 현장입니다."
        : "아직 등록된 점검 회차가 없습니다.<br>'+ 새 점검 회차 시작'으로 시작해보세요."}</div>`;
      return;
    }

    // 날짜(요일) 옆 배지는 그 날짜의 점검 완료 여부(예정/완료)가 아니라 그 회차에 등록된
    // 지적사항 상태(검토중/미해결/해결/지적사항 없음)를 보여준다(사용자 요청) - roundStatusBadge
    // 참고, 지적사항 허브의 업체 배지와 같은 기준.
    const siteDefs = await FireDB.getDeficienciesBySite(currentDeficiencySiteId);
    const defsByRound = new Map();
    siteDefs.forEach((d) => {
      const arr = defsByRound.get(d.roundId) || [];
      arr.push(d);
      defsByRound.set(d.roundId, arr);
    });
    function roundCardHtml(r) {
      const d = r.date ? new Date(r.date + "T00:00:00") : null;
      const dateLabel = d && !isNaN(d) ? `${r.date} (${WEEKDAY_LABEL[d.getDay()]})` : (r.date || "");
      const roundDefs = defsByRound.get(r.id) || [];
      const open = roundDefs.filter((x) => !x.resolved).length;
      const resolved = roundDefs.filter((x) => x.resolved).length;
      const status = roundStatusBadge(r, open, resolved);
      return `
        <div class="list-card" data-round="${r.id}">
          <div class="list-card-title">
            <span class="list-card-title-main">${escapeHtml(dateLabel)}</span>
            <span class="list-card-title-right">
              <span class="badge ${status.cls}">${status.label}</span>
              <button type="button" class="list-card-menu-btn" data-menu-btn>⋯</button>
            </span>
          </div>
          <div class="site-card-menu hidden" data-menu>
            <button type="button" data-menu-edit-date>날짜 수정</button>
            <button type="button" class="danger" data-menu-delete>삭제</button>
          </div>
        </div>
      `;
    }

    list.innerHTML = groupConsecutiveByDate(rounds, (r) => r.date).map((group) => {
      if (group.length < 2) return roundCardHtml(group[0]);
      const endDate = group[0].date;
      const startDate = group[group.length - 1].date;
      return `
        <div class="date-group">
          <div class="date-group-header">${escapeHtml(startDate)} ~ ${escapeHtml(endDate)} (${group.length}일간)</div>
          ${group.map(roundCardHtml).join("")}
        </div>
      `;
    }).join("");

    Array.from(list.querySelectorAll(".list-card")).forEach((el) => {
      const roundId = el.dataset.round;
      el.addEventListener("click", () => openRoundDeficiencies(currentDeficiencySiteId, roundId));
      const menuBtn = el.querySelector("[data-menu-btn]");
      const menu = el.querySelector("[data-menu]");
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const wasOpen = menu === openSiteCardMenu;
        closeSiteCardMenu();
        if (!wasOpen) { menu.classList.remove("hidden"); openSiteCardMenu = menu; }
      });
      menu.addEventListener("click", (e) => e.stopPropagation());
      menu.querySelector("[data-menu-edit-date]").addEventListener("click", async () => {
        closeSiteCardMenu();
        const round = rounds.find((r) => r.id === roundId);
        const newDate = await promptDate("점검 날짜 수정", round.date);
        if (!newDate) return;
        await FireDB.updateRound(roundId, { date: newDate });
        await renderDeficiencyRounds();
      });
      menu.querySelector("[data-menu-delete]").addEventListener("click", async () => {
        closeSiteCardMenu();
        const ok = await confirmDialog("이 점검 회차와 등록된 모든 지적사항을 삭제할까요? 이 작업은 되돌릴 수 없습니다.");
        if (!ok) return;
        await FireDB.deleteRound(roundId);
        await renderDeficiencyRounds();
      });
    });
  }

  $("#btnAddRound").addEventListener("click", async () => {
    const date = await promptDate("새 점검 회차 날짜", todayISO());
    if (!date) return;
    const round = await FireDB.addRound({ siteId: currentDeficiencySiteId, date, label: "", createdAt: new Date().toISOString() });
    await openRoundDeficiencies(currentDeficiencySiteId, round.id);
    // 새 회차를 시작한 김에 바로 자료를 올릴 수 있도록 업로드 창을 띄운다 - "지적사항 자료
    // 올리기" 버튼(btnImportData)을 또 눌러야 하는 수고를 줄이기 위함. 취소하면 그냥 빈 회차만 남는다.
    $("#fileUploadModal").classList.remove("hidden");
  });

  $("#btnBackFromRounds").addEventListener("click", async () => {
    await renderDeficiencyHub();
    showScreen("screen-deficiency-hub");
  });

  async function openRoundDeficiencies(siteId, roundId) {
    currentDeficiencySiteId = siteId;
    currentRoundId = roundId;
    currentDeficiencies = await FireDB.getDeficienciesByRound(roundId);
    currentDeficiencies.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
    completionDateStart = todayISO();
    completionDateEnd = todayISO();
    renderCompletionDateRangeButtons();
    await renderDeficiencies();
    showScreen("screen-deficiencies");
  }

  // ---------- 지적사항 목록/편집 (현장 단위) ----------
  async function renderDeficiencies() {
    revokeObjectUrls();
    const site = await FireDB.getSite(currentDeficiencySiteId);
    const round = await FireDB.getRound(currentRoundId);
    const open = currentDeficiencies.filter((d) => !d.resolved).length;
    const resolved = currentDeficiencies.filter((d) => d.resolved).length;
    $("#deficiencyHeader").innerHTML = `
      <h2>${escapeHtml(site ? site.name : "")} · 지적사항 관리</h2>
      <div class="report-meta-row"><span class="label">점검 날짜</span><span>${escapeHtml(round ? round.date : "-")}${round && round.label ? ` (${escapeHtml(round.label)})` : ""}</span></div>
      <div class="report-meta-row"><span class="label">주소</span><span>${escapeHtml(site && site.address ? site.address : "-")}</span></div>
      <div class="report-meta-row"><span class="label">미해결 / 해결</span><span>${open}건 / ${resolved}건</span></div>
    `;

    const photos = await FireDB.getPhotosBySite(currentDeficiencySiteId);
    const photoMap = new Map(photos.map((p) => [p.id, p]));
    // 다른 사용자/기기에서 올려 이 기기 로컬에는 없는 사진을 구글 드라이브 백업본으로 보충한다
    // (fillMissingPhotosFromDrive 주석 참고) - 목록 렌더링 전에 채워야 아래 photoColHtml에서 바로 보인다.
    await fillMissingPhotosFromDrive(currentDeficiencySiteId, currentDeficiencies, photoMap);

    const list = $("#deficienciesList");
    if (currentDeficiencies.length === 0) {
      list.innerHTML = `<div class="empty-state">${round && round.noDeficiency
        ? "지적내역 없음으로 표시된 회차입니다."
        : "등록된 지적사항이 없습니다.<br>직접 추가하거나 자료를 올려보세요."}</div>`;
      return;
    }

    function photoColHtml(def, role) {
      const ids = role === "before" ? def.beforePhotoIds : def.afterPhotoIds;
      const thumbs = ids.map((pid) => {
        const p = photoMap.get(pid);
        if (!p) return "";
        const url = URL.createObjectURL(p.blob);
        activeObjectUrls.push(url);
        return `<div class="photo-thumb-wrap">
          <img class="photo-thumb" src="${url}">
          <button class="photo-thumb-remove" data-def="${def.id}" data-role="${role}" data-photo="${pid}">×</button>
        </div>`;
      }).join("");
      return `
        <div class="deficiency-photo-col">
          <span class="col-label">${role === "before" ? "이행 전" : "이행 후"}</span>
          <div class="photo-thumbs">
            ${thumbs}
            <label class="btn-add-photo-label">＋
              <input type="file" accept="image/*" class="deficiency-photo-input" data-def="${def.id}" data-role="${role}">
            </label>
          </div>
        </div>
      `;
    }

    function deficiencyCardHtml(def, idx) {
      return `
      <div class="deficiency-card" data-def="${def.id}">
        <div class="deficiency-card-number">${idx + 1}번 지적항목</div>
        <div class="field-row">
          <div class="field"><span>설비</span><input type="text" class="def-field" data-def="${def.id}" data-field="category" list="categoryList" value="${escapeHtml(def.category)}"></div>
          <div class="field"><span>층</span><input type="text" class="def-field" data-def="${def.id}" data-field="floor" value="${escapeHtml(def.floor)}"></div>
        </div>
        <div class="field-row">
          <div class="field"><span>설치장소</span><input type="text" class="def-field" data-def="${def.id}" data-field="location" value="${escapeHtml(def.location)}"></div>
          <div class="field"><span>점검번호</span><input type="text" class="def-field" data-def="${def.id}" data-field="code" value="${escapeHtml(def.code)}"></div>
        </div>
        <div class="field"><span>${idx + 1}번 지적항목 내용</span><textarea class="def-field" data-def="${def.id}" data-field="description" rows="2">${escapeHtml(def.description)}</textarea></div>
        <div class="deficiency-photo-cols">
          ${photoColHtml(def, "before")}
          ${photoColHtml(def, "after")}
        </div>
        <div class="deficiency-resolved-row">
          <input type="checkbox" class="def-resolved" data-def="${def.id}" ${def.resolved ? "checked" : ""}>
          <span>이행완료</span>
        </div>
        <div class="deficiency-card-actions">
          <button class="btn btn-danger btn-delete-def" data-def="${def.id}">삭제</button>
        </div>
      </div>
    `;
    }

    // 미완료/완료로 나눠서 보여준다(사용자 요청) - 번호는 전체 등록 순서(idx) 그대로 유지해,
    // 이행완료 체크로 그룹이 바뀌어도 항목 번호가 바뀌지 않게 한다.
    function groupSectionHtml(title, items) {
      if (items.length === 0) return "";
      return `<div class="deficiency-group-header">${title} (${items.length}건)</div>`
        + items.map(({ def, idx }) => deficiencyCardHtml(def, idx)).join("");
    }
    const unresolvedItems = [];
    const resolvedItems = [];
    currentDeficiencies.forEach((def, idx) => {
      (def.resolved ? resolvedItems : unresolvedItems).push({ def, idx });
    });
    list.innerHTML = groupSectionHtml("미완료", unresolvedItems) + groupSectionHtml("완료", resolvedItems);

    $$("#deficienciesList .def-field").forEach((el) => {
      el.addEventListener("change", async () => {
        await setDeficiencyField(el.dataset.def, el.dataset.field, el.value);
        // 점검번호는 정규화(쉼표 삽입)된 값을 입력칸에도 바로 반영해 사용자가 결과를 즉시 확인할 수 있게 한다.
        if (el.dataset.field === "code") el.value = findDeficiency(el.dataset.def).code;
      });
    });
    $$("#deficienciesList .def-resolved").forEach((el) => {
      el.addEventListener("change", () => setDeficiencyResolved(el.dataset.def, el.checked));
    });
    $$("#deficienciesList .deficiency-photo-input").forEach((input) => {
      // 네이티브 앱에서는 OS 파일 선택창(갤러리 저장 여부를 제어할 수 없음) 대신 Camera 플러그인을
      // 직접 호출한다 - 아래 pickDeficiencyPhotoFiles 주석 참고.
      input.addEventListener("click", (e) => {
        if (!isNativeApp()) return;
        e.preventDefault();
        pickDeficiencyPhotoFiles().then((files) => {
          if (files) onDeficiencyPhotoSelected(input.dataset.def, input.dataset.role, files);
        });
      });
      input.addEventListener("change", (e) => onDeficiencyPhotoSelected(input.dataset.def, input.dataset.role, e.target.files));
    });
    $$("#deficienciesList .photo-thumb-remove").forEach((btn) => {
      btn.addEventListener("click", () => removeDeficiencyPhoto(btn.dataset.def, btn.dataset.role, btn.dataset.photo));
    });
    $$("#deficienciesList .btn-delete-def").forEach((btn) => {
      btn.addEventListener("click", () => deleteDeficiency(btn.dataset.def));
    });
  }

  async function setDeficiencyField(defId, field, value) {
    const def = findDeficiency(defId);
    if (field === "code") value = normalizeInspectionCode(value);
    def[field] = value;
    await FireDB.updateDeficiency(def.id, { [field]: value });
  }

  async function setDeficiencyResolved(defId, checked) {
    const def = findDeficiency(defId);
    def.resolved = checked;
    await FireDB.updateDeficiency(def.id, { resolved: def.resolved });
    await renderDeficiencies();
  }

  // 순수 <input type=file>로 카메라를 열면 안드로이드 카메라 앱이 찍은 사진을 항상 휴대폰
  // 갤러리(DCIM)에도 저장해버려서, 이를 켜고 끌 방법이 없었다(사용자 리포트, 2026-09-02).
  // @capacitor/camera 플러그인은 saveToGallery 옵션으로 이를 직접 제어할 수 있어서, 네이티브
  // 앱에서는 파일 입력 대신 이 플러그인을 거쳐 "사진 촬영/갤러리에서 선택" 중 고르게 한다(기존
  // 안드로이드 파일 선택창과 비슷한 네이티브 바텀시트가 뜬다). 이 프로젝트는 번들러가 없어
  // @capacitor/camera의 JS SDK(Camera.getPhoto())를 로드할 수 없으므로, 다른 플러그인들처럼
  // callNativePlugin으로 네이티브 메서드를 직접 호출한다.
  async function pickDeficiencyPhotoFiles() {
    try {
      const result = await callNativePlugin("Camera", "getPhoto", {
        source: "PROMPT",
        resultType: "dataUrl",
        quality: 90,
        saveToGallery: isPhotoSaveToGalleryEnabled(),
        promptLabelHeader: "사진 추가",
        promptLabelPhoto: "갤러리에서 선택",
        promptLabelPicture: "사진 촬영",
      });
      const blob = await (await fetch(result.dataUrl)).blob();
      return [new File([blob], `photo_${Date.now()}.jpg`, { type: "image/jpeg" })];
    } catch (e) {
      if (e && e.message !== "User cancelled photos app") {
        toast("사진을 가져오지 못했습니다.", "error");
      }
      return null;
    }
  }

  async function onDeficiencyPhotoSelected(defId, role, files) {
    if (!files || files.length === 0) return;
    const def = findDeficiency(defId);
    const targetArr = role === "before" ? def.beforePhotoIds : def.afterPhotoIds;
    // 사진 저장을 시작만 해두고 기다리지 않으면(fire-and-forget), 사용자가 곧바로 다음 사진을
    // 고르거나 화면을 나가버릴 때 업로드가 끝나기 전에 끊겨 조용히 사라지는 문제가 실제로 있었다
    // (드라이브에 지적사항 사진이 단 한 장도 올라간 적이 없었음, 백엔드 자체는 정상 확인됨) -
    // 백업이 실제로 끝날 때까지 기다린 뒤에야 다음 사진으로 넘어가도록 고쳤다. backupToDrive는
    // 실패해도 절대 throw하지 않으므로(항상 조용히 무시) 여기서 기다려도 로컬 저장 흐름은 안전하다.
    // 이 사진은 나중에 다른 기기(PC 등)에서 이행완료보고서를 만들 때 로컬에 원본이 없으면 구글
    // 드라이브 백업본으로 대신 채워진다(위 openCompletionReport 참고) - 그래서 백업이 꺼져 있지
    // 않은데도 실패하면(네트워크/서버 문제 등) 조용히 넘기지 않고 바로 알려준다.
    ImportLoading.show("사진을 저장하고 있습니다.");
    try {
      let idx = 0;
      for (const file of files) {
        idx++;
        ImportLoading.setProgress((idx / files.length) * 100, files.length > 1 ? `사진을 저장하고 있습니다. (${idx}/${files.length})` : "사진을 저장하고 있습니다.");
        // 파일 선택창의 accept="image/*"는 SVG(아이콘/그림 파일)도 걸러내지 못한다 - 벡터 이미지는
        // 절대 실제 현장 사진이 아니므로, 여기서 거르지 않으면 보고서에 그대로(비정상적으로 확대되어)
        // 들어가버린다(실제 사용자가 겪은 문제).
        if (file.type === "image/svg+xml") {
          toast("아이콘/그림 파일(SVG)은 사진으로 등록할 수 없습니다. 실제 사진 파일을 선택해주세요.", "error");
          continue;
        }
        const uploadFile = await compressPhotoForUpload(file);
        const photo = await FireDB.addPhoto({
          siteId: currentDeficiencySiteId,
          itemId: def.id,
          role,
          blob: uploadFile,
          createdAt: new Date().toISOString()
        });
        targetArr.push(photo.id);
        const result = await backupToDrive(currentDeficiencySiteId, "지적사항_사진", `${role === "before" ? "이행전" : "이행후"}_${photo.id}.jpg`, uploadFile);
        if (!result && DriveBackup.isEnabled()) {
          toast("사진은 저장됐지만 구글 드라이브 자동 백업에는 실패했습니다(네트워크 확인).", "error");
        }
      }
    } finally {
      ImportLoading.hide();
    }
    const changes = { beforePhotoIds: def.beforePhotoIds, afterPhotoIds: def.afterPhotoIds };
    // 이행후 사진이 곧 수리 완료의 증거이므로, 한 장이라도 올라오면 이행완료를 자동으로 체크해준다.
    if (role === "after" && !def.resolved) {
      def.resolved = true;
      changes.resolved = true;
    }
    await FireDB.updateDeficiency(def.id, changes);
    await renderDeficiencies();
  }

  async function removeDeficiencyPhoto(defId, role, photoId) {
    const def = findDeficiency(defId);
    const key = role === "before" ? "beforePhotoIds" : "afterPhotoIds";
    def[key] = def[key].filter((id) => id !== photoId);
    await FireDB.deletePhoto(photoId);
    await FireDB.updateDeficiency(def.id, { [key]: def[key] });
    await renderDeficiencies();
  }

  async function deleteDeficiency(defId) {
    const ok = await confirmDialog("이 지적사항을 삭제할까요?");
    if (!ok) return;
    await FireDB.deleteDeficiency(defId);
    currentDeficiencies = currentDeficiencies.filter((d) => d.id !== defId);
    await renderDeficiencies();
  }

  // 회차 목록 화면을 더 이상 거치지 않으므로 뒤로가기는 지적사항 첫 화면으로 돌아간다.
  $("#btnBackFromDeficiencies").addEventListener("click", async () => {
    await renderDeficiencyHub();
    showScreen("screen-deficiency-hub");
  });

  $("#btnAddDeficiency").addEventListener("click", async () => {
    const newDef = newDeficiency({});
    await FireDB.addDeficiency(newDef);
    currentDeficiencies.push(newDef);
    await renderDeficiencies();
    const card = document.querySelector(`.deficiency-card[data-def="${newDef.id}"]`);
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      const firstField = card.querySelector(".def-field");
      if (firstField) firstField.focus();
    }
  });

  $("#btnDeleteAllDeficiencies").addEventListener("click", async () => {
    if (currentDeficiencies.length === 0) {
      toast("삭제할 지적사항이 없습니다.");
      return;
    }
    const ok = await confirmDialog(`지적사항 ${currentDeficiencies.length}건을 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.`);
    if (!ok) return;
    for (const def of currentDeficiencies.slice()) {
      await FireDB.deleteDeficiency(def.id);
    }
    currentDeficiencies = [];
    await renderDeficiencies();
    toast("지적사항을 모두 삭제했습니다.");
  });

  // ---------- 회차(점검 날짜) 관련서류 - 지적사항 자료와 별개로 계약서/허가서 등 파일을 올려두고
  // 다운로드할 수 있게 한다(사용자 요청, 2026-09-07). 실제 파일은 기기별 IndexedDB(roundDocuments)에
  // 캐시하면서 업로드 시점에 구글 드라이브에도 백업하고(사용자 요청: "구글드라이브에 저장돠게해줘"),
  // 어떤 서류가 있는지(id/파일명/용량)는 회차(deficiencyRounds, 공유 Firebase) 안에 documents
  // 목록으로 같이 저장한다 - 그래야 다른 사람/기기에서 업로드한 서류도 목록에 보이고, 이 기기
  // 로컬에 없으면 구글 드라이브에서 그 자리에서 채워 넣을 수 있다(사진의 fillMissingPhotosFromDrive와
  // 같은 방식). 구글 드라이브에는 "<id>_<원래 파일명>"으로 저장해 같은 이름 파일이 여러 개
  // 올라와도 안 겹치게 한다. 현장 등록 폼의 "추가 자료" 업로드/다운로드 방식
  // (attachmentRowHtml/formatFileSize)을 그대로 재사용한다.
  // 이 모달은 지적사항 화면(사진 썸네일이 activeObjectUrls를 쓰고 있음) 위에 뜨므로, 공용
  // activeObjectUrls/revokeObjectUrls를 같이 쓰면 모달을 열 때마다 뒤에 깔린 사진들의 URL까지
  // 지워져 깨져 보인다 - 그래서 이 모달 전용 배열을 따로 둔다.
  let roundDocumentUrls = [];
  function revokeRoundDocumentUrls() {
    roundDocumentUrls.forEach((u) => URL.revokeObjectURL(u));
    roundDocumentUrls = [];
  }

  function roundDocumentDriveFilename(entry) {
    return `${entry.id}_${entry.filename}`;
  }

  async function fillMissingRoundDocumentsFromDrive(round, docsMap) {
    const missing = round.documents.filter((d) => !docsMap.has(d.id));
    if (missing.length === 0) return;
    const site = await FireDB.getSite(round.siteId);
    if (!site || !site.name) return;
    await Promise.all(missing.map(async (d) => {
      const blob = await DriveBackup.fetchFile(site.name, `${DRIVE_APP_TAG}_${companyDriveTag()}_관련서류`, roundDocumentDriveFilename(d));
      if (!blob) return;
      const doc = { id: d.id, roundId: round.id, siteId: round.siteId, filename: d.filename, size: d.size, blob, createdAt: d.createdAt };
      docsMap.set(d.id, doc);
      FireDB.addRoundDocument(doc).catch(() => {});
    }));
  }

  async function renderRoundDocuments() {
    revokeRoundDocumentUrls();
    const list = $("#roundDocumentsList");
    const round = await FireDB.getRound(currentRoundId);
    const entries = round ? round.documents : [];
    if (entries.length === 0) {
      list.innerHTML = `<div class="empty-state">등록된 관련서류가 없습니다.</div>`;
      return;
    }
    const localDocs = await FireDB.getRoundDocumentsByRound(currentRoundId);
    const docsMap = new Map(localDocs.map((d) => [d.id, d]));
    await fillMissingRoundDocumentsFromDrive(round, docsMap);

    list.innerHTML = entries.map((entry) => {
      const doc = docsMap.get(entry.id);
      if (doc && doc.blob) {
        const url = URL.createObjectURL(doc.blob);
        roundDocumentUrls.push(url);
        return attachmentRowHtml(entry.id, entry.filename, entry.size, url);
      }
      // 이 기기에도, 구글 드라이브에도 없음(백업이 꺼져 있었거나 네트워크 문제) - 다운로드는
      // 못하지만 존재는 알 수 있게 남겨두고, 삭제는 계속 가능하게 한다.
      return `
        <div class="list-card attachment-row">
          <div class="list-card-title">${escapeHtml(entry.filename)}</div>
          <div class="list-card-sub">${formatFileSize(entry.size)} · 이 기기에서 불러올 수 없음</div>
          <button class="btn btn-danger btn-delete-attachment" data-att="${entry.id}" type="button">삭제</button>
        </div>
      `;
    }).join("");
    list.querySelectorAll(".btn-delete-attachment").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const ok = await confirmDialog("이 서류를 삭제할까요?");
        if (!ok) return;
        const docId = btn.dataset.att;
        await FireDB.deleteRoundDocument(docId);
        const latestRound = await FireDB.getRound(currentRoundId);
        if (latestRound) {
          await FireDB.updateRound(currentRoundId, { documents: latestRound.documents.filter((d) => d.id !== docId) });
        }
        renderRoundDocuments();
      });
    });
  }

  $("#btnOpenRoundDocuments")?.addEventListener("click", async () => {
    await renderRoundDocuments();
    $("#roundDocumentsModal").classList.remove("hidden");
  });
  $("#btnCloseRoundDocuments").addEventListener("click", () => {
    $("#roundDocumentsModal").classList.add("hidden");
    revokeRoundDocumentUrls();
  });
  $("#btnUploadRoundDocument").addEventListener("click", () => $("#roundDocumentInput").click());
  $("#roundDocumentInput").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;
    ImportLoading.show("서류를 저장하고 있습니다.");
    try {
      const round = await FireDB.getRound(currentRoundId);
      const newEntries = [];
      let idx = 0;
      for (const file of files) {
        idx++;
        ImportLoading.setProgress((idx / files.length) * 100, files.length > 1 ? `서류를 저장하고 있습니다. (${idx}/${files.length})` : "서류를 저장하고 있습니다.");
        const id = FireDB.genId();
        const createdAt = new Date().toISOString();
        await FireDB.addRoundDocument({
          id,
          roundId: currentRoundId,
          siteId: currentDeficiencySiteId,
          filename: file.name,
          size: file.size,
          blob: file,
          createdAt
        });
        const entry = { id, filename: file.name, size: file.size, createdAt };
        await backupToDrive(currentDeficiencySiteId, "관련서류", roundDocumentDriveFilename(entry), file);
        newEntries.push(entry);
      }
      await FireDB.updateRound(currentRoundId, { documents: [...(round ? round.documents : []), ...newEntries] });
    } finally {
      ImportLoading.hide();
    }
    await renderRoundDocuments();
    toast(`${files.length}개 서류를 등록했습니다.`);
  });

  // 이 회차를 "확인해봤는데 지적사항이 정말 없다"고 표시한다 - 회차 단위 플래그(round.noDeficiency)를
  // 쓰므로, 다른 회차(옛 회차·새 회차)의 표시에는 영향을 주지 않는다. 최신 회차일 때만 지적사항
  // 메인메뉴의 업체 배지에도 곧바로 "지적사항 없음"으로 반영된다(latestRoundCountsBySite가 최신
  // 회차 기준으로 보기 때문).
  $("#btnMarkRoundNoDeficiency")?.addEventListener("click", async () => {
    if (currentDeficiencies.length > 0) {
      toast("이미 등록된 지적사항이 있습니다. 먼저 삭제한 뒤 이용해주세요.", "error");
      return;
    }
    const ok = await confirmDialog("이 현장은 지적사항이 없는 것으로 표시할까요?");
    if (!ok) return;
    await FireDB.updateRound(currentRoundId, { noDeficiency: true });
    toast("지적사항 없음으로 표시했습니다.");
    await renderDeficiencies();
  });

  $("#btnDeleteAllSiteDeficiencies").addEventListener("click", async () => {
    const defs = await FireDB.getDeficienciesBySite(currentDeficiencySiteId);
    if (defs.length === 0) {
      toast("삭제할 지적사항이 없습니다.");
      return;
    }
    const ok = await confirmDialog(`이 현장의 모든 점검 회차에 등록된 지적사항 ${defs.length}건을 전부 삭제할까요?\n점검 회차 자체는 남고 그 안의 지적사항만 삭제됩니다. 이 작업은 되돌릴 수 없습니다.`);
    if (!ok) return;
    for (const def of defs) {
      await FireDB.deleteDeficiency(def.id);
    }
    toast("모든 지적사항을 삭제했습니다.");
    await renderDeficiencyRounds();
  });

  // "지적사항 자료 올리기"를 누르면 바로 OS 파일 선택창을 여는 대신, 파일 선택 버튼과 드롭 영역을
  // 함께 보여주는 작은 창을 띄운다 - 화면 아무데나 끌어다 놓아도 되는 건(setupFileDropZone) 알기
  // 어려우므로, 버튼을 눌렀을 때 "여기로 끌어다 놓거나 선택하세요"를 눈에 보이게 안내하기 위함.
  $("#btnImportData").addEventListener("click", () => $("#fileUploadModal").classList.remove("hidden"));
  $("#fileUploadCancelBtn").addEventListener("click", () => $("#fileUploadModal").classList.add("hidden"));
  $("#fileUploadBrowseBtn").addEventListener("click", () => $("#dataImportInput").click());
  setupFileDropZone($("#fileUploadDropZone"), (file) => {
    $("#fileUploadModal").classList.add("hidden");
    handleDeficiencyImportFile(file);
  });

  // 파일 입력 change 이벤트와 드래그앤드롭 양쪽에서 재사용하도록 File 객체를 직접 받는 함수로 분리.
  async function handleDeficiencyImportFile(file) {
    if (!file) return;
    const driveBackupPromise = backupToDrive(currentDeficiencySiteId, "지적사항_자료", file.name, file);
    const ext = file.name.split(".").pop().toLowerCase();
    ImportLoading.show(AiFill.isEnabled() ? "AI가 자료를 분석하고 있습니다." : "자료를 분석하고 있습니다.");
    ImportLoading.startSimulated();
    try {
      let rows = null;
      let lowConfidence = false;
      let typeLabel = "";
      // 구 HWP는 AiFill이 직접 다루지 못하므로(isSupportedExt에 없음) 거래처 등록 가져오기와 동일하게
      // 먼저 hwpx로 변환해서 넘긴다 - 변환 실패 시 원본 그대로 두면 아래에서 "지원하지 않는 형식"으로
      // 처리된다(이 문서는 표 구조가 있어야 인식되므로, 변환된 hwpx도 AI 전용 경로만 탄다 - FireImport엔
      // hwpx 표 파서가 없다).
      let aiFile = file;
      if (ext === "hwp") {
        const convertedHwpx = await ClientImport.convertHwpToHwpxViaService(file);
        if (convertedHwpx) aiFile = new File([convertedHwpx], file.name.replace(/\.hwp$/i, ".hwpx"));
      }
      const aiExt = aiFile.name.split(".").pop().toLowerCase();
      if (AiFill.isEnabled() && AiFill.isSupportedExt(aiExt)) {
        try {
          const aiResult = await AiFill.analyzeDeficiencyFile(aiFile);
          rows = aiResult.rows;
          typeLabel = aiResult.typeLabel;
        } catch (aiErr) {
          rows = null; // AI 분석 실패 시 기존 방식으로 폴백
        }
      }
      if (!rows) {
        if (ext === "xlsx" || ext === "xls") {
          rows = await FireImport.parseExcelFile(file);
          typeLabel = "엑셀";
        } else if (ext === "docx") {
          rows = await FireImport.parseWordFile(file);
          typeLabel = "워드 문서";
        } else if (ext === "pdf") {
          const result = await FireImport.parsePdfFile(file);
          rows = result.rows;
          lowConfidence = result.lowConfidence;
          typeLabel = "PDF";
        } else if (aiExt === "hwpx") {
          // AI(Gemini) 호출이 실패해도(프록시 장애, 모델 사용중지 등) 표 구조가 있는 문서는 여기서
          // 건질 수 있다 - hwp는 위에서 hwpx로 변환됐을 때만(aiExt) 이 경로를 탄다.
          rows = await FireImport.parseHwpxFile(aiFile);
          typeLabel = "한글(HWPX)";
        } else {
          toast(`지원하지 않는 파일 형식입니다 (.xlsx, .docx, .pdf${AiFill.isEnabled() ? ", .hwp, .hwpx, 사진" : ""}만 가능).`, "error");
          return;
        }
      }
      if (!rows || rows.length === 0) {
        toast(`${typeLabel || "파일"}에서 지적사항 표를 인식하지 못했습니다. 다른 파일을 이용하거나 직접 입력해주세요.`, "error");
        return;
      }
      for (const r of rows) {
        const def = newDeficiency(r);
        await FireDB.addDeficiency(def);
        currentDeficiencies.push(def);
      }
      await renderDeficiencies();
      toast(`${typeLabel}에서 ${rows.length}개 지적사항을 가져왔습니다.${lowConfidence ? " (인식 품질이 낮을 수 있어 내용을 확인해주세요.)" : ""}`);
    } catch (err) {
      toast("파일을 읽는 중 오류가 발생했습니다.", "error");
    } finally {
      await driveBackupPromise;
      ImportLoading.hide();
    }
  }
  $("#dataImportInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    $("#fileUploadModal").classList.add("hidden");
    handleDeficiencyImportFile(file);
  });
  // 탐색기/다른 폴더에서 파일을 끌어다 놓아도 "지적사항 자료 올리기" 버튼을 누른 것과 똑같이 동작.
  setupFileDropZone($("#screen-deficiencies"), handleDeficiencyImportFile);

  // ---------- 이행완료 보고서 ----------
  $("#btnGenerateCompletionReport").addEventListener("click", async () => {
    const resolved = currentDeficiencies.filter((d) => d.resolved);
    if (resolved.length === 0) {
      toast("이행완료로 표시된 지적사항이 없습니다. 목록에서 이행완료 여부를 먼저 체크해주세요.", "error");
      return;
    }
    await openCompletionReport();
  });

  let lastCompletionReportData = null;

  async function openCompletionReport() {
    revokeObjectUrls();
    const site = await FireDB.getSite(currentDeficiencySiteId);
    const company = await getCompanyProfile();
    const resolved = currentDeficiencies.filter((d) => d.resolved);
    // 이행조치 일자 - 지적사항 화면의 시작/종료 날짜 버튼(기본값 오늘, 클릭해서 변경 가능)에서 가져온다.
    const dateRange = `${formatDateDot(completionDateStart)} ~ ${formatDateDot(completionDateEnd)}`;

    const photos = await FireDB.getPhotosBySite(currentDeficiencySiteId);
    const photoMap = new Map(photos.map((p) => [p.id, p]));
    // 사진은 기기별 IndexedDB에만 저장된다 - 휴대폰으로 찍어 올린 사진은 PC 등 다른 기기의 로컬
    // 저장소엔 원본이 없어 여기서 빠질 수 있다(실제 사용자가 겪은 문제: "PC에서 이행완료보고서
    // 만들면 텍스트는 나오는데 사진은 안 나옴"). fillMissingPhotosFromDrive가 구글 드라이브 백업본으로
    // 채운다 - 둘 다에 없으면 기존과 동일하게 "사진 없음"으로 표시된다.
    await fillMissingPhotosFromDrive(currentDeficiencySiteId, resolved, photoMap);

    function photoCellHtml(def, role) {
      const ids = role === "before" ? def.beforePhotoIds : def.afterPhotoIds;
      if (ids.length === 0) return `<div class="no-photo">사진 없음</div>`;
      return ids.map((pid) => {
        const p = photoMap.get(pid);
        if (!p) return "";
        const url = URL.createObjectURL(p.blob);
        activeObjectUrls.push(url);
        return `<img src="${url}">`;
      }).join("");
    }

    const siteName = site ? site.name || "-" : "-";
    const siteType = site ? site.buildingType || "-" : "-";
    const siteAddr = site ? site.address || "-" : "-";
    const contactName = site ? site.contactName || "" : "";
    const contactPhone = site ? site.contactPhone || "" : "";
    const managerName = site ? site.fireManagerName || "" : "";
    const managerPhone = site ? site.fireManagerPhone || "" : "";
    const fireStation = site ? (site.fireStation || guessFireStation(site.address)) : "";
    const fireStationLine = fireStation ? `${escapeHtml(fireStation)}장 귀하` : "○○ 소방본부장ㆍ소방서장 귀하";

    // 지적내역서는 사진 있는 항목이 페이지를 길게 늘어뜨리므로, 한 페이지에 4건씩만 담고
    // 나머지는 다음 페이지로 넘긴다 (화면 네비게이션과 인쇄/PDF 양쪽 다 이 단위로 쪽이 나뉜다).
    const DETAIL_ITEMS_PER_PAGE = 4;
    const detailChunks = [];
    for (let i = 0; i < resolved.length; i += DETAIL_ITEMS_PER_PAGE) {
      detailChunks.push(resolved.slice(i, i + DETAIL_ITEMS_PER_PAGE));
    }
    if (detailChunks.length === 0) detailChunks.push([]);

    const detailPagesHtml = detailChunks.map((items, idx) => {
      const rowsHtml = items.map((def) => `
        <tr>
          <td class="did-content">
            <strong>${escapeHtml([def.floor, def.location].filter(Boolean).join(" "))}</strong>
            <div class="report-item-note">${escapeHtml(def.description)}</div>
          </td>
          <td class="did-photo completion-photo-cell" data-photo-label="이행 전">${photoCellHtml(def, "before")}</td>
          <td class="did-photo completion-photo-cell" data-photo-label="이행 후">${photoCellHtml(def, "after")}</td>
        </tr>
      `).join("");
      const pageLabel = detailChunks.length > 1 ? ` (${idx + 1}/${detailChunks.length}쪽)` : "";
      return `
        <div class="report-page">
          <div class="official-form-title">지적내역서 (대상물: ${escapeHtml(siteName)})${pageLabel}</div>
          <table class="completion-table">
            <colgroup>
              <col class="did-content">
              <col class="did-photo">
              <col class="did-photo">
            </colgroup>
            <thead>
              <tr>
                <th colspan="3">이행완료 보고서 증빙자료</th>
              </tr>
              <tr>
                <th class="did-content did-result-label" rowspan="2">이행결과</th>
                <th class="did-photo official-table-note" colspan="2">1. 이행 조치 건별 전ㆍ후 사진<br>2. 공사계약서 등 증빙서류 첨부(별첨)</th>
              </tr>
              <tr>
                <th class="did-photo">이행 전</th>
                <th class="did-photo">이행 후</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      `;
    }).join("");

    $("#completionReportContent").innerHTML = `
      <div class="official-form">
      <div class="report-page">
        <div class="official-form-topnote">■ 소방시설 설치 및 관리에 관한 법률 시행규칙 [별지 제11호서식]</div>
        <div class="official-form-title">소방시설등의 자체점검 결과 이행완료 보고서</div>

        <table class="official-table">
          <tr>
            <td class="section-label" rowspan="3">특정소방<br>대상물</td>
            <td class="field-label">대상물 명칭(상호)</td>
            <td>${escapeHtml(siteName)}</td>
            <td class="field-label">대상물 구분(용도)</td>
            <td>${escapeHtml(siteType)}</td>
          </tr>
          <tr>
            <td class="field-label">관계인</td>
            <td>성명: ${escapeHtml(contactName || "-")}<br>전화번호: <span class="nowrap">${escapeHtml(contactPhone ? formatPhone(contactPhone) : "-")}</span></td>
            <td class="field-label">소방안전관리자</td>
            <td>성명: ${escapeHtml(managerName || "-")}<br>전화번호: <span class="nowrap">${escapeHtml(managerPhone ? formatPhone(managerPhone) : "-")}</span></td>
          </tr>
          <tr>
            <td class="field-label">소재지</td>
            <td colspan="3">${escapeHtml(siteAddr)}</td>
          </tr>
        </table>

        <table class="official-table">
          <tr>
            <td class="section-label" rowspan="3">소방공사<br>업체</td>
            <td class="field-label">업체명(상호)</td>
            <td>${escapeHtml(company.name || "-")}</td>
            <td class="field-label">사업자번호</td>
            <td>${escapeHtml(company.bizRegNo || "-")}</td>
          </tr>
          <tr>
            <td class="field-label">대표이사</td>
            <td colspan="3">성명: ${escapeHtml(company.ceo || "-")} 　전화번호: <span class="nowrap">${escapeHtml(company.phone ? formatPhone(company.phone) : "-")}</span></td>
          </tr>
          <tr>
            <td class="field-label">소재지</td>
            <td colspan="3">${escapeHtml(company.address || "-")}</td>
          </tr>
        </table>

        <table class="official-table official-table-spaced">
          <tr>
            <td class="section-label">이행완료<br>사항</td>
            <td class="field-label">이행조치 내용</td>
            <td>※ 지 적 내 역 참 조 ※</td>
            <td class="field-label">이행조치 일자</td>
            <td>${escapeHtml(dateRange)}</td>
          </tr>
        </table>

        <p class="official-form-legal">
          「소방시설 설치 및 안전관리에 관한 법률」 제23조제4항 및 같은 법 시행규칙 제23조제6항에 따라 위와 같이 소방시설등의 수리ㆍ교체ㆍ정비에 대한 이행완료 보고서를 제출합니다.
        </p>

        <div class="official-form-sign">
          <div>　　년　　월　　일</div>
          <div>관계인: ${escapeHtml(contactName || "")}　　　　　(서명 또는 인)</div>
          <div>${fireStationLine}</div>
        </div>

        <table class="official-table official-table-spaced">
          <tr>
            <td class="field-label">첨부서류</td>
            <td>1. 이행계획 건별 이행 전ㆍ후 사진 증명자료 1부<br>2. 소방시설공사 계약서(이행조치 내용과 관련됩니다) 1부</td>
          </tr>
          <tr>
            <td colspan="2" class="official-table-bar">유의 사항</td>
          </tr>
          <tr>
            <td class="field-label">「소방시설 설치 및 관리에 관한 법률」 제61조제1항 제8호 및 제9호</td>
            <td>1. 특정소방대상물의 관계인이 법 제22조에 따른 소방시설등의 자체점검 결과에 따른 수리ㆍ조치ㆍ정비사항 발생 시 이행계획서를 첨부하지 않거나 거짓으로 제출한 경우 300만원 이하의 과태료를 부과합니다.<br>2. 특정소방대상물의 관계인이 소방시설등의 수리ㆍ조치ㆍ정비 이행계획을 별도의 연기신청 없이 기간 내에 완료하지 않은 경우 300만원 이하의 과태료를 부과합니다.</td>
          </tr>
        </table>

        <div class="official-form-footer">210mm×297mm[백상지(80g/㎡) 또는 중질지(80g/㎡)]</div>
      </div>
      ${detailPagesHtml}
      </div>
    `;
    lastCompletionReportData = { site, company, resolved, photoMap, dateRange, contactName, contactPhone, managerName, managerPhone, siteName, siteType, siteAddr, fireStation };
    completionReportPages = Array.from($("#completionReportContent").querySelectorAll(".report-page"));
    // showScreen을 먼저 해서 컨테이너가 실제로 화면에 보이게 만든 다음에 축소 계산을 해야 한다 -
    // display:none 상태에서 재면 폭이 0으로 나와 축소 비율 계산이 틀어진다.
    showScreen("screen-completion-report");
    showCompletionReportPage(0);
    // 사진(<img>)은 비동기로 로드되며 로드 후 표 높이가 바뀔 수 있어, 다 실린 뒤 축소를 다시 맞춘다.
    $$("#completionReportContent img").forEach((img) => {
      if (!img.complete) img.addEventListener("load", fitCompletionReportScale, { once: true });
    });
  }

  let completionReportPages = [];
  let completionReportPageIndex = 0;

  // 표(.official-form)의 실제 폭(가로 스크롤이 필요했던 그 폭)이 화면에 안 들어가면, 표를 줄바꿈/재배치
  // 하지 않고 가로세로 비율 그대로 통째로 축소(transform: scale)해서 스크롤 없이 한 화면에 담는다.
  // 화면이 넓어서 원래도 들어가면 축소하지 않는다(자연스러운 원본 크기 그대로).
  function fitCompletionReportScale() {
    const container = $("#completionReportContent");
    const form = container && container.querySelector(".official-form");
    if (!container || !form) return;
    const naturalWidth = form.scrollWidth;
    const naturalHeight = form.scrollHeight;
    const available = container.clientWidth;
    if (!naturalWidth || !available || naturalWidth <= available) {
      form.style.transform = "";
      form.style.marginBottom = "";
      return;
    }
    const scale = available / naturalWidth;
    form.style.transform = `scale(${scale})`;
    // transform은 레이아웃 공간을 그대로 차지하므로, 줄어든 만큼을 음수 마진으로 걷어내
    // 페이지 아래(이전/다음 버튼 등)에 빈 여백이 남지 않게 한다.
    form.style.marginBottom = `${Math.round(naturalHeight * scale - naturalHeight)}px`;
  }
  window.addEventListener("resize", () => {
    if ($("#screen-completion-report").classList.contains("active")) fitCompletionReportScale();
  });

  function showCompletionReportPage(idx) {
    if (!completionReportPages.length) return;
    completionReportPageIndex = Math.max(0, Math.min(idx, completionReportPages.length - 1));
    completionReportPages.forEach((el, i) => el.classList.toggle("active", i === completionReportPageIndex));
    const total = completionReportPages.length;
    $("#completionPageIndicator").textContent = `${completionReportPageIndex + 1} / ${total}`;
    $("#btnCompletionPrevPage").disabled = completionReportPageIndex === 0;
    $("#btnCompletionNextPage").disabled = completionReportPageIndex === total - 1;
    $("#completionReportPager").classList.toggle("hidden", total <= 1);
    fitCompletionReportScale();
  }

  $("#btnCompletionPrevPage").addEventListener("click", () => showCompletionReportPage(completionReportPageIndex - 1));
  $("#btnCompletionNextPage").addEventListener("click", () => showCompletionReportPage(completionReportPageIndex + 1));

  $("#btnDownloadCompletionHwpx").addEventListener("click", async () => {
    if (!lastCompletionReportData) return;
    const btn = $("#btnDownloadCompletionHwpx");
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "생성 중...";
    try {
      const blob = await HwpxExport.generateCompletionReportHwpx(lastCompletionReportData);
      await backupToDrive(
        lastCompletionReportData.site ? lastCompletionReportData.site.id : null,
        "이행완료보고서",
        `[${companyDriveTag()}]이행완료보고서_${lastCompletionReportData.siteName}_${todayISO()}.hwpx`,
        blob
      );
      // 앱(APK) 안의 WebView는 <a download>로 조용히 다운로드하는 게 안 보이거나 그냥 안 될 때가
      // 많다(사용자가 실제로 겪은 문제) - 네이티브에서는 안드로이드 표준 "다운로드" 폴더에 직접 저장하고
      // (FileSaver 네이티브 플러그인) 실제 저장된 위치를 그대로 알려준다.
      const filename = `이행완료보고서_${lastCompletionReportData.siteName}.hwpx`;
      if (isNativeApp()) {
        btn.textContent = "저장 중...";
        const saved = await nativeSaveToDownloads(blob, filename, "application/hwp+zip");
        toast(`저장되었습니다: ${saved.location}`, "success");
        await nativeOfferToOpen(saved.uri, saved.mimeType);
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        toast("HWPX 파일이 생성되었습니다. 한글 프로그램에서 정상적으로 열리는지 꼭 확인해주세요.", "success");
      }
    } catch (err) {
      toast("HWPX 파일 생성에 실패했습니다: " + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });

  $("#btnBackFromCompletionReport").addEventListener("click", async () => {
    await renderDeficiencies();
    showScreen("screen-deficiencies");
  });

  // 안드로이드 WebView는 window.print()를 기본적으로 지원하지 않는다(PrintManager 네이티브
  // 연동이 따로 있어야 하는데, 이 프로젝트엔 없다) - 그냥 조용히 아무 반응도 없다(사용자가 실제로
  // 겪은 문제). 네이티브 앱에서는 대신 이미 있는 PDF 생성 경로(공유 버튼과 동일)로 PDF 파일을
  // 만들어 다운로드 폴더에 저장하고 바로 열도록 한다. 웹(데스크톱 브라우저)에서는 실제 인쇄도
  // 가능한 window.print()가 더 유용하므로 그대로 둔다.
  // 네이티브 앱에서는 실제 "인쇄"가 아니라 PDF 저장만 일어나므로 버튼 문구를 그에 맞게 바꾼다.
  if (isNativeApp()) $("#btnPrintCompletionReport").textContent = "PDF 저장";
  $("#btnPrintCompletionReport").addEventListener("click", async () => {
    if (!isNativeApp()) {
      window.print();
      return;
    }
    const btn = $("#btnPrintCompletionReport");
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "PDF 생성 중...";
    try {
      const blob = await generateCompletionReportPdfBlob();
      const filename = `이행완료보고서_${lastCompletionReportData.siteName}.pdf`;
      btn.textContent = "저장 중...";
      const saved = await nativeSaveToDownloads(blob, filename, "application/pdf");
      toast(`저장되었습니다: ${saved.location}`, "success");
      await nativeOfferToOpen(saved.uri, saved.mimeType);
    } catch (err) {
      toast("PDF 생성에 실패했습니다: " + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });

  async function generateCompletionReportPdfBlob() {
    const el = $("#completionReportContent");
    // 화면에서는 한 번에 한 페이지만 보이지만(.report-page.active), PDF에는 전체 페이지가
    // 다 들어가야 하므로 캡처 직전에만 전부 보이게 전환한다 - html2canvas는 @media print를
    // 반영하지 않으므로 인쇄용 CSS만으로는 부족하다. 좁은 화면에서 스크롤 없이 보이도록
    // fitCompletionReportScale이 걸어둔 축소(transform)도 마찬가지로 @media print를 안 타서,
    // 캡처 직전에 걷어내지 않으면 PDF까지 작게 찍힌다 - 캡처 후 화면용 축소를 다시 계산해 돌려놓는다.
    const form = el.querySelector(".official-form");
    if (form) { form.style.transform = ""; form.style.marginBottom = ""; }
    el.classList.add("pdf-export-all-pages");
    try {
      return await html2pdf()
        .set({
          margin: 8,
          filename: "report.pdf",
          image: { type: "jpeg", quality: 0.95 },
          html2canvas: { scale: 2, useCORS: true },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
          pagebreak: { mode: ["css", "legacy"] }
        })
        .from(el)
        .outputPdf("blob");
    } finally {
      el.classList.remove("pdf-export-all-pages");
      fitCompletionReportScale();
    }
  }

  // 파일 공유를 지원하는 브라우저(모바일 대부분)면 공유 시트를 띄우고, 아니면 파일을 바로 다운로드한다.
  async function shareOrDownloadFile(blob, filename, mimeType) {
    if (isNativeApp()) {
      try {
        await nativeShareFiles([{ blob, name: filename }], "이행완료 보고서");
        return;
      } catch (e) {
        if (e && e.message && /cancel/i.test(e.message)) return; // 사용자가 공유 화면에서 취소함
        toast("공유 화면을 여는 데 실패했습니다: " + (e && e.message ? e.message : "알 수 없는 오류"), "error");
        return;
      }
    }
    const file = new File([blob], filename, { type: mimeType });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "이행완료 보고서" });
        return;
      } catch (e) {
        if (e.name === "AbortError") return; // 사용자가 공유를 취소함
        // 그 외 오류(공유 대상 없음 등)면 아래에서 다운로드로 대체 처리
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(`${filename} 파일이 다운로드되었습니다. 원하는 방법으로 공유해주세요.`, "success");
  }

  $("#btnShareCompletionReport").addEventListener("click", async () => {
    if (!lastCompletionReportData) return;
    const format = await pickShareFormat();
    if (!format) return;
    const btn = $("#btnShareCompletionReport");
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "생성 중...";
    // 공유 시트가 뜨는 걸 드라이브 백업 완료까지 기다리게 하고 싶진 않지만, 공유 시트를 연 뒤
    // 함수가 바로 끝나버리면(백업이 아직 진행 중이어도) 조용히 끊길 위험이 있으므로 finally에서 기다린다.
    let driveBackupPromise = Promise.resolve(null);
    try {
      const filenameBase = `이행완료보고서_${lastCompletionReportData.siteName}`;
      // 구글 드라이브에는 회사 태그를 붙인 이름으로 올려서 "보고서 모아보기"가 다른 회사
      // 보고서와 섞이지 않게 걸러낼 수 있게 한다 - 사용자가 직접 받는 파일명은 태그 없이 깔끔하게 둔다.
      const driveFilenameBase = `[${companyDriveTag()}]${filenameBase}`;
      const siteId = lastCompletionReportData.site ? lastCompletionReportData.site.id : null;
      if (format === "hwpx") {
        const blob = await HwpxExport.generateCompletionReportHwpx(lastCompletionReportData);
        driveBackupPromise = backupToDrive(siteId, "이행완료보고서", `${driveFilenameBase}_${todayISO()}.hwpx`, blob);
        btn.textContent = "공유 화면 여는 중...";
        await shareOrDownloadFile(blob, `${filenameBase}.hwpx`, "application/hwp+zip");
      } else {
        const blob = await generateCompletionReportPdfBlob();
        driveBackupPromise = backupToDrive(siteId, "이행완료보고서", `${driveFilenameBase}_${todayISO()}.pdf`, blob);
        btn.textContent = "공유 화면 여는 중...";
        await shareOrDownloadFile(blob, `${filenameBase}.pdf`, "application/pdf");
      }
    } catch (err) {
      toast("파일 생성에 실패했습니다: " + err.message, "error");
    } finally {
      await driveBackupPromise;
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  const DEFAULT_COMPANY = { name: "", address: "", phone: "", ceo: "", bizRegNo: "" };

  // 업체(소방공사업체) 정보는 팀 전체가 공유하는 값이라 Firebase(공유 저장소)에 둔다 - 한 사람이
  // 설정 탭에서 고치면 다른 사람 화면에도 바로 그 값으로 보인다.
  async function getCompanyProfile() {
    const parsed = await FireDB.getCompanyProfile();
    if (!parsed) return { ...DEFAULT_COMPANY };
    return {
      name: parsed.name || "",
      address: parsed.address || "",
      phone: parsed.phone || "",
      ceo: parsed.ceo || "",
      bizRegNo: parsed.bizRegNo || ""
    };
  }

  async function saveCompanyProfile(profile) {
    return FireDB.saveCompanyProfile(profile);
  }


  async function renderSettings() {
    const profile = await getCompanyProfile();
    $("#companyName").value = profile.name;
    $("#companyAddress").value = profile.address;
    $("#companyPhone").value = profile.phone;
    $("#companyCeo").value = profile.ceo;
    $("#companyBizRegNo").value = profile.bizRegNo;
    $("#aiEnabledToggle").checked = AiFill.isEnabled();
    $("#photoSaveToGalleryToggle").checked = isPhotoSaveToGalleryEnabled();
    renderDriveStatus();
    $("#authCurrentUser").textContent = Auth.getDisplayName();
  }

  $("#appVersionText").textContent =
    "현재 버전" + (typeof APP_VERSION !== "undefined" ? ": " + APP_VERSION : "");

  function renderDriveStatus() {
    $("#driveEnabledToggle").checked = DriveBackup.isEnabled();
  }

  $("#driveEnabledToggle").addEventListener("change", (e) => {
    DriveBackup.setEnabled(e.target.checked);
    toast(e.target.checked ? "자동 저장을 켰습니다." : "자동 저장을 껐습니다.");
  });

  $("#aiEnabledToggle").addEventListener("change", (e) => {
    AiFill.setEnabled(e.target.checked);
    toast(e.target.checked ? "AI 자동 인식을 켰습니다." : "AI 자동 인식을 껐습니다.");
  });

  $("#photoSaveToGalleryToggle").addEventListener("change", (e) => {
    setPhotoSaveToGalleryEnabled(e.target.checked);
    toast(e.target.checked ? "촬영한 사진을 휴대폰에도 저장합니다." : "촬영한 사진을 휴대폰에는 저장하지 않습니다.");
  });

  // ---------- 자료 백업 / 복구 ----------
  // 거래처/점검/지적사항/스케줄(=Firebase의 공유 텍스트 자료)의 스냅샷을 zip으로 묶어 구글
  // 드라이브에 보관한다. 사진/첨부파일은 업로드 시점에 이미 각자 개별적으로 구글 드라이브에
  // 자동 저장되므로 여기 다시 담지 않는다(용량 낭비 + 중복). 이행완료보고서도 지적사항 데이터가
  // 있으면 언제든 다시 만들 수 있어 별도로 담지 않는다 - "다시 만들 수 없는 원본 텍스트"만 백업한다.
  async function collectBackupData() {
    const [sites, deficiencies, rounds] = await Promise.all([
      FireDB.getAllSites(),
      FireDB.getAllDeficiencies(),
      FireDB.getAllRounds(),
    ]);
    return { version: 1, exportedAt: new Date().toISOString(), company: await getCompanyProfile(), sites, deficiencies, rounds };
  }

  function backupFilenameDate() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  }

  $("#btnDataBackup").addEventListener("click", async () => {
    const btn = $("#btnDataBackup");
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "백업 중...";
    $("#backupStatus").textContent = "";
    try {
      const data = await collectBackupData();
      const zip = new JSZip();
      zip.file("backup.json", JSON.stringify(data, null, 2));
      const blob = await zip.generateAsync({ type: "blob" });
      const filename = `${DRIVE_APP_TAG}_${companyDriveTag()}_${backupFilenameDate()}.zip`;
      await DriveBackup.uploadBackup(filename, blob);
      $("#backupStatus").textContent = `마지막 백업: ${filename}`;
      toast(`백업 완료: ${filename} (구글 드라이브에 저장됨)`, "success");
    } catch (err) {
      toast("백업에 실패했습니다: " + (err && err.message ? err.message : "알 수 없는 오류"), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });

  $("#btnDataRestore").addEventListener("click", async () => {
    const ok = await confirmDialog(
      "가장 최근 백업으로 복구할까요?\n" +
      "현재 거래처·지적사항 자료가 백업 시점 내용으로 전부 바뀌며, 이 앱을 쓰는 모든 사람에게 적용됩니다.\n" +
      "되돌릴 수 없습니다."
    );
    if (!ok) return;
    const btn = $("#btnDataRestore");
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "복구 중...";
    $("#backupStatus").textContent = "";
    try {
      // 같은 구글 드라이브 계정을 다른 앱(소방점검 관리 등) 및 이 앱을 함께 쓰는 다른 회사와도
      // 공유하므로, 이 앱+이 회사 태그가 붙은 백업 파일만 걸러서 그중 가장 최근 것을 고른다.
      const backups = (await DriveBackup.listBackups()).filter((f) => f.name.startsWith(`${DRIVE_APP_TAG}_${companyDriveTag()}_`));
      if (backups.length === 0) {
        toast("구글 드라이브에 백업 파일이 없습니다.", "error");
        return;
      }
      const latest = backups[0];
      btn.textContent = "다운로드 중...";
      const blob = await DriveBackup.downloadFile(latest.id);
      const zip = await JSZip.loadAsync(blob);
      const entry = zip.file("backup.json");
      if (!entry) throw new Error("백업 파일 형식이 올바르지 않습니다.");
      const data = JSON.parse(await entry.async("string"));

      btn.textContent = "복원 중...";
      for (const site of data.sites || []) await FireDB.addSite(site);
      for (const def of data.deficiencies || []) await FireDB.addDeficiency(def);
      for (const round of data.rounds || []) await FireDB.addRound(round);
      if (data.company) await saveCompanyProfile(data.company);

      $("#backupStatus").textContent = `복구 완료: ${latest.name}`;
      toast(`복구 완료 (백업 파일: ${latest.name})`, "success");
      renderSettings();
    } catch (err) {
      toast("복구에 실패했습니다: " + (err && err.message ? err.message : "알 수 없는 오류"), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });

  $("#btnAuthLogout").addEventListener("click", () => {
    Auth.logout();
    $("#loginUsername").value = "";
    $("#loginPassword").value = "";
    $("#loginGate").classList.remove("hidden");
    showScreen("screen-home");
    toast("로그아웃되었습니다.");
  });

  $("#btnSaveCompany").addEventListener("click", async () => {
    const name = $("#companyName").value.trim() || DEFAULT_COMPANY.name;
    const address = $("#companyAddress").value.trim() || DEFAULT_COMPANY.address;
    const phone = $("#companyPhone").value.trim();
    const ceo = $("#companyCeo").value.trim();
    const bizRegNo = $("#companyBizRegNo").value.trim();
    await saveCompanyProfile({ name, address, phone, ceo, bizRegNo });
    toast("업체 정보가 저장되었습니다. (다른 사람에게도 바로 적용됩니다)");
  });

  // ================= 초기화 =================
  // 지적사항 "설비" 입력칸의 자동완성 후보 (소방시설 표준 분류) - 체크리스트 기능과는 무관하게 유지.
  const DEFICIENCY_CATEGORY_SUGGESTIONS = ["소화설비", "경보설비", "피난구조설비", "소화용수설비", "소화활동설비", "전기 및 기타"];

  function bootApp() {
    $("#bootLoading").classList.add("hidden");
    showScreen("screen-home");
    $("#categoryList").innerHTML = DEFICIENCY_CATEGORY_SUGGESTIONS.map((c) => `<option value="${escapeHtml(c)}">`).join("");
    $("#appVersionTag").textContent = typeof APP_VERSION !== "undefined" ? "v" + APP_VERSION : "";
  }

  // 이제 모든 자료(거래처·점검기록·지적사항·스케줄)가 로그인한 사람만 읽고 쓸 수 있는 공용
  // 온라인 저장소(Firebase)에 있어서, 예전과 달리 사무실 Wi-Fi/로컬에서도 로그인이 항상 필요하다.
  async function attemptLogin() {
    const username = $("#loginUsername").value.trim();
    const password = $("#loginPassword").value;
    $("#btnLogin").disabled = true;
    const ok = await Auth.tryLogin(username, password);
    $("#btnLogin").disabled = false;
    if (ok) {
      $("#loginError").classList.add("hidden");
      $("#loginGate").classList.add("hidden");
      bootApp();
    } else {
      $("#loginError").classList.remove("hidden");
      $("#loginPassword").value = "";
      $("#loginPassword").focus();
    }
  }
  $("#btnLogin").addEventListener("click", attemptLogin);
  $("#loginUsername").addEventListener("keydown", (e) => { if (e.key === "Enter") attemptLogin(); });
  $("#loginPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") attemptLogin(); });

  // Auth.onReady() 자체가 (알 수 없는 이유로) 끝없이 멈출 가능성까지 대비해, 20초 안에 응답이
  // 없으면 로그인 화면으로 강제 전환한다 - "로딩 중" 표시만 영원히 뜨는 상황을 막기 위함.
  const authReadyWithTimeout = Promise.race([
    Auth.onReady(),
    new Promise((resolve) => setTimeout(() => resolve(false), 20000)),
  ]);
  authReadyWithTimeout.then((loggedIn) => {
    if (loggedIn) {
      bootApp();
    } else {
      $("#bootLoading").classList.add("hidden");
      $("#loginGate").classList.remove("hidden");
      $("#loginUsername").focus();
    }
  }).catch(() => {
    $("#bootLoading").classList.add("hidden");
    $("#loginGate").classList.remove("hidden");
    $("#loginUsername").focus();
  });
})();
