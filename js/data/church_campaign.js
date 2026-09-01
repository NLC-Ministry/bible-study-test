// Canonical long-term church campaign configuration and pure schedule helpers.
const CHURCH_CAMPAIGN_ID = "00000000-0000-0000-c026-000000002029";
const CHURCH_CAMPAIGN_PRESET_KEY = "church_2026_2029";

const r = (book, from = 1, to = null) => ({ book, from, to });
const s = (stageNo, roundNo, phase, name, startDate, endDate, awardName, examDate = null) => ({
  stageNo, roundNo, phase, name, startDate, endDate, awardName, examDate
});
const m = (stageNo, roundNo, label, startDate, endDate, readings) => ({
  stageNo, roundNo, label, startDate, endDate, readings
});

const CHURCH_CAMPAIGN = {
  id: CHURCH_CAMPAIGN_ID,
  presetKey: CHURCH_CAMPAIGN_PRESET_KEY,
  planKind: "church_campaign",
  name: "2026\u20132029 \u65b0\u751f\u547d\u8056\u7d93\u901f\u8b80\u8a08\u756b",
  description: "\u5168\u6559\u6703\u4f9d\u7d71\u4e00\u6642\u7a0b\u5b8c\u6210\u8056\u7d93 66 \u5377\uff1b\u52a0\u5165\u4e00\u6b21\u5373\u53ef\u6301\u7e8c\u53c3\u8207\u81f3\u8a08\u756b\u7d50\u675f\u3002",
  startDate: "2026-08-01",
  endDate: "2029-08-31",
  isFixed: true,
  version: 1,
  rules: {
    allowMidJoin: true,
    sequentialAwards: true,
    applyChangesFrom: "future_only",
    teamRules: {
      personal: { min: 1, max: 1, source: "self" },
      smallHome: { min: 2, max: 4, source: "registration" },
      smallGroup: { min: 6, max: null, source: "profile.small_group" }
    }
  },
  stages: [
    s(1, 1, "warmup", "\u7b2c\u4e00\u8f2a\u71b1\u8eab\u8cfd", "2026-08-01", "2026-08-31", "\u78d0\u77f3\u734e", "2026-08-30"),
    s(2, 1, "final", "\u7b2c\u4e00\u8f2a\u671f\u672b\u8cfd", "2026-09-01", "2026-12-31", "\u9435\u734e", "2026-12-27"),
    s(3, 2, "warmup", "\u7b2c\u4e8c\u8f2a\u71b1\u8eab\u8cfd", "2027-01-01", "2027-03-31", "\u9285\u734e", "2027-03-28"),
    s(4, 2, "final", "\u7b2c\u4e8c\u8f2a\u671f\u672b\u8cfd", "2027-04-01", "2027-08-31", "\u9752\u9285\u734e", "2027-08-29"),
    s(5, 3, "full", "\u7b2c\u4e09\u8f2a", "2027-09-01", "2028-03-31", "\u767d\u9280\u734e"),
    s(6, 4, "full", "\u7b2c\u56db\u8f2a", "2028-04-01", "2028-11-30", "\u9ec3\u91d1\u734e"),
    s(7, 5, "full", "\u7b2c\u4e94\u8f2a", "2028-12-01", "2029-03-31", "\u7cbe\u91d1\u734e"),
    s(8, 6, "full", "\u7b2c\u516d\u8f2a", "2029-04-01", "2029-06-30", "\u4fc4\u6590\u91d1\u734e"),
    s(9, 7, "full", "\u7b2c\u4e03\u8f2a", "2029-07-01", "2029-07-31", "\u706b\u7149\u91d1\u734e"),
    s(10, 8, "full", "\u7b2c\u516b\u8f2a", "2029-08-01", "2029-08-31", "\u65b0\u8036\u8def\u6492\u51b7\u734e")
  ],
  segments: [
    m(1, 1, "2026\u5e748\u6708", "2026-08-01", "2026-08-31", [r("\u5275\u4e16\u8a18", 1, 50)]),
    m(2, 1, "2026\u5e749\u6708", "2026-09-01", "2026-09-30", [r("\u51fa\u57c3\u53ca\u8a18", 1, 40)]),
    m(2, 1, "2026\u5e7410\u6708", "2026-10-01", "2026-10-31", [r("\u5229\u672a\u8a18", 1, 27)]),
    m(2, 1, "2026\u5e7411\u6708", "2026-11-01", "2026-11-30", [r("\u6c11\u6578\u8a18", 1, 36)]),
    m(2, 1, "2026\u5e7412\u6708", "2026-12-01", "2026-12-31", [r("\u7533\u547d\u8a18", 1, 34)]),
    m(3, 2, "2027\u5e741\u6708", "2027-01-01", "2027-01-31", [r("\u7d04\u66f8\u4e9e\u8a18"), r("\u58eb\u5e2b\u8a18"), r("\u8def\u5f97\u8a18")]),
    m(3, 2, "2027\u5e742\u6708", "2027-02-01", "2027-02-28", [r("\u6492\u6bcd\u8033\u8a18\u4e0a")]),
    m(3, 2, "2027\u5e743\u6708", "2027-03-01", "2027-03-31", [r("\u6492\u6bcd\u8033\u8a18\u4e0b")]),
    m(4, 2, "2027\u5e744\u6708", "2027-04-01", "2027-04-30", [r("\u5217\u738b\u7d00\u4e0a")]),
    m(4, 2, "2027\u5e745\u6708", "2027-05-01", "2027-05-31", [r("\u5217\u738b\u7d00\u4e0b")]),
    m(4, 2, "2027\u5e746\u6708", "2027-06-01", "2027-06-30", [r("\u6b77\u4ee3\u5fd7\u4e0a")]),
    m(4, 2, "2027\u5e747\u6708", "2027-07-01", "2027-07-31", [r("\u6b77\u4ee3\u5fd7\u4e0b")]),
    m(4, 2, "2027\u5e748\u6708", "2027-08-01", "2027-08-31", [r("\u4ee5\u65af\u62c9\u8a18"), r("\u5c3c\u5e0c\u7c73\u8a18"), r("\u4ee5\u65af\u5e16\u8a18")]),
    m(5, 3, "2027\u5e749\u6708", "2027-09-01", "2027-09-30", [r("\u7d04\u4f2f\u8a18")]),
    m(5, 3, "2027\u5e7410\u6708", "2027-10-01", "2027-10-31", [r("\u8a69\u7bc7", 1, 41)]),
    m(5, 3, "2027\u5e7411\u6708", "2027-11-01", "2027-11-30", [r("\u8a69\u7bc7", 42, 72)]),
    m(5, 3, "2027\u5e7412\u6708", "2027-12-01", "2027-12-31", [r("\u8a69\u7bc7", 73, 106)]),
    m(5, 3, "2028\u5e741\u6708", "2028-01-01", "2028-01-31", [r("\u8a69\u7bc7", 107, 150)]),
    m(5, 3, "2028\u5e742\u6708", "2028-02-01", "2028-02-29", [r("\u7bb4\u8a00")]),
    m(5, 3, "2028\u5e743\u6708", "2028-03-01", "2028-03-31", [r("\u50b3\u9053\u66f8"), r("\u96c5\u6b4c")]),
    m(6, 4, "2028\u5e744\u20135\u6708", "2028-04-01", "2028-05-31", [r("\u4ee5\u8cfd\u4e9e\u66f8")]),
    m(6, 4, "2028\u5e746\u20137\u6708", "2028-06-01", "2028-07-31", [r("\u8036\u5229\u7c73\u66f8"), r("\u8036\u5229\u7c73\u54c0\u6b4c")]),
    m(6, 4, "2028\u5e748\u6708", "2028-08-01", "2028-08-31", [r("\u4ee5\u897f\u7d50\u66f8")]),
    m(6, 4, "2028\u5e749\u6708", "2028-09-01", "2028-09-30", [r("\u4f46\u4ee5\u7406\u66f8"), r("\u4f55\u897f\u963f\u66f8"), r("\u7d04\u73e5\u66f8")]),
    m(6, 4, "2028\u5e7410\u6708", "2028-10-01", "2028-10-31", [r("\u963f\u6469\u53f8\u66f8"), r("\u4fc4\u5df4\u5e95\u4e9e\u66f8"), r("\u7d04\u62ff\u66f8"), r("\u5f4c\u8fe6\u66f8")]),
    m(6, 4, "2028\u5e7411\u6708", "2028-11-01", "2028-11-30", [r("\u90a3\u9d3b\u66f8"), r("\u54c8\u5df4\u8c37\u66f8"), r("\u897f\u756a\u96c5\u66f8"), r("\u54c8\u8a72\u66f8"), r("\u6492\u8fe6\u5229\u4e9e\u66f8"), r("\u746a\u62c9\u57fa\u66f8")]),
    m(7, 5, "2028\u5e7412\u6708", "2028-12-01", "2028-12-31", [r("\u99ac\u592a\u798f\u97f3")]),
    m(7, 5, "2029\u5e741\u6708", "2029-01-01", "2029-01-31", [r("\u99ac\u53ef\u798f\u97f3"), r("\u8def\u52a0\u798f\u97f3")]),
    m(7, 5, "2029\u5e742\u6708", "2029-02-01", "2029-02-28", [r("\u7d04\u7ff0\u798f\u97f3")]),
    m(7, 5, "2029\u5e743\u6708", "2029-03-01", "2029-03-31", [r("\u4f7f\u5f92\u884c\u50b3")]),
    m(8, 6, "2029\u5e744\u6708", "2029-04-01", "2029-04-30", [r("\u7f85\u99ac\u66f8"), r("\u54e5\u6797\u591a\u524d\u66f8")]),
    m(8, 6, "2029\u5e745\u6708", "2029-05-01", "2029-05-31", [r("\u54e5\u6797\u591a\u5f8c\u66f8"), r("\u52a0\u62c9\u592a\u66f8"), r("\u4ee5\u5f17\u6240\u66f8"), r("\u8153\u7acb\u6bd4\u66f8")]),
    m(8, 6, "2029\u5e746\u6708", "2029-06-01", "2029-06-30", [r("\u6b4c\u7f85\u897f\u66f8"), r("\u5e16\u6492\u7f85\u5c3c\u8fe6\u524d\u66f8"), r("\u5e16\u6492\u7f85\u5c3c\u8fe6\u5f8c\u66f8"), r("\u63d0\u6469\u592a\u524d\u66f8"), r("\u63d0\u6469\u592a\u5f8c\u66f8"), r("\u63d0\u591a\u66f8"), r("\u8153\u5229\u9580\u66f8")]),
    m(9, 7, "2029\u5e747\u6708", "2029-07-01", "2029-07-31", [r("\u5e0c\u4f2f\u4f86\u66f8"), r("\u96c5\u5404\u66f8"), r("\u5f7c\u5f97\u524d\u66f8"), r("\u5f7c\u5f97\u5f8c\u66f8"), r("\u7d04\u7ff0\u4e00\u66f8"), r("\u7d04\u7ff0\u4e8c\u66f8"), r("\u7d04\u7ff0\u4e09\u66f8"), r("\u7336\u5927\u66f8")]),
    m(10, 8, "2029\u5e748\u6708", "2029-08-01", "2029-08-31", [r("\u555f\u793a\u9304")])
  ]
};

