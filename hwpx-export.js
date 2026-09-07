// 이행완료보고서 HWPX(신 한글) 파일 생성 - 실제 별지 제11호서식 샘플 파일(templates/completion-report-template.hwpx)을
// 템플릿으로 불러와 DOM으로 파싱한 뒤, 라벨 셀 옆의 값 칸을 찾아 채우고 "이행완료 보고서 증빙자료" 표는
// 실제 항목 수만큼 행을 복제한다. 템플릿에 별도로 있던 "지적내역서" 표는 이 증빙자료 표와 내용이
// 중복돼서 통째로 삭제한다(removeDeficiencyListTable, 사용자 요청 2026-08-21).
// 사진은 hp:pic(그림) 개체로 BinData에 임베드한다 - hp:pic의 정확한 구조는 실제 한글 프로그램의 COM
// 자동화(HWPFrame.HwpObject)로 그림 삽입한 문서를 직접 저장해 나온 XML을 그대로 참고해 맞췄다
// (2026-08-12; 스펙만 보고 손으로 만들었던 이전 버전은 hc:img를 hp:img로 잘못 쓰고 hp:sz/hp:pos/hp:outMargin
// 등 필수 요소가 빠져 있어서 실제 한글에서 파일 자체를 열지 못하는 문제가 있었다).
const HwpxExport = (() => {
  const HP = "http://www.hancom.co.kr/hwpml/2011/paragraph";
  const HC = "http://www.hancom.co.kr/hwpml/2011/core";
  const HH = "http://www.hancom.co.kr/hwpml/2011/head";
  const OPF = "http://www.idpf.org/2007/opf/";
  const TEMPLATE_URL = "templates/completion-report-template.hwpx";

  function el(doc, name, attrs) {
    const e = doc.createElementNS(HP, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function hcEl(doc, name, attrs) {
    const e = doc.createElementNS(HC, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function hhEl(doc, name, attrs) {
    const e = doc.createElementNS(HH, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function getTexts(doc) {
    return Array.from(doc.getElementsByTagNameNS(HP, "t"));
  }

  // "대상물 명칭(상호)"/"업체명(상호)" 등은 실제 템플릿에 값 전용 칸이 따로 없다 - 라벨 칸(hp:tc) 자체가
  // 그 행의 나머지 폭을 차지하는 구조라, "관계인"/"소방안전관리자" 칸이 이미 쓰고 있는 것과 같은 방식으로
  // 라벨 문단 밑에 값 문단을 새로 이어붙인다(옆 칸이 아니라 라벨 밑에 값이 오도록).
  function appendValueLineInLabelCell(doc, labelText, value, occurrence) {
    const tcs = Array.from(doc.getElementsByTagNameNS(HP, "tc"));
    let count = 0;
    for (const tc of tcs) {
      const ps = tc.getElementsByTagNameNS(HP, "p");
      // 셀 전체가 아니라 첫 문단(라벨 줄)만 비교한다 - 같은 라벨이 여러 번 나오는 "소재지" 같은 경우,
      // 앞서 occurrence 0을 처리하며 값 줄을 이어붙이고 나면 셀 전체 텍스트는 더 이상 라벨과 같지 않아서
      // 이후 occurrence를 셀 전체 텍스트로 찾으면 순서가 어긋난다.
      const firstPText = ps.length ? Array.from(ps[0].getElementsByTagNameNS(HP, "t")).map((t) => t.textContent).join("").trim() : "";
      if (firstPText === labelText) {
        if (count === (occurrence || 0)) {
          const labelP = ps[0];
          const newP = labelP.cloneNode(true);
          const t = newP.getElementsByTagNameNS(HP, "t")[0];
          if (t) t.textContent = value;
          const lineseg = newP.getElementsByTagNameNS(HP, "lineseg")[0];
          if (lineseg) lineseg.setAttribute("vertpos", String(1600 * ps.length));
          tc.getElementsByTagNameNS(HP, "subList")[0].appendChild(newP);
          // cellSz의 height는 한글이 실제 내용에 맞춰 다시 계산하는 값이라 손대지 않는다 - 예전에 여기서
          // 미리 높이를 부풀렸더니(+3009) 실제 한글에서 줄 밑에 불필요한 빈 여백이 남는 문제가 있었다.
          return true;
        }
        count++;
      }
    }
    return false;
  }

  // 텍스트 노드(hp:t)의 내용이 조건에 맞는 것을 찾아 콜백으로 치환 - occurrence번째(0-base) 일치 항목만 처리.
  function replaceNthMatchingText(doc, predicate, occurrence, replacer) {
    const ts = getTexts(doc);
    let count = 0;
    for (const t of ts) {
      if (predicate(t.textContent)) {
        if (count === occurrence) {
          t.textContent = replacer(t.textContent);
          return true;
        }
        count++;
      }
    }
    return false;
  }

  // "성명:" / "소재지"처럼 라벨만 있는 run 바로 뒤에 값 run을 복제해서 삽입 (occurrence번째 일치) -
  // 라벨과 값이 같은 줄에 붙는다. 값이 길어질 수 있는 칸(전화번호 등)은 insertValueAsNewLineAfterLabel을 쓴다.
  function insertValueAfterLabelRun(doc, labelText, value, occurrence) {
    const ts = getTexts(doc);
    let count = 0;
    for (const t of ts) {
      if (t.textContent.trim() === labelText) {
        if (count === (occurrence || 0)) {
          const run = t.parentNode;
          const newRun = run.cloneNode(true);
          newRun.getElementsByTagNameNS(HP, "t")[0].textContent = "   " + value;
          run.parentNode.insertBefore(newRun, run.nextSibling);
          return true;
        }
        count++;
      }
    }
    return false;
  }

  // "소방안전관리자" 칸의 "전화번호:" 줄은 폭이 좁아(약 35mm) 값이 길면(특히 "010-1234-5678" 같은
  // 13자) 라벨 뒤에 같은 줄로 이어붙이면 한 줄에 다 안 들어가고 중간에서 줄바꿈돼 버린다(사용자 리포트,
  // 2026-08-29). 글자 크기를 줄이거나(사용자가 "10pt 돋움체 유지"를 요청) 칸 폭을 넓히면(이 칸은 다른
  // 여러 행 - 대상물 구분(용도), 이행조치 일자 등 - 과 같은 열 폭을 공유하고 있어 표 전체 세로선이
  // 어긋날 위험) 둘 다 부작용이 있어서, 대신 라벨 문단 자체는 그대로 두고 값을 라벨 "밑의 새 줄"로
  // 넣는다 - 원본 폰트/크기 그대로 각 줄이 짧아지므로 줄바꿈 걱정 없이 항상 한 줄에 들어간다.
  function insertValueAsNewLineAfterLabel(doc, labelText, value, occurrence) {
    const paras = Array.from(doc.getElementsByTagNameNS(HP, "p"));
    let count = 0;
    for (const p of paras) {
      const text = Array.from(p.getElementsByTagNameNS(HP, "t")).map((t) => t.textContent).join("").trim();
      if (text === labelText) {
        if (count === (occurrence || 0)) {
          const newP = p.cloneNode(true);
          newP.getElementsByTagNameNS(HP, "t")[0].textContent = value;
          const origLineseg = p.getElementsByTagNameNS(HP, "lineseg")[0];
          const newLineseg = newP.getElementsByTagNameNS(HP, "lineseg")[0];
          if (origLineseg && newLineseg) {
            newLineseg.setAttribute("vertpos", String(parseInt(origLineseg.getAttribute("vertpos"), 10) + 1600));
          }
          p.parentNode.insertBefore(newP, p.nextSibling);
          return true;
        }
        count++;
      }
    }
    return false;
  }

  // 표지의 "성명:"/"전화번호:"/"소재지" 같은 라벨 한 줄짜리 문단들(paraPr id=49)이 양쪽정렬(JUSTIFY)로
  // 돼 있어서, 라벨 뒤에 짧은 값만 붙으면 한글이 그 사이 공백을 셀 너비 끝까지 늘려버려 "성명:   홍길동"
  // 사이가 비정상적으로 크게 벌어져 보였다(실사용자가 겪은 문제 - 소방안전관리자 성명/전화번호란).
  // 양쪽정렬은 여러 줄짜리 본문에나 어울리지 이런 한 줄짜리 라벨:값 칸에는 안 맞으므로 왼쪽 정렬로
  // 바꾼다. id=49는 표지 칸 라벨들 전용 스타일이라(본문 문단은 다른 paraPr를 씀) 안전하게 통째로 바꿀 수 있다.
  function fixLabelLineAlignment(headerDoc) {
    const paraPr49 = Array.from(headerDoc.getElementsByTagNameNS(HH, "paraPr")).find((p) => p.getAttribute("id") === "49");
    const align = paraPr49 && paraPr49.getElementsByTagNameNS(HH, "align")[0];
    if (align) align.setAttribute("horizontal", "LEFT");
  }

  // 첨부 페이지의 "지적내역서 (대상물: ...)" 표를 통째로 삭제 - 사진이 들어가는 "이행완료 보고서
  // 증빙자료" 표(fillDeficiencyTable이 채우는 표)와 내용이 중복돼서 필요 없다는 사용자 요청(2026-08-21).
  // 표는 hp:tbl -> hp:run -> hp:p 순으로 감싸여 있으므로, 표만 떼어내면 빈 문단 한 줄이 그 자리에
  // 남는다 - 표 전체가 들어있는 문단(hp:p)째로 지워야 흔적 없이 사라진다.
  function removeDeficiencyListTable(doc) {
    const tbls = Array.from(doc.getElementsByTagNameNS(HP, "tbl"));
    for (const tbl of tbls) {
      const firstText = tbl.getElementsByTagNameNS(HP, "t")[0];
      if (firstText && firstText.textContent.includes("지적내역서")) {
        let node = tbl;
        while (node && node.localName !== "p") node = node.parentNode;
        if (node && node.parentNode) {
          const parent = node.parentNode;
          const nextP = node.nextSibling;
          parent.removeChild(node);
          // 원본 템플릿은 "지적내역서" 표와 다음 "이행완료 보고서 증빙자료" 표 사이에 시각적 여백을
          // 두려고 내용 없는 빈 문단(hp:p) 한 줄을 넣어뒀다 - 위에서 표 문단만 지우면 이 빈 줄이 그대로
          // 남아 다음 표 바로 위, 즉 그 표가 시작되는 페이지 맨 윗줄에 불필요한 빈 줄로 보인다(사용자
          // 리포트: "두번째 페이지 맨윗줄에 한 줄이 띄워진다", 2026-08-22). 표를 감쌌던 문단과 함께
          // 이 빈 줄도 지운다 - 다른 표를 담고 있거나 실제 텍스트가 있는 문단이면 안전하게 건드리지 않는다.
          if (nextP && nextP.localName === "p" && !nextP.getElementsByTagNameNS(HP, "tbl").length) {
            const hasText = Array.from(nextP.getElementsByTagNameNS(HP, "t")).some((t) => t.textContent.trim().length > 0);
            if (!hasText) parent.removeChild(nextP);
          }
        }
        return;
      }
    }
  }

  function fillCoverPage(doc, data) {
    appendValueLineInLabelCell(doc, "대상물 명칭(상호)", data.siteName, 0);
    appendValueLineInLabelCell(doc, "대상물 구분(용도)", data.siteType || "", 0);
    appendValueLineInLabelCell(doc, "업체명(상호)", data.company.name || "", 0);
    appendValueLineInLabelCell(doc, "사업자번호", data.company.bizRegNo || "", 0);
    // "소재지"도 라벨 셀 하나가 행 전체(colSpan=4)를 차지하는 구조라 별도 값 칸이 없음 - 위 필드들과 마찬가지로
    // 옆이 아니라 라벨 밑에 새 줄로 값이 오도록 한다.
    appendValueLineInLabelCell(doc, "소재지", data.siteAddr, 0);
    appendValueLineInLabelCell(doc, "소재지", data.company.address || "", 1);

    // 관계인 / 대표이사 - "(성명:               전화번호:           )" 형태의 한 run 안에 값 삽입 (등장 순서: 관계인 -> 대표이사)
    // 치환 후에도 문자열이 여전히 패턴에 매칭되므로(괄호로 시작, 성명:/전화번호: 포함) occurrence를 0, 1로 명시해야 관계인/대표이사 줄이 서로 안 뒤섞인다.
    const combinedPattern = (s) => s.includes("성명:") && s.includes("전화번호:") && s.trim().startsWith("(");
    replaceNthMatchingText(doc, combinedPattern, 0, () => `(성명: ${data.contactName || "-"}    전화번호: ${data.contactPhone || "-"})`);
    replaceNthMatchingText(doc, combinedPattern, 1, () => `(성명: ${data.company.ceo || "-"}    전화번호: ${data.company.phone || "-"})`);

    // 소방안전관리자 성명/전화번호 - "성명:"은 라벨과 같은 줄에 값을 붙이고(이름은 짧아 줄바꿈될
    // 일이 없음), "전화번호:"는 값을 라벨 밑의 새 줄에 넣는다(10pt 돋움체 그대로 유지하면서 긴
    // 전화번호도 항상 한 줄에 들어가게 하려고 - 사용자 요청, 2026-08-29).
    insertValueAfterLabelRun(doc, "성명:", data.managerName || "-", 0);
    insertValueAsNewLineAfterLabel(doc, "전화번호:", data.managerPhone || "-", 0);

    // 이행조치 일자 - 첫 번째 ". . . ~ . . ." 자리만 실제 날짜로 교체
    replaceNthMatchingText(doc, (s) => /^[.\s∼~]+$/.test(s) && s.includes("."), 0, () => data.dateRange || "");

    // 년/월/일 서명일자(제출 날짜) 줄은 실제 제출 시점에 손으로 적도록 공란으로 남겨둔다(자동 채움 없음).

    // 관계인: (서명란) - "관계인:" 뒤에 공백으로 채워진 유일한 줄
    replaceNthMatchingText(doc, (s) => s.includes("관계인:") && s.trim().length > "관계인:".length, 0, (orig) =>
      orig.replace("관계인:", `관계인: ${data.contactName || ""}`)
    );

    // "○○ 소방본부장ㆍ소방서장 귀하" - 실제 관할소방서 이름을 알면 그것으로 교체 ("귀하"는 별도 run이라 손대지 않음).
    if (data.fireStation) {
      replaceNthMatchingText(doc, (s) => s.includes("소방본부장"), 0, () => `   ${data.fireStation}장 `);
    }
  }

  // 문단(hp:p)의 텍스트를 clear하고 새 텍스트로 교체 (하나의 run만 남김) - 여러 줄이 필요하면 caller가 문단을 복제해서 사용.
  function setParagraphText(p, text, charPrIDRef) {
    const doc = p.ownerDocument;
    Array.from(p.getElementsByTagNameNS(HP, "run")).forEach((r) => r.remove());
    Array.from(p.getElementsByTagNameNS(HP, "linesegarray")).forEach((r) => r.remove());
    const run = el(doc, "hp:run", { charPrIDRef: charPrIDRef || "47" });
    const t = el(doc, "hp:t", {});
    t.textContent = text;
    run.appendChild(t);
    p.appendChild(run);
  }

  // lines의 각 항목은 문자열(기본 charPrIDRef로 표시)이거나 { text, charPrIDRef } 객체(그 줄만 다른
  // 스타일, 예: 굵게)일 수 있다.
  function clearCellAndSetLines(tc, lines, charPrIDRef) {
    const doc = tc.ownerDocument;
    const subList = tc.getElementsByTagNameNS(HP, "subList")[0];
    const paras = Array.from(subList.getElementsByTagNameNS(HP, "p"));
    const templatePara = paras[0];
    paras.forEach((p) => p.remove());
    lines.forEach((line, i) => {
      const p = templatePara.cloneNode(true);
      const isObj = line && typeof line === "object";
      setParagraphText(p, isObj ? line.text : line, (isObj && line.charPrIDRef) || charPrIDRef);
      subList.appendChild(p);
    });
  }

  // hp:pic(그림 개체) 요소 - HWPFrame.HwpObject COM 자동화로 실제 한글이 그림을 삽입한 문서를 저장해
  // 얻은 진짜 예제 XML을 그대로 본떠 만들었다(요소 순서/네임스페이스가 실제와 정확히 일치해야 한글이 연다).
  //
  // hwpWidth/hwpHeight: 화면/표 칸에 실제로 그려질 "표시 크기"(HWPUNIT 단위).
  // pixelWidth/pixelHeight: 실제로 저장한 이미지 파일 자체의 픽셀 크기.
  //
  // 2026-08-19/21 세션에서는 이 함수를 COM 자동화로 실제 한글(Hwp.exe) PDF 렌더링 결과를 재보며
  // "orgSz=픽셀값, curSz=표시크기"로 튜닝했었는데, 2026-08-27에 사용자가 "한글 2020에서는 사진이 매우
  // 확대되어 보인다"고 리포트 - 그 튜닝이 당시 테스트에 쓰인 한글 버전(2022로 추정)에서만 우연히 맞는
  // 값이었을 가능성이 있어, 이번엔 추측 대신 실제 한글이 저장한 hwpx 원본 파일을 직접 뜯어봤다(오픈소스
  // hwpxlib 프로젝트의 테스트 fixture, 544x184px짜리 google.jpg를 넣은 진짜 예제). 아래가 그 구조 -
  // buildPicElement 안의 상세 주석 참고.
  function buildPicElement(doc, binaryId, hwpWidth, hwpHeight, pixelWidth, pixelHeight) {
    const picId = String(1000000000 + Math.floor(Math.random() * 900000000));
    const pic = el(doc, "hp:pic", {
      id: picId,
      zOrder: "0",
      numberingType: "PICTURE",
      textWrap: "TOP_AND_BOTTOM",
      textFlow: "BOTH_SIDES",
      lock: "0",
      dropcapstyle: "None",
      href: "",
      groupLevel: "0",
      instid: String(1000000000 + Math.floor(Math.random() * 900000000)),
      reverse: "0"
    });
    // hp:orgSz/hp:imgDim 단위를 진짜 한글이 저장한 hwpx 원본 파일(오픈소스 hwpxlib의 테스트 fixture,
    // 544x184px짜리 google.jpg를 넣은 실제 예제)을 직접 뜯어보고 정정했다(2026-08-27, 한글 2020에서
    // "사진이 매우 확대되어 보임" 리포트로 조사) - 그 예제에서 hp:orgSz(17664x5975)와 hp:curSz(25942x8775)는
    // 둘 다 HWPUNIT 물리 크기이고 그 비율(25942/17664=1.4686...)이 renderingInfo의 scaMatrix 값과 정확히
    // 일치했다 - 즉 orgSz는 "삽입 당시 크기"(리사이즈 이력의 기준점)일 뿐 픽셀 수가 절대 아니다. 반면
    // hp:imgDim(40800x13800)/hp:imgClip은 원본 픽셀(544x184)에 정확히 75를 곱한 값(40800/544=75.0,
    // 13800/184=75.0) - 75 = 7200(HWPUNIT/inch) ÷ 96(한글이 래스터 이미지에 항상 가정하는 dpi) 이다.
    // 예전 코드는 이 두 단위(HWPUNIT 물리크기 vs "96dpi 가정 픽셀환산값")를 혼동해서 orgSz/imgRect에
    // 그냥 픽셀 개수를 그대로 넣고 있었다 - 한글 2022는 이 값을 관대하게 재해석해서 우연히 정상 표시됐지만,
    // 2020은 그 값을 곧이곧대로 써서 그림이 크게 부풀려 보이는 문제("확대")가 있었던 것으로 보인다.
    // 여기서는 리사이즈 없이 딱 표시 크기 그대로 삽입되는 경우이므로 orgSz=curSz(비율 1, scaMatrix 항등)로 둔다.
    const PIXEL_TO_HWPUNIT_96DPI = 75; // 7200 / 96
    const dimWidth = Math.round(pixelWidth * PIXEL_TO_HWPUNIT_96DPI);
    const dimHeight = Math.round(pixelHeight * PIXEL_TO_HWPUNIT_96DPI);
    pic.appendChild(el(doc, "hp:offset", { x: "0", y: "0" }));
    pic.appendChild(el(doc, "hp:orgSz", { width: String(hwpWidth), height: String(hwpHeight) }));
    pic.appendChild(el(doc, "hp:curSz", { width: String(hwpWidth), height: String(hwpHeight) }));
    pic.appendChild(el(doc, "hp:flip", { horizontal: "0", vertical: "0" }));
    pic.appendChild(
      el(doc, "hp:rotationInfo", { angle: "0", centerX: String(Math.round(hwpWidth / 2)), centerY: String(Math.round(hwpHeight / 2)), rotateimage: "1" })
    );
    const ri = el(doc, "hp:renderingInfo", {});
    ri.appendChild(hcEl(doc, "hc:transMatrix", { e1: "1", e2: "0", e3: "0", e4: "0", e5: "1", e6: "0" }));
    ri.appendChild(hcEl(doc, "hc:scaMatrix", { e1: "1", e2: "0", e3: "0", e4: "0", e5: "1", e6: "0" }));
    ri.appendChild(hcEl(doc, "hc:rotMatrix", { e1: "1", e2: "0", e3: "0", e4: "0", e5: "1", e6: "0" }));
    pic.appendChild(ri);
    // 실제 예제에서 그림 데이터 참조는 hp:img가 아니라 hc:img(core 네임스페이스)이다.
    pic.appendChild(hcEl(doc, "hc:img", { binaryItemIDRef: binaryId, bright: "0", contrast: "0", effect: "REAL_PIC", alpha: "0" }));
    // hp:imgRect는 orgSz와 같은 좌표계(HWPUNIT 물리크기) - 크롭 없이 이미지 전체를 보여주므로 (0,0)~(orgSz).
    const imgRect = el(doc, "hp:imgRect", {});
    imgRect.appendChild(hcEl(doc, "hc:pt0", { x: "0", y: "0" }));
    imgRect.appendChild(hcEl(doc, "hc:pt1", { x: String(hwpWidth), y: "0" }));
    imgRect.appendChild(hcEl(doc, "hc:pt2", { x: String(hwpWidth), y: String(hwpHeight) }));
    imgRect.appendChild(hcEl(doc, "hc:pt3", { x: "0", y: String(hwpHeight) }));
    pic.appendChild(imgRect);
    // hp:imgClip은 imgDim과 같은 좌표계(96dpi 환산 픽셀값) - 크롭 없이 전체를 보여주므로 (0,0)~(imgDim).
    pic.appendChild(el(doc, "hp:imgClip", { left: "0", right: String(dimWidth), top: "0", bottom: String(dimHeight) }));
    pic.appendChild(el(doc, "hp:inMargin", { left: "0", right: "0", top: "0", bottom: "0" }));
    pic.appendChild(el(doc, "hp:imgDim", { dimwidth: String(dimWidth), dimheight: String(dimHeight) }));
    pic.appendChild(el(doc, "hp:effects", {}));
    pic.appendChild(el(doc, "hp:sz", { width: String(hwpWidth), widthRelTo: "ABSOLUTE", height: String(hwpHeight), heightRelTo: "ABSOLUTE", protect: "0" }));
    // treatAsChar="1": 텍스트 흐름에 얹혀 셀 안에 들어가는 인라인 그림(표 밖으로 떠다니지 않음) - 실제 예제와 동일.
    pic.appendChild(el(doc, "hp:pos", {
      treatAsChar: "1", affectLSpacing: "0", flowWithText: "1", allowOverlap: "0", holdAnchorAndSO: "0",
      vertRelTo: "PARA", horzRelTo: "COLUMN", vertAlign: "TOP", horzAlign: "LEFT", vertOffset: "0", horzOffset: "0"
    }));
    pic.appendChild(el(doc, "hp:outMargin", { left: "0", right: "0", top: "0", bottom: "0" }));
    return pic;
  }

  // 사진 파일을 <img>로 디코딩만 한다(아직 캔버스에 그리지 않음) - 원본 크기(naturalWidth/Height)를
  // 먼저 알아야 표 칸에 맞춘 목표 표시 크기(hwpWidth/hwpHeight, setCellPhoto가 계산)를 구할 수 있고,
  // 그 목표 크기를 알아야 아래 encodeImageToJpeg에 넘길 "실제로 그릴 픽셀 수"를 정할 수 있어서
  // 디코딩과 인코딩을 두 단계로 분리했다.
  function decodeImagePhoto(blob) {
    const url = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ image, url, width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image_decode_failed")); };
      image.src = url;
    });
  }

  // 디코딩된 이미지를 targetWidth x targetHeight 픽셀로 캔버스에 다시 그려 JPEG로 인코딩한다. 카메라
  // 사진은 원본 바이트가 항상 "가로"로 저장되고 EXIF Orientation 태그로 실제 회전을 표시하는 경우가
  // 많은데, 브라우저의 <img>는 이를 반영해 정방향으로 그려주는 반면 한글(HWPX)은 이 태그를 무시하고
  // 원본 바이트를 그대로 표시해 일부 사진이 90도 돌아간 채 들어가는 원인이 된다. 화면에 보이는
  // 그대로(회전 반영 완료) 새로 인코딩해 내보내면 뷰어가 EXIF를 읽든 안 읽든 항상 올바른 방향으로 보인다.
  //
  // 예전에는 셀 비율에 맞춰 가운데를 기준으로 잘라냈다가(crop), 이후 원본 비율을 유지한 채 축소하는
  // 방식(letterbox 없는 contain-fit)을 거쳐, 지금은 52x52mm 정사각형에 맞춰 가로/세로를 독립적으로
  // 늘리는 방식이다(사용자 요청, 2026-08-22 - "비율은 조정"해서라도 무조건 52x52mm로 맞춰달라는 요청).
  // 자르지는 않지만(crop 없음) targetWidth/targetHeight 비율이 원본과 다르면 그대로 찌그러져 그려진다 -
  // 원본을 자르지 않는 것과 원본 비율을 유지하는 것은 별개이며, 지금은 후자를 포기했다. 셀 안에서의
  // 목표 크기 계산은 setCellPhoto가 담당한다.
  //
  // targetWidth/targetHeight는 원본 픽셀 크기가 아니라 setCellPhoto가 계산한 "표시 크기에 맞는
  // 인쇄 해상도" 픽셀 수(폰 사진 원본보다 훨씬 작음, 아래 setCellPhoto의 EMBED_DPI 주석 참고) -
  // 이렇게 실제로 그릴 픽셀 수 자체를 줄여서 내보내면, hp:pic의 orgSz/curSz 비율 재계산을 한글
  // 버전마다 조금씩 다르게 처리해도(원본 4000px대 사진을 표 칸 크기(수백 hwpunit)로 짓누르는 극단적인
  // 축소 비율일수록 버전별 편차가 커 보임 - 사용자가 "한글 버전에 따라 사진이 확대되거나 깨져 보인다"고
  // 리포트, 2026-08-21) 그 격차가 훨씬 작아 오작동 여지가 줄어든다.
  async function encodeImageToJpeg(image, url, targetWidth, targetHeight) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext("2d");
      // 항상 흰 배경을 먼저 채운다 - 원본이 PNG(스크린샷 등)면 캔버스가 알파 채널을 가진 채
      // 그려지는데, 실제 PC 한글(Hwp.exe)에서 이렇게 나온 RGBA PNG를 hp:pic으로 삽입하면 깨진
      // 그림 아이콘만 뜨고 사진이 아예 안 보이는 문제가 있었다(휴대폰/모바일 뷰어는 같은 파일을
      // 문제없이 보여줘서 오래 못 찾았다 - 실제 Hwp.exe로 직접 열어 재현/확인함). 아래에서 항상
      // JPEG로만 내보내면(알파 채널 자체가 없는 포맷) 이 문제가 사라진다 - 사진에는 어차피 투명도가
      // 필요 없으므로 원본이 PNG였어도 흰 배경으로 깔고 JPEG로 인코딩해도 시각적으로 차이가 없다.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, targetWidth, targetHeight);
      ctx.drawImage(image, 0, 0, targetWidth, targetHeight);
      return await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas_encode_failed"))), "image/jpeg", 0.92);
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // 셀 안의 "사진" 안내 문단을 지우고 그림 개체를 넣은 새 문단으로 교체. 이미지가 없으면 "사진 없음" 텍스트만 남김.
  async function setCellPhoto(tc, blob, imageState) {
    const doc = tc.ownerDocument;
    const subList = tc.getElementsByTagNameNS(HP, "subList")[0];
    const paras = Array.from(subList.getElementsByTagNameNS(HP, "p"));
    const templatePara = paras[0];
    paras.forEach((p) => p.remove());

    if (!blob) {
      const p = templatePara.cloneNode(true);
      setParagraphText(p, "사진 없음", "47");
      subList.appendChild(p);
      return;
    }

    // SVG(벡터 아이콘/그림)는 실제 현장 사진이 아니다 - <img>로 디코딩 자체는 되는 경우가 많아서
    // (그래서 너비/높이 측정에는 성공) 아래 크기 계산 로직만으로는 걸러지지 않고, 원본이 아주 작은
    // 아이콘 그림을 표 칸 크기까지 억지로 확대해 이상하게 보이는 원인이 된다(실제 사용자가 겪은
    // 문제) - 업로드 시점(app.js)에서도 막지만, 과거에 이미 잘못 저장/백업된 사진을 위한 안전망.
    if (blob.type === "image/svg+xml") {
      const p = templatePara.cloneNode(true);
      setParagraphText(p, "사진을 표시할 수 없습니다 (지원하지 않는 이미지 형식)", "47");
      subList.appendChild(p);
      return;
    }

    let decoded;
    try {
      decoded = await decodeImagePhoto(blob);
    } catch (err) {
      // HEIC(아이폰 기본 사진 형식) 등 브라우저가 디코딩하지 못하는 이미지가 섞여 있으면 크기를 잴 수 없다 -
      // 이 사진 한 장만 건너뛰고 나머지 보고서는 정상 생성한다.
      const p = templatePara.cloneNode(true);
      setParagraphText(p, "사진을 표시할 수 없습니다 (지원하지 않는 이미지 형식)", "47");
      subList.appendChild(p);
      return;
    }
    const { image, url, width, height } = decoded;

    // 이행전/이행후 사진 칸을 가로 52mm x 세로 52mm 정사각형으로 무조건 고정한다(사용자 요청,
    // 2026-08-22) - 예전에는 원본 비율을 유지한 채(contain-fit) 52x52mm 안에 들어가도록만 축소해서
    // 직사각형 사진은 한쪽 변이 52mm보다 작게 나왔는데, 표 전체에서 사진 칸 크기 자체가 완전히
    // 통일되지 않는 문제가 있었다. 이제는 사용자가 명시적으로 "비율은 조정(=찌그러져도 됨)"해서라도
    // 무조건 52x52mm로 맞춰 달라고 요청 - 가로/세로를 각각 52mm로 강제하고 원본 종횡비는 무시한다
    // (아래 encodeImageToJpeg가 drawImage로 targetWidth x targetHeight에 그대로 늘려 넣는다).
    // HWPUNIT는 1/7200인치이므로 52mm = 52 / 25.4 * 7200 ≈ 14740.
    const CELL_PHOTO_SIZE_HWP = Math.round((52 / 25.4) * 7200);
    const hwpWidth = CELL_PHOTO_SIZE_HWP;
    const hwpHeight = CELL_PHOTO_SIZE_HWP;

    // 실제로 파일에 담아 내보낼 픽셀 수는 원본 그대로(폰 사진은 보통 3000~4000px대)가 아니라, 위에서
    // 정한 표시 크기(hwpWidth/hwpHeight)에 맞는 인쇄 해상도(200dpi, HWPUNIT는 1/7200인치)로 낮춘다 -
    // 원본을 그대로 담으면 표 칸 크기(수 cm)에 비해 원본 해상도가 10~20배씩 차이 나는 극단적인 축소
    // 비율이 나오는데, encodeImageToJpeg 주석에 적었듯 이 비율을 한글이 재계산하는 방식이 버전마다
    // 조금씩 달라 일부 버전에서 사진이 확대되거나 깨져 보이는 원인으로 의심된다(사용자 리포트,
    // 2026-08-21). 원본보다 작을 때는(스크린샷 등 이미 작은 사진) 확대하지 않고 원본 그대로 쓴다.
    const EMBED_DPI = 200;
    const embedWidth = Math.max(1, Math.min(width, Math.round((hwpWidth / 7200) * EMBED_DPI)));
    const embedHeight = Math.max(1, Math.min(height, Math.round((hwpHeight / 7200) * EMBED_DPI)));
    const normalizedBlob = await encodeImageToJpeg(image, url, embedWidth, embedHeight);

    // encodeImageToJpeg가 항상 JPEG로 인코딩하므로(PC 한글의 RGBA PNG 렌더링 실패 회피) 고정값.
    const ext = "jpg";
    const mediaType = "image/jpeg";
    const imageIndex = ++imageState.count;
    const binaryId = `image${imageIndex}`;
    const buf = await normalizedBlob.arrayBuffer();
    imageState.zip.file(`BinData/${binaryId}.${ext}`, buf);
    imageState.manifestItems.push({ id: binaryId, href: `BinData/${binaryId}.${ext}`, mediaType });

    const p = templatePara.cloneNode(true);
    Array.from(p.getElementsByTagNameNS(HP, "run")).forEach((r) => r.remove());
    Array.from(p.getElementsByTagNameNS(HP, "linesegarray")).forEach((r) => r.remove());
    const run = el(doc, "hp:run", { charPrIDRef: "47" });
    run.appendChild(buildPicElement(doc, binaryId, hwpWidth, hwpHeight, embedWidth, embedHeight));
    p.appendChild(run);
    subList.appendChild(p);
  }

  // 항목이 딱 1건이라 새로 만드는 행이 표의 첫 행이자 마지막 행을 겸할 때 쓸 테두리 - 위쪽(라벨 행과
  // 맞물리는 선)과 아래쪽(표의 실제 바깥 테두리)이 둘 다 실선이어야 하는데, 원본 템플릿의 예시 4행 중
  // 그런 조합(위아래 둘 다 실선)인 행이 없다(첫 행은 위만 실선, 마지막 행은 아래만 실선). 마지막 행의
  // borderFill을 복제해 위쪽 테두리만 첫 행 것으로 바꿔치기한 새 borderFill을 header.xml에 등록해서 쓴다.
  function buildSingleRowBorderFillIds(headerDoc, firstRow, lastRow) {
    const borderFills = headerDoc.getElementsByTagNameNS(HH, "borderFills")[0];
    const allBorderFills = Array.from(borderFills.getElementsByTagNameNS(HH, "borderFill"));
    const findBorderFill = (id) => allBorderFills.find((bf) => bf.getAttribute("id") === id);
    let nextId = allBorderFills.reduce((max, bf) => Math.max(max, parseInt(bf.getAttribute("id"), 10) || 0), 0);

    const firstTcs = Array.from(firstRow.getElementsByTagNameNS(HP, "tc"));
    const lastTcs = Array.from(lastRow.getElementsByTagNameNS(HP, "tc"));
    const newIds = lastTcs.map((lastTc, idx) => {
      const lastBorderFill = findBorderFill(lastTc.getAttribute("borderFillIDRef"));
      const firstBorderFill = findBorderFill(firstTcs[idx].getAttribute("borderFillIDRef"));
      const newBorderFill = lastBorderFill.cloneNode(true);
      nextId += 1;
      newBorderFill.setAttribute("id", String(nextId));
      const newTop = newBorderFill.getElementsByTagNameNS(HH, "topBorder")[0];
      const firstTop = firstBorderFill.getElementsByTagNameNS(HH, "topBorder")[0];
      if (newTop && firstTop) {
        newTop.setAttribute("type", firstTop.getAttribute("type"));
        newTop.setAttribute("width", firstTop.getAttribute("width"));
        newTop.setAttribute("color", firstTop.getAttribute("color"));
      }
      borderFills.appendChild(newBorderFill);
      return String(nextId);
    });
    borderFills.setAttribute("itemCnt", String(borderFills.getElementsByTagNameNS(HH, "borderFill").length));
    return newIds;
  }

  // rowTemplates(이행전/이행후 사진이 들어가는 행들)가 참조하는 borderFill 중 점선(DASH)인 변을 모두
  // 실선(SOLID)으로 바꾼다 - 항목 사이 구분선(위/아래)뿐 아니라 이행전/이행후 칸을 나누는 세로선도
  // 점선이었는데, 원본 예시 표와 달리 실제 사용자가 실선으로 통일해 달라고 요청했다(2026-08-22).
  // borderFill은 header.xml에 한 번만 정의되고 여러 hp:tc가 id로 공유해서 쓰는 자원이라, 각 행을
  // 복제(cloneNode)해도 이 정의 자체를 바꿔야 실제로 인쇄되는 선이 바뀐다.
  function convertDashedBordersToSolid(headerDoc, rowTemplates) {
    const ids = new Set();
    for (const row of rowTemplates) {
      Array.from(row.getElementsByTagNameNS(HP, "tc")).forEach((tc) => {
        const id = tc.getAttribute("borderFillIDRef");
        if (id) ids.add(id);
      });
    }
    const borderFills = headerDoc.getElementsByTagNameNS(HH, "borderFills")[0];
    Array.from(borderFills.getElementsByTagNameNS(HH, "borderFill")).forEach((bf) => {
      if (!ids.has(bf.getAttribute("id"))) return;
      ["topBorder", "bottomBorder", "leftBorder", "rightBorder"].forEach((side) => {
        const b = bf.getElementsByTagNameNS(HH, side)[0];
        if (b && b.getAttribute("type") === "DASH") b.setAttribute("type", "SOLID");
      });
    });
  }

  function addManifestItems(hpfDoc, items) {
    const manifest = hpfDoc.getElementsByTagNameNS(OPF, "manifest")[0];
    for (const item of items) {
      const el2 = hpfDoc.createElementNS(OPF, "opf:item");
      el2.setAttribute("id", item.id);
      el2.setAttribute("href", item.href);
      el2.setAttribute("media-type", item.mediaType);
      el2.setAttribute("isEmbeded", "1");
      manifest.appendChild(el2);
    }
  }

  // tr[0..headerRowCount-1]의 모든 hp:tc에 header="1"을 표시해, 표가 여러 페이지에 걸치면 이 행들이
  // 매 페이지 위에 반복되게 한다. 템플릿의 hp:tbl에는 이미 repeatHeader="1"이 붙어 있었지만 실제로
  // 반복시킬 행의 hp:tc는 전부 header="0"이라 아무 행도 반복되지 않았다 - 그래서 지적사항이 4건을
  // 넘어가 표가 2페이지로 넘어가면 2페이지 첫머리에 제목/안내문구/이행전·이행후 라벨 없이 사진 칸만
  // 이어져 보이는 문제가 있었다(사용자 리포트, 2026-08-22).
  function markHeaderRows(tbl, headerRowCount) {
    const trs = Array.from(tbl.getElementsByTagNameNS(HP, "tr"));
    for (let i = 0; i < headerRowCount && i < trs.length; i++) {
      Array.from(trs[i].getElementsByTagNameNS(HP, "tc")).forEach((tc) => tc.setAttribute("header", "1"));
    }
  }

  // "지적사항 내용" 칸의 첫 줄(층/위치, 예: "2F 주 소화전")을 굵게 표시하기 위한 charPr을 header.xml에
  // 새로 등록한다 - 원본 템플릿에는 굵은 버전이 따로 없어서(id=47은 굵기 없음) baseId의 정의를 그대로
  // 복제해 <hh:bold/>만 추가한다(사용자 요청, 2026-09-02 - 사진 칸 위 "이행 전"/"이행 후" 라벨처럼
  // 위치 정보가 눈에 띄도록). hh:bold는 스펙상 hh:offset 다음, hh:underline 앞에 와야 한다(다른 굵은
  // charPr들의 요소 순서를 참고해 확인함).
  function buildBoldCharPr(headerDoc, baseId) {
    const charProperties = headerDoc.getElementsByTagNameNS(HH, "charProperties")[0];
    const allCharPrs = Array.from(charProperties.getElementsByTagNameNS(HH, "charPr"));
    const base = allCharPrs.find((cp) => cp.getAttribute("id") === baseId);
    const newCharPr = base.cloneNode(true);
    const nextId = allCharPrs.reduce((max, cp) => Math.max(max, parseInt(cp.getAttribute("id"), 10) || 0), 0) + 1;
    newCharPr.setAttribute("id", String(nextId));
    const offset = newCharPr.getElementsByTagNameNS(HH, "offset")[0];
    offset.parentNode.insertBefore(hhEl(headerDoc, "hh:bold", {}), offset.nextSibling);
    charProperties.appendChild(newCharPr);
    charProperties.setAttribute("itemCnt", String(charProperties.getElementsByTagNameNS(HH, "charPr").length));
    return String(nextId);
  }

  async function fillDeficiencyTable(doc, tbl, items, photoMap, imageState, headerDoc) {
    markHeaderRows(tbl, 3);
    const trs = Array.from(tbl.getElementsByTagNameNS(HP, "tr"));
    // tr[0]=제목, tr[1]=이행결과/안내문구, tr[2]=이행전/이행후 라벨, tr[3..]=예시 데이터 4행 - 이 4행은
    // 표 안에서의 위치에 따라 테두리가 다르다: 첫 행은 위쪽 라벨 행과 맞물리는 윗선만 실선, 중간
    // 행들은 위아래 모두 점선(구분선), 마지막 행만 아래쪽이 표의 실제 바깥 테두리라 실선이다. 항목
    // 수만큼 행을 새로 만들 때도 이 자리별 스타일을 그대로 살려야 마지막 행 아래쪽이 원본과 똑같이
    // 실선으로 나온다(사용자 리포트: "지금은 점선인데 원본과 동일하게 해달라", 2026-08-21) - 예전엔
    // 첫 행 스타일 하나만 모든 행에 그대로 복제해서 마지막 행 아래쪽도 항상 점선이었다.
    const firstRowTemplate = trs[3].cloneNode(true);
    const middleRowTemplate = trs[4].cloneNode(true);
    const lastRowTemplate = trs[trs.length - 1].cloneNode(true);
    for (let i = 3; i < trs.length; i++) trs[i].remove();

    // trs 전체(제목/안내문구/이행전·이행후 라벨 행 + 예시 데이터 행)를 넘긴다 - 이행전/이행후 라벨을
    // 나누는 세로 구분선(trs[2])도 점선이라, 데이터 행만 바꾸면 라벨 행 부분만 점선으로 남아 세로선이
    // 중간에 끊겨 보인다.
    if (headerDoc) convertDashedBordersToSolid(headerDoc, trs);

    // 항목이 딱 1건이면 그 한 행이 첫 행이자 마지막 행을 겸해야 하는데 원본 템플릿엔 그런 조합의 행이
    // 없다 - buildSingleRowBorderFillIds로 위/아래 둘 다 실선인 테두리를 새로 만들어 쓴다.
    const singleRowBorderFillIds = items.length === 1 && headerDoc
      ? buildSingleRowBorderFillIds(headerDoc, firstRowTemplate, lastRowTemplate)
      : null;

    // 지적사항 내용 칸 첫 줄(층/위치)을 굵게 표시하려고 쓸 charPr - 표 전체에서 한 번만 만들어 공유한다.
    const boldContentCharPrId = headerDoc ? buildBoldCharPr(headerDoc, "47") : "47";

    for (let i = 0; i < items.length; i++) {
      const def = items[i];
      const rowTemplate = i === 0 ? firstRowTemplate : (i === items.length - 1 ? lastRowTemplate : middleRowTemplate);
      const row = rowTemplate.cloneNode(true);
      const tcs = Array.from(row.getElementsByTagNameNS(HP, "tc"));
      const [contentTc, beforeTc, afterTc] = tcs;
      if (singleRowBorderFillIds) {
        tcs.forEach((tc, idx) => tc.setAttribute("borderFillIDRef", singleRowBorderFillIds[idx]));
      }

      tcs.forEach((tc) => {
        const addr = tc.getElementsByTagNameNS(HP, "cellAddr")[0];
        if (addr) addr.setAttribute("rowAddr", String(3 + i));
      });

      const locationText = [def.floor, def.location].filter(Boolean).join(" ") || `${i + 1}번 항목`;
      const lines = [{ text: locationText, charPrIDRef: boldContentCharPrId }];
      lines.push(def.description || "");
      clearCellAndSetLines(contentTc, lines, "47");

      // photoMap은 app.js에서 FireDB.getPhotosBySite() 결과(+구글 드라이브에서 보충한 것)를 id 기준으로
      // 매핑한 것 - 값은 Blob이 아니라 { id, siteId, itemId, role, blob, ... } 사진 레코드 전체이므로
      // .blob으로 꺼내 써야 한다. beforePhotoIds/afterPhotoIds는 촬영/업로드한 순서대로 뒤에 추가되므로
      // (onDeficiencyPhotoSelected가 항상 push) 배열의 마지막 항목이 가장 최근에 올린 사진이다 - 한
      // 칸에는 한 장만 넣을 수 있어 그 중 하나를 골라야 하는데, 가장 최근 것을 우선한다. 배열 앞쪽부터
      // 찾으면(구글 드라이브 보충 이후로는 대부분의 id가 뭔가는 찾아지므로) 오래된 사진이 최신 사진을
      // 밀어내고 채워지는 문제가 있었다(실제 사용자가 겪은 문제: "내가 올린 사진이 아니라 이상한
      // 사진으로 채워짐") - 뒤에서부터 찾아 항상 가장 최근 것이 이기도록 한다.
      const beforePhoto = (def.beforePhotoIds || []).map((id) => photoMap.get(id)).filter(Boolean).pop() || null;
      const afterPhoto = (def.afterPhotoIds || []).map((id) => photoMap.get(id)).filter(Boolean).pop() || null;
      await setCellPhoto(beforeTc, beforePhoto ? beforePhoto.blob : null, imageState);
      await setCellPhoto(afterTc, afterPhoto ? afterPhoto.blob : null, imageState);

      tbl.appendChild(row);
    }
    tbl.setAttribute("rowCnt", String(3 + items.length));
  }

  // resolved: 완료된 지적사항 배열 (def.beforePhotoIds/afterPhotoIds/floor/location/code/description)
  // photoMap: Map(photoId -> 사진 레코드, app.js의 FireDB.getPhotosBySite() 결과)
  async function generateCompletionReportHwpx({ site, company, resolved, photoMap, dateRange, contactName, contactPhone, managerName, managerPhone, siteName, siteType, siteAddr, fireStation }) {
    const res = await fetch(TEMPLATE_URL);
    if (!res.ok) throw new Error("template_fetch_failed_" + res.status);
    const buf = await res.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);

    const sectionXmlText = await zip.file("Contents/section0.xml").async("text");
    const hpfXmlText = await zip.file("Contents/content.hpf").async("text");
    const headerXmlText = await zip.file("Contents/header.xml").async("text");

    const parser = new DOMParser();
    const sectionDoc = parser.parseFromString(sectionXmlText, "application/xml");
    const hpfDoc = parser.parseFromString(hpfXmlText, "application/xml");
    const headerDoc = parser.parseFromString(headerXmlText, "application/xml");

    if (sectionDoc.getElementsByTagName("parsererror").length > 0) {
      throw new Error("hwpx_template_parse_error");
    }

    fixLabelLineAlignment(headerDoc);
    fillCoverPage(sectionDoc, { site, company, dateRange, contactName, contactPhone, managerName, managerPhone, siteName, siteType, siteAddr, fireStation });
    removeDeficiencyListTable(sectionDoc);

    const tbls = Array.from(sectionDoc.getElementsByTagNameNS(HP, "tbl"));
    const deficiencyTbl = tbls[tbls.length - 1];
    const imageState = { zip, count: 0, manifestItems: [] };
    await fillDeficiencyTable(sectionDoc, deficiencyTbl, resolved, photoMap, imageState, headerDoc);

    if (imageState.manifestItems.length > 0) {
      addManifestItems(hpfDoc, imageState.manifestItems);
    }

    const serializer = new XMLSerializer();
    const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';
    zip.file("Contents/section0.xml", XML_DECL + serializer.serializeToString(sectionDoc.documentElement));
    zip.file("Contents/content.hpf", XML_DECL + serializer.serializeToString(hpfDoc.documentElement));
    zip.file("Contents/header.xml", XML_DECL + serializer.serializeToString(headerDoc.documentElement));

    return zip.generateAsync({ type: "blob", mimeType: "application/hwp+zip" });
  }

  return { generateCompletionReportHwpx };
})();
