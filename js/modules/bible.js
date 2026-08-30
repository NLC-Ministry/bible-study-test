// js/modules/bible.js

import { createReaderBottomDwellController, observeReaderEndSentinel } from "./reader-bottom-dwell.mjs";
import { getReaderSpeechRate, resolveReaderStartIndex, selectPreferredChineseVoice, selectPreferredVoice } from "./reader-speech.mjs";
import { rankBibleSearchResults } from "./bible-search-ranker.mjs";
import { isPlanProgressLocked } from "../data/plan-progress-availability.mjs";

export function openReaderLayer(element) {
  if (!element) return;
  element.classList.remove("hidden");
  element.style.pointerEvents = "auto";
  element.setAttribute("aria-hidden", "false");
  document.body.classList.add("reader-modal-open");
}

export function closeReaderLayer(element) {
  if (!element) return;
  element.classList.add("hidden");
  element.style.pointerEvents = "none";
  element.setAttribute("aria-hidden", "true");
  const stillOpen = document.querySelector(".full-page-overlay:not(.hidden), .bottom-sheet-backdrop:not(.hidden)");
  document.body.classList.toggle("reader-modal-open", Boolean(stillOpen));
}

export function releaseClosedReaderLayers() {
  document.querySelectorAll(
    ".full-page-overlay.hidden, .bottom-sheet-backdrop.hidden, .reader-search-panel.hidden, " +
    ".full-page-overlay[aria-hidden='true'], .bottom-sheet-backdrop[aria-hidden='true'], .reader-search-panel[aria-hidden='true']"
  ).forEach((layer) => {
    layer.style.pointerEvents = "none";
  });
}

function initSmartFloatingReaderNav() {
  const readerView = document.getElementById("reader-view");
  const floatPrev = document.getElementById("floating-prev-btn");
  const floatNext = document.getElementById("floating-next-btn");
  if (!readerView || (!floatPrev && !floatNext) || readerView.dataset.smartFloatingNavBound === "true") return;

  readerView.dataset.smartFloatingNavBound = "true";
  let idleTimer = null;

  const setNavVisible = (visible, awake = false) => {
    document.body.classList.toggle("reader-nav-hidden", !visible);
    document.body.classList.toggle("reader-nav-awake", visible && awake);
  };

  const wakeFloatingNav = (duration = 1600) => {
    clearTimeout(idleTimer);
    setNavVisible(true, true);
    idleTimer = setTimeout(() => setNavVisible(true, false), duration);
  };

  const hideFloatingNavDuringScroll = () => {
    clearTimeout(idleTimer);
    setNavVisible(false, false);
    idleTimer = setTimeout(() => wakeFloatingNav(1400), 500);
    // One-way: unlike the floating prev/next buttons above, the mobile tab
    // bar must not flicker back in on every scroll pause while reading —
    // it only comes back the next time the reader renders (see the reset
    // in renderReaderText()).
    document.body.classList.add("reader-navbar-hidden");
  };

  const bindFloatingButton = (button, direction) => {
    if (!button) return;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      navigateToChapter(direction);
      wakeFloatingNav(900);
    });
  };

  bindFloatingButton(floatPrev, -1);
  bindFloatingButton(floatNext, 1);

  const scrollSurface = readerView.querySelector(".reader-reading-surface") || document.querySelector(".main-content");
  if (scrollSurface) {
    scrollSurface.addEventListener("scroll", hideFloatingNavDuringScroll, { passive: true });
  }

  // Deliberately no tap-to-reveal listener here: a tap/long-press on scripture
  // text is the verse-selection gesture (single tap and long-press range
  // select). Waking the nav chrome on every such tap made it slide in over
  // the selection UI mid-gesture. Scrolling is the only thing that hides it
  // (hideFloatingNavDuringScroll above); the floating prev/next buttons
  // reappear on their own once scrolling pauses, but the mobile tab bar
  // (reader-navbar-hidden) stays out of the way until the next render.
  setNavVisible(true, false);
  document.body.classList.remove("reader-navbar-hidden");
}
let readerBottomDwellController = null;
let readerEndObserver = null;
let readerEndVisible = false;
let readerRenderRequestId = 0;
let readerAutoReadNoticeKey = "";
let selectionBottomBarCleanup = null;
let selectionBottomBarBindTimer = null;
let multiSelectState = null; // { anchor, end, bookName, chapter, chapterId, verses } | null
const MULTI_SELECT_LONG_PRESS_MS = 480;
const ENGLISH_BIBLE_VERSIONS = new Set(["ESV", "NIV", "NLT", "WEB"]);

function usesEnglishReaderLabels(version = state.readerState?.version) {
  return ENGLISH_BIBLE_VERSIONS.has(String(version || "").toUpperCase());
}

function getReaderBookLabel(book) {
  if (!book) return "";
  return usesEnglishReaderLabels() ? book.eng : book.name;
}

function getReaderBookAbbreviation(book) {
  if (!book) return "";
  if (!usesEnglishReaderLabels()) return book.abbrev;
  const match = String(book.eng || "").match(/^(\d\s+)?([A-Za-z]+)/);
  return match ? `${match[1] || ""}${match[2].slice(0, 4)}`.trim() : book.eng;
}

function getCurrentPlanReaderTask() {
  const plan = window.findPlanByContextId?.(state.readerState?.planContextId) || state.activePlan;
  if (!plan || !state.readerState || !state.readerState.fromPlan) return null;

  const book = BIBLE_BOOKS.find(item => Number(item.id) === Number(state.readerState.bookId));
  const round = Number(state.readerState.planRound || plan.currentRound || 1);
  if (!book || !Array.isArray(plan.days)) return null;

  const findChapter = day => Array.isArray(day?.chapters)
    ? day.chapters.find(item =>
      item.book === book.name &&
      Number(item.chapter) === Number(state.readerState.chapter) &&
      Number(item.round || round) === round
    )
    : null;

  let day = plan.days.find(item => Number(item.dayNum) === Number(state.readerState.planDayNum));
  let chapter = findChapter(day);
  if (!chapter) {
    day = plan.days.find(item => Boolean(findChapter(item))) || null;
    chapter = findChapter(day);
  }

  return chapter ? { book, chapter, day, round, plan } : null;
}

function isCurrentPlanReaderTaskRead(taskContext) {
  if (!taskContext) return false;
  const { chapter, round } = taskContext;
  return Boolean(chapter[`isReadR${round}`] || (round === 1 && chapter.isRead));
}

function getCurrentPlanReaderTargetKey() {
  const taskContext = getCurrentPlanReaderTask();
  if (!taskContext) return "";
  const { book, day, round, plan } = taskContext;
  return [plan.id || plan.globalPlanId || plan.presetKey || "plan", day.dayNum, round, book.name, state.readerState.chapter].join("|");
}

async function autoMarkCurrentPlanReaderTaskRead(expectedTargetKey) {
  const taskContext = getCurrentPlanReaderTask();
  if (!taskContext || getCurrentPlanReaderTargetKey() !== expectedTargetKey) return false;
  if (isCurrentPlanReaderTaskRead(taskContext)) return true;
  if (state.readerState.autoMarked || state.readerState.autoMarkInFlight) return false;
  if (taskContext.plan && isPlanExpired(taskContext.plan)) return false;
  if (isPlanProgressLocked(taskContext.plan, { hidden: window.isPlanHidden?.(taskContext.plan) })) return false;
  if (taskContext.round < Number(taskContext.plan.currentRound || 1)) return false;
  // Offline reading mode is read-only for progress — skip silently rather
  // than showing a toast, matching this auto-mark flow's existing "never
  // interrupt with an intrusive subtitle/toast" design.
  if (state.offlineMode) return false;

  const planDayChKey = `${taskContext.book.name}_${state.readerState.chapter}`;
  const readKey = `isReadR${taskContext.round}`;
  const previousRoundRead = Boolean(taskContext.chapter[readKey]);
  const previousRead = Boolean(taskContext.chapter.isRead);
  state.readerState.autoMarked = true;
  state.readerState.autoMarkInFlight = true;
  taskContext.chapter[readKey] = true;
  if (taskContext.round === 1) taskContext.chapter.isRead = true;
  try {
    window.renderPlanScheduleTracker?.();
    calculatePlanProgress();
    if (typeof updateDashboardView === "function") updateDashboardView();
    await db.logChapterRead(taskContext.book.name, state.readerState.chapter, true, taskContext.round, taskContext.plan);

    const shouldHandleR1 = taskContext.plan.isPlanCompleted && !taskContext.plan.upgradePromptHandled;
    const shouldHandleR2 = taskContext.plan.isRound2Completed && !taskContext.plan.round2UpgradePromptHandled;
    if ((shouldHandleR1 || shouldHandleR2) && typeof window.handleRoundCompletion === "function") {
      await window.handleRoundCompletion(taskContext.plan);
    }
    console.info("[AutoRead] Reading log persisted", { targetKey: expectedTargetKey });
    return true;
  } catch (error) {
    console.error("Failed to auto-mark reader progress", error);
    state.readerState.autoMarked = false;
    taskContext.chapter[readKey] = previousRoundRead;
    taskContext.chapter.isRead = previousRead;
    window.renderPlanScheduleTracker?.();
    calculatePlanProgress();
    if (typeof updateDashboardView === "function") updateDashboardView();
    if (typeof showToast === "function") {
      showToast((window.APP_COPY && window.APP_COPY.plan.syncFail) || "閱讀進度同步失敗，請稍後再試");
    }
    return false;
  } finally {
    state.readerState.autoMarkInFlight = false;
  }
}

function initImmersivePlanReader() {
  const readerView = document.getElementById("reader-view");
  const scrollSurface = readerView && readerView.querySelector(".reader-reading-surface");
  if (!readerView || !scrollSurface || readerView.dataset.immersivePlanReaderBound === "true") return;

  readerView.dataset.immersivePlanReaderBound = "true";
  readerBottomDwellController = createReaderBottomDwellController({
    dwellMs: 1000,
    bottomThreshold: 96,
    onComplete: autoMarkCurrentPlanReaderTaskRead
  });
  scrollSurface.addEventListener("scroll", handleReaderScroll, { passive: true });
  scrollSurface.addEventListener("scrollend", handleReaderScroll, { passive: true });
  const mainSurface = document.querySelector(".main-content");
  if (mainSurface && mainSurface !== scrollSurface && mainSurface.dataset.planReaderBottomDwellBound !== "true") {
    mainSurface.dataset.planReaderBottomDwellBound = "true";
    mainSurface.addEventListener("scroll", handleReaderScroll, { passive: true });
    mainSurface.addEventListener("scrollend", handleReaderScroll, { passive: true });
  }
}