function cloneChurchCampaign(definition = CHURCH_CAMPAIGN) {
  return JSON.parse(JSON.stringify(definition));
}


function getChurchCampaignStageId(stageNo) {
  return "00000000-0000-0000-c026-" + String(Number(stageNo) || 0).padStart(12, "0");
}

function getChurchCampaignStagePresetKey(stageNo) {
  return "church_stage_" + String(Number(stageNo) || 0).padStart(2, "0");
}

function createChurchCampaignStageDefinitions(definition = CHURCH_CAMPAIGN) {
  return (definition.stages || []).map(stage => {
    const segments = (definition.segments || []).filter(segment => Number(segment.stageNo) === Number(stage.stageNo));
    const books = Array.from(new Set(segments.flatMap(segment => segment.readings.map(reading => reading.book))));
    return {
      id: getChurchCampaignStageId(stage.stageNo),
      parentCampaignId: definition.id,
      presetKey: getChurchCampaignStagePresetKey(stage.stageNo),
      planKind: "church_campaign_stage",
      name: "第" + stage.stageNo + "階段｜" + stage.name,
      description: stage.name + "，完成本階段可獲得「" + stage.awardName + "」。",
      startDate: stage.startDate,
      endDate: stage.endDate,
      isFixed: true,
      isHidden: Number(stage.stageNo) > 1,
      version: definition.version,
      stageNo: Number(stage.stageNo),
      roundNo: Number(stage.roundNo),
      phase: stage.phase,
      awardName: stage.awardName,
      examDate: stage.examDate,
      rules: cloneChurchCampaign(definition.rules),
      stages: [cloneChurchCampaign(stage)],
      segments: cloneChurchCampaign(segments),
      books
    };
  });
}

