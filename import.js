// 지적사항 표 가져오기 (엑셀 / 워드 / PDF) - "설비/층/설치장소/점검번호/불량내용" 표 구조를 인식
const FireImport = (() => {

  function cellText(v) {
    if (v == null) return "";
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v).trim();
  }

  // 원시 표(행렬 배열)를 지적사항 배열로 변환
  function rowsToDeficiencies(rows) {
    if (!rows || rows.length === 0) return null;

    let headerIdx = -1;
    let colMap = null;
    for (let i = 0; i < rows.length; i++) {
      const row = (rows[i] || []).map(cellText);
      const hasEquip = row.some((c) => c.includes("설비"));
      const hasContent = row.some((c) => c.includes("불량") || c.includes("내용") || c.includes("지적"));
      const hasLoc = row.some((c) => c.includes("설치장소") || c.includes("위치"));
      if (hasEquip && hasContent && hasLoc) {
        headerIdx = i;
        colMap = {};
        row.forEach((c, idx) => {
          if (c.includes("설비")) colMap.category = idx;
          else if (c === "층") colMap.floor = idx;
          else if (c.includes("설치장소") || c.includes("위치")) colMap.location = idx;
          else if (c.includes("점검번호") || c.includes("번호")) colMap.code = idx;
          else if (c.includes("불량") || c.includes("내용") || c.includes("지적")) colMap.description = idx;
        });
        break;
      }
    }
    if (headerIdx === -1) return null;

    const results = [];
    let lastCategory = "";
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const texts = row.map(cellText);
      if (texts.every((c) => c === "")) continue;
      const firstNonEmpty = texts.find((c) => c !== "") || "";
      if (/^[※*]/.test(firstNonEmpty)) break;

      const get = (key) => (colMap[key] != null ? cellText(row[colMap[key]]) : "");
      let category = get("category");
      if (category) lastCategory = category; else category = lastCategory;
      const floor = get("floor");
      const location = get("location");
      const code = get("code");
      const description = get("description");
      if (!description && !location) continue;
      results.push({ category, floor, location, code, description });
    }

    // 표의 맨 첫 항목(들)이 세로 병합된 '설비' 칸에 속하는데, 그 칸의 글자가 병합 범위 안에서 가운데
    // 정렬되어 있어(PDF 렌더링 특성) 정작 첫 줄이 아니라 그 아래 줄과 같은 높이에 찍히는 경우가 있다.
    // 그러면 위의 순방향 상속(lastCategory)으로는 맨 앞 항목(들)만 설비 값을 못 받고 비어 남는다 -
    // 표에서 처음 발견된 값으로 그 앞의 빈 항목들을 채워준다(뒤에서 앞으로 상속되는 다른 항목이 그
    // 사이에 끼어들 수 없는, 표의 맨 처음 구간에서만 안전하게 적용 가능).
    const firstCatIdx = results.findIndex((r) => r.category);
    if (firstCatIdx > 0) {
      const val = results[firstCatIdx].category;
      for (let i = 0; i < firstCatIdx; i++) results[i].category = val;
    }
    return results.length ? results : null;
  }

  async function parseExcelFile(file) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
      const parsed = rowsToDeficiencies(rows);
      if (parsed) return parsed;
    }
    return null;
  }

  async function parseWordFile(file) {
    const zip = await JSZip.loadAsync(file);
    const docXmlFile = zip.file("word/document.xml");
    if (!docXmlFile) return null;
    const xmlText = await docXmlFile.async("text");
    const xmlDoc = new DOMParser().parseFromString(xmlText, "application/xml");
    const tables = Array.from(xmlDoc.getElementsByTagName("w:tbl"));
    if (tables.length === 0) return null;

    for (const tbl of tables) {
      const trs = Array.from(tbl.getElementsByTagName("w:tr"));
      const rows = trs.map((tr) => {
        const tcs = Array.from(tr.getElementsByTagName("w:tc"));
        return tcs.map((tc) => {
          const ts = Array.from(tc.getElementsByTagName("w:t"));
          return ts.map((t) => t.textContent).join("");
        });
      });
      const parsed = rowsToDeficiencies(rows);
      if (parsed) return parsed;
    }
    return null;
  }

  // HWPX(신 한글 포맷) 표에서 세로 병합(rowSpan)된 칸은 병합 시작 행에만 <hp:tc>가 존재하고 이어지는
  // 행에는 그 칸 자체가 아예 없다(워드 w:tbl의 vMerge와 달리 빈 자리도 안 남긴다) - 그래서 tc를 열
  // 순서대로 그냥 나열하면 뒤 열들이 앞으로 밀린다. rowSpan/colSpan을 반영해 각 tc가 차지하는 자리를
  // 미리 점유 표시해두고, 각 행에서 다음 tc를 "아직 점유 안 된" 첫 열에 배치하는 방식으로 표를 복원한다.
  function hwpxTableToGrid(tblEl) {
    const trs = Array.from(tblEl.getElementsByTagName("hp:tr"));
    const rowCnt = trs.length;
    const grid = Array.from({ length: rowCnt }, () => []);
    const occupied = Array.from({ length: rowCnt }, () => new Set());
    trs.forEach((tr, r) => {
      const tcs = Array.from(tr.getElementsByTagName("hp:tc"));
      let col = 0;
      for (const tc of tcs) {
        while (occupied[r].has(col)) col++;
        const spanEl = tc.getElementsByTagName("hp:cellSpan")[0];
        const colSpan = spanEl ? parseInt(spanEl.getAttribute("colSpan") || "1", 10) : 1;
        const rowSpan = spanEl ? parseInt(spanEl.getAttribute("rowSpan") || "1", 10) : 1;
        const text = Array.from(tc.getElementsByTagName("hp:t")).map((t) => t.textContent).join("");
        grid[r][col] = text;
        for (let rr = r; rr < Math.min(r + rowSpan, rowCnt); rr++) {
          for (let cc = col; cc < col + colSpan; cc++) {
            if (rr === r && cc === col) continue;
            occupied[rr].add(cc);
            if (grid[rr][cc] === undefined) grid[rr][cc] = "";
          }
        }
        col += colSpan;
      }
    });
    return grid.map((row) => row.map((c) => c || ""));
  }

  async function parseHwpxFile(file) {
    const zip = await JSZip.loadAsync(file);
    const sectionNames = Object.keys(zip.files).filter((n) => /^Contents\/section\d+\.xml$/.test(n)).sort();
    for (const name of sectionNames) {
      const xmlText = await zip.file(name).async("text");
      const xmlDoc = new DOMParser().parseFromString(xmlText, "application/xml");
      const tables = Array.from(xmlDoc.getElementsByTagName("hp:tbl"));
      for (const tbl of tables) {
        const parsed = rowsToDeficiencies(hwpxTableToGrid(tbl));
        if (parsed) return parsed;
      }
    }
    return null;
  }

  // 같은 줄(같은 y) 안에서 글자들을 x간격(12pt 초과)으로만 나눠 칸을 추정한다 - 표 헤더처럼 모든 칸에
  // 글자가 있는 줄에서는 잘 맞지만, 세로 병합된 칸이 있는 줄(예: '설비' 칸이 비어 보이는 줄)에서 이
  // 방식을 그대로 쓰면 있는 칸들이 앞으로 밀려버린다 - 그래서 헤더를 찾은 뒤에는 이 함수를 헤더 줄
  // 인식에만 쓰고, 실제 데이터 줄은 아래 열 경계 기반 방식으로 재구성한다.
  function groupByGap(lineItems) {
    const groups = [];
    let cur = [];
    let lastEndX = null;
    lineItems.forEach((it) => {
      if (lastEndX !== null && it.x - lastEndX > 12) {
        groups.push(cur);
        cur = [];
      }
      cur.push(it);
      lastEndX = it.x + it.str.length * 3.5;
    });
    if (cur.length) groups.push(cur);
    return groups;
  }

  async function extractPdfRows(file) {
    if (window.pdfjsLib) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
    }
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

    let totalChars = 0;
    let replacementChars = 0;
    const allRows = [];

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const items = content.items.map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }));
      items.forEach((it) => {
        totalChars += it.str.length;
        replacementChars += (it.str.match(/�/g) || []).length;
      });

      const lines = new Map();
      items.forEach((it) => {
        if (!it.str.trim()) return;
        const key = Math.round(it.y / 4) * 4;
        if (!lines.has(key)) lines.set(key, []);
        lines.get(key).push(it);
      });
      const sortedYs = Array.from(lines.keys()).sort((a, b) => b - a);

      // "설비/층/설치장소/점검번호/불량내용" 표 헤더 줄을 찾아 각 열의 x 시작좌표를 알아낸다 - 이 헤더가
      // 있는 문서(자체 표준 지적내역서 양식)에서만 아래 열 경계 기반 재구성을 적용하고, 못 찾으면(다른
      // 업체 양식 등) 예전처럼 줄 안 글자 간격만으로 나누는 방식 그대로 처리한다.
      let headerColsX = null;
      let headerY = null;
      let headerTexts = null;
      for (const y of sortedYs) {
        const groups = groupByGap(lines.get(y).sort((a, b) => a.x - b.x));
        const texts = groups.map((g) => g.map((it) => it.str).join(""));
        if (
          texts.some((t) => t.includes("설비")) &&
          texts.some((t) => t.includes("불량") || t.includes("내용") || t.includes("지적")) &&
          texts.some((t) => t.includes("설치장소") || t.includes("위치"))
        ) {
          headerColsX = groups.map((g) => g[0].x);
          headerY = y;
          headerTexts = texts;
          break;
        }
      }

      if (!headerColsX || headerColsX.length < 4) {
        sortedYs.forEach((y) => {
          allRows.push(groupByGap(lines.get(y).sort((a, b) => a.x - b.x)).map((g) => g.map((it) => it.str).join("")));
        });
        continue;
      }

      // rowsToDeficiencies는 allRows 안에서 헤더 줄을 직접 찾아 열 매핑을 만드므로, 아래에서 재구성한
      // 데이터 줄들 앞에 원래 헤더 줄 텍스트를 그대로 다시 넣어준다(재구성한 줄들만 넣으면 헤더를 못
      // 찾아 표 전체가 인식 실패로 처리된다).
      allRows.push(headerTexts);

      // 열 경계 = 인접한 두 헤더 칸 x좌표의 중간지점. 헤더 라벨의 시작 x를 그대로 경계로 쓰면 실제 칸
      // 내용의 시작 위치가 라벨보다 앞서는 경우 오분류가 생기므로 중간값을 기준으로 삼는다.
      const bounds = [];
      for (let i = 0; i < headerColsX.length - 1; i++) bounds.push((headerColsX[i] + headerColsX[i + 1]) / 2);
      const colOf = (x) => {
        let idx = 0;
        for (let i = 0; i < bounds.length; i++) if (x >= bounds[i]) idx = i + 1;
        return idx;
      };

      // 헤더보다 위쪽 줄(현장명/점검업체 등 안내 표)과 맨 아래 비고 문구는 제외하고, 나머지 각 줄을
      // 헤더 열 경계에 맞춰 재배치한다 - 줄 안의 글자 간격만으로 나누던 기존 방식은 세로 병합된 '설비'
      // 칸처럼 특정 줄에 값이 아예 없는 열이 있으면 뒤 열들이 앞으로 밀려버렸다(신고된 버그의 원인).
      // 열 경계 기준으로 나누면 값이 없는 열은 그냥 빈 칸으로 남고 나머지 열은 밀리지 않는다.
      const dataEntries = sortedYs
        .filter((y) => y < headerY)
        .map((y) => {
          const lineItems = lines.get(y).sort((a, b) => a.x - b.x);
          const cols = headerColsX.map(() => "");
          lineItems.forEach((it) => { cols[colOf(it.x)] += it.str; });
          return { y, cols };
        })
        .filter((e) => !/^[※*]/.test(e.cols.join("")));

      // '층'+'설치장소'가 함께 있는 줄 = 실제 지적항목 한 줄(이 표에서 세로 병합되지 않는 유일한 열들).
      // 이 줄들을 항목의 기준(anchor)으로 삼고, 그 사이에 낀 다른 줄들(세로 병합된 '설비' 라벨이 줄바꿈/
      // 가운데정렬로 따로 떨어져 나온 조각, 여러 줄로 나뉜 '불량내용' 조각)은 y좌표가 가장 가까운 anchor
      // 줄에 원래 위아래 순서 그대로 이어붙인다.
      const anchors = dataEntries.filter((e) => e.cols[1] && e.cols[2]);
      if (!anchors.length) continue;

      anchors.forEach((a) => {
        a.category = [{ y: a.y, t: a.cols[0] }];
        a.description = [{ y: a.y, t: a.cols[4] }];
      });
      dataEntries.forEach((e) => {
        if (anchors.includes(e)) return;
        if (!e.cols[0] && !e.cols[4]) return;
        let nearest = anchors[0];
        for (const a of anchors) if (Math.abs(a.y - e.y) < Math.abs(nearest.y - e.y)) nearest = a;
        if (e.cols[0]) nearest.category.push({ y: e.y, t: e.cols[0] });
        if (e.cols[4]) nearest.description.push({ y: e.y, t: e.cols[4] });
      });

      const joinTop = (list) => list.sort((a, b) => b.y - a.y).map((x) => x.t).filter(Boolean).join(" ").trim();
      anchors.forEach((a) => {
        allRows.push([joinTop(a.category), a.cols[1], a.cols[2], a.cols[3], joinTop(a.description)]);
      });
    }

    const lowConfidence = totalChars === 0 || replacementChars / Math.max(totalChars, 1) > 0.05;
    return { rows: allRows, lowConfidence };
  }

  async function parsePdfFile(file) {
    const { rows: allRows, lowConfidence } = await extractPdfRows(file);
    const rows = rowsToDeficiencies(allRows);
    return { rows, lowConfidence };
  }

  return { parseExcelFile, parseWordFile, parseHwpxFile, parsePdfFile, extractPdfRows, rowsToDeficiencies };
})();