export function initReaderControls() {
  releaseClosedReaderLayers();
  const bookSelect = document.getElementById("reader-book-select");
  const chapterSelect = document.getElementById("reader-chapter-select");
  const testamentSelect = document.getElementById("reader-testament-select");
  const bookBadge = document.getElementById("reader-book-badge");
  const chapterBadge = document.getElementById("reader-chapter-badge");
  const readerBackBtn = document.getElementById("reader-back-btn");

  if (readerBackBtn) {
    readerBackBtn.addEventListener("click", () => {
      const globalBackBtn = document.getElementById("global-back-btn");
      if (globalBackBtn) globalBackBtn.click();
    });
  }

  populateBookSelector("all");
  populateChapterSelector();
  updatePillLabels();
  renderReaderPicker();

  function openReaderCatalog() {
    if (typeof window.openBibleNavOverlay === "function") window.openBibleNavOverlay();
  }

  if (bookBadge) bookBadge.addEventListener("click", openReaderCatalog);
  if (chapterBadge) chapterBadge.addEventListener("click", openReaderCatalog);

  const navDirectoryBtn = document.getElementById("reader-nav-directory-btn");
  if (navDirectoryBtn) {
    navDirectoryBtn.addEventListener("click", () => {
      if (typeof window.openBibleNavOverlay === "function") {
        window.openBibleNavOverlay();
      }
    });
  }

  setupVersionPickerEvents();

  const navVersionBtn = document.getElementById("reader-nav-version-btn");
  if (navVersionBtn && navVersionBtn.dataset.versionPickerBound !== "true") {
    navVersionBtn.dataset.versionPickerBound = "true";
    navVersionBtn.addEventListener("click", () => {
      if (typeof window.toggleBibleVersion === "function") {
        window.toggleBibleVersion();
      }
    });
  }

  const audioBtn = document.getElementById("reader-audio-btn");
  if (audioBtn) {
    audioBtn.addEventListener("click", () => {
      if (typeof window.toggleReaderAudio === "function") {
        window.toggleReaderAudio();
      }
    });
  }

  const searchBtn = document.getElementById("reader-search-btn");
  const searchOverlay = document.getElementById("global-search-overlay");
  const searchInput = document.getElementById("global-search-input");
  const searchCancelBtn = document.getElementById("global-search-cancel-btn");
  const searchClearBtn = document.getElementById("global-search-clear-btn");
  const searchResultsContainer = document.getElementById("global-search-results");
  const searchResultsCountEl = document.getElementById("search-results-count");

  if (searchBtn && searchOverlay) {
    searchBtn.addEventListener("click", () => {
      openReaderLayer(searchOverlay);
      if (searchInput) {
        searchInput.value = "";
        searchInput.focus();
      }
      if (searchClearBtn) searchClearBtn.classList.add("hidden");
      if (searchResultsContainer) searchResultsContainer.innerHTML = "";
      if (searchResultsCountEl) searchResultsCountEl.textContent = "請輸入關鍵字進行搜尋";
    });
  }

  if (searchCancelBtn && searchOverlay) {
    searchCancelBtn.addEventListener("click", () => {
      closeReaderLayer(searchOverlay);
    });
  }

  if (searchClearBtn && searchInput) {
    searchClearBtn.addEventListener("click", () => {
      searchInput.value = "";
      searchClearBtn.classList.add("hidden");
      if (searchResultsContainer) searchResultsContainer.innerHTML = "";
      if (searchResultsCountEl) searchResultsCountEl.textContent = "請輸入關鍵字進行搜尋";
      searchInput.focus();
    });
  }

  let searchTimeout = null;
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      const query = e.target.value.trim();
      if (searchClearBtn) {
        searchClearBtn.classList.toggle("hidden", !query);
      }
      
      clearTimeout(searchTimeout);
      if (!query) {
        if (searchResultsContainer) searchResultsContainer.innerHTML = "";
        if (searchResultsCountEl) searchResultsCountEl.textContent = "請輸入關鍵字進行搜尋";
        return;
      }
      
      if (searchResultsCountEl) searchResultsCountEl.textContent = "正在搜尋中...";
      
      searchTimeout = setTimeout(async () => {
        try {
          const results = await window.searchBibleText(query, state.readerState.version || "CUNP");
          renderSearchResults(results, query);
        } catch (err) {
          console.error("Search error:", err);
          if (searchResultsCountEl) searchResultsCountEl.textContent = "搜尋失敗，請稍後再試";
        }
      }, 400);
    });
  }

  function renderSearchResults(results, query) {
    if (!searchResultsContainer) return;
    searchResultsContainer.innerHTML = "";
    
    if (!results || results.length === 0) {
      if (searchResultsCountEl) searchResultsCountEl.textContent = "找不到符合的經文";
      return;
    }
    
    if (searchResultsCountEl) {
      searchResultsCountEl.textContent = `共找到 ${results.length} 筆符合的結果`;
    }
    
    results.forEach(item => {
      const div = document.createElement("div");
      div.className = "search-result-item";
      
      const regex = new RegExp(`(${escapeRegExp(query)})`, "gi");
      const highlightedText = item.text.replace(regex, "<mark>$1</mark>");
      
      div.innerHTML = `
        <div class="search-result-ref">${item.bookName} ${item.chapter}章:${item.verse}節</div>
        <div class="search-result-text">${highlightedText}</div>
      `;
      
      div.addEventListener("click", () => {
        if (searchOverlay) closeReaderLayer(searchOverlay);
        
        const book = BIBLE_BOOKS.find(b => b.name === item.bookName || b.eng.toLowerCase() === item.bookEng.toLowerCase());
        if (book) {
          navOverlayState.selectedBookId = book.id;
          navOverlayState.selectedChapter = item.chapter;
          selectNavVerse(item.verse);
        }
      });
      
      searchResultsContainer.appendChild(div);
    });
  }

  const settingsTrigger = document.getElementById("reader-settings-trigger-btn");
  const settingsBackdrop = document.getElementById("typography-settings-backdrop");
  const settingsCloseBtn = document.getElementById("typography-sheet-close-btn");
  const settingsApplyBtn = document.getElementById("typography-sheet-apply-btn");

  if (settingsTrigger && settingsBackdrop) {
    settingsTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      openReaderLayer(settingsBackdrop);
      updateSheetActiveStates();
      if (typeof window.initSpeechPreferencesControls === "function") {
        window.initSpeechPreferencesControls();
      }
    });
  }

  if (settingsCloseBtn && settingsBackdrop) {
    settingsCloseBtn.addEventListener("click", () => {
      closeReaderLayer(settingsBackdrop);
    });
  }

  if (settingsApplyBtn && settingsBackdrop && settingsApplyBtn.dataset.bound !== "true") {
    settingsApplyBtn.dataset.bound = "true";
    settingsApplyBtn.addEventListener("click", () => {
      const slider = document.getElementById("reader-font-size-slider");
      if (slider) state.readerState.fontSize = normalizeReaderFontSize(slider.value);
      updateReaderFontSize();
      try {
        if (state.speechSettings) {
          localStorage.setItem("nlc_speech_settings", JSON.stringify(state.speechSettings));
        }
      } catch (_error) {}
      closeReaderLayer(settingsBackdrop);
      showToast("閱讀與朗讀設定已套用");
    });
  }

  if (settingsBackdrop) {
    settingsBackdrop.addEventListener("click", (e) => {
      if (e.target === settingsBackdrop) {
        closeReaderLayer(settingsBackdrop);
      }
    });
  }

  const readerFontSizeSlider = document.getElementById("reader-font-size-slider");
  if (readerFontSizeSlider && readerFontSizeSlider.dataset.bound !== "true") {
    readerFontSizeSlider.dataset.bound = "true";
    readerFontSizeSlider.addEventListener("input", () => {
      updateFontSizeDraftDisplay(readerFontSizeSlider.value);
    });
  }

  document.querySelectorAll(".reader-font-size-tick").forEach(btn => {
    if (btn.dataset.bound === "true") return;
    btn.dataset.bound = "true";
    btn.addEventListener("click", () => {
      updateFontSizeDraftDisplay(btn.dataset.readerFontSize);
    });
  });

  document.querySelectorAll(".theme-option").forEach(btn => {
    btn.addEventListener("click", () => {
      const theme = btn.dataset.theme;
      if (typeof window.applyAppTheme === "function") {
        window.applyAppTheme(theme);
        updateSheetActiveStates();
      }
    });
  });

  function updateSheetActiveStates() {
    const fontSize = normalizeReaderFontSize(state.readerState.fontSize);
    updateFontSizeDraftDisplay(fontSize);
    document.querySelectorAll(".theme-option").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.theme === state.theme);
    });
  }

  function updateFontSizeDraftDisplay(value) {
    const fontSize = normalizeReaderFontSize(value);
    const slider = document.getElementById("reader-font-size-slider");
    const output = document.getElementById("reader-font-size-value");
    if (slider) {
      slider.value = String(fontSize);
      slider.setAttribute("aria-valuenow", String(fontSize));
      slider.setAttribute("aria-valuetext", `${fontSize}px`);
    }
    if (output) output.textContent = `${fontSize}px`;
    document.querySelectorAll(".reader-font-size-tick").forEach(btn => {
      const isActive = Number(btn.dataset.readerFontSize) === fontSize;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", String(isActive));
    });
  }

  const testamentButtons = document.querySelectorAll("#reader-testament-buttons .reader-picker-tab");
  testamentButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const filter = btn.dataset.testament || "all";
      if (testamentSelect) testamentSelect.value = filter;
      populateBookSelector(filter);
      populateChapterSelector();
      renderReaderPicker();
      updatePillLabels();
    });
  });

  if (testamentSelect) {
    testamentSelect.addEventListener("change", (e) => {
      populateBookSelector(e.target.value);
      populateChapterSelector();
      renderReaderPicker();
      updatePillLabels();
    });
  }

  if (bookSelect) {
    bookSelect.addEventListener("change", () => {
      populateChapterSelector();
      saveReaderPreferences();
      renderReaderText();
      renderReaderPicker();
      updatePillLabels();
    });
  }

  if (chapterSelect) {
    chapterSelect.addEventListener("change", () => {
      state.readerState.chapter = parseInt(chapterSelect.value);
      saveReaderPreferences();
      renderReaderText();
      renderReaderPicker();
      updatePillLabels();
    });
  }

  const incFont = document.getElementById("reader-font-increase");
  const decFont = document.getElementById("reader-font-decrease");
  if (incFont) incFont.addEventListener("click", () => {
    if (state.readerState.fontSize < 24) { state.readerState.fontSize += 2; updateReaderFontSize(); }
  });
  if (decFont) decFont.addEventListener("click", () => {
    if (state.readerState.fontSize > 16) { state.readerState.fontSize -= 2; updateReaderFontSize(); }
  });

  const legacyInc = document.getElementById("increase-font");
  const legacyDec = document.getElementById("decrease-font");
  if (legacyInc) legacyInc.addEventListener("click", () => {
    if (state.readerState.fontSize < 24) { state.readerState.fontSize += 2; updateReaderFontSize(); }
  });
  if (legacyDec) legacyDec.addEventListener("click", () => {
    if (state.readerState.fontSize > 16) { state.readerState.fontSize -= 2; updateReaderFontSize(); }
  });

  const prevChapterBtn = document.getElementById("prev-chapter-btn");
  const nextChapterBtn = document.getElementById("next-chapter-btn");
  if (prevChapterBtn) prevChapterBtn.addEventListener("click", () => {
    navigateToChapter(-1);
  });
  if (nextChapterBtn) nextChapterBtn.addEventListener("click", () => {
    navigateToChapter(1);
  });

  initSmartFloatingReaderNav();
  initImmersivePlanReader();

  const markReadBtn = document.getElementById("mark-read-btn");
  if (markReadBtn) {
    markReadBtn.addEventListener("click", () => {
      const wasChecked = markReadBtn.classList.contains("checked");
      const isChecked = !wasChecked;
      const bookObj = BIBLE_BOOKS.find(b => b.id === state.readerState.bookId);
      if (!bookObj) return;

      // 💡 關鍵修復：唯讀歷史鎖定，防止從讀經頁面誤觸修改歷史遍數打卡紀錄
      const planRound = state.readerState.planRound || (state.activePlan ? state.activePlan.currentRound || 1 : 1);
      const taskPlan = getCurrentPlanReaderTask()?.plan || state.activePlan;
      if (isChecked && isPlanProgressLocked(taskPlan, { hidden: window.isPlanHidden?.(taskPlan) })) {
        showToast("此階段尚未正式開放，目前僅供預覽，無法記錄已讀。");
        return;
      }
      if (state.activePlan && planRound < (state.activePlan.currentRound || 1)) {
        showToast("此遍進度已完成存檔，無法修改以前的打卡紀錄。");
        return;
      }

      if (state.activePlan && isPlanExpired(state.activePlan)) {
        showToast("此計畫已過期，無法再修改打卡紀錄。");
        return;
      }

      if (state.offlineMode) {
        showToast("離線閱讀模式無法記錄進度，恢復連線後再試");
        return;
      }

      markReadBtn.classList.toggle("checked", isChecked);

      let planDayChKey = null;
      if (state.activePlan) {
        planDayChKey = `${bookObj.name}_${state.readerState.chapter}`;
        window.renderPlanScheduleTracker?.();
        calculatePlanProgress();
        if (typeof updateDashboardView === "function") {
          updateDashboardView();
        }
      }

      db.logChapterRead(bookObj.name, state.readerState.chapter, isChecked, planRound, state.activePlan)
        .then(async () => {
          if (state.activePlan) {
            const plan = state.activePlan;
            const shouldHandleR1 = plan.isPlanCompleted && !plan.upgradePromptHandled;
            const shouldHandleR2 = plan.isRound2Completed && !plan.round2UpgradePromptHandled;
            if (shouldHandleR1 || shouldHandleR2) {
              if (typeof window.handleRoundCompletion === "function") {
                await window.handleRoundCompletion(plan);
              }
            }
            if (isChecked && typeof window.checkAndPromptTodayCompletion === "function") {
              await window.checkAndPromptTodayCompletion();
            }
          }
        })
        .catch(error => {
          console.error("Failed to update reader progress in background", error);
          markReadBtn.classList.toggle("checked", wasChecked);
          if (state.activePlan && planDayChKey) {
            window.renderPlanScheduleTracker?.();
            calculatePlanProgress();
            if (typeof updateDashboardView === "function") {
              updateDashboardView();
            }
          }
          showToast((window.APP_COPY && window.APP_COPY.plan.syncFail) || "進度沒同步成功，等一下再試試");
        });
    });
  }
}

export function renderReaderPicker() {
  renderReaderTestamentTabs();
  renderReaderBookGrid();
  renderReaderChapterGrid();
}

function renderReaderTestamentTabs() {
  const testamentSelect = document.getElementById("reader-testament-select");
  const currentFilter = testamentSelect ? testamentSelect.value : "all";
  document.querySelectorAll("#reader-testament-buttons .reader-picker-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.testament === currentFilter);
  });
}

function renderReaderBookGrid() {
  const grid = document.getElementById("reader-book-grid");
  const bookSelect = document.getElementById("reader-book-select");
  const testamentSelect = document.getElementById("reader-testament-select");
  if (!grid || !bookSelect) return;

  const filter = testamentSelect ? testamentSelect.value : "all";
  grid.innerHTML = "";

  BIBLE_BOOKS.forEach(book => {
    if (filter !== "all" && book.section !== filter) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "reader-book-choice";
    btn.classList.toggle("active", Number(book.id) === Number(state.readerState.bookId));
    btn.textContent = getReaderBookLabel(book);
    btn.addEventListener("click", () => {
      state.readerState.bookId = book.id;
      state.readerState.chapter = 1;
      bookSelect.value = String(book.id);
      populateChapterSelector();
      saveReaderPreferences();
      renderReaderPicker();
      updatePillLabels();
    });
    grid.appendChild(btn);
  });
}

function renderReaderChapterGrid() {
  const grid = document.getElementById("reader-chapter-grid");
  const chapterSelect = document.getElementById("reader-chapter-select");
  const book = BIBLE_BOOKS.find(b => Number(b.id) === Number(state.readerState.bookId));
  if (!grid || !chapterSelect || !book) return;

  grid.innerHTML = "";
  for (let chapter = 1; chapter <= book.chapters; chapter++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "reader-chapter-choice";
    btn.classList.toggle("active", Number(chapter) === Number(state.readerState.chapter));
    btn.textContent = chapter;
    btn.addEventListener("click", () => {
      state.readerState.chapter = chapter;
      chapterSelect.value = String(chapter);
      saveReaderPreferences();
      renderReaderText();
      renderReaderPicker();
      updatePillLabels();
    });
    grid.appendChild(btn);
  }
}

export function populateBookSelector(filter) {
  const bookSelect = document.getElementById("reader-book-select");
  if (!bookSelect) return;

  bookSelect.innerHTML = "";

  BIBLE_BOOKS.forEach(book => {
    if (filter === "all" || book.section === filter) {
      const option = document.createElement("option");
      option.value = book.id;
      option.textContent = getReaderBookLabel(book) + " (" + getReaderBookAbbreviation(book) + ")";
      if (book.id === state.readerState.bookId) {
        option.selected = true;
      }
      bookSelect.appendChild(option);
    }
  });
}

