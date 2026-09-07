// 커스텀 토스트 / 확인 모달 (native alert/confirm 대체)
function toast(message, type) {
  const container = document.getElementById("toastContainer");
  const el = document.createElement("div");
  el.className = "toast" + (type === "error" ? " toast-error" : "");
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 2800);
}

function confirmDialog(message) {
  const modal = document.getElementById("confirmModal");
  const msgEl = document.getElementById("confirmMessage");
  const okBtn = document.getElementById("confirmOkBtn");
  const cancelBtn = document.getElementById("confirmCancelBtn");
  msgEl.textContent = message;
  modal.classList.remove("hidden");
  return new Promise((resolve) => {
    function cleanup(result) {
      modal.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
  });
}

// 자료 불러오기(AI 분석/OCR/파일 파싱) 동안 보여주는 진행률 로딩 화면.
// 실제 진행률을 알 수 없는 작업(AI 분석, 엑셀/워드/PDF 파싱 등)은 startSimulated()로 서서히 채워지는 척하다가
// hide()에서 100%로 스냅한다. 사진 OCR처럼 실제 진행률(Tesseract logger)이 있으면 setProgress()로 그 값을 그대로 반영 -
// 이후엔 simPercent도 그 값으로 맞춰서 시뮬레이션이 뒤로 되돌아가거나 다시 앞지르지 않도록 한다.
const ImportLoading = (() => {
  let simTimer = null;
  let simPercent = 0;
  const overlay = () => document.getElementById("importLoadingOverlay");
  const fill = () => document.getElementById("importLoadingBarFill");
  const percentEl = () => document.getElementById("importLoadingPercent");
  const textEl = () => document.getElementById("importLoadingText");

  function show(message) {
    simPercent = 0;
    clearInterval(simTimer);
    simTimer = null;
    if (textEl()) textEl().innerHTML = (message || "자료를 분석하고 있습니다.") + "<br>잠시만 기다려주세요.";
    if (fill()) fill().style.width = "0%";
    if (percentEl()) percentEl().textContent = "0%";
    if (overlay()) overlay().classList.remove("hidden");
  }

  function startSimulated() {
    clearInterval(simTimer);
    simTimer = setInterval(() => {
      simPercent = Math.min(simPercent + (90 - simPercent) * 0.06 + 0.4, 90);
      renderProgress(simPercent);
    }, 200);
  }

  function renderProgress(percent) {
    const p = Math.max(0, Math.min(100, Math.round(percent)));
    if (fill()) fill().style.width = p + "%";
    if (percentEl()) percentEl().textContent = p + "%";
  }

  function setProgress(percent, statusText) {
    simPercent = Math.max(simPercent, percent); // 시뮬레이션 진행률이 실제 값보다 뒤로 되돌아가지 않게
    renderProgress(percent);
    if (statusText && textEl()) textEl().innerHTML = statusText + "<br>잠시만 기다려주세요.";
  }

  // setProgress와 달리 진행률(퍼센트)은 그대로 두고 문구만 바꾼다 - AI 1차 분석 -> 2차 검수처럼
  // 실제 진행률을 모르는 단계가 이어질 때, 진행 중이던 시뮬레이션 바를 뒤로 되돌리지 않기 위함.
  function setStatusText(statusText) {
    if (statusText && textEl()) textEl().innerHTML = statusText + "<br>잠시만 기다려주세요.";
  }

  function hide() {
    clearInterval(simTimer);
    simTimer = null;
    renderProgress(100);
    setTimeout(() => { if (overlay()) overlay().classList.add("hidden"); }, 150);
  }

  return { show, startSimulated, setProgress, setStatusText, hide };
})();

// 날짜(YYYY-MM-DD) 하나를 입력받는 작은 모달 - 지적사항 회차의 방문 날짜를 새로 만들거나 수정할 때 사용.
// 확인 시 입력된 날짜 문자열, 취소 시 null 반환.
function promptDate(title, defaultValue) {
  const modal = document.getElementById("roundDateModal");
  const titleEl = document.getElementById("roundDateModalTitle");
  const input = document.getElementById("roundDateInput");
  const okBtn = document.getElementById("roundDateOkBtn");
  const cancelBtn = document.getElementById("roundDateCancelBtn");
  titleEl.textContent = title;
  input.value = defaultValue || "";
  modal.classList.remove("hidden");
  input.focus();
  return new Promise((resolve) => {
    function cleanup(result) {
      modal.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    }
    function onOk() { cleanup(input.value || null); }
    function onCancel() { cleanup(null); }
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
  });
}

// "pdf" | "hwpx" | null(취소) 반환
function pickShareFormat() {
  const modal = document.getElementById("shareFormatModal");
  const pdfBtn = document.getElementById("shareFormatPdfBtn");
  const hwpxBtn = document.getElementById("shareFormatHwpxBtn");
  const cancelBtn = document.getElementById("shareFormatCancelBtn");
  modal.classList.remove("hidden");
  return new Promise((resolve) => {
    function cleanup(result) {
      modal.classList.add("hidden");
      pdfBtn.removeEventListener("click", onPdf);
      hwpxBtn.removeEventListener("click", onHwpx);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    }
    function onPdf() { cleanup("pdf"); }
    function onHwpx() { cleanup("hwpx"); }
    function onCancel() { cleanup(null); }
    pdfBtn.addEventListener("click", onPdf);
    hwpxBtn.addEventListener("click", onHwpx);
    cancelBtn.addEventListener("click", onCancel);
  });
}