function getChurchCampaignStageDefinition(stageNo, definition = CHURCH_CAMPAIGN) {
  return createChurchCampaignStageDefinitions(definition)
    .find(stage => Number(stage.stageNo) === Number(stageNo)) || null;
}

// 延後大區梯次（church_campaign_stage_cohort）的排程定義：
// 拿「正式階段」的整份經卷清單，壓進梯次自訂的視窗 [startISO, endISO]，
// 收斂成「單一 segment 涵蓋整個視窗」——由 buildChurchCampaignDays 平均鋪、
// 跳週休。這是「一個日曆月」語意：不逐段平移，而是重新分配。
// examDate 一律清成 null（日後由該大區領袖自行訂）。
// 每個梯次列各自呼叫、各自算，不串接、不累加。
function buildCohortStageDefinition(sourceStageDef, startISO, endISO) {
  if (!sourceStageDef || !startISO || !endISO) return null;
  const clone = cloneChurchCampaign(sourceStageDef);
  const sourceStage = (Array.isArray(clone.stages) && clone.stages[0]) || {
    stageNo: clone.stageNo,
    roundNo: clone.roundNo,
    phase: clone.phase,
    name: clone.name,
    awardName: clone.awardName
  };
  const readings = (Array.isArray(clone.segments) ? clone.segments : [])
    .flatMap(segment => Array.isArray(segment.readings) ? segment.readings : [])
    .map(reading => ({ ...reading }));

  clone.startDate = startISO;
  clone.endDate = endISO;
  clone.examDate = null;
  clone.stages = [{
    ...sourceStage,
    startDate: startISO,
    endDate: endISO,
    examDate: null
  }];
  clone.segments = [{
    stageNo: Number(sourceStage.stageNo),
    roundNo: Number(sourceStage.roundNo),
    label: clone.name || sourceStage.name || "延後梯次",
    startDate: startISO,
    endDate: endISO,
    readings
  }];
  return clone;
}

