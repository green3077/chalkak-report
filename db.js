// 소방점검 관리 데이터 저장소.
// 거래처(sites)/점검기록(inspections)/지적사항(deficiencies)/스케줄(schedules)은 팀 전체가
// 공유해야 하는 자료라서 Firebase Realtime Database(온라인, 로그인한 사람 전원이 같은 자료를 봄)에 저장한다.
// 사진(photos)/첨부파일(attachments)은 용량이 커서 아직은 기존처럼 이 기기의 IndexedDB에만 저장된다
// (공유 저장소로 옮기는 작업은 별도 진행 예정 - 그 전까지는 사진은 올린 사람의 기기에서만 보인다).
const FireDB = (() => {
  const DB_NAME = "fire-inspection-db";
  const DB_VERSION = 5;
  const STORES = {
    photos: "photos",
    attachments: "attachments",
    roundDocuments: "roundDocuments"
  };
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onblocked = () => {
        if (window.toast) window.toast("다른 탭/창에서 이 앱이 열려 있어 데이터베이스 업데이트가 대기 중입니다. 다른 탭을 닫아주세요.", "error");
      };
      req.onupgradeneeded = () => {
        const db = req.result;
        const tx = req.transaction;
        let photoStore;
        if (!db.objectStoreNames.contains(STORES.photos)) {
          photoStore = db.createObjectStore(STORES.photos, { keyPath: "id" });
          photoStore.createIndex("inspectionId", "inspectionId", { unique: false });
        } else {
          photoStore = tx.objectStore(STORES.photos);
        }
        if (!photoStore.indexNames.contains("siteId")) {
          photoStore.createIndex("siteId", "siteId", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.attachments)) {
          const store = db.createObjectStore(STORES.attachments, { keyPath: "id" });
          store.createIndex("siteId", "siteId", { unique: false });
        }
        // 회차(점검 날짜) 관련서류 - 지적사항 자료(deficiencies)와 별개로, 계약서/허가서 등 파일을
        // 그 방문 회차에 걸어두고 다운로드할 수 있게 한다(사용자 요청, 2026-09-07). attachments와
        // 같은 이유(용량 큼)로 아직 이 기기에만 저장.
        if (!db.objectStoreNames.contains(STORES.roundDocuments)) {
          const store = db.createObjectStore(STORES.roundDocuments, { keyPath: "id" });
          store.createIndex("roundId", "roundId", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function genId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function put(storeName, record) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function get(storeName, id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAllByIndex(storeName, indexName, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).index(indexName).getAll(value);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function remove(storeName, id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---------- Firebase Realtime Database (공유 자료: 거래처/지적사항) ----------
  // sobang1004와 같은 Firebase 프로젝트를 재사용하되, 데이터가 섞이지 않도록 이 앱(찰칵보고서) 전용
  // 최상위 경로("chalkak/") 아래에만 읽고 쓴다.
  const DB_ROOT = "chalkak";
  function rtdb() {
    return firebase.database();
  }

  // 일부 모바일 환경(불안정한 Wi-Fi, WebView의 소켓 연결 문제 등)에서는 Firebase의 실시간 연결이
  // 붙지 못한 채 .once("value")가 성공도 실패도 하지 않고 영원히 멈출 수 있다 - 그러면 화면 전환은
  // 되는데 내용은 하염없이 빈 채로 남아 "눌러도 반응 없음"처럼 보인다. 15초 안에 응답이 없으면
  // 명확한 에러로 실패시켜서, 호출한 쪽이 최소한 에러 메시지를 보여줄 수 있게 한다.
  function withTimeout(promise, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 응답 시간 초과 (네트워크 확인 필요)`)), 15000)),
    ]);
  }

  async function fbGet(path) {
    const snap = await withTimeout(rtdb().ref(`${DB_ROOT}/${path}`).once("value"), `fbGet(${path})`);
    return snap.exists() ? snap.val() : null;
  }

  async function fbGetAll(path) {
    const snap = await withTimeout(rtdb().ref(`${DB_ROOT}/${path}`).once("value"), `fbGetAll(${path})`);
    const val = snap.val();
    return val ? Object.values(val) : [];
  }

  async function fbSet(path, value) {
    await rtdb().ref(`${DB_ROOT}/${path}`).set(value);
    return value;
  }

  async function fbRemove(path) {
    await rtdb().ref(`${DB_ROOT}/${path}`).remove();
  }

  // 사진이 아직 없는 지적사항(beforePhotoIds/afterPhotoIds가 빈 배열)도 같은 이유로 저장 시
  // 그 필드 자체가 사라진다 - 읽을 때마다 항상 실제 배열을 보장해준다.
  function normalizeDeficiency(def) {
    if (!def) return null;
    return { ...def, beforePhotoIds: def.beforePhotoIds || [], afterPhotoIds: def.afterPhotoIds || [] };
  }

  // inspections.photoIds도 같은 이유(빈 배열이 저장되지 않음)로 문제가 되는데, 여기는 한 가지가
  // 더 있다 - 점검 회차 자체는 이 사진-동기화 기능이 생기기 훨씬 전부터 있던 오래된 데이터라,
  // "photoIds가 없다"가 "이 기능 이전이라 애초에 추적 안 함"인지 "사진을 다 지워서 마지막
  // 하나까지 없어진 빈 배열"인지 읽을 때는 구분이 안 간다(둘 다 키 자체가 없는 것으로 보임).
  // 앞의 경우는 손대면 안 되고(추적 안 하던 사진을 실수로 지울 위험), 뒤의 경우는 빈 배열로
  // 취급해야 삭제가 다른 기기에 제대로 반영된다. 그래서 사진을 올리거나 지울 때마다
  // photoSyncEnabled를 true로 같이 남겨둔다(불리언 true는 지워지지 않으므로) - 이 값이 있으면
  // "이 회차는 이미 새 방식으로 추적 중"이라는 뜻이라 photoIds가 비어 보여도 안심하고 빈
  // 배열로 취급할 수 있다.
  function normalizeInspection(insp) {
    if (!insp) return null;
    if (insp.photoSyncEnabled || Array.isArray(insp.photoIds)) {
      return { ...insp, photoIds: insp.photoIds || [] };
    }
    return insp;
  }

  // deficiencyRounds.documents(관련서류 메타데이터 - id/파일명/용량. 실제 파일은 기기별 IndexedDB
  // roundDocuments에 캐시되고 구글 드라이브에도 백업됨, 2026-09-07)도 같은 이유(Realtime Database는
  // 빈 배열을 저장하지 않고 키 자체를 지움)로 항상 실제 배열을 보장해줘야 한다.
  function normalizeRound(round) {
    if (!round) return null;
    return { ...round, documents: round.documents || [] };
  }

  // 주의: Firebase Realtime Database는 빈 배열([])을 저장하지 않고 그냥 키 자체를 지워버린다
  // (siteIds가 전부 지워진 날짜를 다시 읽으면 siteIds 필드가 아예 없이 돌아온다) - 그래서
  // 스케줄을 읽을 때마다 normalizeSchedule로 항상 실제 배열을 보장해준다.
  function normalizeSchedule(date, sched) {
    if (!sched) return null;
    return { id: date, confirmed: !!sched.confirmed, siteIds: sched.siteIds || [] };
  }
  async function getScheduleByDate(date) {
    return normalizeSchedule(date, await fbGet(`schedules/${date}`));
  }
  async function getAllSchedules() {
    const snap = await withTimeout(rtdb().ref("schedules").once("value"), "getAllSchedules");
    const val = snap.val();
    if (!val) return [];
    return Object.keys(val).map((date) => normalizeSchedule(date, val[date]));
  }

  const api = {
    genId,

    // Sites
    async addSite(site) {
      const id = site.id || genId();
      return fbSet(`sites/${id}`, { ...site, id });
    },
    async updateSite(id, changes) {
      const existing = await fbGet(`sites/${id}`);
      if (!existing) throw new Error("Site not found: " + id);
      return fbSet(`sites/${id}`, { ...existing, ...changes, id });
    },
    async deleteSite(id) {
      const inspections = (await fbGetAll("inspections")).filter((i) => i.siteId === id);
      for (const insp of inspections) {
        await api.deleteInspection(insp.id);
      }
      const rounds = (await fbGetAll("deficiencyRounds")).filter((r) => r.siteId === id);
      for (const round of rounds) {
        await api.deleteRound(round.id);
      }
      // 위 회차 삭제가 회차에 속한 지적사항은 다 지우지만, 회차 이전(마이그레이션 전) 데이터처럼
      // roundId 없이 남아있는 지적사항이 있을 수 있어 이 루프로 마저 정리한다.
      const defs = (await fbGetAll("deficiencies")).filter((d) => d.siteId === id);
      for (const def of defs) {
        await api.deleteDeficiency(def.id);
      }
      const atts = await getAllByIndex(STORES.attachments, "siteId", id);
      for (const att of atts) {
        await remove(STORES.attachments, att.id);
      }
      // 현장점검 사진 갤러리 사진은 inspectionId 없이 siteId로만 귀속되므로 별도로 정리해야 한다
      // (지적사항 사진은 deleteDeficiency가 이미 개별 id로 지웠으므로 여기선 중복 삭제라도 무해함).
      const sitePhotos = await getAllByIndex(STORES.photos, "siteId", id);
      for (const p of sitePhotos) {
        await remove(STORES.photos, p.id);
      }
      const jobs = (await fbGetAll("constructionJobs")).filter((j) => j.siteId === id);
      for (const job of jobs) {
        await fbRemove(`constructionJobs/${job.id}`);
      }
      return fbRemove(`sites/${id}`);
    },
    getSite: (id) => fbGet(`sites/${id}`),
    getAllSites: () => fbGetAll("sites"),

    // Inspections
    async addInspection(inspection) {
      const id = inspection.id || genId();
      return fbSet(`inspections/${id}`, { ...inspection, id });
    },
    async updateInspection(id, changes) {
      const existing = await fbGet(`inspections/${id}`);
      if (!existing) throw new Error("Inspection not found: " + id);
      return fbSet(`inspections/${id}`, { ...existing, ...changes, id });
    },
    async deleteInspection(id) {
      const photos = await getAllByIndex(STORES.photos, "inspectionId", id);
      for (const p of photos) {
        await remove(STORES.photos, p.id);
      }
      return fbRemove(`inspections/${id}`);
    },
    getInspection: async (id) => normalizeInspection(await fbGet(`inspections/${id}`)),
    getAllInspections: async () => (await fbGetAll("inspections")).map(normalizeInspection),
    getInspectionsBySite: async (siteId) => (await fbGetAll("inspections")).filter((i) => i.siteId === siteId),

    // Photos (이 기기에만 저장 - 아직 공유 저장소로 옮기기 전)
    async addPhoto(photo) {
      const id = photo.id || genId();
      return put(STORES.photos, { ...photo, id });
    },
    async deletePhoto(id) {
      return remove(STORES.photos, id);
    },
    async updatePhoto(id, changes) {
      const existing = await get(STORES.photos, id);
      if (!existing) throw new Error("Photo not found: " + id);
      return put(STORES.photos, { ...existing, ...changes, id });
    },
    getPhoto: (id) => get(STORES.photos, id),
    getPhotosByInspection: (inspectionId) => getAllByIndex(STORES.photos, "inspectionId", inspectionId),
    getPhotosBySite: (siteId) => getAllByIndex(STORES.photos, "siteId", siteId),

    // Deficiencies (현장에 직접 귀속, 점검 기록과 무관)
    async addDeficiency(def) {
      const id = def.id || genId();
      return fbSet(`deficiencies/${id}`, { ...def, id });
    },
    async updateDeficiency(id, changes) {
      const existing = await fbGet(`deficiencies/${id}`);
      if (!existing) throw new Error("Deficiency not found: " + id);
      return fbSet(`deficiencies/${id}`, { ...existing, ...changes, id });
    },
    async deleteDeficiency(id) {
      const def = await fbGet(`deficiencies/${id}`);
      if (def) {
        for (const pid of [...(def.beforePhotoIds || []), ...(def.afterPhotoIds || [])]) {
          await remove(STORES.photos, pid);
        }
      }
      return fbRemove(`deficiencies/${id}`);
    },
    getDeficiency: async (id) => normalizeDeficiency(await fbGet(`deficiencies/${id}`)),
    getAllDeficiencies: async () => (await fbGetAll("deficiencies")).map(normalizeDeficiency),
    getDeficienciesBySite: async (siteId) =>
      (await fbGetAll("deficiencies")).filter((d) => d.siteId === siteId).map(normalizeDeficiency),
    getDeficienciesByRound: async (roundId) =>
      (await fbGetAll("deficiencies")).filter((d) => d.roundId === roundId).map(normalizeDeficiency),

    // Deficiency Rounds (지적사항 회차 - 방문 날짜별 묶음. 점검(inspections)과는 별개의 가벼운 개념 -
    // "점검이 먼저 있어야 지적사항을 추가할 수 있다"는 예전 마찰을 되풀이하지 않기 위해, 지적사항
    // 전용으로 회차만 가볍게 관리한다. 사용자 요청(2026-08-22): 업체 하나에 여러 방문 날짜의
    // 보고서가 각각 남아 나중에도 열어서 수정할 수 있어야 함).
    async addRound(round) {
      const id = round.id || genId();
      return fbSet(`deficiencyRounds/${id}`, { ...round, id });
    },
    async updateRound(id, changes) {
      const existing = await fbGet(`deficiencyRounds/${id}`);
      if (!existing) throw new Error("Round not found: " + id);
      return fbSet(`deficiencyRounds/${id}`, { ...existing, ...changes, id });
    },
    async deleteRound(id) {
      const defs = (await fbGetAll("deficiencies")).filter((d) => d.roundId === id);
      for (const def of defs) {
        await api.deleteDeficiency(def.id);
      }
      const docs = await getAllByIndex(STORES.roundDocuments, "roundId", id);
      for (const doc of docs) {
        await remove(STORES.roundDocuments, doc.id);
      }
      return fbRemove(`deficiencyRounds/${id}`);
    },
    getRound: async (id) => normalizeRound(await fbGet(`deficiencyRounds/${id}`)),
    getRoundsBySite: async (siteId) => (await fbGetAll("deficiencyRounds")).filter((r) => r.siteId === siteId).map(normalizeRound),
    getAllRounds: async () => (await fbGetAll("deficiencyRounds")).map(normalizeRound),

    // Attachments (현장에 첨부하는 일반 파일 - 사진과 같은 이유로 아직 이 기기에만 저장)
    async addAttachment(att) {
      const id = att.id || genId();
      return put(STORES.attachments, { ...att, id });
    },
    async deleteAttachment(id) {
      return remove(STORES.attachments, id);
    },
    getAttachmentsBySite: (siteId) => getAllByIndex(STORES.attachments, "siteId", siteId),

    // Round Documents (회차별 관련서류 - 지적사항 자료와 별개, 사진/첨부파일과 같은 이유로 아직 이 기기에만 저장)
    async addRoundDocument(doc) {
      const id = doc.id || genId();
      return put(STORES.roundDocuments, { ...doc, id });
    },
    async deleteRoundDocument(id) {
      return remove(STORES.roundDocuments, id);
    },
    getRoundDocumentsByRound: (roundId) => getAllByIndex(STORES.roundDocuments, "roundId", roundId),

    // Schedules (스케줄 관리 - 날짜별 방문 예정 업체. id = "YYYY-MM-DD", 점검 기록과 무관한 가벼운 일정)
    getScheduleByDate,
    getAllSchedules,
    async addSiteToSchedule(date, siteId) {
      const existing = await getScheduleByDate(date);
      const siteIds = existing ? [...existing.siteIds] : [];
      if (!siteIds.includes(siteId)) siteIds.push(siteId);
      return fbSet(`schedules/${date}`, { id: date, siteIds, confirmed: existing ? existing.confirmed : false });
    },
    // 업체를 하나라도 빼면 그날 "확정"은 더 이상 맞지 않으므로 같이 취소한다 - 확정은 그 시점에
    // 저장된 업체 목록 전체를 방문하기로 확정했다는 뜻이라, 목록이 바뀌면 다시 확인 후 확정해야 한다.
    async removeSiteFromSchedule(date, siteId) {
      const existing = await getScheduleByDate(date);
      if (!existing) return null;
      return fbSet(`schedules/${date}`, { ...existing, siteIds: existing.siteIds.filter((id) => id !== siteId), confirmed: false });
    },
    async setScheduleSiteIds(date, siteIds) {
      const existing = await getScheduleByDate(date);
      return fbSet(`schedules/${date}`, { id: date, siteIds: [...siteIds], confirmed: existing ? existing.confirmed : false });
    },
    async setScheduleConfirmed(date, confirmed) {
      const existing = await getScheduleByDate(date);
      if (!existing) return null;
      return fbSet(`schedules/${date}`, { ...existing, confirmed });
    },

    // Construction Jobs (공사팀 기록 - 점검팀 기록(inspections/deficiencies)과 완전히 분리해서
    // 따로 관리한다, 사용자 요청). 점검팀이 "점검 완료 처리"를 누르면 그 날짜만 여기 자동으로
    // 하나 만들어지고, 그 뒤 내용(메모)은 공사팀이 각자 채운다. 공사팀이 직접 새 항목을 추가할
    // 수도 있다 - 두 팀 다 같은 거래처(sites)를 참조하지만 방문/작업 이력은 서로 건드리지 않는다.
    async addConstructionJob(job) {
      const id = job.id || genId();
      return fbSet(`constructionJobs/${id}`, { ...job, id });
    },
    async updateConstructionJob(id, changes) {
      const existing = await fbGet(`constructionJobs/${id}`);
      if (!existing) throw new Error("Construction job not found: " + id);
      return fbSet(`constructionJobs/${id}`, { ...existing, ...changes, id });
    },
    async deleteConstructionJob(id) {
      return fbRemove(`constructionJobs/${id}`);
    },
    getConstructionJob: (id) => fbGet(`constructionJobs/${id}`),
    getConstructionJobsBySite: async (siteId) =>
      (await fbGetAll("constructionJobs")).filter((j) => j.siteId === siteId),
    getAllConstructionJobs: () => fbGetAll("constructionJobs"),

    // 업체 정보(회사명/주소/전화/대표이사/사업자등록번호/면허번호) - 팀 전체가 같은 값을 보도록
    // 공유 저장소에 둔다(기존엔 기기별 localStorage라 한 사람이 고쳐도 다른 사람 화면엔 안 보였음).
    getCompanyProfile: () => fbGet("companyProfile"),
    async saveCompanyProfile(profile) {
      return fbSet("companyProfile", profile);
    }
  };

  return api;
})();