export function populateChapterSelector() {
  const bookSelect = document.getElementById("reader-book-select");
  const chapterSelect = document.getElementById("reader-chapter-select");
  const bookId = bookSelect ? parseInt(bookSelect.value || state.readerState.bookId, 10) : Number(state.readerState.bookId || 1);
  state.readerState.bookId = bookId;

  const book = BIBLE_BOOKS.find(b => b.id === bookId);
  if (!book) {
    console.error("Book not found for ID:", bookId);
    return;
  }

  if (state.readerState.chapter > book.chapters) {
    state.readerState.chapter = 1;
  }

  if (!chapterSelect) return;
  chapterSelect.innerHTML = "";

  for (let i = 1; i <= book.chapters; i++) {
    const option = document.createElement("option");
    option.value = i;
    option.textContent = usesEnglishReaderLabels() ? `Chapter ${i}` : `${i} 章`;
    if (i === state.readerState.chapter) {
      option.selected = true;
    }
    chapterSelect.appendChild(option);
  }
}

export function saveReaderPreferences() {
  localStorage.setItem("reader_state", JSON.stringify({
    bookId: state.readerState.bookId,
    chapter: state.readerState.chapter
  }));
}

export function updatePillLabels() {
  const book = BIBLE_BOOKS.find(b => b.id === state.readerState.bookId);
  const refLabel = document.getElementById("reader-nav-ref-label");
  if (refLabel && book) {
    refLabel.textContent = usesEnglishReaderLabels()
      ? `${book.eng} ${state.readerState.chapter}`
      : `${book.name} ${state.readerState.chapter}`;
  }

  const versionBtn = document.getElementById("reader-nav-version-btn");
  if (versionBtn) {
    const version = state.readerState.version || "CUNP";
    const label = version === "RCUVTS" ? "RCUV" : version;
    const span = versionBtn.querySelector("span");
    if (span) span.textContent = label;
    const inlineVersion = document.getElementById("reader-version-inline");
    if (inlineVersion) inlineVersion.textContent = label;
    const navBadge = document.getElementById("bible-nav-version-badge");
    if (navBadge) navBadge.textContent = label;
  }
}

const READER_FONT_SIZES = [16, 18, 20, 22, 24];

function normalizeReaderFontSize(value) {
  const requestedSize = Number(value);
  if (!Number.isFinite(requestedSize)) return 20;
  return READER_FONT_SIZES.reduce((closest, size) =>
    Math.abs(size - requestedSize) < Math.abs(closest - requestedSize) ? size : closest, 20);
}

export function updateReaderFontSize() {
  const size = normalizeReaderFontSize(state.readerState.fontSize);
  state.readerState.fontSize = size;
  document.documentElement.style.setProperty("--reader-font-size", size + "px");
  const readerView = document.getElementById("reader-view");
  if (readerView) readerView.style.setProperty("--reader-font-size", size + "px");
  const bibleContent = document.getElementById("bible-content");
  if (bibleContent) {
    bibleContent.style.setProperty("font-size", size + "px", "important");
    bibleContent.querySelectorAll(".verse-text, .verse-num").forEach(element => {
      element.style.setProperty("font-size", size + "px", "important");
    });
  }

  localStorage.setItem("reader_font_size", size);

  const slider = document.getElementById("reader-font-size-slider");
  const output = document.getElementById("reader-font-size-value");
  if (slider) {
    slider.value = String(size);
    slider.setAttribute("aria-valuenow", String(size));
    slider.setAttribute("aria-valuetext", `${size}px`);
  }
  if (output) output.textContent = `${size}px`;

  document.querySelectorAll("#reader-settings-dropdown .font-btn, .reader-font-size-tick").forEach(b => {
    const buttonSize = Number(b.dataset.readerFontSize ?? b.dataset.size);
    const isActive = buttonSize === state.readerState.fontSize;
    b.classList.toggle("active", isActive);
    if (b.classList.contains("reader-font-size-tick")) b.setAttribute("aria-pressed", String(isActive));
  });

  document.querySelectorAll("#reader-settings-dropdown .theme-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.theme === state.theme);
  });
}

function getReaderScrollSurface() {
  const readerSurface = document.querySelector(".reader-reading-surface");
  const mainSurface = document.querySelector(".main-content");
  if (readerSurface && Number(readerSurface.scrollHeight) > Number(readerSurface.clientHeight) + 1) return readerSurface;
  if (mainSurface && Number(mainSurface.scrollHeight) > Number(mainSurface.clientHeight) + 1) return mainSurface;
  return readerSurface || mainSurface;
}

function setReaderScrollTop(top = 0, behavior = "auto") {
  const scrollSurface = getReaderScrollSurface();
  if (!scrollSurface) return false;
  const safeTop = Math.max(0, Number(top) || 0);
  if (behavior === "auto") {
    scrollSurface.scrollTop = safeTop;
    return true;
  }
  try {
    scrollSurface.scrollTo({ top: safeTop, behavior });
  } catch (_error) {
    scrollSurface.scrollTop = safeTop;
  }
  return true;
}

function scrollReaderVerseIntoView(verseElement, behavior = "smooth") {
  const scrollSurface = getReaderScrollSurface();
  if (!scrollSurface || !verseElement) return false;

  const surfaceRect = scrollSurface.getBoundingClientRect();
  const verseRect = verseElement.getBoundingClientRect();
  const centerOffset = Math.max(0, (scrollSurface.clientHeight - verseRect.height) / 2);
  const targetTop = scrollSurface.scrollTop + verseRect.top - surfaceRect.top - centerOffset;
  return setReaderScrollTop(targetTop, behavior);
}

function nextReaderLayoutFrame() {
  return new Promise(resolve => {
    const schedule = window.requestAnimationFrame || (callback => window.setTimeout(callback, 0));
    schedule(() => schedule(resolve));
  });
}

async function resetReaderScrollAfterChapterRender(sessionId) {
  // Wait for the new verses and their final font metrics to affect layout.
  // Reset twice (before and after the layout frames) to defeat mobile browser
  // scroll anchoring, which can otherwise keep the old chapter's bottom edge.
  setReaderScrollTop(0, "auto");
  await nextReaderLayoutFrame();
  if (sessionId !== currentAudioSessionId || !isSpeaking) return false;
  setReaderScrollTop(0, "auto");
  return true;
}

export async function navigateToChapter(direction, options = {}) {
  const autoContinue = options.autoContinue === true;
  const hadAudioPosition = isSpeaking || !document.getElementById("reader-audio-timeline")?.classList.contains("hidden");
  if (!autoContinue) stopReaderAudio(true);
  const currentBook = BIBLE_BOOKS.find(b => b.id === state.readerState.bookId);

  if (direction > 0 && !autoContinue && state.readerState && state.readerState.fromPlan && state.activePlan) {
    const plan = state.activePlan;
    const planDay = state.readerState.planDayNum || 1;
    const selectedDay = plan.days.find(d => d.dayNum === planDay);
    const dayChapters = (selectedDay && selectedDay.chapters) || [];
    const currentChIndex = dayChapters.findIndex(ch =>
      ch.book === currentBook.name && Number(ch.chapter) === Number(state.readerState.chapter)
    );
    const isLastChapterOfDay = currentChIndex === dayChapters.length - 1 || currentChIndex === -1;

    if (isLastChapterOfDay) {
      if (isTodayScheduleCompleted()) {
        return false;
      } else {
        const nextChInfo = getNextPlanChapterInfo(plan, planDay, currentChIndex, dayChapters);
        if (nextChInfo) {
          const nextBook = BIBLE_BOOKS.find(b => b.name === nextChInfo.book || b.eng === nextChInfo.book);
          if (nextBook) {
            state.readerState.bookId = nextBook.id;
            state.readerState.chapter = Number(nextChInfo.chapter);
            state.readerState.planDayNum = nextChInfo.dayNum;
            const rendered = await renderReaderText({ preserveAudio: autoContinue, autoContinue });
            if (autoContinue && rendered !== true) return false;
            if (!autoContinue) resetReaderAudioAfterManualChapterChange(hadAudioPosition);
            return true;
          }
        }
      }
    } else {
      const nextCh = dayChapters[currentChIndex + 1];
      const nextBook = BIBLE_BOOKS.find(b => b.name === nextCh.book || b.eng === nextCh.book);
      if (nextBook) {
        state.readerState.bookId = nextBook.id;
        state.readerState.chapter = Number(nextCh.chapter);
        const rendered = await renderReaderText({ preserveAudio: autoContinue, autoContinue });
        if (autoContinue && rendered !== true) return false;
        if (!autoContinue) resetReaderAudioAfterManualChapterChange(hadAudioPosition);
        return true;
      }
    }
  }

  let newChapter = state.readerState.chapter + direction;
  
  if (newChapter < 1) {
    const prevBookId = state.readerState.bookId - 1;
    if (prevBookId >= 1) {
      const prevBook = BIBLE_BOOKS.find(b => b.id === prevBookId);
      state.readerState.bookId = prevBookId;
      state.readerState.chapter = prevBook.chapters;
      
      const testamentSelect = document.getElementById("reader-testament-select");
      if (testamentSelect) testamentSelect.value = "all";
      populateBookSelector("all");
      populateChapterSelector();
      saveReaderPreferences();
      const rendered = await renderReaderText({ preserveAudio: autoContinue, autoContinue });
      if (autoContinue && rendered !== true) return false;
      if (!autoContinue) resetReaderAudioAfterManualChapterChange(hadAudioPosition);
      return true;
    }
  } else if (newChapter > currentBook.chapters) {
    const nextBookId = state.readerState.bookId + 1;
    if (nextBookId <= 66) {
      state.readerState.bookId = nextBookId;
      state.readerState.chapter = 1;
      
      const testamentSelect = document.getElementById("reader-testament-select");
      if (testamentSelect) testamentSelect.value = "all";
      populateBookSelector("all");
      populateChapterSelector();
      saveReaderPreferences();
      const rendered = await renderReaderText({ preserveAudio: autoContinue, autoContinue });
      if (autoContinue && rendered !== true) return false;
      if (!autoContinue) resetReaderAudioAfterManualChapterChange(hadAudioPosition);
      return true;
    }
  } else {
    state.readerState.chapter = newChapter;
    const chapterSelect = document.getElementById("reader-chapter-select");
    if (chapterSelect) chapterSelect.value = newChapter;
    saveReaderPreferences();
    const rendered = await renderReaderText({ preserveAudio: autoContinue, autoContinue });
    if (autoContinue && rendered !== true) return false;
    if (!autoContinue) resetReaderAudioAfterManualChapterChange(hadAudioPosition);
    return true;
  }
  return false;
}

export async function renderReaderText(options = {}) {
  const container = document.getElementById("bible-content");
  if (!container) return;

  const renderRequestId = ++readerRenderRequestId;
  const requestedVersion = String(state.readerState?.version || "CUNP").toUpperCase();

  let verses = null;
  let isLoading = true;

  if (isSpeaking && options.preserveAudio !== true) {
    stopReaderAudio(true);
  }
  document.body.classList.remove("reader-navbar-hidden");
  state.readerState.selectedVerseNum = null;
  closeSelectionBottomBar();
  closeMultiSelectionBar();
  state.readerState.autoMarked = false;
  state.readerState.autoMarkInFlight = false;
  if (readerBottomDwellController) readerBottomDwellController.reset();
  readerEndObserver?.disconnect();
  readerEndObserver = null;
  readerEndVisible = false;
  const heading = document.getElementById("bible-title");
  const markReadBtn = document.getElementById("mark-read-btn");
  
  const bookId = Number(state.readerState && state.readerState.bookId) || 1;
  const book = BIBLE_BOOKS.find(b => b.id === bookId) || BIBLE_BOOKS[0];
  const chapter = Number(state.readerState && state.readerState.chapter) || 1;

  if (heading) heading.textContent = usesEnglishReaderLabels()
    ? `${book.eng} Chapter ${chapter}`
    : `${book.name} ${chapter}章`;
  updatePillLabels();
  renderReaderPicker();
  loadVerseNotesForChapter(book.name, chapter);

  setReaderScrollTop(0, "auto");

  const bar = document.getElementById("reader-bottom-action-bar");
  if (bar) {
    bar.style.display = "none";
    bar.classList.add("hidden");
  }

  const cacheKey = window.getBibleChapterCacheKey
    ? window.getBibleChapterCacheKey(book.eng, chapter, requestedVersion)
    : `${requestedVersion}_${book.eng}_${chapter}`;
  const cachedData = window._bibleChapterCache && window._bibleChapterCache[cacheKey];
  if (cachedData && !cachedData.isPlaceholder && cachedData.verses && cachedData.verses.length > 0) {
    verses = cachedData.verses;
    isLoading = false;
  }

  if (isLoading || !verses) {
    ComponentSkeletonLoader.show('reader', container);
  } else {
    renderVersesList(container, verses, book.name, chapter);
  }
  
  if (markReadBtn) {
    const isRead = state.readingLogs.some(l => l.book === book.name && l.chapter === chapter);
    markReadBtn.classList.toggle("checked", isRead);
  }

  try {
    isLoading = true;
    const data = await fetchBibleChapter(book.eng, chapter, requestedVersion);
    const requestIsStale = renderRequestId !== readerRenderRequestId
      || String(state.readerState?.version || "CUNP").toUpperCase() !== requestedVersion
      || Number(state.readerState?.bookId) !== bookId
      || Number(state.readerState?.chapter) !== chapter;
    if (requestIsStale) return false;
    verses = data ? data.verses : null;
    isLoading = false;

    if (!verses || verses.length === 0) {
      throw new Error("經文正在稍微休息中，別擔心，我們一起重新點亮畫面試試看！");
    }

    if (data.isPlaceholder) {
      if (options.autoContinue === true && options.autoRetryAttempted !== true) {
        await new Promise(resolve => window.setTimeout(resolve, 450));
        const retryIsStale = renderRequestId !== readerRenderRequestId
          || String(state.readerState?.version || "CUNP").toUpperCase() !== requestedVersion
          || Number(state.readerState?.bookId) !== bookId
          || Number(state.readerState?.chapter) !== chapter;
        if (retryIsStale) return false;
        return renderReaderText({
          preserveAudio: true,
          autoContinue: true,
          autoRetryAttempted: true
        });
      }
      renderReaderLoadRetryState(container, {
        bookEngName: book.eng,
        chapter,
        version: requestedVersion
      });
      updateReaderFontSize();
      return false;
    }

    renderVersesList(container, verses, book.name, chapter);
    triggerPredictivePrefetch();
  } catch (error) {
    if (renderRequestId !== readerRenderRequestId
      || String(state.readerState?.version || "CUNP").toUpperCase() !== requestedVersion) return false;
    console.error("Failed to load complete Bible chapter:", error);
    isLoading = false;
    renderReaderLoadRetryState(container, {
      bookEngName: book.eng,
      chapter,
      version: requestedVersion
    });
    updateReaderFontSize();
    return false;
  }

  updateReaderFontSize();
  setReaderScrollTop(0, "auto");
  updateReaderBottomActionBar();
  bindReaderEndObserver();
  scheduleReaderBottomDwellCheck();
  return true;
}

