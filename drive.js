// 구글 드라이브 자동 저장 - 업로드/생성되는 파일을 사장님의 구글 드라이브 한 곳으로 자동 백업.
// 방문자 개인 로그인 없이, 전용 Cloudflare Worker(fire-inspection-drive-proxy)가 사장님 계정의
// refresh token으로 Drive API를 대신 호출한다. 이 파일은 그 Worker에 파일을 POST하기만 하면 된다.
(function (global) {
  "use strict";

  const PROXY_URL = "https://fire-inspection-drive-proxy.cigar-log-gemini-proxy.workers.dev";
  const APP_SECRET = "jeeun-fire-9417";
  const ENABLED_KEY = "fireinspect_drive_backup_enabled";

  function isEnabled() {
    const v = localStorage.getItem(ENABLED_KEY);
    return v === null ? true : v === "1";
  }

  function setEnabled(v) {
    localStorage.setItem(ENABLED_KEY, v ? "1" : "0");
  }

  function sanitizeName(name) {
    return String(name || "제목없음").replace(/[\\/:*?"<>|]/g, "_").trim() || "제목없음";
  }

  // 항상 non-throwing: 꺼져 있거나 네트워크 실패해도 앱의 로컬 저장/기존 흐름을 절대 막지 않는다.
  async function uploadToSite(siteName, category, filename, blob) {
    if (!blob || !isEnabled()) return null;
    try {
      const form = new FormData();
      form.append("siteName", sanitizeName(siteName || "미지정 현장"));
      form.append("category", category);
      form.append("filename", sanitizeName(filename));
      form.append("file", blob);
      const res = await fetch(PROXY_URL, {
        method: "POST",
        headers: { "x-app-secret": APP_SECRET },
        body: form,
      });
      if (!res.ok) throw new Error("drive_proxy_failed_" + res.status);
      return await res.json();
    } catch (err) {
      console.warn("[DriveBackup] upload failed:", err);
      return null;
    }
  }

  // 목록/다운로드 조회는 업로드와 달리 실패를 사용자에게 보여줘야 하는 화면(보고서 모아보기,
  // 자료 백업/복구)에서 쓰이므로 uploadToSite와 달리 그대로 throw한다(호출부에서 toast 처리).
  async function listReports() {
    const res = await fetch(`${PROXY_URL}?action=list-reports`, {
      headers: { "x-app-secret": APP_SECRET },
    });
    if (!res.ok) throw new Error("list_reports_failed_" + res.status);
    const data = await res.json();
    return data.files || [];
  }

  async function listBackups() {
    const res = await fetch(`${PROXY_URL}?action=list-backups`, {
      headers: { "x-app-secret": APP_SECRET },
    });
    if (!res.ok) throw new Error("list_backups_failed_" + res.status);
    const data = await res.json();
    return data.files || [];
  }

  async function downloadFile(fileId) {
    const res = await fetch(`${PROXY_URL}?action=download&id=${encodeURIComponent(fileId)}`, {
      headers: { "x-app-secret": APP_SECRET },
    });
    if (!res.ok) throw new Error("download_failed_" + res.status);
    return res.blob();
  }

  // 백업 zip 업로드도 uploadToSite와 같은 프록시/폴더 구조를 그대로 재사용한다 -
  // 조은소방_자동저장/_백업/백업/<날짜>.zip (siteName에 특수 폴더명을 써서 현장 목록과 섞이지 않게 함).
  async function uploadBackup(filename, blob) {
    const form = new FormData();
    form.append("siteName", "_백업");
    form.append("category", "백업");
    form.append("filename", filename);
    form.append("file", blob);
    const res = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "x-app-secret": APP_SECRET },
      body: form,
    });
    if (!res.ok) throw new Error("backup_upload_failed_" + res.status);
    return res.json();
  }

  // 사진/첨부파일은 기기별 IndexedDB에만 저장된다 - 다른 기기(예: 휴대폰으로 찍은 사진)에서 올린
  // 사진은 이 기기 로컬에는 원본이 없다. uploadToSite가 저장할 때 쓰는 것과 똑같은 경로 규칙
  // (siteName/category/filename)으로 이미 백업된 사본을 찾아 돌려준다 - 없으면(그 사진이 애초에
  // 백업도 안 됐던 경우) null, 네트워크 실패 등은 조용히 무시(항상 non-throwing, 호출부가 그냥
  // "로컬에도 없고 드라이브에도 없음"으로 처리하면 됨 - 기존 "사진 없음" 표시와 동일).
  async function fetchFile(siteName, category, filename) {
    try {
      const params = new URLSearchParams({
        action: "fetch-file",
        siteName: sanitizeName(siteName || "미지정 현장"),
        category,
        filename: sanitizeName(filename),
      });
      const res = await fetch(`${PROXY_URL}?${params.toString()}`, {
        headers: { "x-app-secret": APP_SECRET },
      });
      if (!res.ok) return null;
      return await res.blob();
    } catch (err) {
      console.warn("[DriveBackup] fetchFile failed:", err);
      return null;
    }
  }

  global.DriveBackup = {
    isEnabled,
    setEnabled,
    uploadToSite,
    listReports,
    listBackups,
    downloadFile,
    uploadBackup,
    fetchFile,
  };
})(window);
