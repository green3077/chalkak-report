// 업로드 파일(PDF/엑셀/워드/한글/HWPX/사진)을 Gemini AI로 분석해 폼 입력칸에 자동으로 채워주는 모듈.
// 실제 Gemini API 키는 이 기기/앱에 전혀 없음 - [[project_cigar_log]]가 이미 사용 중인 공유 Cloudflare Worker
// 프록시(cigar-log-gemini-proxy)를 그대로 호출한다. 별도 키 입력/비밀번호 없이 항상 동작한다.
// 호출이 실패하면 호출부(app.js)가 기존 정규식 기반 파서로 자동 폴백한다.
const AiFill = (() => {
  const ENABLED_STORAGE = "fireInspectionAiEnabled";
  // 2026-08-23: Cloudflare Worker 프록시(cigar-log-gemini-proxy)의 발신 IP가 구글 Gemini API에
  // "User location is not supported"로 계속 걸려서(같은 키를 브라우저에서 직접 호출하면 항상 성공 -
  // 결제 연결 등 계정 조치로도 전혀 해결 안 됨, 원인은 Worker 자체의 IP 대역으로 확인) Vercel(Node.js
  // 런타임)로 옮김 - 로직은 100% 동일(모델 경로 그대로 전달, X-App-Secret/Origin 검사도 동일).
  const PROXY_BASE = "https://gemini-api-proxy-sooty-one.vercel.app";
  // 프록시가 요구하는 공유 시크릿 - 클라이언트 JS가 공개 배포되므로 이 값도 결국 읽을 수 있어 완벽한
  // 인증은 아니지만, workers.dev 주소를 무작위로 스캔해 오는 봇성 오남용은 이걸로 막힌다.
  const APP_SECRET = "a255ad243fa8457b822e73d365cba1e0";
  // 2026-08-21 cigar-log 쪽에서 이미 확인됨: gemini-2.5-flash/gemini-2.0-flash는 구글이 완전히
  // 폐지해 항상 404를 반환한다 - 폴백 목록에서 빼고 gemini-flash-latest로 대체.
  const GEMINI_MODELS = ["gemini-3.6-flash", "gemini-flash-latest"];
  const geminiUrl = (model) => `${PROXY_BASE}/v1beta/models/${model}:generateContent`;
  const IMAGE_MEDIA_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", bmp: "image/bmp", gif: "image/gif" };

  function isEnabled() {
    const v = localStorage.getItem(ENABLED_STORAGE);
    return v === null ? true : v === "1";
  }
  function setEnabled(on) {
    localStorage.setItem(ENABLED_STORAGE, on ? "1" : "0");
  }

  async function fileToBase64(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function decodeXmlEntities(s) {
    return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }

  // HWPX(신 한글 포맷, zip+XML)에서 본문 텍스트 추출 - Contents/section*.xml의 <hp:t> 런을 모두 이어붙임.
  async function hwpxToText(file) {
    const zip = await JSZip.loadAsync(file);
    const sectionNames = Object.keys(zip.files).filter((n) => /^Contents\/section\d+\.xml$/.test(n)).sort();
    const texts = [];
    for (const name of sectionNames) {
      const xml = await zip.file(name).async("text");
      const re = /<hp:t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/hp:t>)/g;
      let m;
      while ((m = re.exec(xml))) {
        if (m[1]) texts.push(decodeXmlEntities(m[1]));
      }
    }
    return texts.join("\n");
  }

  async function excelToText(file) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    return wb.SheetNames.map((name) => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" });
      return `[시트: ${name}]\n` + JSON.stringify(rows);
    }).join("\n\n");
  }

  async function wordToText(file) {
    const zip = await JSZip.loadAsync(file);
    const docXmlFile = zip.file("word/document.xml");
    if (!docXmlFile) return "";
    const xmlText = await docXmlFile.async("text");
    const xmlDoc = new DOMParser().parseFromString(xmlText, "application/xml");
    return Array.from(xmlDoc.getElementsByTagName("w:t")).map((t) => t.textContent).join(" ");
  }

  // 이 파일 형식을 이 함수가 다룰 수 있는지 (구 HWP 바이너리는 다루지 않음 - 호출부가 기존 폴백 경로로 넘어감).
  function isSupportedExt(ext) {
    return ["pdf", "xlsx", "xls", "docx", "hwpx"].includes(ext) || !!IMAGE_MEDIA_TYPES[ext];
  }

  // xlsx/docx/hwpx는 AI 호출 전에 미리 텍스트로 뽑아둔다 - 표/PDF/사진과 달리 이 텍스트는
  // detectSprinklerFromText로 AI 응답을 보완하는 데도 재사용된다.
  async function extractDocText(file, ext) {
    if (ext === "xlsx" || ext === "xls") return excelToText(file);
    if (ext === "docx") return wordToText(file);
    if (ext === "hwpx") return hwpxToText(file);
    return null;
  }

  async function buildParts(file, ext, instruction, docText) {
    if (ext === "pdf") {
      const data = await fileToBase64(file);
      return [{ inline_data: { mime_type: "application/pdf", data } }, { text: instruction }];
    }
    if (IMAGE_MEDIA_TYPES[ext]) {
      const data = await fileToBase64(file);
      return [{ inline_data: { mime_type: IMAGE_MEDIA_TYPES[ext], data } }, { text: instruction }];
    }
    if (!docText || !docText.trim()) return null;
    return [{ text: `${instruction}\n\n--- 문서 내용 ---\n${docText.slice(0, 60000)}` }];
  }

  // 소방시설 세부현황표 같은 문서는 "설비의 종류" 체크박스가 같은 페이지에 여러 번(가압송수장치별로)
  // 반복돼 표 구조가 사라진 평문 텍스트만 보고 훑는 AI가 스프링클러 체크 여부를 놓치는 경우가 있다.
  // "]" 바로 뒤(공백 허용)에 "스프링클러설비"가 붙어 있는 자리만 체크박스로 인정해 "간이스프링클러설비",
  // "화재조기진압용스프링클러설비", "포워터스프링클러설비" 같은 다른 설비명과는 구분한다.
  function detectSprinklerFromText(text) {
    const re = /\[([^\]]{0,4})\]\s*스프링클러설비/g;
    let m, foundAny = false, foundChecked = false;
    while ((m = re.exec(text))) {
      foundAny = true;
      if (/[√✓]/.test(m[1])) foundChecked = true;
    }
    if (!foundAny) return "";
    return foundChecked ? "예" : "아니오";
  }

  // 우리 쪽 JSON 스키마(소문자 type)를 Gemini의 responseSchema 형식(대문자 Type)으로 변환.
  function toGeminiSchema(schema) {
    if (schema.type === "object") {
      return {
        type: "OBJECT",
        properties: Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)])),
        required: schema.required
      };
    }
    if (schema.type === "array") {
      return { type: "ARRAY", items: toGeminiSchema(schema.items) };
    }
    return { type: schema.type.toUpperCase(), description: schema.description };
  }

  function friendlyError(body) {
    try {
      const j = JSON.parse(body);
      return j?.error?.message || body.slice(0, 240);
    } catch {
      return body.slice(0, 240);
    }
  }

  function extractJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start === -1 || end === -1) throw new Error("gemini_no_json");
      return JSON.parse(text.slice(start, end + 1));
    }
  }

  // 모델 하나당 응답 대기 한도 - 예전엔 타임아웃이 전혀 없어서 프록시/모델이 응답 없이 멈추면
  // 호출부의 진행률 표시가 (90%에서 멈춘 채) 끝없이 기다리는 문제가 있었다.
  const GEMINI_TIMEOUT_MS = 25000;

  async function callGemini({ system, parts, schema, maxTokens }) {
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(schema),
        temperature: 0.1,
        maxOutputTokens: maxTokens,
        // gemini-3.6-flash는 기본적으로 "생각" 단계를 거쳐 30초 이상 걸릴 수 있다 - 낮은 예산으로
        // 제한해서 예전 2.0/2.5-flash 수준의 응답 속도(1~3초)를 유지한다(0은 이 모델에서 400 에러).
        thinkingConfig: { thinkingBudget: 512 }
      }
    };
    // 모델 하나가 실패(4xx/5xx/타임아웃/빈 응답 등 사유 불문)하면 바로 다음 모델로 폴백한다 - 예전엔
    // 400/404만 재시도하고 그 외(예: 일시적 5xx)는 즉시 실패 처리해서, 첫 모델이 가끔 흔들릴 때마다
    // AI 결과 대신 정확도가 낮은 정규식 폴백으로 튀어 "불러올 때마다 결과가 다르다"는 원인이 됐다.
    let lastErr = null;
    for (const model of GEMINI_MODELS) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
      try {
        const res = await fetch(geminiUrl(model), {
          method: "POST",
          headers: { "content-type": "application/json", "x-app-secret": APP_SECRET },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          lastErr = new Error(`gemini_api_${res.status}_${model}: ${friendlyError(errText)}`);
          continue;
        }
        const data = await res.json();
        const candidate = data?.candidates?.[0];
        if (!candidate) {
          const blockReason = data?.promptFeedback?.blockReason;
          lastErr = new Error(blockReason ? `gemini_blocked_${blockReason}` : "gemini_no_candidate");
          continue;
        }
        const text = (candidate.content?.parts || []).map((p) => p.text || "").join("");
        if (!text) { lastErr = new Error("gemini_no_text"); continue; }
        return extractJson(text);
      } catch (e) {
        lastErr = e && e.name === "AbortError" ? new Error(`gemini_timeout_${model}`) : e;
      } finally {
        clearTimeout(timeoutId);
      }
    }
    throw lastErr || new Error("gemini_all_models_failed");
  }

  const CLIENT_FIELD_DESCRIPTIONS = {
    name: "거래처명(현장명, 건물명, 상호)",
    address: "소재지 주소 (도로명주소 우선)",
    contactName: "담당자/관계인 성명",
    contactPhone: "담당자/관계인 전화번호, 000-0000-0000 형식",
    fireManagerName: "소방안전관리자 성명",
    fireManagerPhone: "소방안전관리자 전화번호, 000-0000-0000 형식",
    fireManagerAppointDate: "소방안전관리자 선임일자, YYYY-MM-DD 형식",
    fireManagerEduDate: "소방안전관리자 실무교육(최근 교육이수)일자, YYYY-MM-DD 형식",
    receiverLocation: "수신기(자동화재탐지설비) 설치 위치",
    pumpRoomLocation: "펌프실(주된 수원) 설치 위치",
    area: "연면적 (숫자만, 단위 ㎡ 제외)",
    approvalDate: "건축물 사용승인일, YYYY-MM-DD 형식",
    floorInfo: "층수 정보, 예: 지상 5층 / 지하 1층",
    buildingType: "건물 용도/구분",
    sprinklerInstalled: "소화설비 점검표에서 \"스프링클러설비\" 항목 자체가 체크(대상)로 표시되어 있으면 \"예\". \"간이스프링클러설비\", \"화재조기진압용스프링클러설비\", \"포워터스프링클러설비\" 등 이름에 다른 말이 붙은 별개 설비는 체크되어 있어도 이 항목과 무관하므로 포함하지 말 것. 스프링클러설비가 없거나 미설치/해당없음으로 표시되어 있으면 \"아니오\", 문서에서 판단할 수 없으면 빈 문자열"
  };

  const CLIENT_SCHEMA = {
    type: "object",
    properties: Object.fromEntries(Object.entries(CLIENT_FIELD_DESCRIPTIONS).map(([k, desc]) => [k, { type: "string", description: desc }])),
    required: Object.keys(CLIENT_FIELD_DESCRIPTIONS)
  };

  const CLIENT_SYSTEM = "당신은 대한민국 소방점검 업체가 사용하는 업무용 앱의 문서 인식 도우미입니다. 업로드된 문서(소방시설 자체점검 결과보고서, 명함, 안내문 등)에서 요청된 항목을 정확히 추출하세요. 문서에 명시적으로 없는 정보는 절대 추측하지 말고 반드시 빈 문자열(\"\")로 남기세요. 전화번호와 날짜는 지정된 형식으로 정규화하세요. 같은 사람이 여러 역할(예: 관계인이자 소방안전관리자)을 겸하는 경우 해당하는 모든 필드에 채워주세요. 반드시 JSON으로만 응답하세요.";

  // 1차 추출 결과를 문서와 다시 대조해 틀린 값을 바로잡는 2차 "검수" 호출용 프롬프트 - 같은 프롬프트를
  // 두 번 그대로 반복하면 낮은 temperature 탓에 같은 실수를 그대로 반복하기 쉬우므로, 1차 결과를 같이
  // 보여주고 "검토해서 고치라"는 다른 역할을 줘야 실제로 정확도가 올라간다.
  const CLIENT_REVIEW_SYSTEM = "당신은 대한민국 소방점검 업체가 사용하는 업무용 앱의 문서 인식 검수 담당자입니다. 첨부된 문서에서 다른 도우미가 1차로 추출한 결과(JSON)가 아래에 있습니다. 문서 원본과 항목 하나하나를 다시 대조해서: 문서 내용과 다르게 채워진 값은 문서에 맞게 고치고, 문서에 있는데 빠진 값은 채우고, 문서에 근거 없이 채워진 값(추측)은 빈 문자열(\"\")로 비우세요. 확실하지 않으면 절대 추측하지 말고 빈 문자열로 남기세요. 전화번호와 날짜는 지정된 형식으로 정규화하세요. 최종 검수 결과만 JSON으로 응답하세요.";

  // onStatus(선택): 2차 검수 단계로 넘어갈 때 로딩 화면 문구를 바꾸기 위한 콜백.
  async function analyzeClientFile(file, onStatus) {
    const ext = file.name.split(".").pop().toLowerCase();
    if (!isSupportedExt(ext)) return { unsupported: true };
    const instruction = "이 문서에서 거래처(현장) 등록에 필요한 정보를 추출해줘.";
    const docText = await extractDocText(file, ext);
    const parts = await buildParts(file, ext, instruction, docText);
    if (!parts) return { failed: true, typeLabel: extTypeLabel(ext) };
    let fields = await callGemini({ system: CLIENT_SYSTEM, parts, schema: CLIENT_SCHEMA, maxTokens: 4096 });

    // 정확도를 높이기 위해 1차 결과를 문서와 다시 대조하는 2차 검수를 한 번 더 거친다. 검수 자체가
    // 실패해도(타임아웃/오류 등) 전체를 실패시키지 않고 1차 결과를 그대로 쓴다 - 검수는 어디까지나 보정용.
    let reviewed = false;
    try {
      if (onStatus) onStatus("AI가 결과를 한 번 더 검수하고 있습니다.");
      const reviewParts = [...parts, { text: `\n\n--- 1차 추출 결과(JSON) ---\n${JSON.stringify(fields)}` }];
      fields = await callGemini({ system: CLIENT_REVIEW_SYSTEM, parts: reviewParts, schema: CLIENT_SCHEMA, maxTokens: 4096 });
      reviewed = true;
    } catch (e) { /* 검수 실패 시 1차 결과 그대로 사용 */ }

    // AI가 스프링클러 여부를 "예"/"아니오"로 못 정했으면(체크박스 표 구조가 깨져 못 읽은 경우 등)
    // 같은 텍스트에서 체크박스를 직접 찾아 보완한다.
    if (fields.sprinklerInstalled !== "예" && fields.sprinklerInstalled !== "아니오" && docText) {
      const detected = detectSprinklerFromText(docText);
      if (detected) fields.sprinklerInstalled = detected;
    }
    const filledCount = Object.values(fields).filter((v) => v && String(v).trim()).length;
    return { fields, typeLabel: extTypeLabel(ext) + (reviewed ? " (AI 2중 검수)" : " (AI 분석)"), lowConfidence: false, failed: filledCount === 0 };
  }

  const DEFICIENCY_SCHEMA = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string", description: "설비 구분 (예: 소화설비, 경보설비, 피난구조설비 등)" },
            floor: { type: "string", description: "층" },
            location: { type: "string", description: "설치 장소" },
            code: { type: "string", description: "점검번호" },
            description: { type: "string", description: "불량내용(지적사항)" }
          },
          required: ["category", "floor", "location", "code", "description"]
        }
      }
    },
    required: ["items"]
  };

  const DEFICIENCY_SYSTEM = "당신은 대한민국 소방점검 업체가 사용하는 업무용 앱의 문서 인식 도우미입니다. 업로드된 소방시설 지적사항(불량내역) 문서에서 각 지적 항목을 표로 추출하세요. 표는 보통 '설비'(설비 구분) · '층' · '설치장소' · '점검번호' · '불량내용' 5개 열로 되어 있습니다. 반드시 지켜야 할 규칙: 1) '설비' 열은 같은 구분(경보설비, 피난구조설비, 기타 등)에 속한 여러 행이 세로로 병합(rowspan)되어 첫 행에만 글자가 보이고 나머지 행은 빈칸으로 보이는 경우가 매우 흔합니다 - 이런 병합 셀은 그 병합 범위 안의 모든 행에 같은 값을 채워 넣으세요. 2) 어떤 열의 칸이 비어 보인다고 해서 옆(오른쪽) 열의 값을 그 자리로 당겨서 채우면 절대 안 됩니다 - 설비/층/설치장소/점검번호/불량내용은 각 행마다 실제로 그 열에 적힌 값만 넣고, 열 하나가 통째로 밀리는 일이 없도록 각 행을 채운 뒤 5개 값이 원래 표의 같은 행·같은 열과 정확히 대응하는지 다시 확인하세요. 3) 하나의 지적사항이 여러 줄/셀에 걸쳐 나뉘어 있으면 하나의 항목으로 합치세요. 표 헤더나 안내문구는 항목으로 만들지 마세요. 지적사항이 없으면 빈 배열을 반환하세요. 반드시 JSON으로만 응답하세요.";

  async function analyzeDeficiencyFile(file) {
    const ext = file.name.split(".").pop().toLowerCase();
    if (!isSupportedExt(ext)) return { unsupported: true };
    const instruction = "이 문서에서 소방시설 지적사항(불량내역) 목록을 추출해줘.";
    // analyzeClientFile과 마찬가지로 xlsx/docx/hwpx는 buildParts에 docText를 넘겨야 한다 - 이걸
    // 빠뜨리면 buildParts가 항상 docText 없음으로 판단해 null을 반환하고(비-PDF/이미지 형식은 전부),
    // 여기선 조용히 rows:null로 이어져 호출부(app.js)가 "지원하지 않는 파일 형식"으로 잘못 표시한다
    // (실제 사용자 리포트, 2026-08-22 - 2026-08-19에 buildParts가 docText 인자를 받도록 바뀌면서
    // analyzeClientFile 호출부만 고쳐지고 여기는 놓친 회귀 버그).
    const docText = await extractDocText(file, ext);
    const parts = await buildParts(file, ext, instruction, docText);
    if (!parts) return { rows: null, typeLabel: extTypeLabel(ext) };
    const result = await callGemini({ system: DEFICIENCY_SYSTEM, parts, schema: DEFICIENCY_SCHEMA, maxTokens: 8000 });
    return { rows: result.items && result.items.length ? result.items : null, typeLabel: extTypeLabel(ext) + " (AI 분석)" };
  }

  function extTypeLabel(ext) {
    if (ext === "pdf") return "PDF";
    if (ext === "xlsx" || ext === "xls") return "엑셀";
    if (ext === "docx") return "워드 문서";
    if (ext === "hwpx") return "한글(HWPX)";
    if (ext === "hwp") return "한글(HWP)";
    if (IMAGE_MEDIA_TYPES[ext]) return "사진";
    return "파일";
  }

  return { isEnabled, setEnabled, isSupportedExt, analyzeClientFile, analyzeDeficiencyFile, hwpxToText };
})();