function renderReaderLoadRetryState(container, { bookEngName, chapter, version }) {
  if (!container) return;
  container.innerHTML = `
    <div class="reader-load-retry-state" role="alert" aria-live="polite">
      <span class="reader-load-retry-state__icon" aria-hidden="true">
        <span class="nlc-icon nlc-icon--md" data-icon="refresh"></span>
      </span>
      <strong>經文尚未載入</strong>
      <p>請確認網路連線後，再重新讀取本章經文。</p>
      <button type="button" class="primary-btn reader-load-retry-state__button" data-reader-load-retry>
        <span class="nlc-icon nlc-icon--sm" data-icon="refresh" aria-hidden="true"></span>
        <span>重新讀取</span>
      </button>
    </div>
  `;
  if (typeof hydrateIcons === "function") hydrateIcons(container);

  container.querySelector("[data-reader-load-retry]")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    const label = button.querySelector("span:last-child");
    if (label) label.textContent = "重新讀取中…";

    const cacheKey = window.getBibleChapterCacheKey
      ? window.getBibleChapterCacheKey(bookEngName, chapter, version)
      : `${version}_${bookEngName}_${chapter}`;
    if (window._bibleChapterCache) delete window._bibleChapterCache[cacheKey];
    await renderReaderText();
  });
}

function clearReaderStartSelection() {
  const container = document.getElementById("bible-content");
  if (container) {
    container.querySelectorAll(".bible-verse.reader-start-selected").forEach(item => {
      item.classList.remove("reader-start-selected");
      item.setAttribute("aria-pressed", "false");
    });
  }
  if (state.readerState) {
    state.readerState.selectedVerseNum = null;
  }
}

function closeSelectionBottomBar({ clearSelection = true } = {}) {
  if (selectionBottomBarBindTimer) {
    clearTimeout(selectionBottomBarBindTimer);
    selectionBottomBarBindTimer = null;
  }
  if (typeof selectionBottomBarCleanup === "function") {
    selectionBottomBarCleanup();
    selectionBottomBarCleanup = null;
  }
  const rootElement = document.getElementById("selection-bottom-bar-root");
  if (rootElement) rootElement.innerHTML = "";
  if (clearSelection) clearReaderStartSelection();
}

function setReaderStartSelection(verseElement) {
  const container = document.getElementById("bible-content");
  if (!container || !verseElement) {
    clearReaderStartSelection();
    return false;
  }
  const wasSelected = verseElement.classList.contains("reader-start-selected");
  clearReaderStartSelection();
  if (wasSelected) {
    console.info("[ReaderAudio] Start verse selection cleared");
    return false;
  }
  verseElement.classList.add("reader-start-selected");
  verseElement.setAttribute("aria-pressed", "true");
  state.readerState.selectedVerseNum = Number(verseElement.dataset.verse || 1);
  console.info("[ReaderAudio] Start verse selected", { verse: state.readerState.selectedVerseNum });
  return true;
}
function setVerseNoteBadge(verseDiv, hasNote) {
  if (!verseDiv) return;
  let badge = verseDiv.querySelector(".verse-note-badge");
  if (hasNote) {
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "verse-note-badge";
      badge.setAttribute("data-icon", "pencil");
      badge.setAttribute("aria-hidden", "true");
      verseDiv.appendChild(badge);
      // hydrateIcons scans the given root's DESCENDANTS for [data-icon] — it
      // never processes the root element itself, so this must be the badge's
      // container, not the badge (which IS the [data-icon] element).
      if (typeof hydrateIcons === "function") hydrateIcons(verseDiv);
    }
  } else if (badge) {
    badge.remove();
  }
}

/**
 * 長按多節選取（連續範圍，僅限同一章）
 */
function clearMultiSelection() {
  const container = document.getElementById("bible-content");
  if (container) {
    container.querySelectorAll(".bible-verse.multi-selected").forEach(el => {
      el.classList.remove("multi-selected");
    });
  }
  multiSelectState = null;
}

function closeMultiSelectionBar() {
  if (selectionBottomBarBindTimer) {
    clearTimeout(selectionBottomBarBindTimer);
    selectionBottomBarBindTimer = null;
  }
  if (typeof selectionBottomBarCleanup === "function") {
    selectionBottomBarCleanup();
    selectionBottomBarCleanup = null;
  }
  if (!multiSelectState) return;
  const rootElement = document.getElementById("selection-bottom-bar-root");
  if (rootElement) rootElement.innerHTML = "";
  clearMultiSelection();
}

function renderMultiSelectionHighlight() {
  const container = document.getElementById("bible-content");
  if (!container || !multiSelectState) return;
  const low = Math.min(multiSelectState.anchor, multiSelectState.end);
  const high = Math.max(multiSelectState.anchor, multiSelectState.end);
  container.querySelectorAll(".bible-verse[data-verse]").forEach(el => {
    const num = Number(el.dataset.verse);
    el.classList.toggle("multi-selected", num >= low && num <= high);
  });
}

function getMultiSelectedVerses() {
  if (!multiSelectState) return [];
  const low = Math.min(multiSelectState.anchor, multiSelectState.end);
  const high = Math.max(multiSelectState.anchor, multiSelectState.end);
  return multiSelectState.verses
    .filter(v => v.verse >= low && v.verse <= high)
    .sort((a, b) => a.verse - b.verse);
}

function formatMultiVerseCopyText(bookName, chapter, versesInRange) {
  if (versesInRange.length <= 1) {
    const v = versesInRange[0];
    return v ? `【${bookName} ${chapter}:${v.verse}】${v.text}` : "";
  }
  const first = versesInRange[0].verse;
  const last = versesInRange[versesInRange.length - 1].verse;
  const body = versesInRange.map(v => `${v.verse} ${v.text}`).join("\n");
  return `【${bookName} ${chapter}:${first}-${last}】\n${body}`;
}

function openMultiSelectBottomBar() {
  const rootElement = document.getElementById("selection-bottom-bar-root");
  if (!rootElement || !multiSelectState) return;
  if (selectionBottomBarBindTimer) {
    clearTimeout(selectionBottomBarBindTimer);
    selectionBottomBarBindTimer = null;
  }
  if (typeof selectionBottomBarCleanup === "function") {
    selectionBottomBarCleanup();
    selectionBottomBarCleanup = null;
  }

  const { bookName, chapter } = multiSelectState;
  const low = Math.min(multiSelectState.anchor, multiSelectState.end);
  const high = Math.max(multiSelectState.anchor, multiSelectState.end);
  const versesInRange = getMultiSelectedVerses();
  const rangeLabel = low === high ? `${bookName} ${chapter}:${low}` : `${bookName} ${chapter}:${low}-${high}`;
  const selectedText = formatMultiVerseCopyText(bookName, chapter, versesInRange);

  rootElement.innerHTML = `
    <div id="pwa-selection-bottom-bar" class="youversion-action-bar active youversion-action-bar--multi">
      <div class="yv-content-row">
        <div class="yv-highlight-section">
          <span class="yv-section-label">已選取 ${escapeHTML(rangeLabel)}（共 ${versesInRange.length} 節）</span>
        </div>
        <div class="yv-action-group">
          <button type="button" class="yv-multi-cancel-button" data-action="ms-cancel" aria-label="取消多節選取" title="取消多節選取">
            <span class="nlc-icon" data-icon="close" aria-hidden="true"></span>
          </button>
          <button type="button" class="yv-tile" data-action="ms-copy">
            <span class="nlc-icon" data-icon="copy" aria-hidden="true"></span>
            <span class="yv-tile-label">複製</span>
          </button>
          <button type="button" class="yv-tile" data-action="ms-share">
            <span class="nlc-icon" data-icon="share" aria-hidden="true"></span>
            <span class="yv-tile-label">分享</span>
          </button>
        </div>
      </div>
    </div>
  `;

  const barDiv = document.getElementById("pwa-selection-bottom-bar");
  if (!barDiv) return;
  if (typeof hydrateIcons === "function") hydrateIcons(barDiv);

  const cleanupListeners = () => {
    document.removeEventListener("click", onDocClick);
  };
  selectionBottomBarCleanup = cleanupListeners;

  const onDocClick = e => {
    if (barDiv.contains(e.target) || (e.target && e.target.closest && e.target.closest(".bible-verse"))) return;
    closeMultiSelectionBar();
  };

  barDiv.querySelector('[data-action="ms-copy"]')?.addEventListener("click", e => {
    e.stopPropagation();
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(selectedText).then(() => {
        showToast("經文已複製到剪貼簿！");
      });
    } else {
      showToast(selectedText);
    }
    closeMultiSelectionBar();
  });

  barDiv.querySelector('[data-action="ms-share"]')?.addEventListener("click", e => {
    e.stopPropagation();
    if (navigator.share) {
      navigator.share({ title: "經文分享", text: selectedText, url: window.location.href }).catch(() => {});
    } else if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(selectedText).then(() => {
        showToast("經文已複製，可直接貼上分享！");
      });
    }
    closeMultiSelectionBar();
  });

  barDiv.querySelector('[data-action="ms-cancel"]')?.addEventListener("click", e => {
    e.stopPropagation();
    closeMultiSelectionBar();
  });

  selectionBottomBarBindTimer = setTimeout(() => {
    document.addEventListener("click", onDocClick);
    selectionBottomBarBindTimer = null;
  }, 100);
}

function startMultiSelection(verseNum, bookName, chapter, chapterId, verses) {
  closeSelectionBottomBar({ clearSelection: true });
  multiSelectState = { anchor: verseNum, end: verseNum, bookName, chapter, chapterId, verses };
  renderMultiSelectionHighlight();
  openMultiSelectBottomBar();
}

function extendMultiSelection(verseNum) {
  if (!multiSelectState) return;
  multiSelectState.end = verseNum;
  renderMultiSelectionHighlight();
  openMultiSelectBottomBar();
}

function renderVersesList(container, verses, bookName, chapter) {
  container.innerHTML = "";
  clearMultiSelection();
  const chapterId = `${state.readerState?.bookId || "GEN"}_${chapter}`;
  verses.forEach(v => {
    const verseDiv = document.createElement("div");
    verseDiv.className = "bible-verse";
    verseDiv.dataset.verse = String(v.verse);
    verseDiv.id = `reader-verse-${v.verse}`;
    verseDiv.tabIndex = 0;
    verseDiv.setAttribute("role", "button");
    verseDiv.setAttribute("aria-pressed", "false");
    verseDiv.setAttribute("aria-label", `第 ${v.verse} 節，點一下選為朗讀起點`);

    const highlightKey = `${bookName}_${chapter}_${v.verse}`;
    if (state.highlights[highlightKey]) {
      verseDiv.style.setProperty("--verse-highlight-color", state.highlights[highlightKey]);
      verseDiv.setAttribute("data-highlight", state.highlights[highlightKey]);
    }

    verseDiv.innerHTML = `<span class="verse-num">${v.verse}</span><span class="verse-text">${v.text}</span>`;
    setVerseNoteBadge(verseDiv, Boolean(state.verseNotes[highlightKey]));

    let longPressTimer = null;
    let longPressFired = false;

    const clearLongPressTimer = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    const startLongPressTimer = () => {
      clearLongPressTimer();
      longPressFired = false;
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        longPressFired = true;
        if (multiSelectState) {
          extendMultiSelection(v.verse);
        } else {
          startMultiSelection(v.verse, bookName, chapter, chapterId, verses);
        }
      }, MULTI_SELECT_LONG_PRESS_MS);
    };

    verseDiv.addEventListener("touchstart", startLongPressTimer, { passive: true });
    verseDiv.addEventListener("touchend", clearLongPressTimer);
    verseDiv.addEventListener("touchmove", clearLongPressTimer, { passive: true });
    verseDiv.addEventListener("touchcancel", clearLongPressTimer);
    verseDiv.addEventListener("mousedown", startLongPressTimer);
    verseDiv.addEventListener("mouseup", clearLongPressTimer);
    verseDiv.addEventListener("mouseleave", clearLongPressTimer);
    verseDiv.addEventListener("contextmenu", e => {
      if (longPressFired) e.preventDefault();
    });

    const toggleSelection = e => {
      e.stopPropagation();
      if (longPressFired) {
        longPressFired = false;
        return;
      }
      if (multiSelectState) {
        extendMultiSelection(v.verse);
        return;
      }
      const isSelected = setReaderStartSelection(verseDiv);
      if (!isSelected) {
        closeSelectionBottomBar({ clearSelection: false });
        return;
      }
      const verseText = v.text;
      const formattedText = `【${bookName} ${chapter}:${v.verse}】${verseText}`;
      openIntegratedSelectionBottomBar({
        selectedText: formattedText,
        verseText,
        verseDiv,
        highlightKey,
        chapterId,
        bookName,
        chapter,
        verse: v.verse
      });
    };
    verseDiv.addEventListener("click", toggleSelection);
    verseDiv.addEventListener("keydown", e => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggleSelection(e);
    });

    container.appendChild(verseDiv);
  });


  const sentinel = document.createElement("div");
  sentinel.id = "reader-end-sentinel";
  sentinel.setAttribute("aria-hidden", "true");
  sentinel.style.cssText = "height:1px;width:100%;pointer-events:none;";
  container.appendChild(sentinel);
}

let verseNotesLoadToken = 0;