function parseCampaignDate(value) {
  const date = new Date(value + "T00:00:00");
  return Number.isNaN(date.getTime()) ? null : date;
}

function validateChurchCampaign(definition, bibleBooks = window.BIBLE_BOOKS || []) {
  const errors = [];
  const warnings = [];
  const bookMap = new Map(bibleBooks.map(book => [book.name, Number(book.chapters)]));
  const stages = Array.isArray(definition && definition.stages) ? definition.stages : [];
  const segments = Array.isArray(definition && definition.segments) ? definition.segments : [];
  const stageNumbers = new Set();

  if (!definition || definition.planKind !== "church_campaign") errors.push("\u8a08\u756b\u985e\u578b\u5fc5\u9808\u662f\u6559\u6703\u9577\u671f\u8a08\u756b\u3002");
  if (!parseCampaignDate(definition && definition.startDate) || !parseCampaignDate(definition && definition.endDate)) errors.push("\u8a08\u756b\u65e5\u671f\u683c\u5f0f\u4e0d\u6b63\u78ba\u3002");
  stages.forEach(stage => {
    if (!Number.isInteger(Number(stage.stageNo)) || stageNumbers.has(Number(stage.stageNo))) errors.push("\u734e\u52f5\u968e\u6bb5\u7de8\u865f\u4e0d\u53ef\u91cd\u8907\u3002");
    stageNumbers.add(Number(stage.stageNo));
    if (!stage.name || !stage.awardName) errors.push("\u6bcf\u500b\u968e\u6bb5\u90fd\u9700\u8981\u540d\u7a31\u8207\u734e\u9805\u3002");
    if (!parseCampaignDate(stage.startDate) || !parseCampaignDate(stage.endDate) || stage.startDate > stage.endDate) errors.push("\u968e\u6bb5\u65e5\u671f\u4e0d\u6b63\u78ba\u3002");
  });

  let chapterCount = 0;
  let previousEnd = null;
  [...segments].sort((a, b) => a.startDate.localeCompare(b.startDate)).forEach(segment => {
    if (!stageNumbers.has(Number(segment.stageNo))) errors.push("\u7d93\u5377\u6392\u7a0b\u5f15\u7528\u4e86\u4e0d\u5b58\u5728\u7684\u734e\u52f5\u968e\u6bb5\u3002");
    if (!parseCampaignDate(segment.startDate) || !parseCampaignDate(segment.endDate) || segment.startDate > segment.endDate) errors.push("\u7d93\u5377\u6392\u7a0b\u65e5\u671f\u4e0d\u6b63\u78ba\u3002");
    if (previousEnd && segment.startDate <= previousEnd) errors.push("\u7d93\u5377\u6392\u7a0b\u65e5\u671f\u4e0d\u53ef\u91cd\u758a\u3002");
    previousEnd = segment.endDate;
    (segment.readings || []).forEach(reading => {
      const maxChapter = bookMap.get(reading.book);
      const from = Number(reading.from || 1);
      const to = Number(reading.to || maxChapter);
      if (!maxChapter) errors.push("\u627e\u4e0d\u5230\u7d93\u5377\uff1a" + reading.book);
      else if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > maxChapter) errors.push(reading.book + " \u7684\u7ae0\u7bc0\u7bc4\u570d\u4e0d\u6b63\u78ba\u3002");
      else chapterCount += to - from + 1;
    });
  });

  const teamRules = definition && definition.rules && definition.rules.teamRules;
  const smallHomeMin = Number(teamRules && teamRules.smallHome && teamRules.smallHome.min);
  const smallHomeMax = Number(teamRules && teamRules.smallHome && teamRules.smallHome.max);
  if (!teamRules || smallHomeMin < 2 || smallHomeMax > 4 || smallHomeMin > smallHomeMax) errors.push("\u5c0f\u5bb6\u4eba\u6578\u5fc5\u9808\u4ecb\u65bc 2\u20134 \u4eba\u3002");
  if (!teamRules || Number(teamRules.smallGroup && teamRules.smallGroup.min) < 6 || (teamRules.smallGroup && teamRules.smallGroup.max) != null) errors.push("\u5c0f\u7d44\u5fc5\u9808\u70ba 6 \u4eba\u4ee5\u4e0a\u4e14\u4e0d\u8a2d\u4e0a\u9650\u3002");
  if (teamRules && teamRules.smallGroup && teamRules.smallGroup.source !== "profile.small_group") errors.push("\u5c0f\u7d44\u5206\u968a\u5fc5\u9808\u4f9d\u6703\u54e1\u57fa\u672c\u8cc7\u6599\u3002");
  if (chapterCount !== 1189) warnings.push("\u76ee\u524d\u6392\u7a0b\u5171 " + chapterCount + " \u7ae0\uff0c\u4e0d\u662f\u5b8c\u6574\u8056\u7d93 1,189 \u7ae0\u3002");

  return { valid: errors.length === 0, errors, warnings, chapterCount };
}

