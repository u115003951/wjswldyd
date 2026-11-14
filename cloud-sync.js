/**
 * ============================================================================
 * 3단계 모듈: Firebase v10 Modular 클라우드 동기화 · 실시간 랭킹 · 중앙 제보함
 * - GitHub Pages 정적 환경 + Firebase Spark 무료 할당량 최적화 설계
 * - 단축 키 매핑(s, su, t, tu, b, bu, ws, g)으로 2,000문항+ 문서 크기 1MiB 방어
 * - 오프라인/미설정 시 자동 로컬 폴백 및 오프라인 제보 큐 재전송
 * ============================================================================
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  arrayUnion
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const STORAGE_KEYS = {
  SYNC_CODE: "qbank_sync_code",
  NICKNAME: "qbank_user_nickname",
  LAST_SYNC_AT: "qbank_last_sync_at",
  LAST_SYNC_HASH: "qbank_last_sync_hash",
  OFFLINE_QUEUE: "qbank_cloud_offline_queue_v1",
  USER_RECORDS: "qbank_user_records_v1"
};

const CloudSync = {
  app: null,
  auth: null,
  db: null,
  uid: null,
  ready: false,
  _initPromise: null,
  _lastSyncAttemptAt: 0,
  _bgTimer: null,
  DEBOUNCE_MS: 30000,
  CACHE_TTL_MS: 5 * 60 * 1000,
  _rankCache: new Map(),

  isConfigured(cfg) {
    return Boolean(cfg && cfg.apiKey && cfg.apiKey !== "YOUR_API_KEY_HERE" && cfg.projectId && cfg.projectId !== "YOUR_PROJECT_ID");
  },

  async init(firebaseConfig) {
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      if (!this.isConfigured(firebaseConfig)) {
        this.ready = false;
        return null;
      }

      try {
        this.app = initializeApp(firebaseConfig);
        this.auth = getAuth(this.app);
        this.db = getFirestore(this.app);

        await new Promise((resolve) => {
          const unsub = onAuthStateChanged(this.auth, async (user) => {
            if (user) {
              this.uid = user.uid;
              this.ready = true;
              unsub();
              resolve(user.uid);
            } else {
              try {
                const cred = await signInAnonymously(this.auth);
                this.uid = cred.user.uid;
                this.ready = true;
              } catch {
                this.ready = false;
              }
              unsub();
              resolve(this.uid);
            }
          });
        });

        this._bindLifecycleHooks();

        if (this.ready && navigator.onLine) {
          await this.flushOfflineQueue();
          if (this.getSyncCode()) {
            this.syncNow(false);
          }
        }
        return this.uid;
      } catch {
        this.ready = false;
        return null;
      }
    })();

    return this._initPromise;
  },

  _bindLifecycleHooks() {
    if (this._hooksBound) return;
    this._hooksBound = true;

    window.addEventListener("online", () => {
      this.flushOfflineQueue();
      if (this.getSyncCode()) this.syncNow(true);
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && this.getSyncCode()) {
        this.syncNow(false);
      }
    });
  },

  getSyncCode() {
    return (localStorage.getItem(STORAGE_KEYS.SYNC_CODE) || "").trim().toUpperCase();
  },

  getNickname() {
    return (localStorage.getItem(STORAGE_KEYS.NICKNAME) || "").trim() || "匿名考生";
  },

  setNickname(nick) {
    const clean = (nick || "").trim().slice(0, 16) || "匿名考生";
    localStorage.setItem(STORAGE_KEYS.NICKNAME, clean);
    return clean;
  },

  getLastSyncAt() {
    return Number(localStorage.getItem(STORAGE_KEYS.LAST_SYNC_AT) || 0);
  },

  getActorId() {
    const code = this.getSyncCode();
    if (code && /^[A-Z2-9]{6}$/.test(code)) return code;
    return this.uid ? `uid_${this.uid}` : "local_guest";
  },

  /**
   * 단축 키 직렬화 / 역직렬화 (Firestore 1 MiB 문서 크기 한도 방어)
   */
  compactRecords(fullRecords) {
    const out = {};
    for (const [qid, r] of Object.entries(fullRecords || {})) {
      if (!r) continue;
      // 커스텀 문항 ID 제외 (bio_, chem_ 접두사만 클라우드 동기화)
      if (!qid.startsWith("bio_") && !qid.startsWith("chem_")) continue;
      const item = {};
      if (r.studyDone) {
        item.s = true;
        item.su = r.studyUpdatedAt || 0;
      }
      if (r.testStatus) {
        item.t = r.testStatus;
        item.tu = r.testUpdatedAt || 0;
      }
      if (r.bookmarked) {
        item.b = true;
        item.bu = r.bookmarkUpdatedAt || 0;
      }
      if (r.wrongStreak) item.ws = r.wrongStreak;
      if (r.graduated) item.g = true;

      if (Object.keys(item).length > 0) {
        out[qid] = item;
      }
    }
    return out;
  },

  expandRecords(compactMap) {
    const out = {};
    for (const [qid, c] of Object.entries(compactMap || {})) {
      if (!c) continue;
      out[qid] = {
        studyDone: Boolean(c.s),
        studyUpdatedAt: Number(c.su || 0),
        testStatus: c.t || null,
        testUpdatedAt: Number(c.tu || 0),
        bookmarked: Boolean(c.b),
        bookmarkUpdatedAt: Number(c.bu || 0),
        wrongStreak: Number(c.ws || 0),
        graduated: Boolean(c.g)
      };
    }
    return out;
  },

  computeStats(records) {
    let bioSolved = 0, bioCorrect = 0, chemSolved = 0, chemCorrect = 0;
    for (const [qid, r] of Object.entries(records || {})) {
      if (!r || !r.testStatus) continue;
      if (qid.startsWith("bio_")) {
        bioSolved++;
        if (r.testStatus === "correct") bioCorrect++;
      } else if (qid.startsWith("chem_")) {
        chemSolved++;
        if (r.testStatus === "correct") chemCorrect++;
      }
    }
    const totalSolved = bioSolved + chemSolved;
    const totalCorrect = bioCorrect + chemCorrect;
    const accuracy = totalSolved > 0 ? Math.round((totalCorrect / totalSolved) * 1000) / 10 : 0;
    return { bioSolved, bioCorrect, chemSolved, chemCorrect, totalSolved, totalCorrect, accuracy };
  },

  _computeHash(obj) {
    const str = JSON.stringify(obj);
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  },

  /**
   * 6자리 코드 최초 바인딩(랜덤 전용) 또는 기기 간 양방향 병합(기존 코드만 허용)
   */
  async bindAndSync(rawCode, rawNickname, allowCreate = false) {
    const code = (rawCode || "").trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) {
      throw new Error("同步代碼格式錯誤（需為 6 碼英文與數字組合）");
    }
    const nickname = this.setNickname(rawNickname);

    if (!this.ready || !navigator.onLine) {
      localStorage.setItem(STORAGE_KEYS.SYNC_CODE, code);
      return { status: "local_only", mergedCount: 0 };
    }

    const ref = doc(this.db, "sync_profiles", code);
    const snap = await getDoc(ref);

    // 직접 입력한 코드가 DB에 없으면 새 생성 차단 (랜덤 버튼으로만 신규 생성 허용)
    if (!snap.exists() && !allowCreate) {
      throw new Error("查無此同步代碼！若要建立新帳號，請點擊「產生全新代碼」隨機產生。");
    }

    localStorage.setItem(STORAGE_KEYS.SYNC_CODE, code);
    const localFull = JSON.parse(localStorage.getItem(STORAGE_KEYS.USER_RECORDS) || "{}");

    let mergedFull = localFull;
    let status = "created";

    if (snap.exists()) {
      const data = snap.data();
      const boundUids = Array.isArray(data.boundUids) ? data.boundUids : [];
      if (!boundUids.includes(this.uid) && boundUids.length >= 3) {
        throw new Error("此同步代碼已達最多 3 台裝置綁定上限");
      }
      const remoteFull = this.expandRecords(data.records || {});
      mergedFull = window.ProgressStore
        ? window.ProgressStore.mergeRemoteRecords(localFull, remoteFull)
        : { ...remoteFull, ...localFull };

      localStorage.setItem(STORAGE_KEYS.USER_RECORDS, JSON.stringify(mergedFull));
      status = "merged";
    }

    const compact = this.compactRecords(mergedFull);
    const stats = this.computeStats(mergedFull);
    const now = Date.now();

    await setDoc(
      ref,
      {
        syncCode: code,
        nickname,
        boundUids: arrayUnion(this.uid),
        stats,
        records: compact,
        updatedAt: now
      },
      { merge: true }
    );

    localStorage.setItem(STORAGE_KEYS.LAST_SYNC_AT, String(now));
    localStorage.setItem(STORAGE_KEYS.LAST_SYNC_HASH, this._computeHash(compact));
    await this.updateCumulativeRanking(mergedFull, nickname);

    return { status, mergedCount: Object.keys(compact).length };
  },

  /**
   * 30초 디바운싱 + 무변경 쓰기 생략 동기화
   */
  async syncNow(force = false) {
    const code = this.getSyncCode();
    if (!code || !this.ready || !navigator.onLine) return false;

    const now = Date.now();
    if (!force && now - this._lastSyncAttemptAt < this.DEBOUNCE_MS) {
      return false;
    }
    this._lastSyncAttemptAt = now;

    try {
      const ref = doc(this.db, "sync_profiles", code);
      const snap = await getDoc(ref);
      const localFull = JSON.parse(localStorage.getItem(STORAGE_KEYS.USER_RECORDS) || "{}");
      let mergedFull = localFull;

      if (snap.exists()) {
        const remoteFull = this.expandRecords(snap.data().records || {});
        mergedFull = window.ProgressStore
          ? window.ProgressStore.mergeRemoteRecords(localFull, remoteFull)
          : { ...remoteFull, ...localFull };
        localStorage.setItem(STORAGE_KEYS.USER_RECORDS, JSON.stringify(mergedFull));
      }

      const compact = this.compactRecords(mergedFull);
      const newHash = this._computeHash(compact);
      const prevHash = localStorage.getItem(STORAGE_KEYS.LAST_SYNC_HASH);

      if (!force && snap.exists() && newHash === prevHash) {
        localStorage.setItem(STORAGE_KEYS.LAST_SYNC_AT, String(now));
        return true;
      }

      const stats = this.computeStats(mergedFull);
      const nickname = this.getNickname();

      await setDoc(
        ref,
        {
          syncCode: code,
          nickname,
          boundUids: arrayUnion(this.uid),
          stats,
          records: compact,
          updatedAt: now
        },
        { merge: true }
      );

      localStorage.setItem(STORAGE_KEYS.LAST_SYNC_AT, String(now));
      localStorage.setItem(STORAGE_KEYS.LAST_SYNC_HASH, newHash);
      await this.updateCumulativeRanking(mergedFull, nickname);
      return true;
    } catch {
      return false;
    }
  },

  scheduleBackgroundSync() {
    if (!this.getSyncCode()) return;
    clearTimeout(this._bgTimer);
    this._bgTimer = setTimeout(() => {
      this.syncNow(false);
    }, 1500);
  },

  /**
   * 누적 학습량(전체/생물/화학) 리더보드 자동 갱신
   */
  async updateCumulativeRanking(recordsOverride = null, nicknameOverride = null) {
    if (!this.ready || !navigator.onLine || !this.uid) return false;
    const records = recordsOverride || JSON.parse(localStorage.getItem(STORAGE_KEYS.USER_RECORDS) || "{}");
    const stats = this.computeStats(records);
    if (stats.totalSolved <= 0) return false;

    const actorId = this.getActorId();
    const nickname = nicknameOverride || this.getNickname();

    try {
      await setDoc(
        doc(this.db, "rankings_cumulative", actorId),
        {
          id: actorId,
          ownerUid: this.uid,
          nickname,
          totalSolved: stats.totalSolved,
          totalCorrect: stats.totalCorrect,
          accuracy: stats.accuracy,
          bioSolved: stats.bioSolved,
          chemSolved: stats.chemSolved,
          updatedAt: Date.now()
        },
        { merge: true }
      );
      this._rankCache.delete("cum_totalSolved");
      this._rankCache.delete("cum_bioSolved");
      this._rankCache.delete("cum_chemSolved");
      return true;
    } catch {
      return false;
    }
  },

  /**
   * 누적 랭킹 조회 (전체 / 생물 / 화학 문제 수 기준, 5분 TTL 캐시)
   */
  async fetchCumulativeRanking(sortBy = "totalSolved") {
    const validField = ["totalSolved", "bioSolved", "chemSolved"].includes(sortBy)
      ? sortBy
      : "totalSolved";
    const cacheKey = `cum_${validField}`;
    const cached = this._rankCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.CACHE_TTL_MS) {
      return cached.data;
    }
    if (!this.ready || !navigator.onLine) return [];

    try {
      const colRef = collection(this.db, "rankings_cumulative");
      const q = query(colRef, orderBy(validField, "desc"), limit(50));
      const snap = await getDocs(q);
      const list = snap.docs
        .map((d) => d.data())
        .filter((item) => (item[validField] || 0) > 0);

      this._rankCache.set(cacheKey, { ts: Date.now(), data: list });
      return list;
    } catch {
      return [];
    }
  },

  /**
   * 공식 모의고사 회차별 랭킹 등록 (1회 한정 + 최소 풀이 시간 검증)
   */
  async submitExamRanking(examResult, rawNickname) {
    const nickname = this.setNickname(rawNickname);
    if (!this.ready || !navigator.onLine || !this.uid) {
      return { ok: false, reason: "offline" };
    }

    if (examResult.elapsedSeconds < examResult.totalCount * 2) {
      return { ok: false, reason: "too_fast" };
    }

    const actorId = this.getActorId();
    const setKey = examResult.examSetId || "officialA";
    const docId = `${setKey}_${actorId}`;
    const ref = doc(this.db, "rankings_exams", docId);

    try {
      const existing = await getDoc(ref);
      if (existing.exists()) {
        return { ok: false, reason: "already_submitted" };
      }

      await setDoc(ref, {
        setId: setKey,
        subject: examResult.subject,
        examTitle: examResult.examTitle,
        actorId,
        ownerUid: this.uid,
        nickname,
        score: examResult.score,
        correctCount: examResult.correctCount,
        totalCount: examResult.totalCount,
        elapsedSeconds: examResult.elapsedSeconds,
        createdAt: Date.now()
      });

      this._rankCache.delete(`exam_${setKey}`);
      return { ok: true };
    } catch {
      return { ok: false, reason: "error" };
    }
  },

  /**
   * 공식 모의고사 회차별 랭킹 조회 (5분 TTL 캐시)
   */
  async fetchExamRanking(setId) {
    const cacheKey = `exam_${setId}`;
    const cached = this._rankCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.CACHE_TTL_MS) {
      return cached.data;
    }
    if (!this.ready || !navigator.onLine) return [];

    try {
      const q = query(
        collection(this.db, "rankings_exams"),
        where("setId", "==", setId),
        orderBy("score", "desc"),
        orderBy("elapsedSeconds", "asc"),
        limit(50)
      );
      const snap = await getDocs(q);
      const list = snap.docs.map((d) => d.data());
      this._rankCache.set(cacheKey, { ts: Date.now(), data: list });
      return list;
    } catch {
      return [];
    }
  },

  /**
   * 중앙 집중식 문항 오류 제보 전송 (오프라인 시 큐 적재)
   */
  async submitIssueReport(payload) {
    const docData = {
      subject: payload.subject,
      chapterId: payload.chapterId || "",
      chapterTitle: payload.chapterTitle || "",
      questionId: payload.questionId,
      type: payload.type || "其他問題",
      memo: (payload.memo || "").slice(0, 500),
      status: "open",
      reporterUid: this.uid || "offline_user",
      createdAt: Date.now(),
      resolvedAt: null
    };

    if (!this.ready || !navigator.onLine) {
      this._enqueueOffline({ kind: "issue_report", data: docData });
      return false;
    }

    try {
      await addDoc(collection(this.db, "issue_reports"), docData);
      return true;
    } catch {
      this._enqueueOffline({ kind: "issue_report", data: docData });
      return false;
    }
  },

  /**
   * 개발자 일반 건의함 전송
   */
  async submitFeedback(content, category = "功能建議") {
    const docData = {
      category,
      content: (content || "").slice(0, 1000),
      reporterUid: this.uid || "offline_user",
      isRead: false,
      createdAt: Date.now()
    };

    if (!this.ready || !navigator.onLine) {
      this._enqueueOffline({ kind: "user_feedback", data: docData });
      return false;
    }

    try {
      await addDoc(collection(this.db, "user_feedbacks"), docData);
      return true;
    } catch {
      this._enqueueOffline({ kind: "user_feedback", data: docData });
      return false;
    }
  },

  _enqueueOffline(item) {
    try {
      const queue = JSON.parse(localStorage.getItem(STORAGE_KEYS.OFFLINE_QUEUE) || "[]");
      queue.push(item);
      localStorage.setItem(STORAGE_KEYS.OFFLINE_QUEUE, JSON.stringify(queue));
    } catch {}
  },

  async flushOfflineQueue() {
    if (!this.ready || !navigator.onLine) return;
    let queue = [];
    try {
      queue = JSON.parse(localStorage.getItem(STORAGE_KEYS.OFFLINE_QUEUE) || "[]");
    } catch {}
    if (queue.length === 0) return;

    const remain = [];
    for (const item of queue) {
      try {
        if (item.kind === "issue_report") {
          await addDoc(collection(this.db, "issue_reports"), item.data);
        } else if (item.kind === "user_feedback") {
          await addDoc(collection(this.db, "user_feedbacks"), item.data);
        }
      } catch {
        remain.push(item);
      }
    }
    localStorage.setItem(STORAGE_KEYS.OFFLINE_QUEUE, JSON.stringify(remain));
  },

  /**
   * 관리자 스튜디오용 제보함·건의함 클라우드 조회
   */
  async fetchAdminInbox(statusFilter = "open") {
    if (!this.ready || !navigator.onLine) {
      return { reports: [], feedbacks: [], offline: true };
    }

    try {
      const repQuery = statusFilter === "all"
        ? query(collection(this.db, "issue_reports"), orderBy("createdAt", "desc"), limit(50))
        : query(collection(this.db, "issue_reports"), where("status", "==", statusFilter), orderBy("createdAt", "desc"), limit(50));

      const fbQuery = query(collection(this.db, "user_feedbacks"), orderBy("createdAt", "desc"), limit(50));

      const [repSnap, fbSnap] = await Promise.all([getDocs(repQuery), getDocs(fbQuery)]);
      const reports = repSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      let feedbacks = fbSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

      if (statusFilter === "open") {
        feedbacks = feedbacks.filter((f) => !f.isRead);
      } else if (statusFilter === "resolved") {
        feedbacks = feedbacks.filter((f) => Boolean(f.isRead));
      }

      return { reports, feedbacks, offline: false };
    } catch {
      return { reports: [], feedbacks: [], offline: true };
    }
  },
  
/**
   * 관리자 제보 수정 완료 처리
   */
  async resolveIssueReport(reportId, adminPin) {
    if (!this.ready || !navigator.onLine || !reportId) return false;
    try {
      await updateDoc(doc(this.db, "issue_reports", reportId), {
        status: "resolved",
        resolvedAt: Date.now(),
        adminPin: String(adminPin || "")
      });
      return true;
    } catch {
      return false;
    }
  },

  /**
   * 관리자 건의함(피드백) 확인 완료 처리
   */
  async resolveFeedback(feedbackId) {
    if (!this.ready || !navigator.onLine || !feedbackId) return false;
    try {
      await updateDoc(doc(this.db, "user_feedbacks", feedbackId), {
        isRead: true,
        resolvedAt: Date.now()
      });
      return true;
    } catch {
      return false;
    }
  }
};

window.CloudSync = CloudSync;
export default CloudSync;