async function loadVerseNotesForChapter(bookName, chapter) {
  const requestToken = ++verseNotesLoadToken;
  const notes = await db.getVerseNotesForChapter(bookName, chapter);
  if (requestToken !== verseNotesLoadToken) return; // a newer chapter load superseded this request

  state.verseNotes = {};
  Object.keys(notes).forEach(verse => {
    state.verseNotes[`${bookName}_${chapter}_${verse}`] = notes[verse];
  });

  const container = document.getElementById("bible-content");
  if (!container) return;
  container.querySelectorAll(".bible-verse[data-verse]").forEach(verseDiv => {
    const key = `${bookName}_${chapter}_${verseDiv.dataset.verse}`;
    setVerseNoteBadge(verseDiv, Boolean(state.verseNotes[key]));
  });
}

/**
 * Integrated Reader Selection Bottom Bar Launcher
 */
function openIntegratedSelectionBottomBar(options) {
  const { selectedText, verseText, verseDiv, highlightKey, chapterId, bookName, chapter, verse } = options;
  const rootElement = document.getElementById("selection-bottom-bar-root");
  if (!rootElement) return;
  closeSelectionBottomBar({ clearSelection: false });

  if (state.readerState && verseDiv) {
    const verseNum = Number(verseDiv.dataset.verse || 1);
    state.readerState.lastFocusedVerseNum = verseNum;
  }

  const selectedVerseNumber = Number(verseDiv?.dataset.verse || 1);
  const activeHighlightColor = state.highlights?.[highlightKey] || "";
  const hasExistingNote = Boolean(state.verseNotes?.[highlightKey]);

  rootElement.innerHTML = `
    <div id="pwa-selection-bottom-bar" class="youversion-action-bar active">
      <div class="yv-content-row">
        <div class="yv-action-group">
          <button type="button" class="yv-tile" data-action="copy">
            <span class="nlc-icon" data-icon="copy" aria-hidden="true"></span>
            <span class="yv-tile-label">複製</span>
          </button>
          <button type="button" class="yv-tile${activeHighlightColor ? " is-active" : ""}" data-action="toggle-highlight" aria-expanded="false" aria-controls="yv-highlight-palette">
            <span class="nlc-icon" data-icon="pencil" aria-hidden="true"></span>
            <span class="yv-tile-label">螢光筆</span>
          </button>
          <button type="button" class="yv-tile${hasExistingNote ? " is-active" : ""}" data-action="note">
            <span class="nlc-icon" data-icon="journalText" aria-hidden="true"></span>
            <span class="yv-tile-label">筆記</span>
          </button>
          <button type="button" class="yv-tile" data-action="share">
            <span class="nlc-icon" data-icon="share" aria-hidden="true"></span>
            <span class="yv-tile-label">分享</span>
          </button>
        </div>
      </div>
      <div id="yv-highlight-palette" class="yv-highlight-section yv-highlight-popover hidden" data-highlight-palette role="dialog" aria-label="螢光筆色盤">
        <span class="yv-section-label">選擇顏色</span>
        <div class="yv-color-capsule" role="group" aria-label="選擇螢光標註顏色">
          <button type="button" class="yv-dot-clear" data-action="clear" title="取消螢光標註" aria-label="取消螢光標註">
            <span class="nlc-icon" data-icon="noColor" aria-hidden="true"></span>
          </button>
          <span class="yv-section-divider" aria-hidden="true"></span>
          <button type="button" class="yv-dot yv-dot-yellow${activeHighlightColor === "#fef08a" ? " is-active" : ""}" data-color="#fef08a" title="柔黃標註" aria-label="柔黃標註" aria-pressed="${activeHighlightColor === "#fef08a"}"></button>
          <button type="button" class="yv-dot yv-dot-cyan${activeHighlightColor === "#a5f3fc" ? " is-active" : ""}" data-color="#a5f3fc" title="柔藍標註" aria-label="柔藍標註" aria-pressed="${activeHighlightColor === "#a5f3fc"}"></button>
          <button type="button" class="yv-dot yv-dot-green${activeHighlightColor === "#bbf7d0" ? " is-active" : ""}" data-color="#bbf7d0" title="柔綠標註" aria-label="柔綠標註" aria-pressed="${activeHighlightColor === "#bbf7d0"}"></button>
          <button type="button" class="yv-dot yv-dot-dual${activeHighlightColor === "#fed7aa" ? " is-active" : ""}" data-color="#fed7aa" title="柔橘標註" aria-label="柔橘標註" aria-pressed="${activeHighlightColor === "#fed7aa"}"></button>
          <button type="button" class="yv-dot yv-dot-pink${activeHighlightColor === "#fecdd3" ? " is-active" : ""}" data-color="#fecdd3" title="柔粉標註" aria-label="柔粉標註" aria-pressed="${activeHighlightColor === "#fecdd3"}"></button>
          <button type="button" class="yv-dot yv-dot-purple${activeHighlightColor === "#ddd6fe" ? " is-active" : ""}" data-color="#ddd6fe" title="柔紫標註" aria-label="柔紫標註" aria-pressed="${activeHighlightColor === "#ddd6fe"}"></button>
          <label class="yv-custom-color" title="自訂顏色">
            <input type="color" data-custom-highlight-color value="${/^#[0-9a-f]{6}$/i.test(activeHighlightColor) ? activeHighlightColor : "#fef08a"}" aria-label="自訂螢光筆顏色">
            <span aria-hidden="true"></span>
          </label>
        </div>
      </div>
    </div>
  `;

  const barDiv = document.getElementById("pwa-selection-bottom-bar");
  if (!barDiv) return;
  if (typeof hydrateIcons === "function") hydrateIcons(barDiv);

  const cleanupListeners = () => {
    document.removeEventListener("click", onDocClick);
    window.removeEventListener("resize", positionHighlightPalette);
  };

  selectionBottomBarCleanup = cleanupListeners;

  const closeBar = (options = {}) => {
    closeSelectionBottomBar(options);
  };

  const highlightPalette = barDiv.querySelector("[data-highlight-palette]");
  const highlightToggle = barDiv.querySelector('[data-action="toggle-highlight"]');

  const positionHighlightPalette = () => {
    if (!highlightToggle || !highlightPalette || highlightPalette.classList.contains("hidden")) return;
    const barRect = barDiv.getBoundingClientRect();
    const toggleRect = highlightToggle.getBoundingClientRect();
    const anchorX = toggleRect.left - barRect.left + (toggleRect.width / 2);
    highlightPalette.style.setProperty("--yv-highlight-anchor-x", `${anchorX}px`);
  };

  const setHighlightPaletteOpen = (open) => {
    highlightPalette?.classList.toggle("hidden", !open);
    highlightToggle?.setAttribute("aria-expanded", String(open));
    highlightToggle?.classList.toggle("is-active", open || Boolean(state.highlights?.[highlightKey]));
    if (open) requestAnimationFrame(positionHighlightPalette);
  };

  const onDocClick = (e) => {
    if (barDiv.contains(e.target) || (e.target && e.target.closest && e.target.closest(".bible-verse"))) return;
    if (highlightPalette && !highlightPalette.classList.contains("hidden")) {
      setHighlightPaletteOpen(false);
      return;
    }
    closeBar();
  };

  highlightToggle?.addEventListener("click", (e) => {
    e.stopPropagation();
    const shouldOpen = highlightPalette?.classList.contains("hidden");
    setHighlightPaletteOpen(Boolean(shouldOpen));
  });
  window.addEventListener("resize", positionHighlightPalette, { passive: true });

  const applyHighlightColor = (color) => {
    if (!/^#[0-9a-f]{6}$/i.test(String(color || ""))) return;
    const normalizedColor = color.toLowerCase();
    if (verseDiv) {
      verseDiv.style.removeProperty("background-color");
      verseDiv.style.setProperty("--verse-highlight-color", normalizedColor);
      verseDiv.setAttribute("data-highlight", normalizedColor);
    }
    state.highlights[highlightKey] = normalizedColor;
    localStorage.setItem("bible_highlights", JSON.stringify(state.highlights));
    highlightToggle?.classList.add("is-active");

    barDiv.querySelectorAll("[data-color]").forEach(b => {
      const isActive = b.getAttribute("data-color") === normalizedColor;
      b.classList.toggle("is-active", isActive);
      b.setAttribute("aria-pressed", String(isActive));
    });
  };

  barDiv.querySelectorAll("[data-color]").forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      applyHighlightColor(btn.getAttribute("data-color"));
    };
  });

  barDiv.querySelector("[data-custom-highlight-color]")?.addEventListener("input", (e) => {
    e.stopPropagation();
    applyHighlightColor(e.target.value);
  });

  barDiv.querySelector('[data-action="clear"]')?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (verseDiv) {
      verseDiv.style.removeProperty("background-color");
      verseDiv.style.removeProperty("--verse-highlight-color");
      verseDiv.removeAttribute("data-highlight");
    }
    delete state.highlights[highlightKey];
    localStorage.setItem("bible_highlights", JSON.stringify(state.highlights));
    highlightToggle?.classList.add("is-active");

    // 重置所有色點 active 狀態，不關閉 bar
    barDiv.querySelectorAll("[data-color]").forEach(b => {
      b.classList.remove("is-active");
      b.setAttribute("aria-pressed", "false");
    });
  });

  barDiv.querySelector('[data-action="copy"]')?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(selectedText).then(() => {
        showToast("經文已複製到剪貼簿！");
      });
    } else {
      showToast(selectedText);
    }
    closeBar();
  });

  barDiv.querySelector('[data-action="share"]')?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (navigator.share) {
      navigator.share({ title: "經文分享", text: selectedText, url: window.location.href }).catch(() => {});
    } else if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(selectedText).then(() => {
        showToast("經文已複製，可直接貼上分享！");
      });
    }
    closeBar();
  });

  barDiv.querySelector('[data-action="note"]')?.addEventListener("click", (e) => {
    e.stopPropagation();
    const noteVerse = verse || selectedVerseNumber;
    closeBar({ clearSelection: false });
    openVerseNoteEditor({
      bookName,
      chapter,
      verse: noteVerse,
      verseDiv,
      highlightKey,
      verseText: verseText || "",
      referenceLabel: `${bookName || ""} ${chapter || ""}:${noteVerse}`
    });
  });

  selectionBottomBarBindTimer = setTimeout(() => {
    document.addEventListener("click", onDocClick);
    selectionBottomBarBindTimer = null;
  }, 100);
}

/**
 * 逐節筆記全螢幕編輯框
 */
function closeVerseNoteEditor() {
  const rootElement = document.getElementById("verse-note-editor-root");
  if (rootElement) rootElement.innerHTML = "";
  document.body.classList.remove("verse-note-editor-open");
}

function openVerseNoteEditor(options) {
  const { bookName, chapter, verse, verseDiv, highlightKey, referenceLabel, verseText } = options;
  const rootElement = document.getElementById("verse-note-editor-root");
  if (!rootElement || !bookName || !chapter || !verse) return;

  const existingContent = state.verseNotes?.[highlightKey] || "";

  rootElement.innerHTML = `
    <div id="verse-note-editor-overlay" class="full-page-overlay verse-note-editor-overlay" role="dialog" aria-modal="true" aria-labelledby="verse-note-editor-title">
      <header class="overlay-header bible-native-overlay-header">
        <button type="button" class="overlay-back-btn" id="verse-note-editor-close" aria-label="返回">
          <span class="nlc-icon nlc-icon--md nav-back-chevron" data-icon="chevronLeft" aria-hidden="true"></span>
          <span>返回</span>
        </button>
        <div class="overlay-title" id="verse-note-editor-title">經文筆記</div>
        <button type="button" class="verse-note-editor-save" id="verse-note-editor-save">儲存</button>
      </header>
      <div class="verse-note-editor-quote">
        <span class="verse-note-editor-reference">${escapeHTML(referenceLabel || "")}</span>
        <p class="verse-note-editor-verse-text">${escapeHTML(verseText || "")}</p>
      </div>
      <textarea id="verse-note-editor-textarea" class="verse-note-editor-textarea" placeholder="寫下你的註解、心得或禱告…">${escapeHTML(existingContent)}</textarea>
      <footer class="verse-note-editor-footer">
        <button type="button" class="reading-team-danger-link verse-note-editor-delete" id="verse-note-editor-delete"${existingContent ? "" : " hidden"}>刪除筆記</button>
      </footer>
    </div>
  `;

  document.body.classList.add("verse-note-editor-open");
  const overlay = document.getElementById("verse-note-editor-overlay");
  if (!overlay) return;
  if (typeof hydrateIcons === "function") hydrateIcons(overlay);

  const textarea = document.getElementById("verse-note-editor-textarea");
  const deleteBtn = document.getElementById("verse-note-editor-delete");

  const applyBadgeState = hasNote => {
    if (verseDiv) setVerseNoteBadge(verseDiv, hasNote);
  };

  document.getElementById("verse-note-editor-close")?.addEventListener("click", closeVerseNoteEditor);

  document.getElementById("verse-note-editor-save")?.addEventListener("click", async () => {
    const saveBtn = document.getElementById("verse-note-editor-save");
    const content = textarea ? textarea.value : "";
    if (saveBtn) saveBtn.disabled = true;
    try {
      const saved = await db.saveVerseNote(bookName, chapter, verse, content);
      if (saved) {
        state.verseNotes[highlightKey] = saved;
      } else {
        delete state.verseNotes[highlightKey];
      }
      applyBadgeState(Boolean(saved));
      showToast(saved ? "筆記已儲存" : "筆記已清空");
      closeVerseNoteEditor();
    } catch (error) {
      console.error("Failed to save verse note:", error);
      showToast("筆記儲存失敗，請稍後再試。");
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  });

  deleteBtn?.addEventListener("click", async () => {
    deleteBtn.disabled = true;
    try {
      await db.deleteVerseNote(bookName, chapter, verse);
      delete state.verseNotes[highlightKey];
      applyBadgeState(false);
      showToast("筆記已刪除");
      closeVerseNoteEditor();
    } catch (error) {
      console.error("Failed to delete verse note:", error);
      showToast("刪除失敗，請稍後再試。");
      deleteBtn.disabled = false;
    }
  });
}

window.openBibleVersionPicker = function() {
  const modal = document.getElementById("bible-version-picker-modal");
  if (!modal) {
    return window.toggleBibleVersionNext?.();
  }

  const current = state.readerState.version || "CUNP";

  modal.querySelectorAll(".version-option-btn").forEach(btn => {
    const v = btn.getAttribute("data-version");
    btn.classList.toggle("active", v === current);
  });

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
};

window.closeBibleVersionPicker = function() {
  const modal = document.getElementById("bible-version-picker-modal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
};

window.selectBibleVersion = function(newVersion) {
  if (!newVersion) return;
  const current = state.readerState.version || "CUNP";
  window.closeBibleVersionPicker();

  if (current === newVersion) return;

  state.readerState.version = newVersion;
  localStorage.setItem("reader_bible_version", newVersion);

  populateBookSelector(document.getElementById("reader-testament-select")?.value || "all");
  populateChapterSelector();
  renderReaderPicker();
  updatePillLabels();

  const versionBtn = document.getElementById("reader-nav-version-btn");
  if (versionBtn) {
    const label = newVersion === "RCUVTS" ? "RCUV" : newVersion;
    const span = versionBtn.querySelector("span");
    if (span) span.textContent = label;
    const inlineVersion = document.getElementById("reader-version-inline");
    if (inlineVersion) inlineVersion.textContent = label;
    const navBadge = document.getElementById("bible-nav-version-badge");
    if (navBadge) navBadge.textContent = label;
  }

  const versionLabels = {
    CUNP: "新標點和合本",
    RCUVTS: "和合本修訂版",
    CUV: "官話和合本",
    OCCB: "當代譯本開放資源（繁體）",
    WEB: "World English Bible",
    ESV: "ESV (English Standard Version)",
    NIV: "NIV (New International Version)",
    NLT: "NLT (New Living Translation)"
  };

  showToast(`已切換譯本至 ${versionLabels[newVersion] || newVersion}`);
  renderReaderText();
};

window.toggleBibleVersionNext = function() {
  const current = state.readerState.version || "CUNP";
  let next = "CUNP";
  if (current === "CUNP") next = "RCUVTS";
  else if (current === "RCUVTS") next = "CUV";
  else if (current === "CUV") next = "OCCB";
  else if (current === "OCCB") next = "ESV";
  else if (current === "ESV") next = "NIV";
  else if (current === "NIV") next = "NLT";
  else if (current === "NLT") next = "WEB";
  else next = "CUNP";
  window.selectBibleVersion(next);
};

window.toggleBibleVersion = function() {
  window.openBibleVersionPicker();
};

// 綁定 Version Picker Modal 內部事件
function setupVersionPickerEvents() {
  const modal = document.getElementById("bible-version-picker-modal");
  if (!modal || modal.dataset.eventsBound === "true") return;
  modal.dataset.eventsBound = "true";

  const closeBtn = document.getElementById("version-picker-close");
  const backdrop = document.getElementById("version-picker-backdrop");
  closeBtn?.addEventListener("click", window.closeBibleVersionPicker);
  backdrop?.addEventListener("click", window.closeBibleVersionPicker);

  modal.querySelectorAll(".version-option-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const v = btn.getAttribute("data-version");
      if (v) window.selectBibleVersion(v);
    });
  });
}

