// Bible Speed Reading Gamification: Achievements, Fireworks, and Honor Badges

const _stageAwardBadges = (typeof window.createChurchCampaignStageDefinitions === "function"
  ? window.createChurchCampaignStageDefinitions()
  : [])
  // stageNo 2 現在展開成 4 張月度計畫 → 會產生 4 個一樣的 church_stage_award_2；依 stageNo 去重。
  .reduce((acc, stage) => {
    const no = Number(stage.stageNo);
    if (acc.seen.has(no)) return acc;
    acc.seen.add(no);
    acc.list.push({
      id: "church_stage_award_" + no,
      title: stage.awardName,
      description: no === 2
        ? "完成 出埃及記＋利未記＋民數記＋申命記（各一遍）→ 賽季結束後在徽章牆合成鐵獎"
        : "完成「" + stage.name + "」讀經計畫",
      triggerText: no === 2
        ? "四卷遍數加總：每 2 遍 1 顆星（上限 5）→ 每 3 遍 1 顆鑽石（上限 3）→ 每 4 遍 1 個皇冠（上限 3）"
        : "完成1~5遍點亮1~5顆星；完成6~8遍獲得1~3顆鑽石；完成9~10+遍獲得1~3個皇冠至尊榮譽",
      iconKey: "award",
      campaignStageNo: no
    });
    return acc;
  }, { seen: new Set(), list: [] })
  .list;

// 第一輪期末賽（stageNo 2）的四卷小徽章：各自記自己的遍數。集滿四卷後季末手動合成鐵獎。
const _firstRoundFinalBookBadges = (typeof window.createChurchCampaignStageDefinitions === "function"
  ? window.createChurchCampaignStageDefinitions().filter(d => d && d.isMonthlyFinal)
  : [])
  .slice()
  .sort((a, b) => (Number(a.finalMonthIndex) || 0) - (Number(b.finalMonthIndex) || 0))
  .map(d => ({
    id: d.finalBookBadgeId,
    title: (d.books && d.books[0]) || "",
    description: "讀完「" + ((d.books && d.books[0]) || "") + "」（第一輪期末賽，四卷之一）",
    triggerText: "完成1遍點亮1顆星，之後每多讀1遍多1顆星（滿5顆後鑽石、皇冠）",
    iconKey: "bookOpen",
    firstRoundFinalBook: true
  }))
  .filter(b => b.id);

const ACHIEVEMENTS = [..._stageAwardBadges, ..._firstRoundFinalBookBadges];
ACHIEVEMENTS.forEach(badge => {
  badge.designVersion = 2;
  badge.maxStars = 5;
});

const BADGE_UNLOCK_LEVELS = Object.fromEntries(ACHIEVEMENTS.map(badge => [badge.id, 1]));