function buildChurchCampaignDays(definition, bibleBooks = window.BIBLE_BOOKS || [], restWeekdays = []) {
  const restWeekdaySet = new Set((Array.isArray(restWeekdays) ? restWeekdays : []).map(Number));
  const start = parseCampaignDate(definition.startDate);
  const end = parseCampaignDate(definition.endDate);
  if (!start || !end) return [];
  const totalDays = Math.floor((end - start) / 86400000) + 1;
  const days = Array.from({ length: totalDays }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return {
      day: index + 1,
      dayNum: index + 1,
      date: String(date.getMonth() + 1).padStart(2, "0") + "/" + String(date.getDate()).padStart(2, "0"),
      isoDate: date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0"),
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      chapters: [],
      stageNo: null,
      campaignRound: null,
      awardName: null,
      segmentLabel: null,
      isRestDay: false
    };
  });
  const bookMap = new Map(bibleBooks.map(book => [book.name, Number(book.chapters)]));
  const stageMap = new Map((definition.stages || []).map(stage => [Number(stage.stageNo), stage]));

  (definition.segments || []).forEach(segment => {
    const segmentStart = parseCampaignDate(segment.startDate);
    const segmentEnd = parseCampaignDate(segment.endDate);
    if (!segmentStart || !segmentEnd) return;
    const offset = Math.floor((segmentStart - start) / 86400000);
    const segmentDays = Math.floor((segmentEnd - segmentStart) / 86400000) + 1;
    const chapters = [];
    (segment.readings || []).forEach(reading => {
      const maxChapter = bookMap.get(reading.book) || 0;
      const from = Number(reading.from || 1);
      const to = Number(reading.to || maxChapter);
      for (let chapter = from; chapter <= to; chapter++) chapters.push({ book: reading.book, chapter, round: 1 });
    });
    const segmentDayIndexes = Array.from({ length: segmentDays }, (_, index) => index);
    const readingDayIndexes = segmentDayIndexes.filter(index => {
      const day = days[offset + index];
      if (!day) return false;
      const date = parseCampaignDate(day.isoDate);
      return date && !restWeekdaySet.has(date.getDay());
    });
    const allocationDayIndexes = readingDayIndexes.length ? readingDayIndexes : segmentDayIndexes;
    const base = Math.floor(chapters.length / allocationDayIndexes.length);
    const remainder = chapters.length % allocationDayIndexes.length;
    let chapterIndex = 0;
    const stage = stageMap.get(Number(segment.stageNo));

    for (let index = 0; index < segmentDays; index++) {
      const day = days[offset + index];
      if (!day) continue;
      day.stageNo = Number(segment.stageNo);
      day.campaignRound = Number(segment.roundNo);
      day.awardName = stage ? stage.awardName : null;
      day.segmentLabel = segment.label;
      const readingIndex = allocationDayIndexes.indexOf(index);
      if (readingIndex === -1) {
        day.isRestDay = true;
        continue;
      }
      const count = base + (readingIndex < remainder ? 1 : 0);
      day.chapters = chapters.slice(chapterIndex, chapterIndex + count).map(chapter => ({
        ...chapter,
        isRead: false,
        isReadR1: false,
        isReadR2: false,
        isReadR3: false
      }));
      chapterIndex += count;
    }
  });
  return days;
}