let isSpeaking = false;
let isReaderAudioPaused = false;
let speechUtterance = null;
let currentSpeakingVerseIndex = -1;
let verseListForSpeaking = [];
let currentAudioSessionId = 0;
let preferredReaderVoice = null;
let pendingReaderVoicePromise = null;

function updateReaderAudioTimeline(verseIndex, totalVerses, status = "speaking", verseNum = null) {
  const timeline = document.getElementById("reader-audio-timeline");
  const label = document.getElementById("reader-audio-progress-label");
  const track = document.getElementById("reader-audio-progress-track");
  const fill = document.getElementById("reader-audio-progress-fill");
  if (!timeline || !label || !track || !fill || totalVerses <= 0) return;
  const safeIndex = Math.min(Math.max(Number(verseIndex) || 0, 0), totalVerses - 1);
  const currentVerse = verseNum ?? verseListForSpeaking[safeIndex]?.verseNum ?? safeIndex + 1;
  const prefix = status === "paused" ? "已暫停・" : status === "completed" ? "已完成・" : "朗讀中・";
  label.textContent = `${prefix}第 ${currentVerse} 節／共 ${totalVerses} 節`;
  track.setAttribute("aria-valuemax", String(totalVerses));
  track.setAttribute("aria-valuenow", String(safeIndex + 1));
  fill.style.width = `${((safeIndex + 1) / totalVerses) * 100}%`;
  timeline.classList.remove("hidden");
}

function hideReaderAudioTimeline() {
  document.getElementById("reader-audio-timeline")?.classList.add("hidden");
}

function setReaderAudioStartMarker(verseNum = 1) {
  clearSpeakingHighlight();
  clearReaderStartSelection();
  const verseEl = document.getElementById(`reader-verse-${verseNum}`);
  if (!verseEl) return;
  verseEl.classList.add("reader-start-selected");
  verseEl.setAttribute("aria-pressed", "true");
  state.readerState.selectedVerseNum = Number(verseNum) || 1;
}

function resetReaderAudioAfterManualChapterChange(showTimeline) {
  setReaderAudioStartMarker(1);
  if (!showTimeline) return;
  const totalVerses = document.querySelectorAll("#bible-content .bible-verse").length;
  if (totalVerses > 0) updateReaderAudioTimeline(0, totalVerses, "paused", 1);
}
function updateReaderAudioButton(speaking) {
  const btn = document.getElementById("reader-audio-btn");
  if (!btn) return;
  const paused = isReaderAudioPaused;
  const label = speaking ? "暫停朗讀" : paused ? "繼續朗讀" : "朗讀經文";
  btn.classList.toggle("active", speaking);
  btn.classList.toggle("paused", paused);
  btn.setAttribute("aria-pressed", speaking ? "true" : "false");
  btn.setAttribute("aria-label", label);
  btn.title = label;
  const icon = btn.querySelector("[data-icon]");
  if (icon) {
    icon.setAttribute("data-icon", speaking ? "pause" : "volumeNotice");
    icon.replaceChildren();
    if (typeof hydrateIcons === "function") hydrateIcons(btn);
  }
}

function clearSpeakingHighlight() {
  document.querySelectorAll(".bible-verse.speaking-highlight").forEach(el => {
    el.classList.remove("speaking-highlight");
  });
}

function stopReaderAudio(quiet = false, options = {}) {
  const wasActive = isSpeaking || Boolean(window.speechSynthesis?.speaking) || Boolean(window.speechSynthesis?.pending);
  const lastVerseIndex = currentSpeakingVerseIndex;
  const lastVerseTotal = verseListForSpeaking.length;
  const lastVerse = verseListForSpeaking[lastVerseIndex]?.verseNum || lastVerseIndex + 1;
  currentAudioSessionId++;
  if (typeof window.speechSynthesis !== "undefined") {
    try { window.speechSynthesis.cancel(); } catch (_e) {}
  }
  isSpeaking = false;
  isReaderAudioPaused = false;
  currentSpeakingVerseIndex = -1;
  verseListForSpeaking = [];
  speechUtterance = null;
  clearSpeakingHighlight();
  if (options.preservePosition && lastVerseIndex >= 0 && lastVerseTotal > 0) {
    const verseEl = document.getElementById(`reader-verse-${lastVerse}`);
    verseEl?.classList.add("speaking-highlight");
    updateReaderAudioTimeline(lastVerseIndex, lastVerseTotal, options.status || "paused", lastVerse);
  } else {
    hideReaderAudioTimeline();
  }
  updateReaderAudioButton(false);
  if (!quiet && wasActive && typeof showToast === "function") showToast("已停止朗讀");
}

function resetReaderAudioState() {
  isSpeaking = false;
  isReaderAudioPaused = false;
  currentSpeakingVerseIndex = -1;
  verseListForSpeaking = [];
  speechUtterance = null;
  clearSpeakingHighlight();
  hideReaderAudioTimeline();
  updateReaderAudioButton(false);
}

window.clearReaderAudioOnPageExit = function () {
  stopReaderAudio(true);
  clearReaderStartSelection();
};

// Not a true speechSynthesis.pause() — that suspends mid-utterance and, on
// resume, ignores any verse the user marks in the meantime (speechSynthesis
// has no way to "resume from a different position"). Instead this fully
// cancels the utterance and just marks the current verse as the start point,
// so the next 朗讀 press below always restarts from that verse's beginning —
// whichever verse ends up marked, including one the user taps while paused.
function pauseReaderAudio() {
  if (!isSpeaking || typeof window.speechSynthesis === "undefined") return false;
  const currentItem = verseListForSpeaking[currentSpeakingVerseIndex];
  currentAudioSessionId++;
  try {
    window.speechSynthesis.cancel();
  } catch (_e) {}

  isSpeaking = false;
  isReaderAudioPaused = true;
  if (currentItem) {
    clearReaderStartSelection();
    const verseEl = document.getElementById(`reader-verse-${currentItem.verseNum}`);
    verseEl?.classList.add("reader-start-selected", "speaking-highlight");
    verseEl?.setAttribute("aria-pressed", "true");
    state.readerState.selectedVerseNum = currentItem.verseNum;
    updateReaderAudioTimeline(currentSpeakingVerseIndex, verseListForSpeaking.length, "paused", currentItem.verseNum);
  }
  updateReaderAudioButton(false);
  if (typeof showToast === "function") showToast("朗讀已暫停，再按一次會從標記的那一節開頭朗讀");
  return true;
}

function getInstalledReaderVoice(targetLang = "zh-TW") {
  if (typeof window.speechSynthesis === "undefined") return Promise.resolve(null);
  const immediate = window.speechSynthesis.getVoices?.() || [];
  preferredReaderVoice = selectPreferredVoice(immediate, targetLang) || preferredReaderVoice;
  if (preferredReaderVoice && preferredReaderVoice.lang?.toLowerCase().startsWith(targetLang.slice(0, 2).toLowerCase())) {
    return Promise.resolve(preferredReaderVoice);
  }
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.speechSynthesis.removeEventListener?.("voiceschanged", finish);
      preferredReaderVoice = selectPreferredVoice(window.speechSynthesis.getVoices?.() || [], targetLang);
      resolve(preferredReaderVoice);
    };
    window.speechSynthesis.addEventListener?.("voiceschanged", finish, { once: true });
    window.setTimeout(finish, 400);
  });
}

function warmReaderVoice(targetLang = "zh-TW") {
  if (typeof window.speechSynthesis === "undefined") return Promise.resolve(null);
  if (pendingReaderVoicePromise) return pendingReaderVoicePromise;
  pendingReaderVoicePromise = getInstalledReaderVoice(targetLang)
    .catch(() => null)
    .finally(() => {
      pendingReaderVoicePromise = null;
    });
  return pendingReaderVoicePromise;
}

function speakNextVerseInQueue(sessionId) {
  if (sessionId !== currentAudioSessionId || !isSpeaking) return;
  if (currentSpeakingVerseIndex < 0 || currentSpeakingVerseIndex >= verseListForSpeaking.length) {
    void continueReaderAudioToNextChapter(sessionId);
    return;
  }
  const currentItem = verseListForSpeaking[currentSpeakingVerseIndex];
  if (!currentItem) {
    stopReaderAudio(true);
    return;
  }

  clearSpeakingHighlight();
  updateReaderAudioTimeline(currentSpeakingVerseIndex, verseListForSpeaking.length, "speaking");
  const verseEl = document.getElementById(`reader-verse-${currentItem.verseNum}`);
  if (verseEl) {
    verseEl.classList.add("speaking-highlight");
    scrollReaderVerseIntoView(verseEl, "smooth");
  }

  const currentVersion = state.readerState?.version || "CUNP";
  const isEnglish = ["ESV", "NIV", "NLT", "WEB"].includes(currentVersion);
  const fallbackLang = isEnglish ? "en-US" : "zh-TW";
  const settings = state.speechSettings || {};

  speechUtterance = new SpeechSynthesisUtterance(currentItem.text);

  const voices = window.speechSynthesis.getVoices?.() || [];
  let voiceToUse = null;

  if (isEnglish) {
    // 💡 英文聖經防護：綁定英文 Voice，但完全響應使用者設定的自訂語速 (settings.rate)！
    if (typeof selectPreferredVoice === "function") {
      voiceToUse = selectPreferredVoice(voices, "en-US");
    }
    speechUtterance.lang = voiceToUse?.lang || "en-US";
    if (voiceToUse) speechUtterance.voice = voiceToUse;
    speechUtterance.rate = getReaderSpeechRate("en-US", settings.rate);
    speechUtterance.pitch = 1.0;
  } else {
    // 中文聖經：正常套用使用者偏好的中文語音與語速設定
    if (settings.voiceURI) {
      const matched = voices.find(v => v.voiceURI === settings.voiceURI || v.name === settings.voiceURI);
      if (matched) voiceToUse = matched;
    }
    if (!voiceToUse && typeof selectPreferredVoice === "function") {
      voiceToUse = selectPreferredVoice(voices, fallbackLang);
    }

    speechUtterance.lang = voiceToUse?.lang || fallbackLang;
    if (voiceToUse) speechUtterance.voice = voiceToUse;

    speechUtterance.rate = getReaderSpeechRate(speechUtterance.lang || fallbackLang, settings.rate);

    speechUtterance.pitch = 1.0;
  }
  speechUtterance.volume = 1;
  speechUtterance.onend = () => {
    if (sessionId !== currentAudioSessionId || !isSpeaking) return;
    currentSpeakingVerseIndex++;
    speakNextVerseInQueue(sessionId);
  };
  speechUtterance.onerror = error => {
    if (sessionId !== currentAudioSessionId || !isSpeaking) return;
    console.warn("[ReaderAudio] Speech synthesis interrupted", error);
    stopReaderAudio(true);
    if (typeof showToast === "function") showToast("朗讀暫時中斷，請再試一次");
  };
  window.speechSynthesis.speak(speechUtterance);
}

