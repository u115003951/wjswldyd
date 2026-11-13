/**
 * ============================================================================
 * 2단계·3단계 통합 모듈: 대용량(1,200p+) PDF 청크 파서 · 생물/화학 보정 · 분할 크롭 · AdminStudio · 클라우드 제보함
 * ============================================================================
 */
(() => {
  /**
   * 1. 이미지 자동 최적화기 (최대 가로 1000px 리사이징 + WebP 0.82 압축)
   */
  const ImageOptimizer = {
    async compressToWebP(sourceBlobOrCanvas, maxWidth = 1000, quality = 0.82) {
      let canvas;
      if (sourceBlobOrCanvas instanceof HTMLCanvasElement) {
        canvas = sourceBlobOrCanvas;
      } else {
        const bitmap = await createImageBitmap(sourceBlobOrCanvas);
        const scale = bitmap.width > maxWidth ? maxWidth / bitmap.width : 1;
        canvas = document.createElement("canvas");
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
      }

      if (canvas.width > maxWidth) {
        const scale = maxWidth / canvas.width;
        const resized = document.createElement("canvas");
        resized.width = Math.round(canvas.width * scale);
        resized.height = Math.round(canvas.height * scale);
        resized.getContext("2d").drawImage(canvas, 0, 0, resized.width, resized.height);
        canvas = resized;
      }

      return new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob), "image/webp", quality);
      });
    }
  };

  /**
   * 2. 생물 / 화학 텍스트 & 수식 정밀 후처리기
   */
  const TextNormalizer = {
    normalize(rawText, mode = "biology") {
      if (!rawText) return "";
      let text = rawText.replace(/\s+/g, " ").trim();

      text = text.replace(/\$([^$]+)\$/g, (_, inner) => {
        return inner
          .replace(/\\rightarrow/g, " → ")
          .replace(/\\leftrightarrow/g, " ⇌ ")
          .replace(/\\equiv/g, "≡")
          .replace(/\\times/g, "×")
          .replace(/\\circ/g, "°")
          .replace(/~/g, " ")
          .replace(/_\{([^}]+)\}/g, "<sub>$1</sub>")
          .replace(/_([0-9a-zA-Z+-]+)/g, "<sub>$1</sub>")
          .replace(/\^\{([^}]+)\}/g, "<sup>$1</sup>")
          .replace(/\^([0-9+-]+)/g, "<sup>$1</sup>");
      });

      if (mode === "chemistry") {
        text = text.replace(/\b([A-Z][a-z]?(?:\d+)?(?:[A-Z][a-z]?\d*)*)\s*([2-9]?[+-])(?=\s|[,.;:)\]）]|$)/g, (m, formula, charge) => {
          const subbed = formula.replace(/([A-Za-z\)])(\d+)/g, "$1<sub>$2</sub>");
          return `${subbed}<sup>${charge}</sup>`;
        });

        text = text.replace(/\b((?:[A-Z][a-z]?\d*|\([A-Za-z0-9]+\)\d+){2,}|[A-Z][a-z]?\d+)\b/g, (token) => {
          if (/^(Section|Page|Chapter|Ans|Answer|Category)$/i.test(token)) return token;
          return token.replace(/([A-Za-z\)])(\d+)/g, "$1<sub>$2</sub>");
        });

        text = text.replace(/<=>|<->/g, "⇌").replace(/->/g, "→");
      } else {
        text = text.replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, "$1");
        text = text.replace(/([A-Za-z0-9])([\u4e00-\u9fff])/g, "$1 $2");
        text = text.replace(/([\u4e00-\u9fff])([A-Za-z0-9])/g, "$1 $2");
        text = text
          .replace(/\b(CO|H2O|O2|NAD|FAD|FADH2)\b/g, (m) => m.replace(/(\D)(\d+)/g, "$1<sub>$2</sub>"))
          .replace(/\bNAD\+/g, "NAD<sup>+</sup>");
      }

      return text.trim();
    }
  };

  /**
   * 3. 대용량(1,200p+) 논블로킹 PDF 청크 파서
   */
  const PdfChunkParser = {
    cancelled: false,

    cancel() {
      this.cancelled = true;
    },

    parseAnswerLine(line) {
      const colonIdx = line.search(/[:：]/);
      if (colonIdx > 0 && colonIdx <= 22) {
        const label = line.slice(0, colonIdx).replace(/\s+/g, "").toLowerCase();
        const after = line.slice(colonIdx + 1).trim();
        const validLabels = new Set([
          "answer", "ans", "ansewr", "ansewer", "aswer", "answr", "answ", "解答", "答案"
        ]);
        if (validLabels.has(label)) {
          const valMatch = after.match(/^([A-Ea-e]|True|False|T|F)(?:\b|[).．、\s]|$)/i);
          if (valMatch) return valMatch[1].toUpperCase();
        }
      }
      const fallback = line.match(/^(?:a\s*n\s*s(?:\s*w\s*e\s*r|\s*e\s*w\s*e?\s*r)?|解答|答案)\s+([A-Ea-e]|True|False)\b/i);
      if (fallback) return fallback[1].toUpperCase();
      return null;
    },

    async parsePdfFile(file, mode = "biology", { onProgress, forcedChapterId = null, startSeq = 0 } = {}) {
      this.cancelled = false;
      const arrayBuffer = await file.arrayBuffer();
      const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const totalPages = pdfDoc.numPages;
      const CHUNK_SIZE = 20;

      const chapters = [];
      let currentChapter = forcedChapterId
        ? { id: forcedChapterId, title: "지정 단원", order: 1 }
        : { id: "ch01", title: "Chapter 1 (기본 단원)", order: 1 };
      chapters.push(currentChapter);

      const questions = [];
      let curQ = null;
      let curOptIdx = -1;
      let chapterSeqMap = { [currentChapter.id]: startSeq };

      const ensureChapter = (rawTitle) => {
        if (forcedChapterId) return;
        const clean = rawTitle.trim();
        let found = chapters.find((c) => c.title === clean);
        if (!found) {
          const order = chapters.length + 1;
          const id = "ch" + String(order).padStart(2, "0");
          found = { id, title: clean, order };
          chapters.push(found);
          chapterSeqMap[id] = 0;
        }
        currentChapter = found;
        if (chapters[0].title === "Chapter 1 (기본 단원)" && questions.length === 0 && chapters.length > 1) {
          chapters.shift();
        }
      };

      const finalizeQuestion = () => {
        if (!curQ) return;
        const prefix = mode === "biology" ? "bio" : "chem";
        chapterSeqMap[curQ.chapterId] = (chapterSeqMap[curQ.chapterId] || 0) + 1;
        const seq = String(chapterSeqMap[curQ.chapterId]).padStart(4, "0");

        const qHtml = TextNormalizer.normalize(curQ.rawStem, mode);
        const optLen = curQ.rawOptions.length;
        const opts = [];
        for (let i = 0; i < optLen; i++) {
          const rawOpt = curQ.rawOptions[i];
          opts.push({
            origIdx: i,
            textHtml: rawOpt ? TextNormalizer.normalize(rawOpt, mode) : ""
          });
        }

        const needsImage = /following information|following table|shown below|represented below|accompanying figure|下圖|附圖/i.test(curQ.rawStem);

        questions.push({
          id: `${prefix}_${curQ.chapterId}_${seq}`,
          chapterId: curQ.chapterId,
          questionHtml: qHtml,
          image: null,
          options: opts,
          answerIndex: curQ.answerIndex,
          explanationHtml: curQ.rawExplanation ? TextNormalizer.normalize(curQ.rawExplanation, mode) : "",
          sourcePage: curQ.sourcePage,
          needsImage
        });

        curQ = null;
        curOptIdx = -1;
      };

      for (let startPage = 1; startPage <= totalPages; startPage += CHUNK_SIZE) {
        if (this.cancelled) throw new Error("PDF 분석이 취소되었습니다.");
        const endPage = Math.min(startPage + CHUNK_SIZE - 1, totalPages);

        for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
          const page = await pdfDoc.getPage(pageNum);
          const viewport = page.getViewport({ scale: 1.0 });
          const textContent = await page.getTextContent();
          const lines = this.extractOrderedLines(textContent.items, viewport.width);

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (/^Copyright\s*©/i.test(trimmed)) continue;
            if (/^Page\s+\d+$/i.test(trimmed)) continue;
            if (/^\d+$/.test(trimmed)) continue;
            if (/^(Bloom's Taxonomy|Category|Section|Learning Outcome|Global LO|Topic)\s*:/i.test(trimmed)) continue;

            if (/^\d+\.\d+\s+(?:Multiple-Choice|Student Edition|End-of-Chapter|Self-Quiz|Test Your Understanding|Concept Check).*/i.test(trimmed)) {
              finalizeQuestion();
              continue;
            }

            if (/^(Chapter\s+\d+[:\s].+|第\s*\d+\s*章.+)/i.test(trimmed)) {
              finalizeQuestion();
              ensureChapter(trimmed);
              continue;
            }

            const ansToken = curQ ? this.parseAnswerLine(trimmed) : null;
            if (ansToken && curQ) {
              if (ansToken === "TRUE" || ansToken === "T" || ansToken === "FALSE" || ansToken === "F") {
                if (curQ.rawOptions.length === 0) {
                  curQ.rawOptions = ["True", "False"];
                }
                curQ.answerIndex = (ansToken === "TRUE" || ansToken === "T") ? 0 : 1;
              } else {
                const map = { A: 0, B: 1, C: 2, D: 3, E: 4 };
                curQ.answerIndex = map[ansToken] ?? null;
              }
              continue;
            }

            const qStartMatch = trimmed.match(/^(?:\(?(\d{1,4})[).．、])\s+(.+)/);
            if (qStartMatch) {
              const validOptCount = curQ ? curQ.rawOptions.filter((v) => v && v.trim()).length : 0;
              const isNewQuestion = !curQ || curQ.answerIndex !== null || validOptCount >= 2;
              if (isNewQuestion) {
                finalizeQuestion();
                curQ = {
                  chapterId: currentChapter.id,
                  sourcePage: pageNum,
                  rawStem: qStartMatch[2],
                  rawOptions: [],
                  answerIndex: null,
                  rawExplanation: ""
                };
                curOptIdx = -1;
                continue;
              }
            }

            if (!curQ) continue;

            const inlineOpts = [...trimmed.matchAll(/(?:^|\s)\(?([A-E])[)．.]\s+([^\n]+?)(?=\s+\(?[A-E][)．.]\s+|$)/g)];
            if (inlineOpts.length >= 2) {
              for (const m of inlineOpts) {
                const idx = { A: 0, B: 1, C: 2, D: 3, E: 4 }[m[1]];
                curQ.rawOptions[idx] = m[2].trim();
                curOptIdx = idx;
              }
              continue;
            }

            const singleOptMatch = trimmed.match(/^\(?([A-E])[)．.]\s*(.*)/);
            if (singleOptMatch) {
              const idx = { A: 0, B: 1, C: 2, D: 3, E: 4 }[singleOptMatch[1]];
              curQ.rawOptions[idx] = singleOptMatch[2].trim();
              curOptIdx = idx;
              continue;
            }

            const expMatch = trimmed.match(/^(?:Explanation|解析)\s*[:：]\s*(.*)/i);
            if (expMatch) {
              curQ.rawExplanation = expMatch[1];
              curOptIdx = -2;
              continue;
            }

            if (curOptIdx === -2) {
              curQ.rawExplanation += " " + trimmed;
            } else if (curOptIdx >= 0) {
              curQ.rawOptions[curOptIdx] = (curQ.rawOptions[curOptIdx] || "") + " " + trimmed;
            } else {
              curQ.rawStem += " " + trimmed;
            }
          }
        }

        if (onProgress) onProgress(endPage, totalPages, questions.length);
        await new Promise((r) => setTimeout(r, 0));
      }

      finalizeQuestion();
      return { chapters, questions };
    },

    extractOrderedLines(items, pageWidth) {
      if (!items || items.length === 0) return [];
      const midX = pageWidth * 0.48;
      let leftCount = 0;
      let rightCount = 0;

      const mapped = items
        .filter((it) => it.str && it.str.trim().length > 0)
        .map((it) => {
          const x = it.transform[4];
          const y = it.transform[5];
          if (x < midX - 20) leftCount++;
          else if (x > midX + 20) rightCount++;
          return { str: it.str, x, y };
        });

      const isTwoColumn = leftCount > 15 && rightCount > 15 && Math.abs(leftCount - rightCount) < Math.max(leftCount, rightCount) * 0.65;

      const groupToLines = (arr) => {
        arr.sort((a, b) => (Math.abs(b.y - a.y) > 4 ? b.y - a.y : a.x - b.x));
        const lines = [];
        let curY = null;
        let buf = [];
        for (const item of arr) {
          if (curY === null || Math.abs(item.y - curY) <= 4.5) {
            buf.push(item.str);
            if (curY === null) curY = item.y;
          } else {
            lines.push(buf.join(" "));
            buf = [item.str];
            curY = item.y;
          }
        }
        if (buf.length > 0) lines.push(buf.join(" "));
        return lines;
      };

      if (isTwoColumn) {
        const leftItems = mapped.filter((m) => m.x < midX);
        const rightItems = mapped.filter((m) => m.x >= midX);
        return [...groupToLines(leftItems), ...groupToLines(rightItems)];
      }
      return groupToLines(mapped);
    }
  };

  /**
   * 4. 관리자 비주얼 에디터 & PDF 분할 화면 크롭 스튜디오 & 클라우드 제보함
   */
  const AdminStudio = {
    state: {
      activeTab: "editor", // editor | pdfImport | examSets | reports
      targetSubject: "biology",
      workingData: null,
      selectedChapterFilter: "ALL",
      selectedQuestionId: null,
      pinnedQuestionId: null, // 이상 문항 필터 중 수정 완료되어도 현재 보고 있는 문항은 화면에서 이탈하지 않도록 고정
      onlyAbnormal: false,
      searchQuery: "",
      imageBlobs: new Map(),
      pdfDoc: null,
      pdfPageNum: 1,
      pdfTotalPages: 0,
      stagingQuestions: [],
      stagingChapters: [],
      reportStatusFilter: "open",
      cloudReports: [],
      cloudFeedbacks: [],
      cloudInboxLoaded: false
    },

    async mount(container) {
      this.container = container;
      if (!this.state.workingData) {
        await this.loadSubjectForEdit(this.state.targetSubject);
      }
      await this.refreshCloudInbox();
      this.bindPasteListener();
      this.render();
    },

    async loadSubjectForEdit(subject) {
      this.state.targetSubject = subject;
      this.state.selectedChapterFilter = "ALL";
      this.state.pinnedQuestionId = null;
      const cached = await LocalIDB.getDataset(`cache_${subject}`);
      const base = cached || JSON.parse(JSON.stringify(EMBEDDED_DEFAULT_DATA[subject]));
      this.state.workingData = JSON.parse(JSON.stringify(base));
      this.sortChaptersByOrder();
      this.state.selectedQuestionId = this.state.workingData.questions[0]?.id || null;
    },

    async loadFromDeployedGithub() {
      const subject = this.state.targetSubject;
      try {
        const res = await fetch(`./data/${subject}.json?t=${Date.now()}`);
        if (!res.ok) throw new Error(`서버에서 data/${subject}.json 파일을 찾을 수 없습니다 (HTTP ${res.status}).`);
        const json = await res.json();
        if (!json || !Array.isArray(json.questions)) throw new Error("올바른 문제은행 JSON 형식이 아닙니다.");

        this.state.workingData = json;
        this.state.selectedChapterFilter = "ALL";
        this.state.pinnedQuestionId = null;
        this.sortChaptersByOrder();
        this.state.selectedQuestionId = json.questions[0]?.id || null;
        await LocalIDB.setDataset(`cache_${subject}`, json);
        this.render();
        App.showToast(`GitHub 배포본(data/${subject}.json, 총 ${json.questions.length}문항)을 성공적으로 불러왔습니다!`, "success");
      } catch (err) {
        App.showToast(err.message || "GitHub 배포본을 불러오지 못했습니다.", "error");
      }
    },

    triggerLocalJsonImport() {
      const input = document.getElementById("admin-local-json-input");
      if (input) {
        input.value = "";
        input.click();
      }
    },

    async handleLocalJsonFile(file) {
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        if (!json || !Array.isArray(json.questions) || !Array.isArray(json.chapters)) {
          throw new Error("유효한 문제은행 JSON 구조(chapters, questions 포함)가 아닙니다.");
        }
        const subject = json.subject === "chemistry" ? "chemistry" : (json.subject === "biology" ? "biology" : this.state.targetSubject);
        this.state.targetSubject = subject;
        this.state.workingData = json;
        this.state.selectedChapterFilter = "ALL";
        this.state.pinnedQuestionId = null;
        this.sortChaptersByOrder();
        this.state.selectedQuestionId = json.questions[0]?.id || null;
        await LocalIDB.setDataset(`cache_${subject}`, json);
        this.render();
        App.showToast(`로컬 파일(${file.name}, 총 ${json.questions.length}문항)을 불러왔습니다!`, "success");
      } catch (err) {
        App.showToast(err.message || "JSON 파일을 읽는 중 오류가 발생했습니다.", "error");
      }
    },

    getAbnormalReasons(q) {
      if (!q) return ["문항 데이터 없음"];
      const reasons = [];
      if (!App.stripHtml(q.questionHtml).trim()) {
        reasons.push("지문 누락");
      }
      if (!Array.isArray(q.options) || q.options.length < 4) {
        reasons.push(`선지 ${q.options?.length || 0}개`);
      } else {
        const emptyLabels = [];
        const letters = ["A", "B", "C", "D", "E"];
        q.options.forEach((opt, idx) => {
          if (!opt || !App.stripHtml(opt.textHtml || "").trim()) {
            emptyLabels.push(letters[idx] || `${idx + 1}번`);
          }
        });
        if (emptyLabels.length > 0) {
          reasons.push(`선지 ${emptyLabels.join(",")} 공백`);
        }
      }
      if (
        q.answerIndex === null ||
        q.answerIndex === undefined ||
        q.answerIndex < 0 ||
        q.answerIndex >= (q.options?.length || 0) ||
        !App.stripHtml(q.options?.[q.answerIndex]?.textHtml || "").trim()
      ) {
        reasons.push("정답 확인필요");
      }
      if (q.needsImage && !q.image) {
        reasons.push("그림/표 미첨부");
      }
      return reasons;
    },

    isAbnormalQuestion(q) {
      return this.getAbnormalReasons(q).length > 0;
    },

    bindPasteListener() {
      if (this._pasteBound) return;
      this._pasteBound = true;
      document.addEventListener("paste", async (e) => {
        if (App.state.view !== "admin" || !this.state.selectedQuestionId) return;
        const items = e.clipboardData?.items || [];
        for (const item of items) {
          if (item.type.startsWith("image/")) {
            e.preventDefault();
            const rawBlob = item.getAsFile();
            if (!rawBlob) return;
            const optimized = await ImageOptimizer.compressToWebP(rawBlob, 1000, 0.82);
            await this.attachImageToSelectedQuestion(optimized);
            App.showToast("클립보드 이미지가 WebP로 자동 압축되어 첨부되었습니다!", "success");
            break;
          }
        }
      });
    },

    async attachImageToSelectedQuestion(webpBlob) {
      const q = this.state.workingData.questions.find((item) => item.id === this.state.selectedQuestionId);
      if (!q) return;
      // 이상 문항 필터 중 수정된 경우에도 현재 보고 있는 문항이 목록에서 즉시 사라지지 않도록 고정
      if (this.state.onlyAbnormal) {
        this.state.pinnedQuestionId = q.id;
      }
      const filePath = `images/${q.id}.webp`;
      this.state.imageBlobs.set(filePath, webpBlob);
      ImageResolver.registerTempUrl(filePath, URL.createObjectURL(webpBlob));
      q.image = filePath;
      q.needsImage = false;
      await LocalIDB.setDataset(`cache_${this.state.targetSubject}`, this.state.workingData);
      this.render();
    },

    render() {
      const { activeTab, targetSubject, workingData, cloudInboxLoaded, cloudReports } = this.state;
      const localReports = JSON.parse(localStorage.getItem(ProgressStore.REPORTS_KEY) || "[]");
      const openReportsCount = cloudInboxLoaded
        ? cloudReports.filter((r) => r.status === "open").length
        : localReports.filter((r) => r.status === "open").length;
      const abnormalCount = workingData.questions.filter((q) => this.isAbnormalQuestion(q)).length;

      this.container.innerHTML = `
        <div class="space-y-4">
          <input id="admin-local-json-input" type="file" accept=".json" class="hidden" onchange="AdminStudio.handleLocalJsonFile(this.files[0])" />
          <input id="admin-chapter-replace-pdf-input" type="file" accept=".pdf" class="hidden" onchange="AdminStudio.handleChapterReplacePdf(this.files[0])" />

          <!-- 상단 관리자 툴바 -->
          <div class="bg-slate-900 text-white rounded-2xl p-4 flex flex-col xl:flex-row items-start xl:items-center justify-between gap-3">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
                <i data-lucide="shield-check" class="w-5 h-5"></i>
              </div>
              <div>
                <div class="flex flex-wrap items-center gap-2">
                  <h2 class="font-bold text-base">관리자 문제은행 스튜디오 (Admin Studio)</h2>
                  <select onchange="AdminStudio.switchSubject(this.value)" class="bg-slate-800 border border-slate-700 text-xs font-bold rounded-lg px-2.5 py-1 text-amber-300">
                    <option value="biology" ${targetSubject === "biology" ? "selected" : ""}>편집 과목: 생물 (biology.json)</option>
                    <option value="chemistry" ${targetSubject === "chemistry" ? "selected" : ""}>편집 과목: 화학 (chemistry.json)</option>
                  </select>
                </div>
                <p class="text-xs text-slate-400 mt-0.5">배포본 불러오기 · 챕터별 일괄 편집/교체 · Ctrl+V 이미지 첨부 · ZIP 내보내기 후 GitHub 업로드</p>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-2 self-end xl:self-auto">
              <button onclick="AdminStudio.loadFromDeployedGithub()" class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sky-300 font-bold text-xs flex items-center gap-1.5" title="현재 사이트에 배포된 data/${targetSubject}.json 파일을 불러옵니다">
                <i data-lucide="cloud-download" class="w-3.5 h-3.5"></i> GitHub 배포본 불러오기
              </button>
              <button onclick="AdminStudio.triggerLocalJsonImport()" class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-bold text-xs flex items-center gap-1.5" title="PC에 저장된 JSON 파일을 불러옵니다">
                <i data-lucide="folder-open" class="w-3.5 h-3.5"></i> 로컬 JSON 열기
              </button>
              <button onclick="AdminStudio.exportZipBundle()" class="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center gap-1.5 shadow-xs">
                <i data-lucide="archive" class="w-4 h-4"></i> 일괄 내보내기 (.zip)
              </button>
              <button onclick="App.goHome()" class="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold">관리자 나가기</button>
            </div>
          </div>

          <!-- 4대 기능 탭 바 -->
          <div class="flex flex-wrap gap-2">
            <button onclick="AdminStudio.setTab('editor')" class="px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 ${activeTab === "editor" ? "bg-blue-600 text-white" : "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800"}">
              <i data-lucide="edit-3" class="w-4 h-4"></i> 문제은행 비주얼 에디터
              ${abnormalCount > 0 ? `<span class="px-1.5 py-0.2 rounded-full bg-amber-400 text-slate-950 text-[10px]">이상 ${abnormalCount}건</span>` : ""}
            </button>
            <button onclick="AdminStudio.setTab('pdfImport')" class="px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 ${activeTab === "pdfImport" ? "bg-blue-600 text-white" : "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800"}">
              <i data-lucide="file-search" class="w-4 h-4"></i> PDF 단원별 일괄 가져오기
            </button>
            <button onclick="AdminStudio.setTab('examSets')" class="px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 ${activeTab === "examSets" ? "bg-blue-600 text-white" : "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800"}">
              <i data-lucide="clipboard-list" class="w-4 h-4"></i> 공식 모의고사 회차 관리
            </button>
            <button onclick="AdminStudio.setTab('reports')" class="px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 ${activeTab === "reports" ? "bg-blue-600 text-white" : "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800"}">
              <i data-lucide="flag" class="w-4 h-4"></i> 오류 제보 및 건의함
              ${openReportsCount > 0 ? `<span class="px-1.5 py-0.2 rounded-full bg-rose-500 text-white text-[10px]">${openReportsCount}</span>` : ""}
            </button>
          </div>

          <!-- 탭 컨텐츠 영역 -->
          <div id="admin-tab-content">
            ${activeTab === "editor" ? this.renderEditorTabHtml() : ""}
            ${activeTab === "pdfImport" ? this.renderPdfImportTabHtml() : ""}
            ${activeTab === "examSets" ? this.renderExamSetsTabHtml() : ""}
            ${activeTab === "reports" ? this.renderReportsTabHtml() : ""}
          </div>
        </div>
      `;
      lucide.createIcons();
      if (this.state.pdfDoc && (activeTab === "editor" || activeTab === "pdfImport")) {
        this.renderPdfCanvasPage();
      }
    },

    async switchSubject(subject) {
      await this.loadSubjectForEdit(subject);
      this.render();
    },

    async setTab(tab) {
      this.state.activeTab = tab;
      if (tab === "reports") {
        await this.refreshCloudInbox();
      }
      this.render();
    },

    async refreshCloudInbox(filterOverride = null) {
      if (filterOverride) this.state.reportStatusFilter = filterOverride;
      if (window.CloudSync && window.CloudSync.ready && navigator.onLine) {
        const res = await window.CloudSync.fetchAdminInbox(this.state.reportStatusFilter);
        this.state.cloudReports = res.reports;
        this.state.cloudFeedbacks = res.feedbacks;
        this.state.cloudInboxLoaded = !res.offline;
      } else {
        this.state.cloudInboxLoaded = false;
      }
    },

    /**
     * =========================================================================
     * 탭 1: 비주얼 에디터 + 챕터별 일괄 관리 + 이상 문항 필터 + PDF 분할 크롭 패널
     * =========================================================================
     */
    renderEditorTabHtml() {
      const { workingData, selectedChapterFilter, selectedQuestionId, pinnedQuestionId, onlyAbnormal, searchQuery, pdfDoc } = this.state;

      let list = workingData.questions;
      if (selectedChapterFilter !== "ALL") {
        list = list.filter((q) => q.chapterId === selectedChapterFilter);
      }
      if (onlyAbnormal) {
        list = list.filter((q) => this.isAbnormalQuestion(q) || q.id === pinnedQuestionId);
      }
      if (searchQuery.trim()) {
        const kw = searchQuery.toLowerCase();
        list = list.filter((q) => q.id.toLowerCase().includes(kw) || App.stripHtml(q.questionHtml).toLowerCase().includes(kw));
      }

      const selectedQ = list.find((q) => q.id === selectedQuestionId) || list[0] || null;
      if (selectedQ && selectedQ.id !== selectedQuestionId) {
        this.state.selectedQuestionId = selectedQ.id;
      }

      const activeChapterObj = selectedChapterFilter !== "ALL"
        ? workingData.chapters.find((c) => c.id === selectedChapterFilter)
        : null;
      const chapterQCount = selectedChapterFilter !== "ALL"
        ? workingData.questions.filter((q) => q.chapterId === selectedChapterFilter).length
        : workingData.questions.length;

      return `
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div class="lg:col-span-5 space-y-3">
            <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-3.5 space-y-2.5">
              <div class="flex items-center justify-between gap-2">
                <label class="text-xs font-bold text-slate-600 dark:text-slate-300 shrink-0">단원(챕터) 선택:</label>
                <select onchange="AdminStudio.setChapterFilter(this.value)" class="flex-1 px-2.5 py-1.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-bold">
                  <option value="ALL" ${selectedChapterFilter === "ALL" ? "selected" : ""}>전체 챕터 보기 (${workingData.chapters.length}개 단원 · 총 ${workingData.questions.length}문항)</option>
                  ${workingData.chapters.map((ch) => {
                    const cnt = workingData.questions.filter((q) => q.chapterId === ch.id).length;
                    return `<option value="${ch.id}" ${selectedChapterFilter === ch.id ? "selected" : ""}>${ch.title} (${cnt}문항)</option>`;
                  }).join("")}
                </select>
              </div>

              ${activeChapterObj ? `
                <div class="p-2.5 rounded-xl bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-800/60 space-y-2">
                  <div class="flex items-center gap-1.5">
                    <input id="edit-chapter-title-input" type="text" value="${activeChapterObj.title.replace(/"/g, "&quot;")}" class="flex-1 px-2.5 py-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-semibold" placeholder="챕터 제목 수정..." />
                    <button onclick="AdminStudio.renameSelectedChapter()" class="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold shrink-0">이름 저장</button>
                  </div>
                  <div class="grid grid-cols-2 gap-1.5 pt-1">
                    <button onclick="AdminStudio.autoMatchAnswersFromBank()" class="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold flex items-center justify-center gap-1" title="기존 문제은행에서 동일/유사 문제를 찾아 정답·해설·이미지를 자동으로 채웁니다">
                      <i data-lucide="sparkles" class="w-3 h-3"></i> 문제은행 자동 정답 매칭
                    </button>
                    <button onclick="AdminStudio.pinSelectedChapterToTop()" class="px-2.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-[11px] font-bold flex items-center justify-center gap-1" title="이 단원(기출 족보 등)을 1단원 맨 앞으로 이동시킵니다">
                      <i data-lucide="arrow-up-to-line" class="w-3 h-3"></i> 1단원 맨 앞으로 고정
                    </button>
                    <button onclick="AdminStudio.triggerChapterReplacePdf()" class="px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-bold flex items-center justify-center gap-1">
                      <i data-lucide="refresh-cw" class="w-3 h-3"></i> 이 챕터 PDF 재업로드 교체
                    </button>
                    <button onclick="AdminStudio.deleteSelectedChapterAll()" class="px-2.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold flex items-center justify-center gap-1">
                      <i data-lucide="trash-2" class="w-3 h-3"></i> 챕터 전체 삭제 (${chapterQCount}문항)
                    </button>
                  </div>
                </div>
              ` : `
                <div class="flex flex-wrap items-center justify-between gap-1.5 text-[11px] text-slate-400 px-1">
                  <span>특정 챕터 선택 시 자동 정답 매칭 · 1단원 앞 고정 · PDF 교체가 가능합니다.</span>
                  <div class="flex items-center gap-2 shrink-0">
                    <button onclick="AdminStudio.addNewChapter(true)" class="text-amber-600 dark:text-amber-400 hover:underline font-bold">+ 기출 족보(맨 앞)</button>
                    <span class="text-slate-300">|</span>
                    <button onclick="AdminStudio.addNewChapter(false)" class="text-blue-600 hover:underline font-bold">+ 새 챕터</button>
                  </div>
                </div>
              `}
            </div>

            <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-3.5 space-y-2.5">
              <div class="flex items-center justify-between gap-2">
                <input type="text" value="${searchQuery}" oninput="AdminStudio.setSearchQuery(this.value)" placeholder="문항 ID 또는 본문 키워드 검색..." class="flex-1 px-3 py-1.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs" />
                <button onclick="AdminStudio.addNewQuestion()" class="px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold shrink-0">+ 새 문항 추가</button>
              </div>
              <div class="flex items-center justify-between">
                <label class="flex items-center gap-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400 cursor-pointer">
                  <input type="checkbox" ${onlyAbnormal ? "checked" : ""} onchange="AdminStudio.toggleAbnormalFilter(this.checked)" class="rounded text-amber-500" />
                  <span>확인 필요 이상 문항만 보기</span>
                </label>
                <span class="text-[11px] text-slate-400">표시 중: ${list.length} / 범위 ${chapterQCount}문항</span>
              </div>

              <div class="max-h-[380px] overflow-y-auto space-y-1.5 pr-1">
                ${list.length === 0 ? `<div class="text-center text-xs text-slate-400 py-8">조건에 해당하는 문항이 없습니다.</div>` : list.map((q) => {
                  const isSel = selectedQ && q.id === selectedQ.id;
                  const reasons = this.getAbnormalReasons(q);
                  const isResolvedPinned = onlyAbnormal && reasons.length === 0 && q.id === pinnedQuestionId;
                  return `
                    <button onclick="AdminStudio.selectQuestion('${q.id}')" class="w-full text-left p-2.5 rounded-xl border text-xs transition ${isSel ? "border-blue-600 bg-blue-50 dark:bg-blue-950/50" : "border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50"}">
                      <div class="flex items-center justify-between gap-1">
                        <span class="font-mono font-bold ${isSel ? "text-blue-600 dark:text-blue-400" : "text-slate-500"}">${q.id}</span>
                        <div class="flex items-center gap-1 flex-wrap justify-end">
                          ${q.image ? `<span class="px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-700 text-[10px]">이미지</span>` : ""}
                          ${reasons.length > 0 ? `<span class="px-1.5 py-0.2 rounded bg-amber-100 text-amber-800 text-[10px] font-bold">${reasons[0]}</span>` : ""}
                          ${isResolvedPinned ? `<span class="px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-800 text-[10px] font-bold">수정 완료 ✓</span>` : ""}
                        </div>
                      </div>
                      <div class="truncate text-slate-700 dark:text-slate-300 mt-1">${App.stripHtml(q.questionHtml) || "(빈 문제 지문)"}</div>
                    </button>
                  `;
                }).join("")}
              </div>
            </div>

            ${pdfDoc ? this.renderSplitPdfCropperHtml(selectedQ?.sourcePage) : `
              <div class="bg-slate-100 dark:bg-slate-900/60 border border-dashed border-slate-300 dark:border-slate-700 rounded-2xl p-4 text-center text-xs text-slate-500">
                💡 안내: PDF를 불러오면 이곳에 원본 PDF 분할 화면이 나타나 마우스 드래그로 그림·표를 바로 잘라 넣을 수 있습니다.
              </div>
            `}
          </div>

          <div class="lg:col-span-7">
            ${selectedQ ? this.renderQuestionFormHtml(selectedQ, list) : `
              <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-10 text-center text-xs text-slate-400">왼쪽 목록에서 문항을 선택하거나 「+ 새 문항 추가」를 눌러주세요.</div>
            `}
          </div>
        </div>
      `;
    },

    sortChaptersByOrder() {
      const { workingData } = this.state;
      if (!workingData || !Array.isArray(workingData.chapters)) return;
      workingData.chapters.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    },

    normalizeMatchText(html) {
      return App.stripHtml(html || "")
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
        .trim();
    },

    computeTextSimilarity(strA, strB) {
      if (!strA || !strB) return 0;
      if (strA === strB) return 1;
      const tokensA = strA.split(/\s+/).filter(Boolean);
      const tokensB = strB.split(/\s+/).filter(Boolean);
      if (tokensA.length === 0 || tokensB.length === 0) return 0;
      const setB = new Set(tokensB);
      let common = 0;
      for (const t of tokensA) {
        if (setB.has(t)) common++;
      }
      return (2 * common) / (tokensA.length + tokensB.length);
    },

    async pinSelectedChapterToTop() {
      const { workingData, selectedChapterFilter, targetSubject } = this.state;
      if (selectedChapterFilter === "ALL") return;
      const ch = workingData.chapters.find((c) => c.id === selectedChapterFilter);
      if (!ch) return;

      const minOrder = workingData.chapters.reduce((min, item) => Math.min(min, item.order ?? 1), 1);
      ch.order = minOrder <= 0 ? minOrder - 1 : 0;
      if (!ch.title.startsWith("📌")) {
        ch.title = `📌 [기출 족보] ${ch.title}`;
      }
      this.sortChaptersByOrder();
      await LocalIDB.setDataset(`cache_${targetSubject}`, workingData);
      this.render();
      App.showToast(`[${ch.title}] 단원이 1단원 맨 앞으로 고정 배치되었습니다!`, "success");
    },

    async autoMatchAnswersFromBank() {
      const { workingData, selectedChapterFilter, targetSubject } = this.state;
      if (selectedChapterFilter === "ALL") return;

      const targetQuestions = workingData.questions.filter((q) => q.chapterId === selectedChapterFilter);
      const bankQuestions = workingData.questions.filter(
        (q) =>
          q.chapterId !== selectedChapterFilter &&
          q.answerIndex !== null &&
          q.answerIndex !== undefined &&
          App.stripHtml(q.questionHtml || "").trim().length >= 12
      );

      if (bankQuestions.length === 0) {
        App.showToast("비교할 기존 문제은행(정답이 등록된 타 단원 문항)이 없습니다.", "warning");
        return;
      }

      const indexedBank = bankQuestions.map((bq) => ({
        q: bq,
        normStem: this.normalizeMatchText(bq.questionHtml),
        normOpts: (bq.options || []).map((o) => this.normalizeMatchText(o.textHtml))
      }));

      let matchedCount = 0;

      for (const tq of targetQuestions) {
        if (tq.answerIndex !== null && tq.answerIndex !== undefined && !this.isAbnormalQuestion(tq)) {
          continue;
        }
        const normTargetStem = this.normalizeMatchText(tq.questionHtml);
        if (!normTargetStem) continue;

        let bestMatch = null;
        let bestScore = 0;

        for (const item of indexedBank) {
          const score = this.computeTextSimilarity(normTargetStem, item.normStem);
          if (score > bestScore) {
            bestScore = score;
            bestMatch = item;
          }
        }

        if (bestMatch && bestScore >= 0.82) {
          const srcQ = bestMatch.q;
          const srcCorrectOptNorm = bestMatch.normOpts[srcQ.answerIndex] || "";
          let mappedAnswerIdx = srcQ.answerIndex;

          if (srcCorrectOptNorm && Array.isArray(tq.options) && tq.options.length > 0) {
            let bestOptIdx = -1;
            let bestOptSim = 0;
            tq.options.forEach((opt, idx) => {
              const sim = this.computeTextSimilarity(this.normalizeMatchText(opt.textHtml), srcCorrectOptNorm);
              if (sim > bestOptSim) {
                bestOptSim = sim;
                bestOptIdx = idx;
              }
            });
            if (bestOptIdx >= 0 && bestOptSim >= 0.75) {
              mappedAnswerIdx = bestOptIdx;
            }
          }

          tq.answerIndex = mappedAnswerIdx;
          if (!App.stripHtml(tq.explanationHtml || "").trim() && srcQ.explanationHtml) {
            tq.explanationHtml = srcQ.explanationHtml;
          }
          if (!tq.image && srcQ.image) {
            tq.image = srcQ.image;
            tq.needsImage = false;
          }
          matchedCount++;
        }
      }

      await LocalIDB.setDataset(`cache_${targetSubject}`, workingData);
      this.render();
      const remainCount = targetQuestions.filter((q) => this.isAbnormalQuestion(q)).length;
      App.showToast(
        `자동 매칭 완료! ${matchedCount}문항의 정답·해설을 문제은행에서 복원했습니다. (남은 검수 필요: ${remainCount}문항)`,
        matchedCount > 0 ? "success" : "info"
      );
    },

    setChapterFilter(chId) {
      this.state.selectedChapterFilter = chId;
      this.state.pinnedQuestionId = null;
      let filtered = chId === "ALL"
        ? this.state.workingData.questions
        : this.state.workingData.questions.filter((q) => q.chapterId === chId);
      if (this.state.onlyAbnormal) {
        filtered = filtered.filter((q) => this.isAbnormalQuestion(q));
      }
      const firstQ = filtered[0] || null;
      this.state.selectedQuestionId = firstQ?.id || null;
      if (firstQ?.sourcePage && this.state.pdfDoc) {
        this.state.pdfPageNum = firstQ.sourcePage;
      }
      this.render();
    },

    async addNewChapter(isPastExam = false) {
      const { workingData, targetSubject } = this.state;
      const order = isPastExam ? 0 : workingData.chapters.length + 1;
      const newId = (isPastExam ? "past_" : "ch") + String(Date.now()).slice(-5);
      const defaultTitle = isPastExam
        ? "📌 [기출 족보] 2025학년도 기출문제"
        : `Chapter ${workingData.chapters.length + 1}`;
      const title = prompt(
        isPastExam
          ? "1단원 맨 앞에 배치할 기출 족보 이름을 입력하세요:"
          : "새로 추가할 단원(챕터) 이름을 입력하세요:",
        defaultTitle
      );
      if (!title || !title.trim()) return;

      if (isPastExam) {
        const minOrder = workingData.chapters.reduce((min, item) => Math.min(min, item.order ?? 1), 1);
        workingData.chapters.unshift({ id: newId, title: title.trim(), order: minOrder <= 0 ? minOrder - 1 : 0 });
      } else {
        workingData.chapters.push({ id: newId, title: title.trim(), order });
      }
      this.sortChaptersByOrder();
      this.state.selectedChapterFilter = newId;
      this.state.pinnedQuestionId = null;
      await LocalIDB.setDataset(`cache_${targetSubject}`, workingData);
      this.render();
      App.showToast(`새 단원(${title.trim()})이 생성되었습니다.`, "success");
    },

    async renameSelectedChapter() {
      const { workingData, selectedChapterFilter, targetSubject } = this.state;
      if (selectedChapterFilter === "ALL") return;
      const input = document.getElementById("edit-chapter-title-input");
      const newTitle = input?.value.trim();
      if (!newTitle) {
        App.showToast("단원 이름을 입력해 주세요.", "warning");
        return;
      }
      const ch = workingData.chapters.find((c) => c.id === selectedChapterFilter);
      if (ch) {
        ch.title = newTitle;
        await LocalIDB.setDataset(`cache_${targetSubject}`, workingData);
        this.render();
        App.showToast("단원 이름이 수정되었습니다.", "success");
      }
    },

    async deleteSelectedChapterAll() {
      const { workingData, selectedChapterFilter, targetSubject } = this.state;
      if (selectedChapterFilter === "ALL") return;
      const ch = workingData.chapters.find((c) => c.id === selectedChapterFilter);
      if (!ch) return;

      const targetQuestions = workingData.questions.filter((q) => q.chapterId === selectedChapterFilter);
      const ok = confirm(`정말 [${ch.title}] 단원과 그 안에 포함된 ${targetQuestions.length}개 문제를 전부 삭제하시겠습니까?\n(삭제 후 다른 챕터 문항들의 고유 ID는 유지됩니다.)`);
      if (!ok) return;

      targetQuestions.forEach((q) => {
        if (q.image) this.state.imageBlobs.delete(q.image);
      });

      workingData.questions = workingData.questions.filter((q) => q.chapterId !== selectedChapterFilter);
      workingData.chapters = workingData.chapters.filter((c) => c.id !== selectedChapterFilter);

      this.state.selectedChapterFilter = "ALL";
      this.state.pinnedQuestionId = null;
      this.state.selectedQuestionId = workingData.questions[0]?.id || null;
      await LocalIDB.setDataset(`cache_${targetSubject}`, workingData);
      this.render();
      App.showToast(`[${ch.title}] 단원 및 ${targetQuestions.length}개 문항이 일괄 삭제되었습니다.`, "info");
    },

    triggerChapterReplacePdf() {
      if (this.state.selectedChapterFilter === "ALL") return;
      const input = document.getElementById("admin-chapter-replace-pdf-input");
      if (input) {
        input.value = "";
        input.click();
      }
    },

    async handleChapterReplacePdf(file) {
      const { workingData, selectedChapterFilter, targetSubject } = this.state;
      if (!file || selectedChapterFilter === "ALL") return;

      const ch = workingData.chapters.find((c) => c.id === selectedChapterFilter);
      if (!ch) return;

      const oldQuestions = workingData.questions.filter((q) => q.chapterId === selectedChapterFilter);
      const ok = confirm(`[${ch.title}] 단원의 기존 ${oldQuestions.length}개 문제를 지우고, 선택한 PDF(${file.name})에서 추출한 문제들로 교체하시겠습니까?`);
      if (!ok) return;

      try {
        App.showToast(`[${ch.title}] PDF 분석 중... 잠시만 기다려 주세요.`, "info");
        const buf = await file.arrayBuffer();
        this.state.pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
        this.state.pdfTotalPages = this.state.pdfDoc.numPages;
        this.state.pdfPageNum = 1;

        const res = await PdfChunkParser.parsePdfFile(file, targetSubject, {
          forcedChapterId: selectedChapterFilter,
          startSeq: 0
        });

        if (res.questions.length === 0) {
          App.showToast("선택한 PDF에서 추출된 문항이 없어 기존 데이터를 유지했습니다.", "warning");
          return;
        }

        oldQuestions.forEach((q) => {
          if (q.image) this.state.imageBlobs.delete(q.image);
        });
        workingData.questions = workingData.questions.filter((q) => q.chapterId !== selectedChapterFilter);
        workingData.questions.push(...res.questions);

        this.state.pinnedQuestionId = null;
        this.state.selectedQuestionId = res.questions[0]?.id || null;
        await LocalIDB.setDataset(`cache_${targetSubject}`, workingData);
        this.render();
        App.showToast(`[${ch.title}] 단원이 새 PDF의 ${res.questions.length}문항으로 교체되었습니다!`, "success");
      } catch (err) {
        App.showToast(err.message || "챕터 PDF 교체 중 오류가 발생했습니다.", "error");
      }
    },

    renderQuestionFormHtml(q, currentList = []) {
      const { workingData, onlyAbnormal } = this.state;
      const letters = ["A", "B", "C", "D", "E"];
      const opts = [...(q.options || [])];
      while (opts.length < 4) opts.push({ origIdx: opts.length, textHtml: "" });
      const abnormalReasons = this.getAbnormalReasons(q);

      const curIdx = currentList.findIndex((item) => item.id === q.id);
      const nextQ = curIdx >= 0 && curIdx + 1 < currentList.length ? currentList[curIdx + 1] : null;

      return `
        <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100 dark:border-slate-800">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-mono text-xs font-bold px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800">${q.id}</span>
              <select onchange="AdminStudio.updateQuestionField('chapterId', this.value)" class="text-xs font-semibold px-2.5 py-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800">
                ${workingData.chapters.map((ch) => `<option value="${ch.id}" ${ch.id === q.chapterId ? "selected" : ""}>${ch.title}</option>`).join("")}
              </select>
              ${abnormalReasons.length > 0 ? `
                <span class="px-2 py-0.5 rounded-lg bg-amber-100 text-amber-800 text-[11px] font-bold">검수 사유: ${abnormalReasons.join(", ")}</span>
              ` : `
                <span class="px-2 py-0.5 rounded-lg bg-emerald-100 text-emerald-700 text-[11px] font-bold">정상 문항 ${onlyAbnormal ? "(현재 화면 유지됨)" : ""}</span>
              `}
            </div>
            <div class="flex items-center gap-1.5">
              ${nextQ ? `
                <button onclick="AdminStudio.selectQuestion('${nextQ.id}')" class="px-2.5 py-1 rounded-lg text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white">다음 문항 ▶</button>
              ` : ""}
              <button onclick="AdminStudio.addOptionSlot()" ${opts.length >= 5 ? "disabled" : ""} class="px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-100 dark:bg-slate-800 disabled:opacity-40">+ 5번 보기(E) 추가</button>
              <button onclick="AdminStudio.deleteSelectedQuestion()" class="px-2.5 py-1 rounded-lg text-xs font-semibold text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40">이 문항 삭제</button>
            </div>
          </div>

          <div class="space-y-1">
            <div class="flex items-center justify-between">
              <label class="text-xs font-bold">문제 지문 (HTML &lt;sub&gt; / &lt;sup&gt; 태그 지원):</label>
              <button onclick="AdminStudio.autoFormatChemOnCurrent()" class="text-[11px] text-blue-600 hover:underline font-semibold">화학식 위·아래첨자 자동 보정</button>
            </div>
            <textarea rows="3" oninput="AdminStudio.updateQuestionField('questionHtml', this.value)" class="w-full p-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-mono">${q.questionHtml || ""}</textarea>
          </div>

          <div class="p-3 rounded-xl border border-dashed border-blue-300 dark:border-blue-800 bg-blue-50/40 dark:bg-blue-950/20 space-y-2">
            <div class="flex items-center justify-between text-xs">
              <span class="font-bold text-blue-700 dark:text-blue-300">첨부 이미지 (이 화면에서 Ctrl+V로 캡처 붙여넣기 또는 왼쪽 PDF 드래그 크롭)</span>
              ${q.image ? `<button onclick="AdminStudio.removeQuestionImage()" class="text-rose-600 font-semibold hover:underline">이미지 제거</button>` : ""}
            </div>
            ${q.image ? `
              <div class="flex items-center gap-3">
                ${ImageResolver.renderImageTagHtml(q.image)}
                <span class="text-[11px] font-mono text-slate-500">${q.image}</span>
              </div>
            ` : `<div class="text-[11px] text-slate-400">첨부된 이미지가 없습니다.</div>`}
          </div>

          <div class="space-y-2">
            <label class="text-xs font-bold block">보기 선택지 및 정답 지정 (왼쪽 라디오 버튼 클릭):</label>
            ${opts.map((opt, idx) => {
              const isEmptyOpt = !App.stripHtml(opt.textHtml || "").trim();
              return `
                <div class="flex items-center gap-2">
                  <input type="radio" name="admin-correct-ans" ${q.answerIndex === idx ? "checked" : ""} onchange="AdminStudio.updateQuestionField('answerIndex', ${idx})" class="w-4 h-4 text-emerald-600" />
                  <span class="w-6 text-xs font-bold text-center ${isEmptyOpt ? "text-rose-500" : ""}">${letters[idx]}</span>
                  <input type="text" value="${(opt.textHtml || "").replace(/"/g, "&quot;")}" placeholder="${isEmptyOpt ? "⚠ 비어 있는 선지입니다 (입력 필요)" : ""}" oninput="AdminStudio.updateOptionText(${idx}, this.value)" class="flex-1 px-3 py-1.5 rounded-xl border ${isEmptyOpt ? "border-amber-400 bg-amber-50/50 dark:bg-amber-950/20" : "border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800"} text-xs" />
                </div>
              `;
            }).join("")}
          </div>

          <div class="space-y-1">
            <label class="text-xs font-bold block">해설 (선택 사항):</label>
            <textarea rows="2" oninput="AdminStudio.updateQuestionField('explanationHtml', this.value)" class="w-full p-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs">${q.explanationHtml || ""}</textarea>
          </div>

          <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2">
            <div class="text-[11px] font-bold text-slate-400">실시간 렌더링 미리보기 (학생 화면 기준):</div>
            <div id="admin-live-preview" class="question-html text-sm leading-relaxed">${q.questionHtml || ""}</div>
          </div>
        </div>
      `;
    },

    setSearchQuery(val) {
      this.state.searchQuery = val;
      this.render();
    },

    toggleAbnormalFilter(checked) {
      this.state.onlyAbnormal = checked;
      this.state.pinnedQuestionId = null;

      if (checked) {
        let filtered = this.state.workingData.questions;
        if (this.state.selectedChapterFilter !== "ALL") {
          filtered = filtered.filter((q) => q.chapterId === this.state.selectedChapterFilter);
        }
        if (this.state.searchQuery.trim()) {
          const kw = this.state.searchQuery.toLowerCase();
          filtered = filtered.filter((q) => q.id.toLowerCase().includes(kw) || App.stripHtml(q.questionHtml).toLowerCase().includes(kw));
        }
        const firstAbnormal = filtered.find((q) => this.isAbnormalQuestion(q));
        if (firstAbnormal) {
          this.state.selectedQuestionId = firstAbnormal.id;
          if (firstAbnormal.sourcePage && this.state.pdfDoc) {
            this.state.pdfPageNum = firstAbnormal.sourcePage;
          }
        }
      }
      this.render();
    },

    selectQuestion(qid) {
      // 사용자가 명시적으로 다른 문항을 선택하면 이전 문항 고정 해제
      if (this.state.pinnedQuestionId && this.state.pinnedQuestionId !== qid) {
        this.state.pinnedQuestionId = null;
      }
      this.state.selectedQuestionId = qid;
      const q = this.state.workingData.questions.find((item) => item.id === qid);
      if (q?.sourcePage && this.state.pdfDoc) {
        this.state.pdfPageNum = q.sourcePage;
      }
      this.render();
    },

    async updateQuestionField(field, value) {
      const q = this.state.workingData.questions.find((item) => item.id === this.state.selectedQuestionId);
      if (!q) return;
      if (this.state.onlyAbnormal) {
        this.state.pinnedQuestionId = q.id;
      }
      q[field] = value;
      await LocalIDB.setDataset(`cache_${this.state.targetSubject}`, this.state.workingData);
      if (field === "questionHtml") {
        const prev = document.getElementById("admin-live-preview");
        if (prev) prev.innerHTML = value;
      }
      if (field === "chapterId" || field === "answerIndex") {
        this.render();
      }
    },

    async updateOptionText(idx, value) {
      const q = this.state.workingData.questions.find((item) => item.id === this.state.selectedQuestionId);
      if (!q) return;
      if (this.state.onlyAbnormal) {
        this.state.pinnedQuestionId = q.id;
      }
      while (q.options.length <= idx) q.options.push({ origIdx: q.options.length, textHtml: "" });
      q.options[idx].textHtml = value;
      await LocalIDB.setDataset(`cache_${this.state.targetSubject}`, this.state.workingData);
    },

    async addOptionSlot() {
      const q = this.state.workingData.questions.find((item) => item.id === this.state.selectedQuestionId);
      if (!q || q.options.length >= 5) return;
      if (this.state.onlyAbnormal) {
        this.state.pinnedQuestionId = q.id;
      }
      q.options.push({ origIdx: q.options.length, textHtml: "" });
      await LocalIDB.setDataset(`cache_${this.state.targetSubject}`, this.state.workingData);
      this.render();
    },

    async removeQuestionImage() {
      const q = this.state.workingData.questions.find((item) => item.id === this.state.selectedQuestionId);
      if (!q) return;
      if (this.state.onlyAbnormal) {
        this.state.pinnedQuestionId = q.id;
      }
      if (q.image) this.state.imageBlobs.delete(q.image);
      q.image = null;
      await LocalIDB.setDataset(`cache_${this.state.targetSubject}`, this.state.workingData);
      this.render();
    },

    async autoFormatChemOnCurrent() {
      const q = this.state.workingData.questions.find((item) => item.id === this.state.selectedQuestionId);
      if (!q) return;
      if (this.state.onlyAbnormal) {
        this.state.pinnedQuestionId = q.id;
      }
      q.questionHtml = TextNormalizer.normalize(q.questionHtml, "chemistry");
      q.options = q.options.map((o) => ({ ...o, textHtml: TextNormalizer.normalize(o.textHtml, "chemistry") }));
      await LocalIDB.setDataset(`cache_${this.state.targetSubject}`, this.state.workingData);
      this.render();
      App.showToast("화학식 위·아래첨자 보정이 적용되었습니다.", "success");
    },

    async addNewQuestion() {
      const { workingData, targetSubject, selectedChapterFilter } = this.state;
      const defaultCh = selectedChapterFilter !== "ALL"
        ? selectedChapterFilter
        : (workingData.chapters[0]?.id || "ch01");
      const prefix = targetSubject === "biology" ? "bio" : "chem";

      let maxNum = 0;
      workingData.questions.forEach((item) => {
        const m = item.id.match(/_(\d+)$/);
        if (m && item.chapterId === defaultCh) {
          maxNum = Math.max(maxNum, parseInt(m[1], 10));
        }
      });

      const newId = `${prefix}_${defaultCh}_${String(maxNum + 1).padStart(4, "0")}`;
      const newQ = {
        id: newId,
        chapterId: defaultCh,
        questionHtml: "새 문제 지문을 입력하세요...",
        image: null,
        options: [
          { origIdx: 0, textHtml: "" },
          { origIdx: 1, textHtml: "" },
          { origIdx: 2, textHtml: "" },
          { origIdx: 3, textHtml: "" }
        ],
        answerIndex: 0,
        explanationHtml: ""
      };

      workingData.questions.push(newQ);
      this.state.selectedQuestionId = newId;
      await LocalIDB.setDataset(`cache_${targetSubject}`, workingData);
      this.render();
      App.showToast(`새 문항 (${newId})이 추가되었습니다.`, "success");
    },

    async deleteSelectedQuestion() {
      const { workingData, selectedQuestionId, targetSubject } = this.state;
      if (!selectedQuestionId) return;
      if (this.state.pinnedQuestionId === selectedQuestionId) {
        this.state.pinnedQuestionId = null;
      }
      workingData.questions = workingData.questions.filter((q) => q.id !== selectedQuestionId);
      this.state.selectedQuestionId = workingData.questions[0]?.id || null;
      await LocalIDB.setDataset(`cache_${targetSubject}`, workingData);
      this.render();
      App.showToast("문항이 삭제되었습니다 (기존 다른 문항의 고유 번호는 유지됩니다).", "info");
    },

    renderSplitPdfCropperHtml(sourcePageHint) {
      const { pdfPageNum, pdfTotalPages } = this.state;
      return `
        <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-3 space-y-2">
          <div class="flex items-center justify-between text-xs">
            <span class="font-bold text-indigo-600 dark:text-indigo-400">PDF 분할 크롭 뷰어 (마우스로 영역 드래그)</span>
            <div class="flex items-center gap-1">
              ${sourcePageHint && sourcePageHint !== pdfPageNum ? `
                <button onclick="AdminStudio.jumpPdfPage(${sourcePageHint})" class="px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-bold text-[11px]">출처 ${sourcePageHint}p 이동</button>
              ` : ""}
              <button onclick="AdminStudio.jumpPdfPage(${pdfPageNum - 1})" ${pdfPageNum <= 1 ? "disabled" : ""} class="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 disabled:opacity-40">◀</button>
              <span class="font-mono px-1">${pdfPageNum}/${pdfTotalPages}</span>
              <button onclick="AdminStudio.jumpPdfPage(${pdfPageNum + 1})" ${pdfPageNum >= pdfTotalPages ? "disabled" : ""} class="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 disabled:opacity-40">▶</button>
            </div>
          </div>
          <div class="relative overflow-auto max-h-[380px] border border-slate-200 dark:border-slate-700 rounded-xl bg-slate-100 dark:bg-slate-950 select-none">
            <canvas id="pdf-crop-canvas" class="w-full cursor-crosshair block"></canvas>
            <div id="pdf-crop-selection-box" class="hidden absolute border-2 border-rose-500 bg-rose-500/20 pointer-events-none"></div>
          </div>
        </div>
      `;
    },

    jumpPdfPage(num) {
      if (!this.state.pdfDoc) return;
      if (num < 1 || num > this.state.pdfTotalPages) return;
      this.state.pdfPageNum = num;
      this.render();
    },

    async renderPdfCanvasPage() {
      const canvas = document.getElementById("pdf-crop-canvas");
      const selBox = document.getElementById("pdf-crop-selection-box");
      if (!canvas || !this.state.pdfDoc) return;

      const page = await this.state.pdfDoc.getPage(this.state.pdfPageNum);
      const viewport = page.getViewport({ scale: 2.0 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;

      let startX = 0, startY = 0, dragging = false;

      canvas.onmousedown = (e) => {
        const rect = canvas.getBoundingClientRect();
        startX = e.clientX - rect.left;
        startY = e.clientY - rect.top;
        dragging = true;
        if (selBox) {
          selBox.style.left = `${startX}px`;
          selBox.style.top = `${startY}px`;
          selBox.style.width = "0px";
          selBox.style.height = "0px";
          selBox.classList.remove("hidden");
        }
      };

      canvas.onmousemove = (e) => {
        if (!dragging || !selBox) return;
        const rect = canvas.getBoundingClientRect();
        const curX = e.clientX - rect.left;
        const curY = e.clientY - rect.top;
        const x = Math.min(startX, curX);
        const y = Math.min(startY, curY);
        const w = Math.abs(curX - startX);
        const h = Math.abs(curY - startY);
        selBox.style.left = `${x}px`;
        selBox.style.top = `${y}px`;
        selBox.style.width = `${w}px`;
        selBox.style.height = `${h}px`;
      };

      canvas.onmouseup = async (e) => {
        if (!dragging) return;
        dragging = false;
        if (selBox) selBox.classList.add("hidden");

        const rect = canvas.getBoundingClientRect();
        const endX = e.clientX - rect.left;
        const endY = e.clientY - rect.top;
        const x = Math.min(startX, endX);
        const y = Math.min(startY, endY);
        const w = Math.abs(endX - startX);
        const h = Math.abs(endY - startY);

        if (w < 15 || h < 15) return;

        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;

        const cropCanvas = document.createElement("canvas");
        cropCanvas.width = Math.round(w * scaleX);
        cropCanvas.height = Math.round(h * scaleY);
        cropCanvas.getContext("2d").drawImage(
          canvas,
          Math.round(x * scaleX), Math.round(y * scaleY), cropCanvas.width, cropCanvas.height,
          0, 0, cropCanvas.width, cropCanvas.height
        );

        const webpBlob = await ImageOptimizer.compressToWebP(cropCanvas, 1000, 0.85);
        await this.attachImageToSelectedQuestion(webpBlob);
        App.showToast("선택한 영역이 잘려 현재 문항에 자동 첨부되었습니다!", "success");
      };
    },

    renderPdfImportTabHtml() {
      const { stagingQuestions, stagingChapters, targetSubject } = this.state;
      return `
        <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-5">
          <div>
            <h3 class="font-bold text-base">PDF 단원(챕터)별 일괄 가져오기</h3>
            <p class="text-xs text-slate-500 mt-1">수천 페이지짜리 통파일 대신 <strong>단원(Chapter)별로 분할된 PDF</strong>를 하나씩 업로드하면, 단원 오인식 없이 정확한 챕터 구조로 문제은행에 누적됩니다.</p>
          </div>

          <div class="p-3.5 rounded-xl bg-blue-50/70 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800/60 text-xs text-blue-900 dark:text-blue-200 flex items-start gap-2">
            <i data-lucide="info" class="w-4 h-4 text-blue-600 shrink-0 mt-0.5"></i>
            <div>
              <strong>권장 업로드 방식:</strong> PDF 파일을 선택하면 파일명이 「저장할 단원명」에 자동 입력되며, 해당 PDF의 전체 문항이 지정한 <strong>단일 챕터</strong>로 깔끔하게 묶입니다. (단원명을 지우고 비워둘 경우에만 본문 내 <code>Chapter N</code> 헤더를 자동 탐색합니다.)
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
            <div>
              <label class="text-xs font-bold block mb-1">1. 과목 전용 파싱 규칙 선택</label>
              <select id="admin-pdf-mode" class="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-bold">
                <option value="biology" ${targetSubject === "biology" ? "selected" : ""}>생물 모드 (용어 줄바꿈 병합 + 단원말 문제 구분)</option>
                <option value="chemistry" ${targetSubject === "chemistry" ? "selected" : ""}>화학 모드 (위·아래첨자 + 이온 전하 + 화살표 보정)</option>
              </select>
            </div>
            <div>
              <label class="text-xs font-bold block mb-1">2. 단원(챕터) PDF 파일 선택</label>
              <input id="admin-pdf-file" type="file" accept=".pdf" onchange="const inp=document.getElementById('admin-pdf-chapter-title'); if(inp && !inp.value.trim() && this.files[0]) inp.value=this.files[0].name.replace(/\\.pdf$/i,'');" class="w-full text-xs file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 font-semibold" />
            </div>
            <div>
              <label class="text-xs font-bold block mb-1">3. 저장할 단원(챕터)명</label>
              <input id="admin-pdf-chapter-title" type="text" placeholder="예: Chapter 1 細胞結構 (자동 입력)" class="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-semibold" />
            </div>
            <div class="flex gap-2">
              <button onclick="AdminStudio.runAdminPdfParse()" class="flex-1 py-2 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs">PDF 분석 시작</button>
              <button onclick="PdfChunkParser.cancel()" class="py-2 px-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold">중단</button>
            </div>
          </div>

          <div id="admin-pdf-progress" class="hidden space-y-1.5 bg-slate-50 dark:bg-slate-800 p-3.5 rounded-xl">
            <div class="flex justify-between text-xs font-bold">
              <span id="admin-pdf-prog-label">분석 준비 중...</span>
              <span id="admin-pdf-prog-pct">0%</span>
            </div>
            <div class="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
              <div id="admin-pdf-prog-bar" class="h-full bg-blue-600 transition-all" style="width: 0%"></div>
            </div>
          </div>

          ${stagingQuestions.length > 0 ? `
            <div class="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="text-xs font-bold text-emerald-600">
                  분석 완료! [${stagingChapters.map((c) => c.title).join(", ")}] — 총 ${stagingQuestions.length}문항 추출됨 (검수 필요 ${stagingQuestions.filter((q) => this.isAbnormalQuestion(q)).length}문항 포함)
                </div>
                <div class="flex gap-2">
                  <button onclick="AdminStudio.mergeStagingToWorking(false)" class="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs">기존 문제은행에 새 단원으로 추가</button>
                  <button onclick="AdminStudio.mergeStagingToWorking(true)" class="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs">기존 전체 지우고 덮어쓰기</button>
                </div>
              </div>
              <div class="max-h-64 overflow-y-auto space-y-2 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
                ${stagingQuestions.slice(0, 50).map((q) => `
                  <div class="text-xs p-2 rounded-lg bg-slate-50 dark:bg-slate-800/60 flex items-center justify-between gap-2">
                    <span class="truncate"><strong>[${q.id}]</strong> ${App.stripHtml(q.questionHtml)}</span>
                    <span class="shrink-0 font-mono text-[11px] text-slate-400">${q.sourcePage}p · 정답:${q.answerIndex !== null ? ["A","B","C","D","E"][q.answerIndex] : "확인필요"}</span>
                  </div>
                `).join("")}
                ${stagingQuestions.length > 50 ? `<div class="text-center text-[11px] text-slate-400 py-1">...상위 50문항만 미리 표시됩니다. 병합 후 비주얼 에디터에서 전체 문항을 편집할 수 있습니다.</div>` : ""}
              </div>
            </div>
          ` : ""}
        </div>
      `;
    },

    async runAdminPdfParse() {
      const file = document.getElementById("admin-pdf-file")?.files?.[0];
      if (!file) {
        App.showToast("먼저 PDF 파일을 선택해 주세요.", "warning");
        return;
      }
      const mode = document.getElementById("admin-pdf-mode")?.value || "biology";
      const customChapterTitle = (document.getElementById("admin-pdf-chapter-title")?.value || "").trim();
      const progBox = document.getElementById("admin-pdf-progress");
      const label = document.getElementById("admin-pdf-prog-label");
      const pctEl = document.getElementById("admin-pdf-prog-pct");
      const bar = document.getElementById("admin-pdf-prog-bar");

      progBox.classList.remove("hidden");

      try {
        const buf = await file.arrayBuffer();
        this.state.pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
        this.state.pdfTotalPages = this.state.pdfDoc.numPages;
        this.state.pdfPageNum = 1;

        const forcedId = customChapterTitle ? "ch_stage_01" : null;
        const res = await PdfChunkParser.parsePdfFile(file, mode, {
          forcedChapterId: forcedId,
          startSeq: 0,
          onProgress: (cur, total, count) => {
            const p = Math.round((cur / total) * 100);
            label.textContent = `분석 중: ${cur} / ${total} 페이지 (추출된 문항: ${count}개)...`;
            pctEl.textContent = `${p}%`;
            bar.style.width = `${p}%`;
          }
        });

        if (customChapterTitle && res.chapters.length > 0) {
          res.chapters[0].title = customChapterTitle;
        }

        this.state.stagingChapters = res.chapters;
        this.state.stagingQuestions = res.questions;
        this.render();
        App.showToast(`분석 완료! 총 ${res.questions.length}문항이 검수 대기열에 등록되었습니다.`, "success");
      } catch (err) {
        App.showToast(err.message || "PDF 분석 중 오류가 발생했습니다.", "error");
      }
    },

    async mergeStagingToWorking(replaceAll = false) {
      const { workingData, stagingChapters, stagingQuestions, targetSubject } = this.state;
      if (replaceAll) {
        workingData.chapters = [...stagingChapters];
        workingData.questions = [...stagingQuestions];
      } else {
        stagingChapters.forEach((sc) => {
          const existing = workingData.chapters.find((c) => c.title === sc.title);
          if (existing) {
            const oldId = sc.id;
            const prefix = targetSubject === "biology" ? "bio" : "chem";
            let maxNum = 0;
            workingData.questions.forEach((item) => {
              const m = item.id.match(/_(\d+)$/);
              if (m && item.chapterId === existing.id) {
                maxNum = Math.max(maxNum, parseInt(m[1], 10));
              }
            });
            stagingQuestions.forEach((sq) => {
              if (sq.chapterId === oldId) {
                maxNum += 1;
                sq.chapterId = existing.id;
                sq.id = `${prefix}_${existing.id}_${String(maxNum).padStart(4, "0")}`;
              }
            });
          } else {
            const order = workingData.chapters.length + 1;
            const newChId = "ch" + String(order).padStart(2, "0");
            const oldId = sc.id;
            const prefix = targetSubject === "biology" ? "bio" : "chem";
            workingData.chapters.push({ id: newChId, title: sc.title, order });
            stagingQuestions.forEach((sq) => {
              if (sq.chapterId === oldId) {
                sq.chapterId = newChId;
                sq.id = sq.id.replace(new RegExp(`^${prefix}_${oldId}_`), `${prefix}_${newChId}_`);
              }
            });
          }
        });
        workingData.questions.push(...stagingQuestions);
      }

      this.state.stagingQuestions = [];
      this.state.selectedChapterFilter = "ALL";
      this.state.pinnedQuestionId = null;
      this.state.selectedQuestionId = workingData.questions[0]?.id || null;
      await LocalIDB.setDataset(`cache_${targetSubject}`, workingData);
      this.state.activeTab = "editor";
      this.render();
      App.showToast("병합 완료! 「확인 필요 이상 문항만 보기」를 체크해 누락된 선지나 그림 문항을 검수하세요.", "success");
    },

    renderExamSetsTabHtml() {
      const { workingData } = this.state;
      const sets = workingData.officialExamSets || [];

      return `
        <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-5">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="font-bold text-base">공식 모의고사 회차 관리 (지정 범위 시험지)</h3>
              <p class="text-xs text-slate-500 mt-0.5">「제1회, 제2회」 등 진도별 지정 모의고사를 생성하고 검수한 뒤 「공개 발행」으로 전환하면 학생 화면과 전용 랭킹에 노출됩니다.</p>
            </div>
            <button onclick="AdminStudio.openCreateExamSetModal()" class="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs">+ 새 모의고사 회차 생성</button>
          </div>

          <div class="space-y-3">
            ${sets.length === 0 ? `<p class="text-xs text-slate-400 text-center py-6">생성된 공식 모의고사 회차가 없습니다.</p>` : sets.map((s, idx) => `
              <div class="p-4 rounded-xl border border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <div class="flex items-center gap-2">
                    <span class="font-bold text-sm">${s.title}</span>
                    <span class="text-[11px] px-2 py-0.5 rounded-full font-bold ${s.published ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}">
                      ${s.published ? "공개 발행됨" : "임시 저장 (비공개)"}
                    </span>
                  </div>
                  <div class="text-xs text-slate-500 mt-1">총 ${s.questionIds.length}문항 · 제한 시간 ${s.durationMinutes}분</div>
                </div>
                <div class="flex items-center gap-2">
                  <button onclick="AdminStudio.toggleExamSetPublish(${idx})" class="px-3 py-1.5 rounded-xl text-xs font-bold ${s.published ? "bg-slate-100 dark:bg-slate-800" : "bg-emerald-600 text-white"}">
                    ${s.published ? "비공개 전환" : "지금 공개 발행"}
                  </button>
                  <button onclick="AdminStudio.deleteExamSet(${idx})" class="px-3 py-1.5 rounded-xl text-xs font-semibold text-rose-600 hover:bg-rose-50">삭제</button>
                </div>
              </div>
            `).join("")}
          </div>
        </div>
      `;
    },

    openCreateExamSetModal() {
      const { workingData } = this.state;
      const nextNum = (workingData.officialExamSets?.length || 0) + 1;
      App.openModal(`
        <div class="space-y-4">
          <h3 class="text-base font-bold">새 공식 모의고사 회차 생성</h3>
          <div class="space-y-2">
            <label class="text-xs font-bold block">시험지 제목 (학생 화면 표시명):</label>
            <input id="new-exam-title" type="text" value="第${nextNum}回 階段範圍模擬考" class="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-bold" />
          </div>
          <div class="space-y-2">
            <label class="text-xs font-bold block">제한 시간 (분):</label>
            <input id="new-exam-mins" type="number" min="5" max="180" value="30" class="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-bold" />
          </div>
          <div class="space-y-2">
            <label class="text-xs font-bold block">출제 범위 단원 선택 (선택한 단원의 문항 포함):</label>
            <div class="max-h-36 overflow-y-auto space-y-1 border border-slate-200 dark:border-slate-700 rounded-xl p-2.5">
              ${workingData.chapters.map((ch) => `
                <label class="flex items-center gap-2 text-xs">
                  <input type="checkbox" name="exam-set-ch" value="${ch.id}" checked />
                  <span>${ch.title}</span>
                </label>
              `).join("")}
            </div>
          </div>
          <div class="flex justify-end gap-2">
            <button onclick="App.closeModal()" class="px-4 py-2 rounded-xl text-xs font-semibold bg-slate-100 dark:bg-slate-800">취소</button>
            <button onclick="AdminStudio.createExamSet()" class="px-4 py-2 rounded-xl text-xs font-bold bg-blue-600 text-white">시험지 생성 (임시저장)</button>
          </div>
        </div>
      `);
    },

    async createExamSet() {
      const { workingData, targetSubject } = this.state;
      const title = document.getElementById("new-exam-title")?.value.trim() || "미지정 모의고사";
      const mins = parseInt(document.getElementById("new-exam-mins")?.value, 10) || 30;
      const chIds = Array.from(document.querySelectorAll('input[name="exam-set-ch"]:checked')).map((el) => el.value);
      const qIds = workingData.questions.filter((q) => chIds.includes(q.chapterId)).map((q) => q.id);

      if (qIds.length === 0) {
        App.showToast("선택한 단원에 포함된 문항이 없습니다.", "warning");
        return;
      }
      if (!workingData.officialExamSets) workingData.officialExamSets = [];
      workingData.officialExamSets.push({
        setId: `${targetSubject}_set_${Date.now()}`,
        title,
        durationMinutes: mins,
        published: false,
        questionIds: qIds
      });

      await LocalIDB.setDataset(`cache_${targetSubject}`, workingData);
      App.closeModal();
      this.render();
      App.showToast("모의고사 임시저장본이 생성되었습니다. 검수 후 「지금 공개 발행」을 눌러주세요.", "success");
    },

    async toggleExamSetPublish(idx) {
      const { workingData, targetSubject } = this.state;
      workingData.officialExamSets[idx].published = !workingData.officialExamSets[idx].published;
      await LocalIDB.setDataset(`cache_${targetSubject}`, workingData);
      this.render();
    },

    async deleteExamSet(idx) {
      const { workingData, targetSubject } = this.state;
      workingData.officialExamSets.splice(idx, 1);
      await LocalIDB.setDataset(`cache_${targetSubject}`, workingData);
      this.render();
    },

    /**
     * =========================================================================
     * 탭 4: 중앙 클라우드 오류 제보 및 건의함 (미해결/해결됨 필터 + 바로 수정)
     * =========================================================================
     */
    renderReportsTabHtml() {
      const { cloudInboxLoaded, cloudReports, cloudFeedbacks, reportStatusFilter } = this.state;
      const localReports = JSON.parse(localStorage.getItem(ProgressStore.REPORTS_KEY) || "[]");
      const localFeedbacks = JSON.parse(localStorage.getItem(ProgressStore.FEEDBACK_KEY) || "[]");

      const reports = cloudInboxLoaded
        ? cloudReports
        : localReports.filter((r) => (reportStatusFilter === "all" ? true : r.status === reportStatusFilter));
      const feedbacks = cloudInboxLoaded
        ? cloudFeedbacks
        : localFeedbacks.filter((f) => {
            if (reportStatusFilter === "open") return !f.isRead;
            if (reportStatusFilter === "resolved") return Boolean(f.isRead);
            return true;
          });

      return `
        <div class="space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl px-4 py-2.5">
            <div class="flex items-center gap-2 text-xs">
              <span class="font-bold ${cloudInboxLoaded ? "text-emerald-600" : "text-amber-600"}">
                ${cloudInboxLoaded ? "☁️ Firebase 중앙 클라우드 제보함 실시간 연동됨" : "💾 오프라인 모드 (본 기기 로컬 저장분 표시)"}
              </span>
            </div>
            <div class="flex items-center gap-1.5">
              <button onclick="AdminStudio.changeReportFilter('open')" class="px-2.5 py-1 rounded-lg text-xs font-bold ${reportStatusFilter === "open" ? "bg-rose-600 text-white" : "bg-slate-100 dark:bg-slate-800"}">미해결만</button>
              <button onclick="AdminStudio.changeReportFilter('resolved')" class="px-2.5 py-1 rounded-lg text-xs font-bold ${reportStatusFilter === "resolved" ? "bg-emerald-600 text-white" : "bg-slate-100 dark:bg-slate-800"}">해결됨</button>
              <button onclick="AdminStudio.changeReportFilter('all')" class="px-2.5 py-1 rounded-lg text-xs font-bold ${reportStatusFilter === "all" ? "bg-blue-600 text-white" : "bg-slate-100 dark:bg-slate-800"}">전체 보기</button>
              <button onclick="AdminStudio.changeReportFilter(null)" class="px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200">새로고침</button>
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3">
              <h3 class="font-bold text-sm text-rose-600 flex items-center gap-1.5">
                <i data-lucide="flag" class="w-4 h-4"></i> 문항 오류 제보 목록 (${reports.length}건)
              </h3>
              ${reports.length === 0 ? `<p class="text-xs text-slate-400 py-4 text-center">해당 조건의 문항 오류 제보가 없습니다.</p>` : reports.map((r, idx) => `
                <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800 text-xs space-y-2 border border-slate-200/70 dark:border-slate-700">
                  <div class="flex items-center justify-between font-bold">
                    <span>[${r.subject === "biology" ? "생물" : "화학"}] ${r.questionId}</span>
                    <span class="${r.status === "open" ? "text-rose-500" : "text-emerald-500"}">${r.status === "open" ? r.type : "해결 완료"}</span>
                  </div>
                  <p class="text-slate-600 dark:text-slate-300">${r.memo || "추가 메모 없음"}</p>
                  <div class="flex items-center justify-between pt-1">
                    <span class="text-[11px] text-slate-400">${r.createdAt ? new Date(r.createdAt).toLocaleString("ko-KR") : ""}</span>
                    <div class="flex gap-1.5">
                      <button onclick="AdminStudio.jumpToReportedQuestion('${r.subject}', '${r.questionId}')" class="px-2.5 py-1 rounded-lg bg-blue-600 text-white font-bold text-[11px]">이 문항 바로 수정</button>
                      ${r.status === "open" ? `<button onclick="AdminStudio.markReportResolved('${r.id || ""}', ${idx})" class="px-2.5 py-1 rounded-lg bg-emerald-600 text-white font-bold text-[11px]">해결 완료 처리</button>` : ""}
                    </div>
                  </div>
                </div>
              `).join("")}
            </div>

            <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3">
              <h3 class="font-bold text-sm text-blue-600 flex items-center gap-1.5">
                <i data-lucide="message-square" class="w-4 h-4"></i> 개발자 건의함 / 사용자 피드백 (${feedbacks.length}건)
              </h3>
              ${feedbacks.length === 0 ? `<p class="text-xs text-slate-400 py-4 text-center">해당 조건의 건의사항이 없습니다.</p>` : feedbacks.map((f, idx) => `
                <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800 text-xs space-y-2 border border-slate-200/70 dark:border-slate-700">
                  <div class="flex items-center justify-between">
                    <span class="font-bold text-blue-600 dark:text-blue-400">${f.nickname || f.category || "익명 사용자"}</span>
                    <span class="text-[11px] font-bold ${f.isRead ? "text-emerald-500" : "text-rose-500"}">${f.isRead ? "확인 완료" : "미확인"}</span>
                  </div>
                  <p class="text-slate-700 dark:text-slate-200 leading-relaxed">${f.content}</p>
                  <div class="flex items-center justify-between pt-1">
                    <span class="text-[11px] text-slate-400">${f.createdAt ? new Date(f.createdAt).toLocaleString("ko-KR") : ""}</span>
                    ${!f.isRead ? `<button onclick="AdminStudio.markFeedbackResolved('${f.id || ""}', ${idx})" class="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-[11px]">확인 완료 처리</button>` : ""}
                  </div>
                </div>
              `).join("")}
            </div>
          </div>
        </div>
      `;
    },

    async changeReportFilter(filter) {
      await this.refreshCloudInbox(filter);
      this.render();
    },

    async jumpToReportedQuestion(subject, questionId) {
      if (this.state.targetSubject !== subject) {
        await this.loadSubjectForEdit(subject);
      }
      this.state.selectedChapterFilter = "ALL";
      this.state.pinnedQuestionId = null;
      this.state.selectedQuestionId = questionId;
      this.state.onlyAbnormal = false;
      this.state.activeTab = "editor";
      this.render();
      App.showToast(`제보된 문항(${questionId}) 편집 화면으로 이동했습니다.`, "info");
    },

    async markReportResolved(docId, idx) {
      if (this.state.cloudInboxLoaded && docId && window.CloudSync) {
        await window.CloudSync.resolveIssueReport(docId);
        await this.refreshCloudInbox();
        this.render();
        App.showToast("클라우드 제보가 해결 완료 처리되었습니다.", "success");
        return;
      }
      const reports = JSON.parse(localStorage.getItem(ProgressStore.REPORTS_KEY) || "[]");
      if (reports[idx]) {
        reports[idx].status = "resolved";
        localStorage.setItem(ProgressStore.REPORTS_KEY, JSON.stringify(reports));
        this.render();
      }
    },

    async markFeedbackResolved(docId, idx) {
      if (this.state.cloudInboxLoaded && docId && window.CloudSync) {
        await window.CloudSync.resolveFeedback(docId);
        await this.refreshCloudInbox();
        this.render();
        App.showToast("건의사항이 확인 완료 처리되었습니다.", "success");
        return;
      }
      const feedbacks = JSON.parse(localStorage.getItem(ProgressStore.FEEDBACK_KEY) || "[]");
      if (feedbacks[idx]) {
        feedbacks[idx].isRead = true;
        localStorage.setItem(ProgressStore.FEEDBACK_KEY, JSON.stringify(feedbacks));
        this.render();
      }
    },

    async exportZipBundle() {
      if (!window.JSZip) {
        App.showToast("JSZip 모듈이 아직 로드되지 않았습니다.", "error");
        return;
      }
      const { workingData, targetSubject, imageBlobs } = this.state;
      workingData.updatedAt = new Date().toISOString();

      const cleanData = JSON.parse(JSON.stringify(workingData));
      cleanData.questions.forEach((q) => {
        delete q.sourcePage;
        delete q.needsImage;
      });

      const zip = new JSZip();
      zip.file(`data/${targetSubject}.json`, JSON.stringify(cleanData, null, 2));

      const imgFolder = zip.folder("images");
      for (const [path, blob] of imageBlobs.entries()) {
        const fileName = path.replace(/^images\//, "");
        imgFolder.file(fileName, blob);
      }

      const content = await zip.generateAsync({ type: "blob" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(content);
      a.download = `${targetSubject}_qbank_bundle_${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      App.showToast(`${targetSubject}.json 및 이미지 ${imageBlobs.size}장이 ZIP 패키지로 다운로드되었습니다!`, "success");
    }
  };

/**
   * ============================================================================
   * 5. 학생 개인용 커스텀 셀프 편집기 (CustomStudio)
   * ============================================================================
   */
  const CustomStudio = {
    state: {
      activeTab: "editor", // editor | pdfImport
      slotId: "slot_1",
      slotName: "自訂題庫",
      datasetKey: "custom_slot_slot_1",
      parseMode: "biology", // biology | chemistry
      workingData: null,
      selectedChapterFilter: "ALL",
      selectedQuestionId: null,
      pinnedQuestionId: null,
      onlyAbnormal: false,
      searchQuery: "",
      pdfDoc: null,
      pdfPageNum: 1,
      pdfTotalPages: 0,
      stagingQuestions: [],
      stagingChapters: []
    },

    async mount(container) {
      this.container = container;
      const slotId = CustomSlotManager.getActiveSlotId();
      const slots = CustomSlotManager.getSlots();
      const activeSlot = slots.find((s) => s.id === slotId) || slots[0];

      this.state.slotId = slotId;
      this.state.slotName = activeSlot.name;
      this.state.datasetKey = `custom_slot_${slotId}`;

      await this.loadLocalCustomData();
      this.bindPasteListener();
      this.render();
    },

    async loadLocalCustomData() {
      let saved = await LocalIDB.getDataset(this.state.datasetKey);
      if (!saved && this.state.slotId === "slot_1") {
        saved = await LocalIDB.getDataset("custom_qbank");
      }

      if (saved && Array.isArray(saved.questions) && Array.isArray(saved.chapters)) {
        this.state.workingData = saved;
      } else {
        this.state.workingData = {
          subject: "custom",
          subjectName: this.state.slotName,
          updatedAt: new Date().toISOString(),
          chapters: [{ id: "ch01", title: "第1章 自訂章節", order: 1 }],
          questions: []
        };
        await this.saveToLocalIDB();
      }

      if (this.state.workingData.chapters.length === 0) {
        this.state.workingData.chapters.push({ id: "ch01", title: "第1章 自訂章節", order: 1 });
      }
      this.state.workingData.chapters.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
      this.state.selectedChapterFilter = "ALL";
      this.state.pinnedQuestionId = null;
      this.state.selectedQuestionId = this.state.workingData.questions[0]?.id || null;
    },

    async saveToLocalIDB() {
      this.state.workingData.subject = "custom";
      this.state.workingData.subjectName = this.state.slotName;
      this.state.workingData.updatedAt = new Date().toISOString();
      await LocalIDB.setDataset(this.state.datasetKey, this.state.workingData);
    },

    async storeImageLocally(webpBlob) {
      const imgKey = `custom_${this.state.slotId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const idbPath = await LocalIDB.saveImageBlob(imgKey, webpBlob);
      ImageResolver.registerTempUrl(idbPath, URL.createObjectURL(webpBlob));
      return idbPath;
    },

    bindPasteListener() {
      if (this._pasteBound) return;
      this._pasteBound = true;
      document.addEventListener("paste", async (e) => {
        if (App.state.view !== "customEditor" || !this.state.selectedQuestionId) return;
        const items = e.clipboardData?.items || [];
        for (const item of items) {
          if (item.type.startsWith("image/")) {
            e.preventDefault();
            const rawBlob = item.getAsFile();
            if (!rawBlob) return;
            const optimized = await ImageOptimizer.compressToWebP(rawBlob, 1000, 0.82);
            await this.attachImageToSelectedQuestion(optimized);
            App.showToast("剪貼簿圖片已自動壓縮並儲存至本機題庫！", "success");
            break;
          }
        }
      });
    },

    async attachImageToSelectedQuestion(webpBlob) {
      const q = this.state.workingData.questions.find((item) => item.id === this.state.selectedQuestionId);
      if (!q) return;
      if (this.state.onlyAbnormal) {
        this.state.pinnedQuestionId = q.id;
      }
      const idbPath = await this.storeImageLocally(webpBlob);
      q.image = idbPath;
      q.needsImage = false;
      await this.saveToLocalIDB();
      this.render();
    },

    getAbnormalReasons(q) {
      return AdminStudio.getAbnormalReasons(q);
    },

    isAbnormalQuestion(q) {
      return AdminStudio.isAbnormalQuestion(q);
    },

    render() {
      const { activeTab, workingData, parseMode, slotName } = this.state;
      const abnormalCount = workingData.questions.filter((q) => this.isAbnormalQuestion(q)).length;

      this.container.innerHTML = `
        <div class="space-y-4">
          <input id="custom-studio-json-input" type="file" accept=".json" class="hidden" onchange="CustomStudio.handleBackupJsonImport(this.files[0])" />

          <!-- 상단 커스텀 셀프 에디터 툴바 -->
          <div class="bg-indigo-950 text-white rounded-2xl p-4 flex flex-col xl:flex-row items-start xl:items-center justify-between gap-3">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-xl bg-indigo-500/20 text-indigo-300 flex items-center justify-center shrink-0">
                <i data-lucide="notebook-pen" class="w-5 h-5"></i>
              </div>
              <div>
                <div class="flex flex-wrap items-center gap-2">
                  <h2 class="font-bold text-base">自訂題庫編輯器（${slotName}）</h2>
                  <select onchange="CustomStudio.setParseMode(this.value)" class="bg-indigo-900 border border-indigo-700 text-xs font-bold rounded-lg px-2.5 py-1 text-amber-300">
                    <option value="biology" ${parseMode === "biology" ? "selected" : ""}>公式/解析規則：生物</option>
                    <option value="chemistry" ${parseMode === "chemistry" ? "selected" : ""}>公式/解析規則：化學</option>
                  </select>
                </div>
                <p class="text-xs text-indigo-200/80 mt-0.5">所有修改皆自動儲存於本機瀏覽器 · 支援 Ctrl+V 貼上截圖與左側 PDF 拖曳裁切附圖</p>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-2 self-end xl:self-auto">
              <button onclick="CustomStudio.exportBackupJson()" class="px-3 py-2 rounded-xl bg-indigo-900 hover:bg-indigo-800 border border-indigo-700 text-indigo-200 font-bold text-xs flex items-center gap-1.5">
                <i data-lucide="download" class="w-3.5 h-3.5"></i> 匯出備份 (.json)
              </button>
              <button onclick="document.getElementById('custom-studio-json-input').click()" class="px-3 py-2 rounded-xl bg-indigo-900 hover:bg-indigo-800 border border-indigo-700 text-indigo-200 font-bold text-xs flex items-center gap-1.5">
                <i data-lucide="upload" class="w-3.5 h-3.5"></i> 匯入備份
              </button>
              <button onclick="App.selectSubject('custom')" class="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1.5">
                <i data-lucide="check-circle-2" class="w-4 h-4"></i> 編輯完成 · 返回練習
              </button>
            </div>
          </div>

          <!-- 2대 핵심 탭 -->
          <div class="flex flex-wrap gap-2">
            <button onclick="CustomStudio.setTab('editor')" class="px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 ${activeTab === "editor" ? "bg-indigo-600 text-white" : "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800"}">
              <i data-lucide="edit-3" class="w-4 h-4"></i> 題目視覺化編輯與檢修 (${workingData.questions.length} 題)
              ${abnormalCount > 0 ? `<span class="px-1.5 py-0.2 rounded-full bg-amber-400 text-slate-950 text-[10px]">待確認 ${abnormalCount} 題</span>` : ""}
            </button>
            <button onclick="CustomStudio.setTab('pdfImport')" class="px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 ${activeTab === "pdfImport" ? "bg-indigo-600 text-white" : "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800"}">
              <i data-lucide="file-plus-2" class="w-4 h-4"></i> 依章節解析 PDF 並新增
            </button>
          </div>

          <div>
            ${activeTab === "editor" ? this.renderEditorTabHtml() : this.renderPdfImportTabHtml()}
          </div>
        </div>
      `;
      lucide.createIcons();
      ImageResolver.hydrateImages(this.container);
      if (this.state.pdfDoc && activeTab === "editor") {
        this.renderPdfCanvasPage();
      }
    },

    setTab(tab) {
      this.state.activeTab = tab;
      this.render();
    },

    setParseMode(mode) {
      this.state.parseMode = mode;
      this.render();
    },

    renderEditorTabHtml() {
      const { workingData, selectedChapterFilter, selectedQuestionId, pinnedQuestionId, onlyAbnormal, searchQuery, pdfDoc } = this.state;

      let list = workingData.questions;
      if (selectedChapterFilter !== "ALL") {
        list = list.filter((q) => q.chapterId === selectedChapterFilter);
      }
      if (onlyAbnormal) {
        list = list.filter((q) => this.isAbnormalQuestion(q) || q.id === pinnedQuestionId);
      }
      if (searchQuery.trim()) {
        const kw = searchQuery.toLowerCase();
        list = list.filter((q) => q.id.toLowerCase().includes(kw) || App.stripHtml(q.questionHtml).toLowerCase().includes(kw));
      }

      const selectedQ = list.find((q) => q.id === selectedQuestionId) || list[0] || null;
      if (selectedQ && selectedQ.id !== selectedQuestionId) {
        this.state.selectedQuestionId = selectedQ.id;
      }

      const activeChapterObj = selectedChapterFilter !== "ALL"
        ? workingData.chapters.find((c) => c.id === selectedChapterFilter)
        : null;

      return `
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <!-- 좌측: 단원 선택 + 문항 목록 + PDF 크롭기 -->
          <div class="lg:col-span-5 space-y-3">
            <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-3.5 space-y-2.5">
              <div class="flex items-center justify-between gap-2">
                <label class="text-xs font-bold shrink-0">選擇章節：</label>
                <select onchange="CustomStudio.setChapterFilter(this.value)" class="flex-1 px-2.5 py-1.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-bold">
                  <option value="ALL" ${selectedChapterFilter === "ALL" ? "selected" : ""}>全部章節 (${workingData.questions.length} 題)</option>
                  ${workingData.chapters.map((ch) => {
                    const cnt = workingData.questions.filter((q) => q.chapterId === ch.id).length;
                    return `<option value="${ch.id}" ${selectedChapterFilter === ch.id ? "selected" : ""}>${ch.title} (${cnt} 題)</option>`;
                  }).join("")}
                </select>
                <button onclick="CustomStudio.addNewChapter()" class="px-2.5 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-xs font-bold shrink-0">+ 新增章節</button>
              </div>

              ${activeChapterObj ? `
                <div class="flex items-center gap-1.5 pt-1">
                  <input id="custom-ch-title" type="text" value="${activeChapterObj.title.replace(/"/g, "&quot;")}" class="flex-1 px-2.5 py-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs" />
                  <button onclick="CustomStudio.renameChapter()" class="px-2.5 py-1 rounded-lg bg-indigo-600 text-white text-[11px] font-bold">改名</button>
                  <button onclick="CustomStudio.deleteChapter()" class="px-2.5 py-1 rounded-lg bg-rose-600 text-white text-[11px] font-bold">刪除此章</button>
                </div>
              ` : ""}
            </div>

            <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-3.5 space-y-2.5">
              <div class="flex items-center gap-2">
                <input type="text" value="${searchQuery}" oninput="CustomStudio.setSearchQuery(this.value)" placeholder="搜尋題號或題目關鍵字..." class="flex-1 px-3 py-1.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs" />
                <button onclick="CustomStudio.addNewQuestion()" class="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shrink-0">+ 新增題目</button>
              </div>
              <div class="flex items-center justify-between">
                <label class="flex items-center gap-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400 cursor-pointer">
                  <input type="checkbox" ${onlyAbnormal ? "checked" : ""} onchange="CustomStudio.toggleAbnormalFilter(this.checked)" class="rounded text-amber-500" />
                  <span>只看異常 / 待確認題目</span>
                </label>
                <span class="text-[11px] text-slate-400">顯示 ${list.length} 題</span>
              </div>

              <div class="max-h-[360px] overflow-y-auto space-y-1.5 pr-1">
                ${list.length === 0 ? `<div class="text-center text-xs text-slate-400 py-8">尚無題目，請點擊上方「依章節解析 PDF 並新增」或「+ 新增題目」。</div>` : list.map((q) => {
                  const isSel = selectedQ && q.id === selectedQ.id;
                  const reasons = this.getAbnormalReasons(q);
                  const isResolvedPinned = onlyAbnormal && reasons.length === 0 && q.id === pinnedQuestionId;
                  return `
                    <button onclick="CustomStudio.selectQuestion('${q.id}')" class="w-full text-left p-2.5 rounded-xl border text-xs transition ${isSel ? "border-indigo-600 bg-indigo-50 dark:bg-indigo-950/50" : "border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50"}">
                      <div class="flex items-center justify-between gap-1">
                        <span class="font-mono font-bold text-slate-500">${q.id}</span>
                        <div class="flex items-center gap-1">
                          ${q.image ? `<span class="px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-700 text-[10px]">含附圖</span>` : ""}
                          ${reasons.length > 0 ? `<span class="px-1.5 py-0.2 rounded bg-amber-100 text-amber-800 text-[10px] font-bold">待檢查</span>` : ""}
                          ${isResolvedPinned ? `<span class="px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-800 text-[10px] font-bold">已修正 ✓</span>` : ""}
                        </div>
                      </div>
                      <div class="truncate text-slate-700 dark:text-slate-300 mt-1">${App.stripHtml(q.questionHtml) || "（空白題幹）"}</div>
                    </button>
                  `;
                }).join("")}
              </div>
            </div>

            ${pdfDoc ? this.renderSplitPdfCropperHtml(selectedQ?.sourcePage) : `
              <div class="bg-slate-100 dark:bg-slate-900/60 border border-dashed border-slate-300 dark:border-slate-700 rounded-2xl p-4 text-center text-xs text-slate-500">
                💡 提示：至「依章節解析 PDF 並新增」分頁載入 PDF 後，此處會顯示原始頁面，可用滑鼠拖曳框選圖表並自動裁切貼入題目！
              </div>
            `}
          </div>

          <!-- 우측: 문항 상세 편집 폼 -->
          <div class="lg:col-span-7">
            ${selectedQ ? this.renderQuestionFormHtml(selectedQ, list) : `
              <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-10 text-center text-xs text-slate-400">請從左側選擇題目，或點擊「+ 新增題目」開始建立。</div>
            `}
          </div>
        </div>
      `;
    },

    renderQuestionFormHtml(q, currentList = []) {
      const { workingData, onlyAbnormal } = this.state;
      const letters = ["A", "B", "C", "D", "E"];
      const opts = [...(q.options || [])];
      while (opts.length < 4) opts.push({ origIdx: opts.length, textHtml: "" });
      const abnormalReasons = this.getAbnormalReasons(q);

      const curIdx = currentList.findIndex((item) => item.id === q.id);
      const nextQ = curIdx >= 0 && curIdx + 1 < currentList.length ? currentList[curIdx + 1] : null;

      return `
        <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100 dark:border-slate-800">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-mono text-xs font-bold px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800">${q.id}</span>
              <select onchange="CustomStudio.updateQuestionField('chapterId', this.value)" class="text-xs font-semibold px-2.5 py-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800">
                ${workingData.chapters.map((ch) => `<option value="${ch.id}" ${ch.id === q.chapterId ? "selected" : ""}>${ch.title}</option>`).join("")}
              </select>
              ${abnormalReasons.length > 0
                ? `<span class="px-2 py-0.5 rounded-lg bg-amber-100 text-amber-800 text-[11px] font-bold">建議檢查此題內容</span>`
                : `<span class="px-2 py-0.5 rounded-lg bg-emerald-100 text-emerald-700 text-[11px] font-bold">格式完整 ${onlyAbnormal ? "(保留於目前畫面)" : ""}</span>`}
            </div>
            <div class="flex items-center gap-1.5">
              ${nextQ ? `
                <button onclick="CustomStudio.selectQuestion('${nextQ.id}')" class="px-2.5 py-1 rounded-lg text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white">下一題 ▶</button>
              ` : ""}
              <button onclick="CustomStudio.addOptionSlot()" ${opts.length >= 5 ? "disabled" : ""} class="px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-100 dark:bg-slate-800 disabled:opacity-40">+ 新增選項 (E)</button>
              <button onclick="CustomStudio.deleteSelectedQuestion()" class="px-2.5 py-1 rounded-lg text-xs font-semibold text-rose-600 hover:bg-rose-50">刪除此題</button>
            </div>
          </div>

          <div class="space-y-1">
            <div class="flex items-center justify-between">
              <label class="text-xs font-bold">題目敘述（支援 &lt;sub&gt; / &lt;sup&gt; 上下標標籤）：</label>
              <button onclick="CustomStudio.autoFormatChemOnCurrent()" class="text-[11px] text-indigo-600 hover:underline font-semibold">自動校正化學式上下標</button>
            </div>
            <textarea rows="3" oninput="CustomStudio.updateQuestionField('questionHtml', this.value)" class="w-full p-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-mono">${q.questionHtml || ""}</textarea>
          </div>

          <div class="p-3 rounded-xl border border-dashed border-indigo-300 dark:border-indigo-800 bg-indigo-50/40 dark:bg-indigo-950/20 space-y-2">
            <div class="flex items-center justify-between text-xs">
              <span class="font-bold text-indigo-700 dark:text-indigo-300">題目附圖（按 Ctrl+V 直接貼上截圖，或由左側 PDF 拖曳裁切）</span>
              ${q.image ? `<button onclick="CustomStudio.removeQuestionImage()" class="text-rose-600 font-semibold hover:underline">移除附圖</button>` : ""}
            </div>
            ${q.image ? `<div>${ImageResolver.renderImageTagHtml(q.image)}</div>` : `<div class="text-[11px] text-slate-400">尚未附加圖片</div>`}
          </div>

          <div class="space-y-2">
            <label class="text-xs font-bold block">選項內容與正確答案（請點選左側圓圈指定正解）：</label>
            ${opts.map((opt, idx) => {
              const isEmptyOpt = !App.stripHtml(opt.textHtml || "").trim();
              return `
                <div class="flex items-center gap-2">
                  <input type="radio" name="custom-correct-ans" ${q.answerIndex === idx ? "checked" : ""} onchange="CustomStudio.updateQuestionField('answerIndex', ${idx})" class="w-4 h-4 text-emerald-600" />
                  <span class="w-6 text-xs font-bold text-center ${isEmptyOpt ? "text-rose-500" : ""}">${letters[idx]}</span>
                  <input type="text" value="${(opt.textHtml || "").replace(/"/g, "&quot;")}" placeholder="${isEmptyOpt ? "此選項目前為空，請補充內容" : ""}" oninput="CustomStudio.updateOptionText(${idx}, this.value)" class="flex-1 px-3 py-1.5 rounded-xl border ${isEmptyOpt ? "border-amber-400 bg-amber-50/50 dark:bg-amber-950/20" : "border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800"} text-xs" />
                </div>
              `;
            }).join("")}
          </div>

          <div class="space-y-1">
            <label class="text-xs font-bold block">詳解說明（選填）：</label>
            <textarea rows="2" oninput="CustomStudio.updateQuestionField('explanationHtml', this.value)" class="w-full p-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs">${q.explanationHtml || ""}</textarea>
          </div>

          <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-1.5">
            <div class="text-[11px] font-bold text-slate-400">即時排版預覽：</div>
            <div id="custom-live-preview" class="question-html text-sm leading-relaxed">${q.questionHtml || ""}</div>
          </div>
        </div>
      `;
    },

    renderPdfImportTabHtml() {
      const { stagingQuestions, stagingChapters, parseMode } = this.state;
      return `
        <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-5">
          <div>
            <h3 class="font-bold text-base">智慧解析 PDF 題庫並匯入（建議依章節分批上傳）</h3>
            <p class="text-xs text-slate-500 mt-1">請將 PDF 依「單一章節」拆分後逐章上傳，系統會自動帶入檔名作為章節名稱，並將整份 PDF 歸類至該章節，避免大檔案章節錯亂。</p>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
            <div>
              <label class="text-xs font-bold block mb-1">1. 選擇科目解析規則</label>
              <select id="custom-studio-pdf-mode" onchange="CustomStudio.setParseMode(this.value)" class="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-bold">
                <option value="biology" ${parseMode === "biology" ? "selected" : ""}>生物規則（自動合併斷行專有名詞）</option>
                <option value="chemistry" ${parseMode === "chemistry" ? "selected" : ""}>化學規則（自動校正上下標與離子電荷）</option>
              </select>
            </div>
            <div>
              <label class="text-xs font-bold block mb-1">2. 選擇單一章節 PDF</label>
              <input id="custom-studio-pdf-file" type="file" accept=".pdf" onchange="const inp=document.getElementById('custom-studio-chapter-title'); if(inp && !inp.value.trim() && this.files[0]) inp.value=this.files[0].name.replace(/\\.pdf$/i,'');" class="w-full text-xs file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:text-indigo-700 font-semibold" />
            </div>
            <div>
              <label class="text-xs font-bold block mb-1">3. 指定章節名稱</label>
              <input id="custom-studio-chapter-title" type="text" placeholder="預設自動帶入 PDF 檔名" class="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-semibold" />
            </div>
            <div class="flex gap-2">
              <button onclick="CustomStudio.runPdfParse()" class="flex-1 py-2 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs">開始解析 PDF</button>
              <button onclick="PdfChunkParser.cancel()" class="py-2 px-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold">停止</button>
            </div>
          </div>

          <div id="custom-studio-pdf-progress" class="hidden space-y-1.5 bg-slate-50 dark:bg-slate-800 p-3.5 rounded-xl">
            <div class="flex justify-between text-xs font-bold">
              <span id="custom-studio-pdf-prog-label">解析中...</span>
              <span id="custom-studio-pdf-prog-pct">0%</span>
            </div>
            <div class="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
              <div id="custom-studio-pdf-prog-bar" class="h-full bg-indigo-600 transition-all" style="width: 0%"></div>
            </div>
          </div>

          ${stagingQuestions.length > 0 ? `
            <div class="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="text-xs font-bold text-emerald-600">
                  解析完成：[${stagingChapters.map((c) => c.title).join(", ")}] — 共 ${stagingQuestions.length} 題（待確認 ${stagingQuestions.filter((q) => this.isAbnormalQuestion(q)).length} 題）
                </span>
                <div class="flex gap-2">
                  <button onclick="CustomStudio.applyStaging(false)" class="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs">新增章節至現有題庫</button>
                  <button onclick="CustomStudio.applyStaging(true)" class="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs">清空舊題並覆蓋寫入</button>
                </div>
              </div>
            </div>
          ` : ""}
        </div>
      `;
    },

    async runPdfParse() {
      const file = document.getElementById("custom-studio-pdf-file")?.files?.[0];
      if (!file) return App.showToast("請先選擇 PDF 檔案", "warning");
      const mode = document.getElementById("custom-studio-pdf-mode")?.value || "biology";
      const customChapterTitle = (document.getElementById("custom-studio-chapter-title")?.value || "").trim() || file.name.replace(/\.pdf$/i, "");
      const progBox = document.getElementById("custom-studio-pdf-progress");
      const label = document.getElementById("custom-studio-pdf-prog-label");
      const pctEl = document.getElementById("custom-studio-pdf-prog-pct");
      const bar = document.getElementById("custom-studio-pdf-prog-bar");
      progBox.classList.remove("hidden");

      try {
        const buf = await file.arrayBuffer();
        this.state.pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
        this.state.pdfTotalPages = this.state.pdfDoc.numPages;
        this.state.pdfPageNum = 1;

        const res = await PdfChunkParser.parsePdfFile(file, mode, {
          forcedChapterId: "ch_stage_01",
          startSeq: 0,
          onProgress: (cur, total, count) => {
            const p = Math.round((cur / total) * 100);
            label.textContent = `解析中：第 ${cur} / ${total} 頁（已擷取 ${count} 題）...`;
            pctEl.textContent = `${p}%`;
            bar.style.width = `${p}%`;
          }
        });
        if (res.chapters.length > 0) {
          res.chapters[0].title = customChapterTitle;
        }
        this.state.stagingChapters = res.chapters;
        this.state.stagingQuestions = res.questions;
        this.render();
        App.showToast(`共擷取 ${res.questions.length} 題！請選擇匯入方式`, "success");
      } catch (err) {
        App.showToast(err.message || "PDF 解析發生錯誤", "error");
      }
    },

    async applyStaging(replaceAll = false) {
      const { workingData, stagingChapters, stagingQuestions } = this.state;
      if (replaceAll) {
        workingData.chapters = [...stagingChapters];
        workingData.questions = [...stagingQuestions];
      } else {
        stagingChapters.forEach((sc) => {
          const existing = workingData.chapters.find((c) => c.title === sc.title);
          if (existing) {
            const oldId = sc.id;
            stagingQuestions.forEach((sq, i) => {
              if (sq.chapterId === oldId) {
                sq.chapterId = existing.id;
                sq.id = `cust_${existing.id}_${String(workingData.questions.length + i + 1).padStart(4, "0")}`;
              }
            });
          } else {
            const newChId = "ch" + String(workingData.chapters.length + 1).padStart(2, "0");
            const oldId = sc.id;
            workingData.chapters.push({ id: newChId, title: sc.title, order: workingData.chapters.length + 1 });
            stagingQuestions.forEach((sq, i) => {
              if (sq.chapterId === oldId) {
                sq.chapterId = newChId;
                sq.id = `cust_${newChId}_${String(workingData.questions.length + i + 1).padStart(4, "0")}`;
              }
            });
          }
        });
        workingData.questions.push(...stagingQuestions);
      }

      this.state.stagingQuestions = [];
      this.state.selectedChapterFilter = "ALL";
      this.state.pinnedQuestionId = null;
      this.state.selectedQuestionId = workingData.questions[0]?.id || null;
      await this.saveToLocalIDB();
      this.state.activeTab = "editor";
      this.render();
      App.showToast("已儲存至本機題庫！可直接檢修題目或框選 PDF 附圖", "success");
    },

    renderSplitPdfCropperHtml(sourcePageHint) {
      const { pdfPageNum, pdfTotalPages } = this.state;
      return `
        <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-3 space-y-2">
          <div class="flex items-center justify-between text-xs">
            <span class="font-bold text-indigo-600 dark:text-indigo-400">PDF 圖表裁切器（按住滑鼠左鍵拖曳框選）</span>
            <div class="flex items-center gap-1">
              ${sourcePageHint && sourcePageHint !== pdfPageNum ? `<button onclick="CustomStudio.jumpPdfPage(${sourcePageHint})" class="px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-bold text-[11px]">跳至第 ${sourcePageHint} 頁</button>` : ""}
              <button onclick="CustomStudio.jumpPdfPage(${pdfPageNum - 1})" ${pdfPageNum <= 1 ? "disabled" : ""} class="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 disabled:opacity-40">◀</button>
              <span class="font-mono px-1">${pdfPageNum}/${pdfTotalPages}</span>
              <button onclick="CustomStudio.jumpPdfPage(${pdfPageNum + 1})" ${pdfPageNum >= pdfTotalPages ? "disabled" : ""} class="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 disabled:opacity-40">▶</button>
            </div>
          </div>
          <div class="relative overflow-auto max-h-[360px] border border-slate-200 dark:border-slate-700 rounded-xl bg-slate-100 dark:bg-slate-950 select-none">
            <canvas id="custom-pdf-crop-canvas" class="w-full cursor-crosshair block"></canvas>
            <div id="custom-pdf-crop-box" class="hidden absolute border-2 border-rose-500 bg-rose-500/20 pointer-events-none"></div>
          </div>
        </div>
      `;
    },

    jumpPdfPage(num) {
      if (!this.state.pdfDoc || num < 1 || num > this.state.pdfTotalPages) return;
      this.state.pdfPageNum = num;
      this.render();
    },

    async renderPdfCanvasPage() {
      const canvas = document.getElementById("custom-pdf-crop-canvas");
      const selBox = document.getElementById("custom-pdf-crop-box");
      if (!canvas || !this.state.pdfDoc) return;

      const page = await this.state.pdfDoc.getPage(this.state.pdfPageNum);
      const viewport = page.getViewport({ scale: 2.0 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

      let startX = 0, startY = 0, dragging = false;
      canvas.onmousedown = (e) => {
        const rect = canvas.getBoundingClientRect();
        startX = e.clientX - rect.left;
        startY = e.clientY - rect.top;
        dragging = true;
        if (selBox) {
          Object.assign(selBox.style, { left: `${startX}px`, top: `${startY}px`, width: "0px", height: "0px" });
          selBox.classList.remove("hidden");
        }
      };
      canvas.onmousemove = (e) => {
        if (!dragging || !selBox) return;
        const rect = canvas.getBoundingClientRect();
        const curX = e.clientX - rect.left;
        const curY = e.clientY - rect.top;
        Object.assign(selBox.style, {
          left: `${Math.min(startX, curX)}px`,
          top: `${Math.min(startY, curY)}px`,
          width: `${Math.abs(curX - startX)}px`,
          height: `${Math.abs(curY - startY)}px`
        });
      };
      canvas.onmouseup = async (e) => {
        if (!dragging) return;
        dragging = false;
        if (selBox) selBox.classList.add("hidden");
        const rect = canvas.getBoundingClientRect();
        const endX = e.clientX - rect.left;
        const endY = e.clientY - rect.top;
        const w = Math.abs(endX - startX);
        const h = Math.abs(endY - startY);
        if (w < 15 || h < 15) return;

        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const cropCanvas = document.createElement("canvas");
        cropCanvas.width = Math.round(w * scaleX);
        cropCanvas.height = Math.round(h * scaleY);
        cropCanvas.getContext("2d").drawImage(
          canvas,
          Math.round(Math.min(startX, endX) * scaleX),
          Math.round(Math.min(startY, endY) * scaleY),
          cropCanvas.width,
          cropCanvas.height,
          0, 0, cropCanvas.width, cropCanvas.height
        );
        const webpBlob = await ImageOptimizer.compressToWebP(cropCanvas, 1000, 0.85);
        await this.attachImageToSelectedQuestion(webpBlob);
        App.showToast("已裁切選取區域並儲存至本機題庫！", "success");
      };
    },

    setChapterFilter(chId) {
      this.state.selectedChapterFilter = chId;
      this.state.pinnedQuestionId = null;
      let filtered = chId === "ALL" ? this.state.workingData.questions : this.state.workingData.questions.filter((q) => q.chapterId === chId);
      if (this.state.onlyAbnormal) {
        filtered = filtered.filter((q) => this.isAbnormalQuestion(q));
      }
      const firstQ = filtered[0] || null;
      this.state.selectedQuestionId = firstQ?.id || null;
      if (firstQ?.sourcePage && this.state.pdfDoc) this.state.pdfPageNum = firstQ.sourcePage;
      this.render();
    },

    setSearchQuery(val) {
      this.state.searchQuery = val;
      this.render();
    },

    toggleAbnormalFilter(checked) {
      this.state.onlyAbnormal = checked;
      this.state.pinnedQuestionId = null;

      if (checked) {
        let filtered = this.state.workingData.questions;
        if (this.state.selectedChapterFilter !== "ALL") {
          filtered = filtered.filter((q) => q.chapterId === this.state.selectedChapterFilter);
        }
        if (this.state.searchQuery.trim()) {
          const kw = this.state.searchQuery.toLowerCase();
          filtered = filtered.filter((q) => q.id.toLowerCase().includes(kw) || App.stripHtml(q.questionHtml).toLowerCase().includes(kw));
        }
        const firstAbnormal = filtered.find((q) => this.isAbnormalQuestion(q));
        if (firstAbnormal) {
          this.state.selectedQuestionId = firstAbnormal.id;
          if (firstAbnormal.sourcePage && this.state.pdfDoc) {
            this.state.pdfPageNum = firstAbnormal.sourcePage;
          }
        }
      }
      this.render();
    },

    selectQuestion(qid) {
      if (this.state.pinnedQuestionId && this.state.pinnedQuestionId !== qid) {
        this.state.pinnedQuestionId = null;
      }
      this.state.selectedQuestionId = qid;
      const q = this.state.workingData.questions.find((item) => item.id === qid);
      if (q?.sourcePage && this.state.pdfDoc) this.state.pdfPageNum = q.sourcePage;
      this.render();
    },

    async addNewChapter() {
      const title = prompt("請輸入新章節名稱：", `第${this.state.workingData.chapters.length + 1}章 自訂章節`);
      if (!title?.trim()) return;
      const newId = "ch" + String(Date.now()).slice(-5);
      this.state.workingData.chapters.push({ id: newId, title: title.trim(), order: this.state.workingData.chapters.length + 1 });
      this.state.selectedChapterFilter = newId;
      this.state.pinnedQuestionId = null;
      await this.saveToLocalIDB();
      this.render();
    },

    async renameChapter() {
      const ch = this.state.workingData.chapters.find((c) => c.id === this.state.selectedChapterFilter);
      const val = document.getElementById("custom-ch-title")?.value.trim();
      if (!ch || !val) return;
      ch.title = val;
      await this.saveToLocalIDB();
      this.render();
      App.showToast("章節名稱已更新", "success");
    },

    async deleteChapter() {
      const chId = this.state.selectedChapterFilter;
      if (chId === "ALL" || !confirm("確定要刪除此章節及其包含的所有題目嗎？")) return;
      this.state.workingData.questions = this.state.workingData.questions.filter((q) => q.chapterId !== chId);
      this.state.workingData.chapters = this.state.workingData.chapters.filter((c) => c.id !== chId);
      if (this.state.workingData.chapters.length === 0) {
        this.state.workingData.chapters.push({ id: "ch01", title: "第1章 自訂章節", order: 1 });
      }
      this.state.selectedChapterFilter = "ALL";
      this.state.pinnedQuestionId = null;
      this.state.selectedQuestionId = this.state.workingData.questions[0]?.id || null;
      await this.saveToLocalIDB();
      this.render();
    },

    async addNewQuestion() {
      const { workingData, selectedChapterFilter } = this.state;
      const defaultCh = selectedChapterFilter !== "ALL" ? selectedChapterFilter : (workingData.chapters[0]?.id || "ch01");
      const newId = `cust_${defaultCh}_${String(Date.now()).slice(-5)}`;
      workingData.questions.push({
        id: newId,
        chapterId: defaultCh,
        questionHtml: "請在此輸入題目敘述...",
        image: null,
        options: [
          { origIdx: 0, textHtml: "" },
          { origIdx: 1, textHtml: "" },
          { origIdx: 2, textHtml: "" },
          { origIdx: 3, textHtml: "" }
        ],
        answerIndex: 0,
        explanationHtml: ""
      });
      this.state.selectedQuestionId = newId;
      await this.saveToLocalIDB();
      this.render();
    },

    async deleteSelectedQuestion() {
      const { workingData, selectedQuestionId } = this.state;
      if (!selectedQuestionId) return;
      if (this.state.pinnedQuestionId === selectedQuestionId) {
        this.state.pinnedQuestionId = null;
      }
      workingData.questions = workingData.questions.filter((q) => q.id !== selectedQuestionId);
      this.state.selectedQuestionId = workingData.questions[0]?.id || null;
      await this.saveToLocalIDB();
      this.render();
    },

    async updateQuestionField(field, value) {
      const q = this.state.workingData.questions.find((item) => item.id === this.state.selectedQuestionId);
      if (!q) return;
      if (this.state.onlyAbnormal) {
        this.state.pinnedQuestionId = q.id;
      }
      q[field] = value;
      await this.saveToLocalIDB();
      if (field === "questionHtml") {
        const prev = document.getElementById("custom-live-preview");
        if (prev) prev.innerHTML = value;
      } else if (field === "chapterId" || field === "answerIndex") {
        this.render();
      }
    },

    async updateOptionText(idx, value) {
      const q = this.state.workingData.questions.find((item) => item.id === this.state.selectedQuestionId);
      if (!q) return;
      if (this.state.onlyAbnormal) {
        this.state.pinnedQuestionId = q.id;
      }
      while (q.options.length <= idx) q.options.push({ origIdx: q.options.length, textHtml: "" });
      q.options[idx].textHtml = value;
      await this.saveToLocalIDB();
    },

    async addOptionSlot() {
      const q = this.state.workingData.questions.find((item) => item.id === this.state.selectedQuestionId);
      if (!q || q.options.length >= 5) return;
      if (this.state.onlyAbnormal) {
        this.state.pinnedQuestionId = q.id;
      }
      q.options.push({ origIdx: q.options.length, textHtml: "" });
      await this.saveToLocalIDB();
      this.render();
    },

    async removeQuestionImage() {
      const q = this.state.workingData.questions.find((item) => item.id === this.state.selectedQuestionId);
      if (!q) return;
      if (this.state.onlyAbnormal) {
        this.state.pinnedQuestionId = q.id;
      }
      q.image = null;
      await this.saveToLocalIDB();
      this.render();
    },

    async autoFormatChemOnCurrent() {
      const q = this.state.workingData.questions.find((item) => item.id === this.state.selectedQuestionId);
      if (!q) return;
      if (this.state.onlyAbnormal) {
        this.state.pinnedQuestionId = q.id;
      }
      q.questionHtml = TextNormalizer.normalize(q.questionHtml, "chemistry");
      q.options = q.options.map((o) => ({ ...o, textHtml: TextNormalizer.normalize(o.textHtml, "chemistry") }));
      await this.saveToLocalIDB();
      this.render();
      App.showToast("已自動套用化學式上下標校正", "success");
    },

    exportBackupJson() {
      const blob = new Blob([JSON.stringify(this.state.workingData, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `custom_qbank_${this.state.slotId}_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
    },

    async handleBackupJsonImport(file) {
      if (!file) return;
      try {
        const json = JSON.parse(await file.text());
        if (!Array.isArray(json.questions) || !Array.isArray(json.chapters)) {
          throw new Error("無效的題庫 JSON 格式");
        }
        this.state.workingData = json;
        this.state.pinnedQuestionId = null;
        this.state.selectedQuestionId = json.questions[0]?.id || null;
        await this.saveToLocalIDB();
        this.render();
        App.showToast(`已從備份檔還原 ${json.questions.length} 題！`, "success");
      } catch (err) {
        App.showToast(err.message || "檔案讀取失敗", "error");
      }
    }
  };

  window.PdfChunkParser = PdfChunkParser;
  window.AdminStudio = AdminStudio;
  window.CustomStudio = CustomStudio;
})();