function formatBadgeUnlockDate(date) {
  const d = date || new Date();
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function recordBadgeUnlockDate(badgeId) {
  const level = BADGE_UNLOCK_LEVELS[badgeId];
  if (!level) return;
  const key = `date_unlocked_${badgeId}_lvl_${level}`;
  if (!localStorage.getItem(key)) {
    localStorage.setItem(key, formatBadgeUnlockDate());
  }
}

function refreshBadgeSurfaces() {
  if (typeof renderBadgeWall === "function") {
    renderBadgeWall("badges-grid");
  }
}

// Check achievements and trigger popup if newly unlocked
async function checkAchievements(silent = false) {
  const unlocked = JSON.parse(localStorage.getItem("unlocked_badges") || "[]");
  const newlyUnlocked = [];

  ACHIEVEMENTS.forEach(badge => {
    const stateInfo = typeof window.getBadgeStarState === "function"
      ? window.getBadgeStarState(badge)
      : { level: unlocked.includes(badge.id) ? 1 : 0 };
    for (let star = 1; star <= stateInfo.level; star++) {
      const dateKey = `date_unlocked_${badge.id}_lvl_${star}`;
      if (!localStorage.getItem(dateKey)) localStorage.setItem(dateKey, formatBadgeUnlockDate());
    }
    if (stateInfo.level > 0 && !unlocked.includes(badge.id)) newlyUnlocked.push(badge.id);
  });

  if (newlyUnlocked.length === 0) {
    refreshBadgeSurfaces();
    return;
  }

  const updatedUnlocked = [...new Set([...unlocked, ...newlyUnlocked])];
  localStorage.setItem("unlocked_badges", JSON.stringify(updatedUnlocked));
  newlyUnlocked.forEach(function (badgeId, index) {
    if (silent) {
      localStorage.setItem(`notified_${badgeId}`, "true");
      localStorage.setItem(`${badgeId}_unlocked`, "true");
    } else {
      if (index === 0 && typeof window.triggerBadgeUnlockNotification === "function") {
        const badge = ACHIEVEMENTS.find(item => item.id === badgeId);
        if (badge) window.triggerBadgeUnlockNotification(badgeId, badge.title);
      } else {
        localStorage.setItem(`notified_${badgeId}`, "true");
      }
    }
  });
  refreshBadgeSurfaces();
}

// Particle system Canvas Fireworks
function launchFireworks() {
  const canvas = document.createElement("canvas");
  canvas.id = "fireworks-canvas";
  canvas.style = "position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 99999;";
  document.body.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  let width = canvas.width = window.innerWidth;
  let height = canvas.height = window.innerHeight;

  const resizeHandler = () => {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  };
  window.addEventListener("resize", resizeHandler);

  const particles = [];

  class Particle {
    constructor(x, y, color) {
      this.x = x;
      this.y = y;
      this.color = color;
      this.angle = Math.random() * Math.PI * 2;
      this.speed = Math.random() * 6 + 2;
      this.vx = Math.cos(this.angle) * this.speed;
      this.vy = Math.sin(this.angle) * this.speed;
      this.gravity = 0.06;
      this.alpha = 1;
      this.decay = Math.random() * 0.015 + 0.01;
    }
    update() {
      this.x += this.vx;
      this.y += this.vy;
      this.vy += this.gravity;
      this.alpha -= this.decay;
    }
    draw() {
      ctx.save();
      ctx.globalAlpha = this.alpha;
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(this.x, this.y, Math.random() * 2 + 2, 0, Math.PI * 2);
      ctx.shadowBlur = 10;
      ctx.shadowColor = this.color;
      ctx.fill();
      ctx.restore();
    }
  }

  function createExplosion(x, y) {
    const colors = ["#ff5252", "#ffeb3b", "#00e676", "#2979ff", "#e040fb", "#ff9100", "#18ffff"];
    const color = colors[Math.floor(Math.random() * colors.length)];
    for (let i = 0; i < 80; i++) {
      particles.push(new Particle(x, y, color));
    }
  }

  let frameCount = 0;
  function animate() {
    ctx.clearRect(0, 0, width, height);

    if (frameCount % 25 === 0) {
      createExplosion(
        Math.random() * width * 0.8 + width * 0.1,
        Math.random() * height * 0.5 + height * 0.15
      );
    }
    frameCount++;

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.update();
      if (p.alpha <= 0) {
        particles.splice(i, 1);
      } else {
        p.draw();
      }
    }

    if (frameCount < 160) {
      requestAnimationFrame(animate);
    } else {
      canvas.style.transition = "opacity 0.8s ease";
      canvas.style.opacity = "0";
      setTimeout(() => {
        canvas.remove();
        window.removeEventListener("resize", resizeHandler);
      }, 800);
    }
  }

  animate();
}

function renderUnlockedBadgesWall() {
  // Deprecated: Badge strip is removed as badges only display on the profile page
}

function getAchievementById(badgeId) {
  return ACHIEVEMENTS.find(achievement => achievement.id === badgeId) || null;
}