function getChurchCampaignTeamStatus(type, members, definition = CHURCH_CAMPAIGN) {
  const list = Array.isArray(members) ? members : [];
  const rules = definition.rules.teamRules;
  if (type === "personal") {
    return { eligible: list.length === 1, count: list.length, min: 1, max: 1 };
  }
  if (type === "smallHome") {
    const min = Number(rules.smallHome.min);
    const max = Number(rules.smallHome.max);
    return { eligible: list.length >= min && list.length <= max, count: list.length, min, max };
  }
  if (type === "smallGroup") {
    const min = Number(rules.smallGroup.min);
    const grouped = list.reduce((result, member) => {
      const group = String(member && member.small_group || "").trim();
      if (group) result[group] = (result[group] || 0) + 1;
      return result;
    }, {});
    return {
      eligible: Object.values(grouped).some(count => count >= min),
      count: list.length,
      min,
      max: null,
      source: "profile.small_group",
      groups: Object.entries(grouped).map(([name, count]) => ({ name, count, eligible: count >= min }))
    };
  }
  return { eligible: false, count: list.length, min: 0, max: 0 };
}

window.CHURCH_CAMPAIGN_ID = CHURCH_CAMPAIGN_ID;
window.CHURCH_CAMPAIGN_PRESET_KEY = CHURCH_CAMPAIGN_PRESET_KEY;
window.CHURCH_CAMPAIGN = CHURCH_CAMPAIGN;
window.getChurchCampaignStageId = getChurchCampaignStageId;
window.getChurchCampaignStagePresetKey = getChurchCampaignStagePresetKey;
window.createChurchCampaignStageDefinitions = createChurchCampaignStageDefinitions;
window.getChurchCampaignStageDefinition = getChurchCampaignStageDefinition;
window.buildCohortStageDefinition = buildCohortStageDefinition;
window.cloneChurchCampaign = cloneChurchCampaign;
window.validateChurchCampaign = validateChurchCampaign;
window.buildChurchCampaignDays = buildChurchCampaignDays;
window.getChurchCampaignTeamStatus = getChurchCampaignTeamStatus;

// ── 進度比對的「教會原始日程」──────────────────────────────────────────────
// 「落後 / 超前 / 補讀」的唯一比對尺：該階段書卷 ÷ 起訖天數、平均鋪、每週七日。
// 不套使用者的 level、也不套使用者個人的休息日（第 3 參數固定傳 []）。
// 非教會 campaign 的計畫沒有 campaignDefinition → 退回 plan.days（原則只規範教會階段）。
const _canonicalStageScheduleCache = new Map();
function getCanonicalStageScheduleDays(plan) {
  if (!plan) return [];
  const def = plan.campaignDefinition;
  if (!def) return Array.isArray(plan.days) ? plan.days : [];
  const key = String(def.id || def.presetKey || plan.presetKey || plan.globalPlanId || plan.id || "")
    + "|" + String(def.startDate || plan.startDate || "")
    + "|" + String(def.endDate || plan.endDate || "");
  const cached = _canonicalStageScheduleCache.get(key);
  if (cached) return cached;
  let built = null;
  try {
    built = buildChurchCampaignDays(def, window.BIBLE_BOOKS || [], []);
  } catch (error) {
    console.warn("getCanonicalStageScheduleDays: build failed, using plan.days", error);
  }
  if (!Array.isArray(built) || !built.length) {
    built = Array.isArray(plan.days) ? plan.days : [];
  }
  if (key !== "||") _canonicalStageScheduleCache.set(key, built);
  return built;
}
window.getCanonicalStageScheduleDays = getCanonicalStageScheduleDays;

