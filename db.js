// 찰칵보고서 데이터 저장소.
// 거래처(sites)/지적사항(deficiencies)/지적사항 회차(deficiencyRounds)는 같은 회사 사람들끼리
// 공유해야 하는 자료라서 Firebase Realtime Database(온라인, 로그인한 사람 전원이 같은 자료를 봄)에 저장한다.
// 사진(photos)/관련서류(roundDocuments)는 용량이 커서 아직은 기기별 IndexedDB에만 저장된다
// (필요 시 구글 드라이브에 자동 백업되어 다른 기기에서도 채워짐).
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
        // 그 방문 회차에 걸어두고 다운로드할 수 있게 한다. attachments와 같은 이유(용량 큼)로
        // 아직 이 기기에만 저장.
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
  // 최상위 경로("chalkak/") 아래에만 읽고 쓴다. 그 아래는 다시 로그인한 회사(companyId)별로
  // "companies/<companyId>/" 밑에 나뉘어 있어, 서로 다른 회사가 같은 앱/계정 풀을 공유해도 각자
  // 자기 회사 자료만 보고 쓸 수 있다 - 실제 접근 제한은 클라이언트 코드가 아니라 Firebase
  // Realtime Database 보안규칙(chalkak/companyAccess/<uid> === companyId 확인)이 담당한다.
  const DB_ROOT = "chalkak";
  function rtdb() {
    return firebase.database();
  }
  function companyRoot() {
    const companyId = window.Auth && Auth.getCompanyId && Auth.getCompanyId();
    if (!companyId) throw new Error("로그인한 회사 정보를 확인할 수 없습니다. 다시 로그인해주세요.");
    return `${DB_ROOT}/companies/${companyId}`;
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
    const snap = await withTimeout(rtdb().ref(`${companyRoot()}/${path}`).once("value"), `fbGet(${path})`);
    return snap.exists() ? snap.val() : null;
  }

  async function fbGetAll(path) {
    const snap = await withTimeout(rtdb().ref(`${companyRoot()}/${path}`).once("value"), `fbGetAll(${path})`);
    const val = snap.val();
    return val ? Object.values(val) : [];
  }

  async function fbSet(path, value) {
    await rtdb().ref(`${companyRoot()}/${path}`).set(value);
    return value;
  }

  async function fbRemove(path) {
    await rtdb().ref(`${companyRoot()}/${path}`).remove();
  }

  // 사진이 아직 없는 지적사항(beforePhotoIds/afterPhotoIds가 빈 배열)도 같은 이유로 저장 시
  // 그 필드 자체가 사라진다 - 읽을 때마다 항상 실제 배열을 보장해준다.
  function normalizeDeficiency(def) {
    if (!def) return null;
    return { ...def, beforePhotoIds: def.beforePhotoIds || [], afterPhotoIds: def.afterPhotoIds || [] };
  }

  // deficiencyRounds.documents(관련서류 메타데이터 - id/파일명/용량. 실제 파일은 기기별 IndexedDB
  // roundDocuments에 캐시되고 구글 드라이브에도 백업됨)도 같은 이유(Realtime Database는 빈 배열을
  // 저장하지 않고 키 자체를 지움)로 항상 실제 배열을 보장해줘야 한다.
  function normalizeRound(round) {
    if (!round) return null;
    return { ...round, documents: round.documents || [] };
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
      const sitePhotos = await getAllByIndex(STORES.photos, "siteId", id);
      for (const p of sitePhotos) {
        await remove(STORES.photos, p.id);
      }
      return fbRemove(`sites/${id}`);
    },
    getSite: (id) => fbGet(`sites/${id}`),
    getAllSites: () => fbGetAll("sites"),

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
    getPhotosBySite: (siteId) => getAllByIndex(STORES.photos, "siteId", siteId),

    // Deficiencies (현장에 직접 귀속)
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

    // Deficiency Rounds (지적사항 회차 - 방문 날짜별 묶음). 업체 하나에 여러 방문 날짜의 보고서가
    // 각각 남아 나중에도 열어서 수정할 수 있다.
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

    // Round Documents (회차별 관련서류 - 지적사항 자료와 별개, 사진과 같은 이유로 아직 이 기기에만 저장)
    async addRoundDocument(doc) {
      const id = doc.id || genId();
      return put(STORES.roundDocuments, { ...doc, id });
    },
    async deleteRoundDocument(id) {
      return remove(STORES.roundDocuments, id);
    },
    getRoundDocumentsByRound: (roundId) => getAllByIndex(STORES.roundDocuments, "roundId", roundId),

    // 소방공사업체 정보(업체명/주소/전화/대표이사/사업자등록번호) - 같은 회사 사람 모두가 같은
    // 값을 보도록 공유 저장소에 둔다.
    getCompanyProfile: () => fbGet("companyProfile"),
    async saveCompanyProfile(profile) {
      return fbSet("companyProfile", profile);
    }
  };

  return api;
})();