async function continueReaderAudioToNextChapter(sessionId) {
  if (sessionId !== currentAudioSessionId || !isSpeaking) return;
  const moved = await navigateToChapter(1, { autoContinue: true });
  if (!moved || sessionId !== currentAudioSessionId || !isSpeaking) {
    if (verseListForSpeaking.length > 0) {
      updateReaderAudioTimeline(verseListForSpeaking.length - 1, verseListForSpeaking.length, "completed");
    }
    stopReaderAudio(true, { preservePosition: true, status: "completed" });
    return;
  }
  const scrollReset = await resetReaderScrollAfterChapterRender(sessionId);
  if (!scrollReset || sessionId !== currentAudioSessionId || !isSpeaking) return;
  const container = document.getElementById("bible-content");
  verseListForSpeaking = Array.from(container?.querySelectorAll(".bible-verse") || []).map(el => ({
    verseNum: Number(el.dataset.verse || 0),
    text: el.querySelector(".verse-text")?.textContent.trim() || ""
  })).filter(item => item.text.length > 0);
  if (verseListForSpeaking.length === 0) {
    stopReaderAudio(true);
    return;
  }
  currentSpeakingVerseIndex = 0;
  speakNextVerseInQueue(sessionId);
}

window.toggleReaderAudio = async function(startVerseNum = null) {
  if (typeof window.speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined") {
    if (typeof showToast === "function") showToast("您的瀏覽器不支援語音朗讀功能");
    return;
  }
  if (isSpeaking) {
    if (pauseReaderAudio()) return;
    stopReaderAudio(false, { preservePosition: true });
    return;
  }
  // Paused (or genuinely idle): always (re)start fresh from whichever verse
  // is currently marked — state.readerState.selectedVerseNum below — rather
  // than resuming mid-utterance. stopReaderAudio() only cancels playback; it
  // does not clear the verse marker, so a verse tapped while paused sticks.
  if (isReaderAudioPaused || window.speechSynthesis.speaking || window.speechSynthesis.pending) {
    stopReaderAudio(true);
  }

  resetReaderAudioState();
  const container = document.getElementById("bible-content");
  if (!container) return;
  verseListForSpeaking = Array.from(container.querySelectorAll(".bible-verse")).map(el => ({
    verseNum: Number(el.dataset.verse || 0),
    text: el.querySelector(".verse-text")?.textContent.trim() || ""
  })).filter(item => item.text.length > 0);
  if (verseListForSpeaking.length === 0) return;

  const selectedVerseNum = startVerseNum ?? state.readerState?.selectedVerseNum ?? null;
  const startIndex = resolveReaderStartIndex(verseListForSpeaking, selectedVerseNum);
  if (startIndex < 0) return;

  currentAudioSessionId++;
  const sessionId = currentAudioSessionId;
  isSpeaking = true;
  currentSpeakingVerseIndex = startIndex;
  updateReaderAudioButton(true);
  const currentVersion = state.readerState?.version || "CUNP";
  const isEnglish = ["ESV", "NIV", "NLT", "WEB"].includes(currentVersion);
  const targetLang = isEnglish ? "en-US" : "zh-TW";
  const immediateVoices = window.speechSynthesis.getVoices?.() || [];
  preferredReaderVoice = selectPreferredVoice(immediateVoices, targetLang) || preferredReaderVoice;
  warmReaderVoice(targetLang).then(voice => {
    if (voice && sessionId === currentAudioSessionId && isSpeaking) preferredReaderVoice = voice;
  });

  const startVerse = verseListForSpeaking[startIndex];
  console.info("[ReaderAudio] Playback started", {
    verse: startVerse?.verseNum || 1,
    voice: preferredReaderVoice?.name || "browser default",
    lang: preferredReaderVoice?.lang || "zh-TW"
  });
  if (typeof showToast === "function") showToast(`從第 ${startVerse?.verseNum || 1} 節開始朗讀`);
  speakNextVerseInQueue(sessionId);
};
window.searchChapterVerses = function(keyword) {
  const container = document.getElementById("bible-content");
  if (!container) return;
  
  container.querySelectorAll(".bible-verse").forEach(verseDiv => {
    const verseTextEl = verseDiv.querySelector(".verse-text");
    if (verseTextEl) {
      verseTextEl.innerHTML = verseTextEl.textContent;
    }
  });
  
  const cleanKeyword = keyword.trim();
  if (!cleanKeyword) return;
  
  container.querySelectorAll(".bible-verse").forEach(verseDiv => {
    const verseTextEl = verseDiv.querySelector(".verse-text");
    if (verseTextEl) {
      const text = verseTextEl.textContent;
      const regex = new RegExp(`(${escapeRegExp(cleanKeyword)})`, "gi");
      if (text.toLowerCase().includes(cleanKeyword.toLowerCase())) {
        verseTextEl.innerHTML = text.replace(regex, "<mark>$1</mark>");
      }
    }
  });
};

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let navOverlayState = {
  activeTab: 'book',
  selectedBookId: 1,
  selectedChapter: 1,
  selectedVerse: 1,
  viewMode: 'grid',
  autoAdvance: true
};

window.openBibleNavOverlay = function() {
  const overlay = document.getElementById("bible-nav-overlay");
  if (!overlay) return;
  
  navOverlayState.selectedBookId = state.readerState.bookId;
  navOverlayState.selectedChapter = state.readerState.chapter;
  navOverlayState.selectedVerse = 1;

  updateBibleNavLocale();
  
  openReaderLayer(overlay);
  
  const gridBtn = document.getElementById("view-mode-grid");
  const listBtn = document.getElementById("view-mode-list");
  if (gridBtn && listBtn) {
    gridBtn.classList.toggle("active", navOverlayState.viewMode === 'grid');
    listBtn.classList.toggle("active", navOverlayState.viewMode === 'list');
  }

  const tabs = document.querySelectorAll("#bible-nav-overlay .segmented-tab");
  tabs.forEach(tab => {
    if (!tab.dataset.bound) {
      tab.dataset.bound = "true";
      tab.addEventListener("click", () => {
        window.switchNavTab(tab.dataset.tab);
      });
    }
  });

  if (gridBtn && !gridBtn.dataset.bound) {
    gridBtn.dataset.bound = "true";
    gridBtn.addEventListener("click", () => {
      navOverlayState.viewMode = 'grid';
      gridBtn.classList.add("active");
      if (listBtn) listBtn.classList.remove("active");
      renderBibleNavContent();
    });
  }
  if (listBtn && !listBtn.dataset.bound) {
    listBtn.dataset.bound = "true";
    listBtn.addEventListener("click", () => {
      navOverlayState.viewMode = 'list';
      listBtn.classList.add("active");
      if (gridBtn) gridBtn.classList.remove("active");
      renderBibleNavContent();
    });
  }

  const backBtn = document.getElementById("bible-nav-back-btn");
  if (backBtn && !backBtn.dataset.bound) {
    backBtn.dataset.bound = "true";
    backBtn.addEventListener("click", () => {
      if (navOverlayState.activeTab === 'verse') {
        window.switchNavTab('chapter');
      } else if (navOverlayState.activeTab === 'chapter') {
        window.switchNavTab('book');
      } else {
        closeReaderLayer(overlay);
      }
    });
  }

  // .reader-version-btn (the top navbar's own version pill) is hidden on
  // narrow phones (@media max-width:420px) for space — this badge inside the
  // directory overlay is the mobile replacement entry point into the version
  // picker, so it must open the same modal rather than sit dead/unbound.
  const versionBadge = document.getElementById("bible-nav-version-badge");
  if (versionBadge && !versionBadge.dataset.bound) {
    versionBadge.dataset.bound = "true";
    versionBadge.addEventListener("click", () => {
      closeReaderLayer(overlay);
      if (typeof window.openBibleVersionPicker === "function") {
        window.openBibleVersionPicker();
      }
    });
  }

  window.switchNavTab('book');
};