window.getAchievementById = getAchievementById;
window.triggerBadgeUnlockNotification = function(badgeId) {
  const badge = getAchievementById(badgeId);
  if (!badge) {
    return { ok: false, status: 404, error: "badge_not_found" };
  }
  const hasNotified = localStorage.getItem(`notified_${badgeId}`) === "true";
  if (hasNotified) return { ok: true, alreadyNotified: true, badge };

  const isDark = state.theme === "dark" || document.body.classList.contains("dark-theme");

  const unlocked = JSON.parse(localStorage.getItem("unlocked_badges") || "[]");
  if (!unlocked.includes(badgeId)) {
    unlocked.push(badgeId);
    localStorage.setItem("unlocked_badges", JSON.stringify(unlocked));
  }

  recordBadgeUnlockDate(badgeId);

  const page = document.getElementById("badge-detail-page");
  if (page) {
    page.classList.remove("hidden");
  }
  if (typeof window.openBadgeDetailPage === "function") {
    window.openBadgeDetailPage(badge, true, isDark);
  }

  if (typeof launchFireworks === "function") {
    launchFireworks();
  }

  localStorage.setItem(`notified_${badgeId}`, "true");
  localStorage.setItem(`${badgeId}_unlocked`, "true");

  refreshBadgeSurfaces();
  return { ok: true, badge };
};


// 第一輪期末賽：使用者在徽章牆按「合成鐵獎」時呼叫。防連點；只成立一次。
window.synthesizeFirstRoundFinal = function synthesizeFirstRoundFinal() {
  const status = typeof window.getFirstRoundFinalStatus === "function" ? window.getFirstRoundFinalStatus() : null;
  const store = window.FIRST_ROUND_FINAL_STORAGE || {
    synthesized: "church_r1final_synthesized", ironTier: "church_r1final_iron_tier"
  };
  if (!status) return { ok: false, error: "status_unavailable" };
  if (status.synthesized) return { ok: true, alreadySynthesized: true, tier: status.ironTier };
  if (!status.canSynthesize) {
    return { ok: false, error: status.seasonEnded ? "threshold_not_met" : "season_not_ended" };
  }
  const tier = Math.max(1, Number(
    typeof window.ironTierFromSum === "function" ? window.ironTierFromSum(status.starSum) : 1
  ) || 1);
  try {
    localStorage.setItem(store.ironTier, String(tier));
    localStorage.setItem(store.synthesized, "1");
  } catch (_e) { /* noop */ }

  // triggerBadgeUnlockNotification 自己會 push unlocked_badges / recordBadgeUnlockDate /
  // launchFireworks / openBadgeDetailPage；它會擋 notified_ 旗標，所以在它之前先清掉。
  try { localStorage.removeItem("notified_church_stage_award_2"); } catch (_e) {}
  if (typeof window.triggerBadgeUnlockNotification === "function") {
    window.triggerBadgeUnlockNotification("church_stage_award_2");
  } else {
    const unlocked = JSON.parse(localStorage.getItem("unlocked_badges") || "[]");
    if (!unlocked.includes("church_stage_award_2")) {
      unlocked.push("church_stage_award_2");
      localStorage.setItem("unlocked_badges", JSON.stringify(unlocked));
    }
    if (typeof launchFireworks === "function") launchFireworks();
  }
  refreshBadgeSurfaces();
  return { ok: true, tier };
};

window.refreshBadgeSurfaces = refreshBadgeSurfaces;
window.launchFireworks = launchFireworks;
window.renderUnlockedBadgesWall = renderUnlockedBadgesWall;
window.ACHIEVEMENTS = ACHIEVEMENTS;
window.BADGE_UNLOCK_LEVELS = BADGE_UNLOCK_LEVELS;
window.checkAchievements = checkAchievements;
window.recordBadgeUnlockDate = recordBadgeUnlockDate;