window.switchNavTab = function(tabName) {
  navOverlayState.activeTab = tabName;
  
  document.querySelectorAll("#bible-nav-overlay .segmented-tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });
  
  updateNavOverlayHeader();
  renderBibleNavContent();
};

function updateNavOverlayHeader() {
  const titleEl = document.getElementById("bible-nav-title");
  if (!titleEl) return;
  
  const book = BIBLE_BOOKS.find(b => b.id === navOverlayState.selectedBookId);
  const english = usesEnglishReaderLabels();
  const bookLabel = getReaderBookLabel(book);
  if (navOverlayState.activeTab === 'book') {
    titleEl.textContent = english ? "Select Book" : "選擇書卷";
  } else if (navOverlayState.activeTab === 'chapter') {
    titleEl.textContent = book ? bookLabel : (english ? "Select Chapter" : "選擇章節");
  } else if (navOverlayState.activeTab === 'verse') {
    titleEl.textContent = book
      ? (english ? `${bookLabel} Chapter ${navOverlayState.selectedChapter}` : `${bookLabel} ${navOverlayState.selectedChapter}章`)
      : (english ? "Select Verse" : "選擇節");
  }
}

function updateBibleNavLocale() {
  const overlay = document.getElementById("bible-nav-overlay");
  if (!overlay) return;
  const english = usesEnglishReaderLabels();
  const backText = document.querySelector("#bible-nav-back-btn span:last-child");
  if (backText) backText.textContent = english ? "Back" : "返回";
  const tabLabels = english
    ? { book: "Book", chapter: "Chapter", verse: "Verse" }
    : { book: "卷", chapter: "章", verse: "節" };
  overlay.querySelectorAll(".segmented-tab").forEach(tab => {
    tab.textContent = tabLabels[tab.dataset.tab] || tab.textContent;
  });
  const viewLabel = document.getElementById("bible-nav-view-label");
  if (viewLabel) viewLabel.textContent = english ? "View" : "檢視";
  const gridBtn = document.getElementById("view-mode-grid");
  const listBtn = document.getElementById("view-mode-list");
  if (gridBtn) {
    gridBtn.title = english ? "Grid" : "網格";
    gridBtn.setAttribute("aria-label", gridBtn.title);
  }
  if (listBtn) {
    listBtn.title = english ? "List" : "清單";
    listBtn.setAttribute("aria-label", listBtn.title);
  }
  updateNavOverlayHeader();
}

function renderBibleNavContent() {
  const container = document.getElementById("bible-nav-content");
  if (!container) return;
  
  container.innerHTML = "";
  const book = BIBLE_BOOKS.find(b => b.id === navOverlayState.selectedBookId);
  
  if (navOverlayState.activeTab === 'book') {
    document.querySelector("#bible-nav-overlay .mode-selector-bar").style.display = "flex";
    
    if (navOverlayState.viewMode === 'grid') {
      const oldSection = document.createElement("div");
      oldSection.className = "bible-nav-section-title";
      oldSection.textContent = usesEnglishReaderLabels() ? "Old Testament" : "舊約聖經";
      container.appendChild(oldSection);
      
      const oldGrid = document.createElement("div");
      oldGrid.className = "bible-nav-grid";
      
      const newSection = document.createElement("div");
      newSection.className = "bible-nav-section-title";
      newSection.textContent = usesEnglishReaderLabels() ? "New Testament" : "新約聖經";
      
      const newGrid = document.createElement("div");
      newGrid.className = "bible-nav-grid";
      
      BIBLE_BOOKS.forEach(b => {
        const item = document.createElement("div");
        item.className = "grid-item-book";
        item.classList.toggle("active", b.id === navOverlayState.selectedBookId);
        item.innerHTML = `
          <span class="abbrev-title">${escapeHTML(getReaderBookAbbreviation(b))}</span>
          <span class="full-title">${escapeHTML(getReaderBookLabel(b))}</span>
        `;
        item.addEventListener("click", () => selectNavBook(b.id));
        
        if (b.section === 'old') {
          oldGrid.appendChild(item);
        } else {
          newGrid.appendChild(item);
        }
      });
      
      container.appendChild(oldGrid);
      container.appendChild(newSection);
      container.appendChild(newGrid);
    } else {
      const oldSection = document.createElement("div");
      oldSection.className = "bible-nav-section-title";
      oldSection.textContent = usesEnglishReaderLabels() ? "Old Testament" : "舊約聖經";
      container.appendChild(oldSection);
      
      const oldList = document.createElement("div");
      oldList.className = "bible-nav-list";
      
      const newSection = document.createElement("div");
      newSection.className = "bible-nav-section-title";
      newSection.textContent = usesEnglishReaderLabels() ? "New Testament" : "新約聖經";
      
      const newList = document.createElement("div");
      newList.className = "bible-nav-list";
      
      BIBLE_BOOKS.forEach(b => {
        const item = document.createElement("div");
        item.className = "book-list-item-asym";
        item.classList.toggle("active", b.id === navOverlayState.selectedBookId);
        item.innerHTML = `
          <div class="book-brand-box">${escapeHTML(getReaderBookAbbreviation(b))}</div>
          <div class="book-names-box">
            <span class="book-full-title">${escapeHTML(getReaderBookLabel(b))}</span>
            ${usesEnglishReaderLabels() ? "" : `<span class="book-english-sub">${escapeHTML(b.eng)}</span>`}
          </div>
        `;
        item.addEventListener("click", () => selectNavBook(b.id));
        
        if (b.section === 'old') {
          oldList.appendChild(item);
        } else {
          newList.appendChild(item);
        }
      });
      
      container.appendChild(oldList);
      container.appendChild(newSection);
      container.appendChild(newList);
    }
  } else if (navOverlayState.activeTab === 'chapter') {
    document.querySelector("#bible-nav-overlay .mode-selector-bar").style.display = "none";
    
    const grid = document.createElement("div");
    grid.className = "chapter-nav-grid";
    
    const totalChapters = book ? book.chapters : 50;
    for (let c = 1; c <= totalChapters; c++) {
      const item = document.createElement("div");
      item.className = "grid-item-number";
      item.classList.toggle("active", c === navOverlayState.selectedChapter);
      item.textContent = c;
      item.addEventListener("click", () => selectNavChapter(c));
      grid.appendChild(item);
    }
    container.appendChild(grid);
  } else if (navOverlayState.activeTab === 'verse') {
    document.querySelector("#bible-nav-overlay .mode-selector-bar").style.display = "none";
    
    const grid = document.createElement("div");
    grid.className = "verse-nav-grid";
    
    let totalVerses = 30;
    if (book && typeof BIBLE_VERSE_COUNTS !== "undefined") {
      const bookCounts = BIBLE_VERSE_COUNTS[book.eng];
      if (bookCounts && bookCounts[navOverlayState.selectedChapter - 1]) {
        totalVerses = bookCounts[navOverlayState.selectedChapter - 1];
      }
    }

    for (let v = 1; v <= totalVerses; v++) {
      const item = document.createElement("div");
      item.className = "grid-item-number";
      item.classList.toggle("active", v === navOverlayState.selectedVerse);
      item.textContent = v;
      item.addEventListener("click", () => selectNavVerse(v));
      grid.appendChild(item);
    }
    container.appendChild(grid);
  }
}

function selectNavBook(bookId) {
  navOverlayState.selectedBookId = bookId;
  navOverlayState.selectedChapter = 1;
  window.switchNavTab('chapter');
}

function selectNavChapter(chNum) {
  navOverlayState.selectedChapter = chNum;
  window.switchNavTab('verse');
}

async function selectNavVerse(vNum) {
  navOverlayState.selectedVerse = vNum;
  
  closeReaderLayer(document.getElementById("bible-nav-overlay"));
  
  state.readerState.bookId = navOverlayState.selectedBookId;
  state.readerState.chapter = navOverlayState.selectedChapter;
  
  const bookSelect = document.getElementById("reader-book-select");
  if (bookSelect) {
    bookSelect.value = String(navOverlayState.selectedBookId);
    populateChapterSelector();
  }
  const chapterSelect = document.getElementById("reader-chapter-select");
  if (chapterSelect) {
    chapterSelect.value = String(navOverlayState.selectedChapter);
  }
  
  saveReaderPreferences();
  updatePillLabels();
  
  try {
    await renderReaderText();
    
    const container = document.getElementById("bible-content");
    if (container) {
      setTimeout(() => {
        const verses = container.querySelectorAll(".bible-verse");
        for (let v of verses) {
          const numEl = v.querySelector(".verse-num");
          if ((v.dataset.verse && parseInt(v.dataset.verse) === vNum) || (numEl && parseInt(numEl.textContent) === vNum)) {
            v.scrollIntoView({ behavior: 'smooth', block: 'center' });
            
            const oldBg = v.style.backgroundColor;
            v.style.backgroundColor = 'var(--color-brand-subtle, rgba(4,169,210,0.22))';
            setTimeout(() => {
              v.style.backgroundColor = oldBg;
            }, 1500);
            break;
          }
        }
      }, 100);
    }
  } catch (err) {
    console.error(err);
  }
}

window.__BIBLE_SEARCH_CORPUS = window.__BIBLE_SEARCH_CORPUS || null;

window.setBibleSearchCorpus = function(corpus) {
  window.__BIBLE_SEARCH_CORPUS = Array.isArray(corpus) ? corpus : null;
};

function searchLocalBibleCorpus(query) {
  const corpus = window.__BIBLE_SEARCH_CORPUS;
  if (!Array.isArray(corpus) || !query) return null;
  return rankBibleSearchResults(corpus, query, { includeFuzzy: true, limit: 120 })
    .map(item => ({
      bookName: item.bookName || item.book || "",
      bookEng: item.bookEng || "",
      chapter: Number(item.chapter || 1),
      verse: Number(item.verse || 1),
      text: String(item.text || "")
    }));
}

window.searchBibleText = async function(query, translation = "CUNP") {
  const localResults = searchLocalBibleCorpus(query);
  if (localResults) return localResults;

  window.__BIBLE_SEARCH_REQUEST_CACHE = window.__BIBLE_SEARCH_REQUEST_CACHE || new Map();
  const cacheKey = `${String(translation).toUpperCase()}:${String(query).trim().toLocaleLowerCase()}`;
  if (window.__BIBLE_SEARCH_REQUEST_CACHE.has(cacheKey)) {
    return window.__BIBLE_SEARCH_REQUEST_CACHE.get(cacheKey);
  }

  const url = `https://bolls.life/search/${encodeURIComponent(translation)}/?search=${encodeURIComponent(query)}`;
  const request = fetch(url).then(async res => {
    if (!res.ok) throw new Error("Search request failed");
    const data = await res.json();
    const mapped = data.map(item => {
      const book = BIBLE_BOOKS.find(b => b.id === item.book);
      return {
        book: item.book,
        bookName: book ? book.name : String(item.book),
        bookEng: book ? book.eng : "",
        chapter: item.chapter,
        verse: item.verse,
        text: item.text
      };
    });
    return rankBibleSearchResults(mapped, query, { includeFuzzy: true, limit: 120 });
  }).catch(error => {
    window.__BIBLE_SEARCH_REQUEST_CACHE.delete(cacheKey);
    throw error;
  });
  window.__BIBLE_SEARCH_REQUEST_CACHE.set(cacheKey, request);
  return request;
};

export function updateReaderBottomActionBar() {
  const bar = document.getElementById("reader-bottom-action-bar");
  if (!bar) return;
  bar.style.display = "none";
  bar.classList.add("hidden");
}

function getNextPlanChapterInfo(plan, planDay, currentChIndex, dayChapters) {
  if (currentChIndex !== -1 && currentChIndex < dayChapters.length - 1) {
    return {
      book: dayChapters[currentChIndex + 1].book,
      chapter: dayChapters[currentChIndex + 1].chapter,
      dayNum: planDay
    };
  }
  
  const nextDays = plan.days.filter(d => d.dayNum > planDay);
  for (const d of nextDays) {
    const firstUnread = d.chapters.find(ch => !ch.isRead);
    if (firstUnread) {
      return {
        book: firstUnread.book,
        chapter: firstUnread.chapter,
        dayNum: d.dayNum
      };
    }
  }
  return null;
}

function triggerPredictivePrefetch() {
  const currentBook = BIBLE_BOOKS.find(b => b.id === state.readerState.bookId);
  if (!currentBook) return;

  let nextBookEng = currentBook.eng;
  let nextChapter = state.readerState.chapter + 1;

  if (nextChapter > currentBook.chapters) {
    const nextBook = BIBLE_BOOKS.find(b => b.id === currentBook.id + 1);
    if (nextBook) {
      nextBookEng = nextBook.eng;
      nextChapter = 1;
    } else {
      return;
    }
  }

  const requestedVersion = String(state.readerState?.version || "CUNP").toUpperCase();
  const cacheKey = window.getBibleChapterCacheKey
    ? window.getBibleChapterCacheKey(nextBookEng, nextChapter, requestedVersion)
    : `${requestedVersion}_${nextBookEng}_${nextChapter}`;
  if (window._bibleChapterCache && window._bibleChapterCache[cacheKey]) {
    return;
  }

  fetchBibleChapter(nextBookEng, nextChapter, requestedVersion)
    .then(data => {
      if (window._bibleChapterCache && data && !data.isPlaceholder) {
        window._bibleChapterCache[cacheKey] = data;
      }
    })
    .catch(err => {
      console.warn(`⚠️ [背景預載失敗] 無法預載下一章: ${cacheKey}`, err);
    });
}

function checkReaderBottomDwell(surface = getReaderScrollSurface(), isAtBottom = null) {
  if (!readerBottomDwellController || !surface) return;
  const taskContext = getCurrentPlanReaderTask();
  readerBottomDwellController.check(surface, {
    eligible: Boolean(
      taskContext &&
      window.appRouter && window.appRouter.currentTab === "reader-view" &&
      !isPlanProgressLocked(taskContext.plan, { hidden: window.isPlanHidden?.(taskContext.plan) }) &&
      !isCurrentPlanReaderTaskRead(taskContext) &&
      !state.readerState.autoMarked &&
      !state.readerState.autoMarkInFlight
    ),
    targetKey: getCurrentPlanReaderTargetKey(),
    isAtBottom
  });
}

function bindReaderEndObserver() {
  readerEndObserver?.disconnect();
  readerEndObserver = null;
  readerEndVisible = false;
  const root = getReaderScrollSurface();
  const sentinel = document.getElementById("reader-end-sentinel");
  if (!root || !sentinel) return;
  readerEndObserver = observeReaderEndSentinel({
    root,
    sentinel,
    onChange: isVisible => {
      readerEndVisible = isVisible;
      if (isVisible) {
        const targetKey = getCurrentPlanReaderTargetKey();
        const noticeKey = targetKey || `missing|${state.readerState?.bookId}|${state.readerState?.chapter}`;
        if (state.readerState?.fromPlan && readerAutoReadNoticeKey !== noticeKey) {
          readerAutoReadNoticeKey = noticeKey;
          console.info("[AutoRead] Reader bottom detected", {
            targetKey: targetKey || null,
            planContextId: state.readerState?.planContextId || null,
            bookId: state.readerState?.bookId || null,
            chapter: state.readerState?.chapter || null
          });
        }
        checkReaderBottomDwell(root, () => readerEndVisible);
      } else readerBottomDwellController?.cancel();
    }
  });
}
function scheduleReaderBottomDwellCheck() {
  requestAnimationFrame(() => requestAnimationFrame(() => checkReaderBottomDwell()));
}

function handleReaderScroll(event) {
  const bar = document.getElementById("reader-bottom-action-bar");
  if (bar) {
    bar.style.display = "none";
    bar.classList.add("hidden");
  }

  checkReaderBottomDwell(getReaderScrollSurface() || event.currentTarget || event.target);
}

function isTodayScheduleCompleted() {
  if (!state.activePlan) return false;
  const now = new Date();
  const todayYear = now.getFullYear();
  const todayMonth = now.getMonth() + 1;
  const todayDay = now.getDate();
  const todayDayObj = state.activePlan.days.find(d => {
    if (Number(d.year) !== todayYear || Number(d.month) !== todayMonth) return false;
    const parts = d.date.split('/');
    return parts.length === 2 && Number(parts[1]) === todayDay;
  });

  if (!todayDayObj || !todayDayObj.chapters || todayDayObj.chapters.length === 0) return false;

  const currentRound = state.activePlan.currentRound || 1;
  return todayDayObj.chapters.every(ch => {
    const r = ch.round || currentRound;
    if (r === 1) return Boolean(ch.isReadR1 || ch.isRead);
    if (r === 2) return Boolean(ch.isReadR2);
    if (r >= 3) return Boolean(ch.isReadR3);
    return Boolean(ch.isRead);
  });
}

function showPlanNavigationPrompt(options = {}) {
  let onCatchUp = options.onCatchUp;
  let onReadAhead = options.onReadAhead;
  let readAheadDayNum = options.readAheadDayNum || 2;
  let hasCatchUp = options.hasCatchUp || false;
  let catchUpDayNum = options.catchUpDayNum || null;

  if (typeof options === "function") {
    onCatchUp = arguments[0];
    onReadAhead = arguments[1];
    readAheadDayNum = arguments[2] || 2;
    hasCatchUp = false;
  }

  // Remove existing dialog if any
  const existing = document.getElementById("plan-nav-prompt-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "plan-nav-prompt-overlay";
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(0,0,0,0.55); backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
    padding: 1rem;
    animation: fadeIn 0.2s ease;
  `;

  const catchUpBtnHtml = hasCatchUp
    ? `<button id="plan-nav-catchup-btn" type="button" style="
        padding: 0.75rem; border-radius: var(--radius-md, 12px); font-size: 0.9rem; font-weight: 500;
        border: none; background: var(--color-brand); color: white; cursor: pointer;
      ">繼續補讀第 ${catchUpDayNum || ''} 天未完進度</button>`
    : '';

  const readAheadStyle = hasCatchUp
    ? `border: 1.5px solid var(--color-brand); background: var(--bg-input); color: var(--color-brand);`
    : `border: none; background: var(--color-brand); color: white;`;

  overlay.innerHTML = `
    <div id="plan-nav-prompt-dialog" style="
      background: var(--bg-card, white);
      border-radius: 16px;
      padding: 1.5rem;
      width: 100%; max-width: 400px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.25);
      animation: slideUp 0.25s cubic-bezier(0.34,1.56,0.64,1);
      text-align: center;
    ">
      <div style="display:flex; flex-direction:column; align-items:center; gap:0.6rem; margin-bottom:1.2rem;">
        <span style="font-size: 2.2rem; display: block; margin-bottom: 0.4rem;">🎉</span>
        <h3 style="margin:0; font-size:1.15rem; font-weight:700; color:var(--text-primary);">恭喜完成今日進度！</h3>
        <p style="margin:0.5rem 0 0; font-size:0.88rem; color:var(--text-secondary); line-height: 1.5;">
          您已讀完今日計畫的所有章節。接下來，您想要繼續做什麼？
        </p>
      </div>

      <div style="display:flex; flex-direction:column; gap:0.75rem; width:100%;">
        ${catchUpBtnHtml}

        <button id="plan-nav-readahead-btn" type="button" style="
          padding: 0.75rem; border-radius: var(--radius-md, 12px); font-size: 0.9rem; font-weight: 500;
          cursor: pointer; ${readAheadStyle}
        ">超前閱讀第 ${readAheadDayNum} 天進度</button>

        <button id="plan-nav-cancel-btn" type="button" style="
          padding: 0.6rem; border-radius: var(--radius-md, 12px); font-size: 0.875rem; font-weight: 500;
          border: none; background: transparent; color: var(--text-muted); cursor: pointer;
        ">取消</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Bind actions
  overlay.querySelector("#plan-nav-catchup-btn").onclick = () => {
    overlay.remove();
    if (typeof onCatchUp === "function") onCatchUp();
  };

  overlay.querySelector("#plan-nav-readahead-btn").onclick = () => {
    overlay.remove();
    if (typeof onReadAhead === "function") onReadAhead();
  };

  overlay.querySelector("#plan-nav-cancel-btn").onclick = () => {
    overlay.remove();
  };

  // Close when clicking overlay backdrop
  overlay.onclick = (e) => {
    if (e.target === overlay) {
      overlay.remove();
    }
  };
}

export function init() {
  initReaderControls();
}

window.renderReaderText = renderReaderText;
window.saveReaderPreferences = saveReaderPreferences;
window.populateBookSelector = populateBookSelector;
window.populateChapterSelector = populateChapterSelector;
window.updatePillLabels = updatePillLabels;
window.updateReaderFontSize = updateReaderFontSize;
window.navigateToChapter = navigateToChapter;
window.initReaderControls = init;
