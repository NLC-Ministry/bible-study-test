// js/modules/home.js
import { validateVerseSource } from "./verse-validator.mjs";
import { DevotionalSharingController } from "./devotional-sharing-controller.mjs";
import { formatUpcomingPlanCountdown } from "./home-plan-countdown.mjs";

const sharingController = new DevotionalSharingController();
let pastoralSharingWallEnabled = false;
let dashboardSecondaryWorkTimer = null;

function applyPastoralSharingWallVisibility(enabled) {
  pastoralSharingWallEnabled = enabled === true;
  const card = document.getElementById("pastoral-sharing-wall-card");
  if (!card) return;
  card.classList.toggle("hidden", !pastoralSharingWallEnabled);
  card.setAttribute("aria-hidden", pastoralSharingWallEnabled ? "false" : "true");
  if (!pastoralSharingWallEnabled) {
    const wall = document.getElementById("home-verse-wall");
    if (wall) wall.innerHTML = "";
    document.querySelector(".devotional-card")?.classList.add("hidden");
  }
}

async function refreshPastoralSharingWallAvailability() {
  applyPastoralSharingWallVisibility(false);
  if (typeof db === "undefined" || typeof db.getFeatureSetting !== "function") return false;
  const result = await db.getFeatureSetting("pastoral_sharing_wall", false);
  const enabled = !result.error && result.enabled === true;
  applyPastoralSharingWallVisibility(enabled);
  if (enabled) await fetchPastoralVerseWall();
  return enabled;
}

window.addEventListener("pastoral-sharing-wall-changed", event => {
  const enabled = event.detail?.enabled === true;
  applyPastoralSharingWallVisibility(enabled);
  if (enabled) fetchPastoralVerseWall();
});

function scheduleDashboardSecondaryWork() {
  if (dashboardSecondaryWorkTimer !== null) {
    clearTimeout(dashboardSecondaryWorkTimer);
  }

  const scheduleAfterPaint = typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame.bind(window)
    : callback => window.setTimeout(callback, 0);

  scheduleAfterPaint(() => {
    dashboardSecondaryWorkTimer = window.setTimeout(() => {
      dashboardSecondaryWorkTimer = null;
      calculateAndRenderPersonalRankings();
      renderPastoralZoneRankingList();
      loadTodayDevotional();
      refreshPastoralSharingWallAvailability();
      renderPilgrimageTrail();
      if (!state.pilgrimageControlsInit) {
        initPilgrimageControls();
        state.pilgrimageControlsInit = true;
      }
      if (typeof hydrateIcons === "function") {
        hydrateIcons(document.getElementById("dashboard-view"));
      }
    }, 0);
  });
}


const DAILY_VERSES = [
  { text: "「愛是恆久忍耐，又有恩慈；愛是不嫉妒；愛是不自誇，不張狂，不做害羞的事，不求自己的益處，不輕易發怒，不計算人的惡。」", source: "哥林多前書 13:4-5" },
  { text: "「要常常喜樂，不住的禱告，凡事謝恩；因為這是神在基督耶穌裡向你們所定的旨意。」", source: "帖撒羅尼迦前書 5:16-18" },
  { text: "「應當一無罣慮，只要凡事藉著禱告、祈求，和感謝，將你們所要的告訴神。神所賜、出人意外的平安必在基督耶穌裡保守你們的心懷意念。」", source: "腓立比書 4:6-7" },
  { text: "「願耶和華賜福給你，保護你。願耶和華使他的臉光照你，賜恩給你。願耶和華向你仰臉，賜你平安。」", source: "民數記 6:24-26" },
  { text: "「但那等候耶和華的必從新得力。他們必如鷹展翅上騰；他們奔跑卻不困倦，行走卻不疲乏。」", source: "以賽亞書 40:31" },
  { text: "「你不要害怕，因為我與你同在；不要驚惶，因為我是你的神。我必堅固你，我必幫助你；我必用我公義的右手扶持你。」", source: "以賽亞書 41:10" },
  { text: "「凡你們所做的都要憑愛心而做。」", source: "哥林多前書 16:14" },
  { text: "「我今日所吩咐你的話都要記在心上，也要殷勤教訓你的兒女。無論你坐在家裡，行在路上，躺下，起來，都要談論。」", source: "申命記 6:6-7" },
  { text: "「耶和華說：我知道我向你們所懷的意念是賜平安的意念，不是降災禍的意念，要叫你們末後有指望。」", source: "耶利米書 29:11" },
  { text: "「倚靠耶和華、以耶和華為可靠的，那人有福了！他必像樹栽於水旁，在河邊扎根，炎熱來到，並不懼怕，葉子仍必青翠，在乾旱之年毫無掛慮，而且結果不止。」", source: "耶利米書 17:7-8" },
  { text: "「所以我告訴你們，凡你們禱告祈求的，無論是甚麼，只要信是得著的，就必得著。」", source: "馬可福音 11:24" },
  { text: "「你所做的，要交託耶和華，你所謀的，就必成立。」", source: "箴言 16:3" },
  { text: "「求你使我清晨得聽你慈愛之言，因我倚靠你；求你使我知道當行的路，因我的心仰望你。」", source: "詩篇 143:8" },
  { text: "「求他按著他豐盛的榮耀，藉著他的靈，叫你們心裡的力量剛強起來，使基督因你們的信，住在你們心裡，叫你們的愛心有根有基。」", source: "以弗所書 3:16-17" },
  { text: "「無論做甚麼，都要從心裡做，像是給主做的，不是給人做的，因你們知道從主那裡必得著基業為賞賜；你們所事奉的乃是主基督。」", source: "歌羅西書 3:23-24" },
  { text: "「但願使人有盼望的神，因信將諸般的喜樂、平安充滿你們的心，使你們藉著聖靈的能力大有盼望。」", source: "羅馬書 15:13" },
  { text: "「耶和華必在你前面行；他必與你同在，必不撇下你，也不丟棄你。不要懼怕，也不要驚惶。」", source: "申命記 31:8" },
  { text: "「耶和華要保護你，免受一切的災害；他要保護你的性命。你出你入，耶和華要保護你，從今時直到永遠。」", source: "詩篇 121:7-8" },
  { text: "「耶穌對他說：復活在我，生命也在我。信我的人雖然死了，也必復活，凡活著信我的人必永遠不死。你信這話麼？」", source: "約翰福音 11:25-26" },
  { text: "「因我們行事為人是憑著信心，不是憑著眼見。」", source: "哥林多後書 5:7" },
  { text: "「他們說：當信主耶穌，你和你一家都必得救。」", source: "使徒行傳 16:31" },
  { text: "「不可使慈愛、誠實離開你，要繫在你頸項上，刻在你心版上。這樣，你必在神和世人眼前蒙恩寵，有聰明。」", source: "箴言 3:3-4" },
  { text: "「你要專心仰賴耶和華，不可倚靠自己的聰明，在你一切所行的事上都要認定他，他必指引你的路。」", source: "箴言 3:5-6" },
  { text: "「信就是所望之事的實底，是未見之事的確據。」", source: "希伯來書 11:1" },
  { text: "「凡事謙虛、溫柔、忍耐，用愛心互相寬容。」", source: "以弗所書 4:2" },
  { text: "「你們要事奉耶和華你們的神，他必賜福與你的糧與你的水，也必從你們中間除去疾病。」", source: "詩篇 119:10" },
  { text: "「聖靈所結的果子，就是仁愛、喜樂、和平、忍耐、恩慈、良善、信實、溫柔、節制。這樣的事沒有律法禁止。」", source: "加拉太書 5:22-23" },
  { text: "「你們要事奉耶和華你們的神，他必賜福與你的糧與你的水，也必從你們中間除去疾病。」", source: "出埃及記 23:25" },
  { text: "「所以，我親愛的弟兄們，你們務要堅固，不可搖動，常常竭力多做主工；因為知道，你們的勞苦在主裡面不是徒然的。」", source: "哥林多前書 15:58" },
  { text: "「如今常存的有信，有望，有愛這三樣，其中最大的是愛。」", source: "哥林多前書 13:13" },
  { text: "「你回去告訴我民的君希西家說：耶和華你祖大衛的神如此說：我聽見了你的禱告，看見了你的眼淚，我必醫治你；到第三日，你必上到耶和華的殿。」", source: "列王記下 20:5" },
  { text: "「我豈沒有吩咐你麼？你當剛強壯膽！不要懼怕，也不要驚惶；因為你無論往那裡去，耶和華你的神必與你同在。」", source: "約書亞記 1:9" },
  { text: "「在這一切之外，要存著愛心，愛心就是聯絡全德的。」", source: "歌羅西書 3:14" },
  { text: "「我們若照他的旨意求甚麼，他就聽我們，這是我們向他所存坦然無懼的心。」", source: "約翰一書 5:14" },
  { text: "「將你心所願的賜給你，成就你的一切籌算。」", source: "詩篇 20:4" },
  { text: "「主就是那靈；主的靈在那裡，那裡就得以自由。」", source: "哥林多後書 3:17" },
  { text: "「你從水中經過，我必與你同在；你逿過江河，水必不漫過你；你從火中行過，必不被燒，火燄也不著在你身上。」", source: "以賽亞書 43:2" },
  { text: "「你們要謹慎行事，不要像愚昧人，當像智慧人。要愛惜光陰，因為現今的世代邪惡。」", source: "以弗所書 5:15-16" },
  { text: "「耶穌對他說：你若能信，在信的人，凡事都能。」", source: "馬可福音 9:23" },
  { text: "「耶和華啊，你是我的神；我要尊崇你，我要稱讚你的名。因為你以忠信誠實行過奇妙的事，成就你古時所定的。」", source: "以賽亞書 25:1" },
  { text: "「各人要隨本心所酌定的，不要作難，不要勉強，因為捐得樂意的人是神所喜愛的。」", source: "哥林多後書 9:7" },
  { text: "「你們要恆切禱告，在此儆醒感恩。」", source: "歌羅西書 4:2" },
  { text: "「神愛我們的心，我們也知道也信。神就是愛；住在愛裡面的，就是住在神裡面，神也住在他裡面。」", source: "約翰一書 4:16" },
  { text: "「在指望中要喜樂，在患難中要忍耐，禱告要恆切。」", source: "羅馬書 12:12" },
  { text: "「我懼怕的時候要倚靠你。」", source: "詩篇 56:3" },
  { text: "「你們要呼求我，禱告我，我就應允你們。」", source: "耶利米書 29:12" },
  { text: "「我將這些事告訴你們，是要叫你們在我裡面有平安。在世上，你們有苦難；但你們可以放心，我已經勝了世界。」", source: "約翰福音 16:33" },
  { text: "「約在半夜，保羅和西拉禱告，唱詩讚美神，眾囚犯也側耳而聽。」", source: "使徒行傳 16:25" },
  { text: "「因為我耶和華你的神必攙扶你的右手，對你說：不要害怕！我必幫助你。」", source: "以賽亞書 41:13" },
  { text: "「並要以恩慈相待，存憐憫的心，彼此饒恕，正如神在基督裡饒恕了你們一樣。」", source: "以弗所書 4:32" },
  { text: "「凡勞苦擔重擔的人可以到我這裡來，我就使你們得安息。」", source: "馬太福音 11:28" },
  { text: "「你們務要儆醒，在真道上站立得穩，要作大丈夫，要剛強。」", source: "哥林多前書 16:13" },
  { text: "「看哪，弟兄和睦同居是何等地善，何等地美！」", source: "詩篇 119:10" },
  { text: "「耶和華啊，尊大、能力、榮耀、強勝、威嚴都是你的；凡天上地下的都是你的；國度也是你的，並且你為至高，為萬有之首。」", source: "歷代志上 29:11" },
  { text: "「看哪，弟兄和睦同居是何等地善，何等地美！」", source: "詩篇 133:1" },
  { text: "「聖靈所結的果子，就是仁愛、喜樂、和平、忍耐、恩慈、良善、信實、溫柔、節制。這樣的事沒有律法禁止。」", source: "加拉太書 5:22-23" },
  { text: "「你們豈不知不義的人不能承受神的國麼？不要自欺！無論是淫亂的、拜偶像的、姦淫的、作孌童的、親男色的、偷竊的、貪婪的、醉酒的、辱罵的、勒索的，都不能承受神的國。」", source: "哥林多前書 6:9-10" },
  { text: "「我的肉體和我的心腸衰殘；但神是我心裡的力量，又是我的福分，直到永遠。」", source: "詩篇 73:26" },
  { text: "「所以，你們該彼此勸慰，互相建立，正如你們素常所行的。」", source: "帖撒羅尼迦前書 5:11" },
  { text: "「這稱為我名下的子民，若是自卑、禱告，尋求我的面，轉離他們的惡行，我必從天上垂聽，赦免他們的罪，醫治他們的地。」", source: "歷代志下 7:14" },
  { text: "「遮掩人過的，尋求人愛；屢次挑錯的，離間密友。」", source: "箴言 17:9" },
  { text: "「應當稱謝耶和華；因他本為善，他的慈愛永遠長存！」", source: "歷代志上 16:34" },
  { text: "「我的心哪，你為何憂悶？為何在我裡面煩躁？應當仰望神，因我還要稱讚他。他是我臉上的光榮，是我的神。」", source: "詩篇 42:11" },
  { text: "「所以，你們因信基督耶穌都是神的兒子。你們受洗歸入基督的都是披戴基督了。」", source: "加拉太書 3:26-27" },
  { text: "「你要保守你心，勝過保守一切，因為一生的果效是由心發出。」", source: "箴言 4:23" },
  { text: "「只是你們要行道，不要單單聽道，自己欺哄自己。」", source: "雅各書 1:22" },
  { text: "「水中照臉，彼此相符；人與人，心也相對。」", source: "箴言 27:19" },
  { text: "「我們愛，因為神先愛我們。」", source: "約翰一書 4:19" },
  { text: "「要穿戴神所賜的全副軍裝，就能抵擋魔鬼的詭計。」", source: "以弗所書 6:11" },
  { text: "「只要憑著信心求，一點不疑惑；因為那疑惑的人，就像海中的波浪，被風吹動翻騰。」", source: "雅各書 1:6" },
  { text: "「你求告我，我就應允你，並將你所不知道、又大又難的事指示你。」", source: "耶利米書 33:3" },
  { text: "「不要效法這個世界，只要心意更新而變化，叫你們察驗何為神的善良、純全、可喜悅的旨意。」", source: "羅馬書 12:2" },
  { text: "「願頌讚歸與我們的主耶穌基督的父神，就是發慈悲的父，賜各樣安慰的神。我們在一切患難中，他就安慰我們，叫我們能用神所賜的安慰去安慰那遭各樣患難的人。」", source: "哥林多後書 1:3-4" },
  { text: "「所以，我們只管坦然無懼的來到施恩的寶座前，為要得憐恤，蒙恩惠，作隨時的幫助。」", source: "希伯來書 4:16" },
  { text: "「弟兄們，我藉我們主耶穌基督的名勸你們都說一樣的話。你們中間也不可分黨，只要一心一意，彼此相合。」", source: "哥林多前書 1:10" },
  { text: "「人為朋友捨命，人的愛心沒有比這個大的。」", source: "約翰福音 15:13" },
  { text: "「你們尋求我，若專心尋求我，就必尋見。」", source: "耶利米書 29:13" },
  { text: "「凡有氣息的都要讚美耶和華！你們要讚美耶和華！」", source: "詩篇 150:6" },
  { text: "「耶穌看著他們，說：在人是不能，在神卻不然，因為神凡事都能。」", source: "馬可福音 10:27" },
  { text: "「你的話是我腳前的燈，是我路上的光。」", source: "詩篇 119:10" },
  { text: "「殷勤不可懶惰。要心裡火熱，常常服事主。」", source: "羅馬書 12:11" },
  { text: "「你的話是我腳前的燈，是我路上的光。」", source: "詩篇 119:105" },
  { text: "「朋友乃時常親愛，弟兄為患難而生。」", source: "箴言 17:17" },
  { text: "「他醫好傷心的人，裹好他們的傷處。」", source: "詩篇 147:3" },
  { text: "「因為神賜給我們，不是膽怯的心，乃是剛強、仁愛、謹守的心。」", source: "提摩太後書 1:7" },
  { text: "「我靠著那加給我力量的，凡事都能做。」", source: "腓立比書 4:13" },
  { text: "「你們饒恕人的過犯，你們的天父也必饒恕你們的過犯。」", source: "馬太福音 6:14" },
  { text: "「豈不知你們的身子就是聖靈的殿麼？這聖靈是從神而來，住在你們裡頭的；並且你們不是自己的人；因為你們是重價買來的。所以，要在你們的身子上榮耀神。」", source: "哥林多前書 6:19-20" },
  { text: "「感謝神，使我們藉著我們的主耶穌基督得勝。」", source: "哥林多前書 15:57" },
  { text: "「我們若認自己的罪，神是信實的，是公義的，必要赦免我們的罪，洗淨我們一切的不義。」", source: "約翰一書 1:9" },
  { text: "「疲乏的，他賜能力；軟弱的，他加力量。」", source: "以賽亞書 40:29" },
  { text: "「耶穌說：讓小孩子到我這裡來，不要禁止他們；因為在天國的，正是這樣的人。」", source: "馬太福音 19:14" },
  { text: "「我留下平安給你們；我將我的平安賜給你們。我所賜的，不像世人所賜的。你們心裡不要憂愁，也不要膽怯。」", source: "約翰福音 14:27" },
  { text: "「你們當剛強壯膽，不要害怕，也不要畏懼他們，因為耶和華你的神和你同去。他必不撇下你，也不丟棄你。」", source: "申命記 31:6" },
  { text: "「追求公義仁慈的，就尋得生命、公義，和尊榮。」", source: "箴言 21:21" },
  { text: "「教養孩童，使他走當行的道，就是到老他也不偏離。」", source: "箴言 22:6" },
  { text: "「因為無論在那裡，有兩三個人奉我的名聚會，那裡就有我在他們中間。」", source: "馬太福音 18:20" },
  { text: "「因為萬有都是本於他，倚靠他，歸於他。願榮耀歸給他，直到永遠。阿們！」", source: "羅馬書 11:36" },
  { text: "「不是你們揀選了我，是我揀選了你們，並且分派你們去結果子，叫你們的果子常存，使你們奉我的名，無論向父求甚麼，他就賜給你們。」", source: "約翰福音 15:16" },
  { text: "「我算甚麼，我的民算甚麼，竟能如此樂意奉獻？因為萬物都從你而來，我們把從你而得的獻給你。」", source: "歷代志上 29:14" },
  { text: "「我的神必照他榮耀的豐富，在基督耶穌裡，使你們一切所需用的都充足。」", source: "腓立比書 4:19" },
  { text: "「好施捨的，必得豐裕；滋潤人的，必得滋潤。」", source: "箴言 11:25" },
  { text: "「遮掩自己罪過的，必不亨通；承認離棄罪過的，必蒙憐恤。」", source: "箴言 28:13" },
  { text: "「因為，耶和華賜人智慧；知識和聰明都由他口而出。」", source: "箴言 2:6" },
  { text: "「聖經都是神所默示的，於教訓、督責、使人歸正、教導人學義都是有益的，叫屬神的人得以完全，預備行各樣的善事。」", source: "提摩太後書 3:16-17" },
  { text: "「耶穌說：我不是對你說過，你若信，就必看見神的榮耀麼？」", source: "約翰福音 11:40" },
  { text: "「我一心尋求了你；求你不要叫我偏離你的命令。」", source: "詩篇 119:10" },
  { text: "「凡事謙虛、溫柔、忍耐，用愛心互相寬容。」", source: "以弗所書 4:2" }
];

const HEAVENLY_FATHER_CARDS = [
  "親愛的孩子：不要怕，只要信！當你覺得疲憊或孤單時，來到我這裡，我必為你重新注滿愛與力量。我以永遠的愛愛你，我絕不撇下你。",
  "親愛的孩子：你不是一個錯誤。你生命中所有的日子，都寫在我的冊上了。我定準了你的年歲和所住的疆界，你受造是極其奇妙可畏的。",
  "親愛的孩子：我是你的供應者，我必供應你所需的一切。我向你所懷的意念，是要叫你末後有指望。放手交託給我，我就為你成就大事。",
  "親愛的孩子：你傷心的時候，我靠近你；如同牧人懷抱羊羔，我將你懷抱在胸前。有一天，我要擦去你一切的眼淚，帶走你所有的苦楚。",
  "親愛的孩子：當你感到信心不足時，請來仰望我。失敗只是我磨練你的過程，生命真正的意義，在於即便在困難中仍能靠我常常喜樂。",
  "親愛的孩子：不要害怕，我與你同在。我用張開、充滿熱情的愛環繞你。當你感到孤單絕望時，來到我面前，我會賜給你不同的眼光看世界。",
  "親愛的孩子：你是照著我的形象所造的，在我的眼中你是極其珍貴的。你的頭髮我都一一數過了，你生活、動作、存留，都在乎我。",
  "親愛的孩子：我並非冷漠而憤怒的，我是完全的愛。我因你歡欣喜樂，我決不停止施恩與你，因為你是我最珍貴的產業。",
  "親愛的孩子：如果你一心一意尋找我，就必尋見；以我為樂，我就把你心裡所求的賜給你。我能為你成就一切，遠超過你所求所想。",
  "親愛的孩子：我是你最佳的鼓勵者，也是在一切患難中安慰你的父親。我要恢復你的力量，恢復你的禱告，因為在我這裡永遠有平安。",
  "親愛的孩子：無論發生什麼，請記得我永遠愛你，你永遠是我的寶貝。當世界讓你失望時，我的雙手永遠為你敞開，等候你回家。",
  "親愛的孩子：在乾旱之年你也不用掛慮，因為你就像栽在水旁的樹。只要你倚靠我，你的葉子仍必青翠，且會源源不斷地結出豐盛的果實。",
  "親愛的孩子：應當一無罣慮，只要凡事藉著禱告和感謝，將你所要的告訴我。我所賜出人意外的平安，必在基督耶穌裡保守你的心懷意念。",
  "親愛的孩子：你所經歷的風浪，我都看見了。我是平息風浪的主，只要對我有信心，安靜在我懷裡，你會看見風浪之後的彩虹與晴天。",
  "親愛的孩子：在人這是不能的，但在我凡事都能。不要用你受限的眼光來看你的未來，因為我為你預備的，是眼睛未曾看見、人心也未曾想到的美妙計劃。",
  "親愛的孩子：我的恩典夠你用的，因為我的能力是在人的軟弱上顯得完全。當你覺得自己最軟弱無助的時候，正是我的大能要彰顯的時候。",
  "親愛的孩子：要常常喜樂，不住地禱告，凡事謝恩。因為當你開始感恩時，喜樂的泉源就會從你心中湧流出來，黑暗與愁雲也必退去。",
  "親愛的孩子：你要保守你心，勝過保守一切，因為一生的果效是由心發出。不要讓世界的喧囂奪走了你的平靜，讓我的話語成為你心中的錨。",
  "親愛的孩子：我留下平安給你，我將我的平安賜給你。我所賜的，不像世人所賜的。所以你心裡不要憂愁，也不要膽怯，昂首前行吧！",
  "親愛的孩子：你要專心仰賴我，不可倚靠自己的聰明。在你一切所行的事上都要認定我，我必指引你的路，帶領你走出迷茫。",
  "親愛的孩子：我以永遠的愛愛你，我向你的意念其數比海沙更多。你是獨一無二的，不需要去迎合世界或與他人比較，因為我就是愛本來的你。",
  "親愛的孩子：疲乏的，我賜能力；軟弱的，我加力量。當你奔跑困倦、行走疲乏時，來到我的施恩座前，我必使你如鷹展翅上騰，重新得力。",
  "親愛的孩子：你是我的手工作品，在基督裡造成的。我為你量身打造了美好的路程，不要害怕跨出腳步，因為我早已在你前面為你開路。",
  "親愛的孩子：不要為明天憂慮，因為明天自有明天的憂慮。一天的難處一天當就夠了。學會活在今天，享受我今天為你預備的陽光與恩典。",
  "親愛的孩子：手扶著犁向後看的人，不配進神的國。忘記背後，努力面前的，向著標竿直跑。你的過去已經被我塗抹，你的未來充滿無限的榮耀。",
  "親愛的孩子：你們要先求我的國和我的義，這些東西都要加給你們了。當你把我放在你生命的首位時，你會發現一切的需要我都早已為你預備妥當。",
  "親愛的孩子：各人要隨本心所酌定的，不要作難，不要勉強，因為捐得樂意的人是我所喜愛的。用慷慨與愛心去祝福他人，你必經歷加倍的豐盛。",
  "親愛的孩子：主就是那靈；我的靈在那裡，那裡就得以自由。脫去那些束縛你的重擔與罪疚感，在我愛的光中，你可以自由自在地呼吸與生活。",
  "親愛的孩子：你從水中經過，我必與你同在；你逿過江河，水必不漫過你。不管環境看起來多麼險惡，我都在你身邊，我是你隨時的幫助。",
  "親愛的孩子：凡你們所做的都要憑愛心而做。愛是恆久忍耐，又有恩慈。當你用愛去對待身邊的人時，你就是在彰顯我的榮耀，我也必因此賜福與你。",
  "親愛的孩子：當你覺得無人了解你的痛苦時，請記得我看見了你的眼淚。我將你的眼淚裝在我的革袋裡，我比任何人都更在乎你的心痛。",
  "親愛的孩子：你不用刻意裝得堅強。在我面前，你可以坦然哭泣，展現你的脆弱。我就是你最好的避難所，我溫柔的手會撫平你的不安。",
  "親愛的孩子：事情的終局強如事情的起頭。雖然現在這段路看起來漫長而痛苦，但我正在為你預備一個榮耀的終局，忍耐到底的必然得救。",
  "親愛的孩子：世界總是以你的表現和成就來定義你的價值，但我只因為你是我的孩子而愛你。你的存在本身就是對我最大的喜悅。",
  "親愛的孩子：你所做最微小的善事，哪怕只是給小子一杯涼水，我都牢記在心。不要灰心喪志，因為到了時候，你必會看見豐收的喜樂。",
  "親愛的孩子：人看外貌，我卻看內心。你的善良、你的掙扎、你對正直的堅持，我都看得清清楚楚。你在暗中行的一切，我都必在明處報答你。",
  "親愛的孩子：不要與別人比較。每個人都有我為他們量身設定的腳步。專注於我帶領你的方向，因為你的腳步也是我所定準的。",
  "親愛的孩子：我從來不打盹，也不睡覺。在黑夜最深的時候，我也依然站在你身旁守護你。安心合眼入睡吧，我正在為你承擔一切重擔。",
  "親愛的孩子：你的過去無法決定你的未來。在我這裡，每天都是新的起點。我的恩典每天早上都是新的，我的誠實極其廣大。",
  "親愛的孩子：不要讓怨恨留在你心裡。原諒那些傷害你的人，不是因為他們配得，而是因為你配得自由。放手交給我，我會親自為你伸冤。",
  "親愛的孩子：我是平息狂風暴雨的神。雖然你現在的環境狂風肆虐，但只要你相信我，對我說：'主啊，我相信你'，風浪就必漸漸平息。",
  "親愛的孩子：我必為你打破銅門，砍斷鐵閂。你生命中所面臨的那些看似無法逾越的障礙，在我面前都將如蠟融化。要剛強壯膽！",
  "親愛的孩子：我向你所懷的意念，不是降災禍的意念，而是賜平安的意念。你要堅定相信，我所允許發生的一切事情，最終都將使你得益處。",
  "親愛的孩子：不要害怕別人的眼光。我是你的盾牌，是你的榮耀，又是叫你抬起頭來的。在我的愛中，你可以抬起頭來，充滿自信地生活。",
  "親愛的孩子：你的身體是聖靈的殿。要好好愛護自己，不要用過度的工作或焦慮來摧殘你的身心。安靜休息，也是一種對我的信靠。",
  "親愛的孩子：我是你隨時的幫助。你不需要等到事情完美了才來找我。現在，就在你最混亂、最不知所措的時刻，直接開口呼求我吧！",
  "親愛的孩子：我是你的盾牌。那射向你的冷言冷語和惡意攻擊，我都為你擋下了。不要害怕，因為保護你的，是萬軍之耶和華。",
  "親愛的孩子：要學會安靜下來。在安靜中，你才能聽見我微小的聲音，領受我給你的智慧與指引。得力在乎平靜安穩，得救在乎歸回安息。",
  "親愛的孩子：不要羨惡人發達。他們的路終必走入荒涼。而你的路，雖然可能窄小，卻是一條引向永恆生命與無限豐盛的生命之路。",
  "親愛的孩子：我必為你敞開天上的府庫，將福氣傾倒在你身上，甚至無處可容。只要你行事為人對得起我，你就必看見我的恩惠滿溢。",
  "親愛的孩子：我是好牧人。我認識我的羊，我的羊也認識我。哪怕你走迷了路，我也必翻山越嶺把你找回來，抱在懷中帶回溫暖的家。",
  "親愛的孩子：不要因為等待而失去信心。我的時間表是最完美的。當我似乎沒有回應時，我其實正在你的生命中做更深、更美好的鋪陳。",
  "親愛的孩子：你手所做的工作，我都必親自堅立。不要覺得你的努力都是徒然。只要你心裡存著誠實為我而做，你的勞苦就必蒙我紀念。",
  "親愛的孩子：我是醫治你的主。不論是身體的疾病，還是心靈的創傷，我都能醫治。將你的痛處交給我，讓我用慈愛的膏油為你抹平傷痛。",
  "親愛的孩子：要用愛心接待客旅。當你用愛去溫暖身邊的人時，你就如同在服事我。我必照著你付出的愛，加倍地回饋與你。",
  "親愛的孩子：不要被過去的失敗所束縛。我的兒子耶穌已經在十字架上為你承擔了一切。抬起頭來，你是自由的，也是被赦免的。",
  "親愛的孩子：我必為你開通達的道路。當前面看似無路時，我必在曠野開道路，在沙漠開江河。要堅信我的大能，我正為你做一件新事。",
  "親愛的孩子：我是阿拉法，我是俄梅戛；我是創始成終的神。既然我開始了在你身上的美好善工，我就必親自帶領你，直到這工圓滿完成。",
  "親愛的孩子：要穿戴我賜給你的全副軍裝，就能抵擋魔鬼的詭計。這軍裝就是真理、公義、平安的福音、信德、救恩與聖靈的寶劍。",
  "親愛的孩子：不要懼怕黑暗，因為我就是光。當你走在死蔭的幽谷時，我的光也必照亮你的腳步，保護你安然度過每一個險境。",
  "親愛的孩子：你的靈魂極其寶貴，甚至連全天下的財寶都無法相比。我是如此珍惜你，甚至願意為你付出生命。要明白你被愛的程度。",
  "親愛的孩子：要用智慧與溫柔來回答眾人。一句溫和的回答能消解怒氣，一腔暴戾的言語只會挑起爭端。讓你的口成為祝福的源頭。",
  "親愛的孩子：在人際關係中受的傷，我都看見了。我是纏裹傷口的神，我必為你預備真心相待的屬靈夥伴，讓你重新經歷愛的溫暖。",
  "親愛的孩子：不要為生命憂慮吃什麼、喝什麼，為身體憂慮穿什麼。你看野地的百合花，野地的草，我都如此妝飾牠們，何況是你們呢？",
  "親愛的孩子：我是看顧你的神。不論你走到哪裡，我的眼目都從不離開你。你出你入，我都必保護你，從現在直到永遠。",
  "親愛的孩子：要常常在我的愛中扎根。只有當你深深明白我是如何愛你時，你才能有充足的勇氣去面對生活中的所有挑戰與風浪。",
  "親愛的孩子：我必賜智慧給你，使你能在複雜的局面中做出正確的抉擇。只要你向我求，我必慷慨賜予，並且不責備你。",
  "親愛的孩子：不要讓世界的價值觀奪走了你的喜樂。追求地上的名利終必虛空，追求我的國度和永恆的福分，必能帶給你持久的平安。",
  "親愛的孩子：我是你的山寨，是你的高臺。當仇敵像洪水般湧來時，來到我的保護傘下，沒有任何武器能傷害躲在我懷裡的你。",
  "親愛的孩子：要存心謙卑，彼此順服。尊榮以前，必有謙卑。當你願意放低自己、服事他人時，我必在最適當的時刻將你升為高。",
  "親愛的孩子：當你覺得無路可走時，向天舉目吧！你的幫助是從造天地的耶和華而來。我必不叫你的腳搖動，保護你的也必不打盹。",
  "親愛的孩子：我必用我的恩惠像盾牌一樣四面護衛你。只要你行在我的心意中，恩惠與慈愛就必一生一世緊緊隨著你，永不離開。",
  "親愛的孩子：要保守口舌，不出惡言。多言多語難免有過，禁止嘴唇是有智慧。讓你的言語充滿恩慈，好像用鹽調和一樣。",
  "親愛的孩子：我是你生命的主宰。你一生的道路都在我的手中。不要害怕未知的明天，因為我早已站在你的明天，為你安排好了一切。",
  "親愛的孩子：當你感到軟弱、提不起勁來禱告時，不要自責。我的聖靈會用說不出來的嘆息替你祈求，我深知你心中的渴望與無奈。",
  "親愛的孩子：要結出聖靈的果子，就是仁愛、喜樂、和平、忍耐、恩慈、良善、信實、溫柔和節制。這是我要在你生命中雕琢的樣貌。",
  "親愛的孩子：不要因環境的艱難而對我的愛產生懷疑。我的愛是永恆不變的，沒有任何事情能叫你與我的愛隔絕。我是你永遠的靠山。",
  "親愛的孩子：我是你性命的保障，你還懼怕誰呢？縱有軍兵安營攻擊你，你的心也不要害怕。要堅信在爭戰之中，我必為你取得勝利。",
  "親愛的孩子：要用喜樂的心去面對每一天。喜樂的心乃是良藥，憂傷的靈使骨枯乾。當你笑看生活時，我的恩典就會成為你的力量。",
  "親愛的孩子：我是賜平安的神，我必親自將平安充滿你的心，使你在這動盪的世界中，依然能擁有平靜的靈魂與安穩的腳步。",
  "親愛的孩子：要行公義，好憐憫，存謙卑的心，與你的神同行。這就是我對你的期望，當你如此行時，你就必得著滿足的喜樂。",
  "親愛的孩子：不要害怕為主名受委屈。在世上你們有苦難，但你們可以放心，耶穌已經勝了世界。你在我裡面所受的苦，必有榮耀的賞賜。",
  "親愛的孩子：我是你的磐石，我的工作是完美的。不論你覺得自己有多少缺點，在我眼中，你都是我精心設計、無可替代的藝術品。",
  "親愛的孩子：要將你的道路交託耶和華，並倚靠他，他就必成全。不要急著用自己的手段去解決問題，安靜等候我的作為吧！",
  "親愛的孩子：我是你的亮光，要照亮你黑暗的角落。不論你心中藏著什麼陰霾，帶到我的光中吧，我必用溫暖的愛將其完全驅散。",
  "親愛的孩子：要以感謝進入我的門，以讚美進入我的院。當你開始讚美時，鎖鏈就會斷開，監牢的大門也必為你震動敞開。",
  "親愛的孩子：不要灰心，我的恩典始終與你同在。你在流淚撒種時所付出的每一份努力，都必在歡呼收割的季節得到百倍的收成。",
  "親愛的孩子：我是你的避難所，是你的力量，是你在患難中隨時的幫助。所以地雖改變，山雖動搖到海心，我們也不要害怕。",
  "親愛的孩子：要常常思念上面的事，不要只思念地上的事。地上的事物都會過去，唯有我給你的應許與永恆的國度會永遠長存。",
  "親愛的孩子：我是萬王之王，萬主之主。這世界上沒有任何權勢能大過我。只要你堅定跟隨我，就沒有任何環境能阻擋我對你的祝福。",
  "親愛的孩子：要凡事謝恩。不論在順境還是逆境中，都尋找值得感謝的地方。感恩的心境會開啟你屬靈的眼睛，看見藏在困難背後的祝福。",
  "親愛的孩子：不要怕，因為我與你同在。我必堅固你，我必幫助你，我必用我公義的右手扶持你。我的右手滿有能力，必領你進入寬闊之地。",
  "親愛的孩子：我是耶和華拉法，是醫治你的神。我聽見了你的禱告，看見了你的眼淚，我必醫治你，使你的生命重新煥發出健康與朝氣。",
  "親愛的孩子：要殷勤不可懶惰。要心裡火熱，常常服事主。在你的崗位上盡忠職守，因為你不是在服事人，而是在服事愛你的天父。",
  "親愛的孩子：我是耶和華以勒，在我的山上必有預備。不要為明天的生計和物質缺乏焦慮，我必照著我榮耀的豐富，充足地供應你一切需要。",
  "親愛的孩子：要保守自己常在我的愛中，仰望我們主耶穌基督的憐憫，直到永生。你是我懷裡的羊羔，沒有人能從我的手中將你奪去。",
  "親愛的孩子：不要為作惡的心懷不平，也不要嫉妒那行不義的。因為他們如草快被割下，又如綠色的青草快要枯乾。你當倚靠我而行善。",
  "親愛的孩子：我是你的引導者。我必在你的前面行，為你修平崎嶇的道路。只要你緊緊跟隨我的腳步，你就必不至迷失方向，得著生命的冠冕。",
  "親愛的孩子：要曉得真理，真理必叫你們得以自由。不要再被謊言和罪疚感所控訴，在我兒子耶穌的寶血裡，你已經獲得了完全的釋放與自由。",
  "親愛的孩子：無論你現在面對什麼，請記住我的慈愛永遠長存。我的慈愛比生命更好，我的嘴唇要頌讚你。去吧，帶著我的愛與祝福，勇敢地活出精彩的每一天！"
];

export function updateDashboardView() {
  try {
    if (typeof calculatePlanProgress === "function") {
      calculatePlanProgress();
    }
  } catch (e) {
    console.warn("[Home] calculatePlanProgress error:", e);
  }
  const greetingEl = document.getElementById("user-greeting");
  if (greetingEl) {
    greetingEl.textContent = state.currentUser.name || "弟兄姊妹";
  }
  const streakEl = document.getElementById("streak-days");
  if (streakEl) {
    streakEl.textContent = state.currentUser.streak || "0";
  }

  renderDailyVerse();
  updateAnnouncementsList();



  const planSummaryDiv = document.getElementById("active-plan-summary");
  if (state.activePlan) {
    const progress = state.activePlan.progress || 0;
    const currentRound = state.activePlan.currentRound || 1;
    const started = isPlanStarted(state.activePlan);
    const countdownText = started
      ? ""
      : formatUpcomingPlanCountdown(state.activePlan.startDate);
    const waitingLabel = countdownText
      ? `等待開始・${countdownText}`
      : "等待開始";
    const isAdmin = state.currentUser && getUserRoleCode(state.currentUser) === 'admin';
    const isPlanAvailable = started || isAdmin;
    let statusText = "";
    if (started) {
      if (currentRound > 1) {
        statusText = `已完成第 ${currentRound - 1} 遍 | 第 ${currentRound} 遍：${progress}% (${state.activePlan.completedChapters} / ${state.activePlan.currentRoundTotalChapters || state.activePlan.totalChapters} 章)`;
      } else {
        statusText = `進度: ${progress}% (${state.activePlan.completedChapters} / ${state.activePlan.currentRoundTotalChapters || state.activePlan.totalChapters} 章)`;
      }
    } else {
      statusText = `<span class="text-brand" style="font-weight: 500;">${waitingLabel}</span> (將於 ${state.activePlan.startDate} 開始)`;
    }

    const streakDays = state.currentUser.streak || 0;
    const totalCompletionRate = progress;

    const now = new Date();
    const todayYear = now.getFullYear();
    const todayMonth = now.getMonth() + 1;
    const todayDay = now.getDate();

    const isFixed = state.activePlan.isFixed !== false && state.activePlan.is_fixed !== false;

    let todayDayObj = null;
    const planDays = Array.isArray(state.activePlan.days) ? state.activePlan.days : [];
    if (isFixed) {
      todayDayObj = planDays.find(d => {
        if (!d || Number(d.year) !== todayYear || Number(d.month) !== todayMonth) return false;
        const parts = String(d.date || "").split('/');
        return parts.length === 2 && Number(parts[1]) === todayDay;
      });
    } else {
      // 彈性時間計畫：指向第一個未完成的讀經天數
      todayDayObj = planDays.find(d => {
        const currentRound = state.activePlan.currentRound || 1;
        return d.chapters && d.chapters.some(ch => {
          const taskRound = ch.round || currentRound;
          let isRead = false;
          if (taskRound === 1) isRead = ch.isReadR1 || ch.isRead;
          else if (taskRound === 2) isRead = ch.isReadR2;
          else if (taskRound >= 3) isRead = ch.isReadR3;
          else isRead = ch.isRead;
          return !isRead;
        });
      });
      if (!todayDayObj && planDays.length > 0) {
        todayDayObj = planDays[planDays.length - 1];
      }
    }

    let todayTotalCount = 0;
    let todayReadCount = 0;
    if (todayDayObj && todayDayObj.chapters) {
      todayTotalCount = todayDayObj.chapters.length;
      todayDayObj.chapters.forEach(ch => {
        const currentRound = state.activePlan.currentRound || 1;
        const taskRound = ch.round || currentRound;
        let isRead = false;
        if (taskRound === 1) isRead = ch.isReadR1 || ch.isRead;
        else if (taskRound === 2) isRead = ch.isReadR2;
        else if (taskRound >= 3) isRead = ch.isReadR3;
        else isRead = ch.isRead;
        if (isRead) todayReadCount++;
      });
    }

    const periodHtml = isFixed
      ? `計畫週期: ${state.activePlan.startDate} ~ ${state.activePlan.endDate} (${state.activePlan.totalDays} 天)`
      : `計畫類型: 彈性時間 (共 ${state.activePlan.totalDays} 天)`;

    const progressLabel = isFixed ? "今日進度" : `第 ${todayDayObj ? todayDayObj.dayNum : 1} 天`;

    let dayNum = 1;
    if (isFixed) {
      if (todayDayObj) {
        dayNum = todayDayObj.dayNum;
      } else {
        const planStart = new Date(state.activePlan.startDate + "T00:00:00");
        const todayZero = new Date();
        todayZero.setHours(0, 0, 0, 0);
        dayNum = Math.max(1, Math.round((todayZero - planStart) / 86400000) + 1);
      }
    } else {
      dayNum = todayDayObj ? todayDayObj.dayNum : 1;
    }

    planSummaryDiv.innerHTML = `
      <div class="plan-progress-header">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;">
          <h4 style="font-size: 1.15rem; font-weight: 500; color: var(--text-primary); margin: 0;">${state.activePlan.name}</h4>
          ${started
        ? `<span class="stat-badge stat-badge--success">第 ${dayNum} 天</span>`
        : `<span class="stat-badge stat-badge--brand">${waitingLabel}</span>`
      }
        </div>
        <p style="font-size: 0.88rem; color: var(--text-secondary); margin-top: 0.2rem;">
          ${periodHtml}
        </p>
        <div class="plan-progress-wrapper plan-progress-wrapper--spaced">
          <div class="plan-progress-bar" style="width: ${progress}%;"></div>
        </div>
        <p style="font-size: 0.88rem; font-weight: 500; color: var(--text-secondary); margin-top: 0.5rem; text-align: right; margin-bottom: 1rem;">
          ${statusText}
        </p>

        <div class="dashboard-stat-strip"
             onclick="event.stopPropagation(); window.showPlanStatsModal ? window.showPlanStatsModal() : null;"
             title="點擊展開詳細統計">
          <div class="dashboard-stat-strip__item">
            <span class="dashboard-stat-strip__value dashboard-stat-strip__value--warning">
              <span class="nlc-icon dashboard-stat-strip__icon" data-icon="fire" aria-hidden="true"></span>${streakDays} 天
            </span>
            <span class="dashboard-stat-strip__label">連續讀經</span>
          </div>
          <div class="dashboard-stat-strip__divider"></div>
          <div class="dashboard-stat-strip__item">
            <span class="dashboard-stat-strip__value dashboard-stat-strip__value--brand">
              <span class="nlc-icon dashboard-stat-strip__icon" data-icon="bookOpen" aria-hidden="true"></span>${todayReadCount}/${todayTotalCount} 章
            </span>
            <span class="dashboard-stat-strip__label">${progressLabel}</span>
          </div>
          <div class="dashboard-stat-strip__divider"></div>
          <div class="dashboard-stat-strip__item">
            <span class="dashboard-stat-strip__value dashboard-stat-strip__value--success">
              <span class="nlc-icon dashboard-stat-strip__icon" data-icon="trendTwo" aria-hidden="true"></span>${totalCompletionRate}%
            </span>
            <span class="dashboard-stat-strip__label">計畫進度</span>
          </div>
        </div>
      </div>
      <div style="display: flex; gap: 1rem; margin-top: 1.2rem;">
        <button class="secondary-btn flex-btn" onclick="event.stopPropagation(); window.openActivePlanFromDashboard()">讀經表</button>
        <button class="primary-btn flex-btn" onclick="event.stopPropagation(); window.startReadingCurrentChapter()" ${isPlanAvailable ? '' : 'disabled style="opacity: 0.6; cursor: not-allowed;"'}>開始閱讀</button>
      </div>
    `;
    planSummaryDiv.classList.add("route-plan-card");
    planSummaryDiv.setAttribute("role", "button");
    planSummaryDiv.setAttribute("tabindex", "0");
    planSummaryDiv.onclick = window.openActivePlanFromDashboard;
    planSummaryDiv.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        window.openActivePlanFromDashboard(event);
      }
    };
  } else {
    planSummaryDiv.classList.remove("route-plan-card");
    planSummaryDiv.removeAttribute("role");
    planSummaryDiv.removeAttribute("tabindex");
    planSummaryDiv.onclick = null;
    planSummaryDiv.onkeydown = null;
    planSummaryDiv.innerHTML = `
      <div class="empty-state" style="text-align: center; padding: 2rem 0;">
        <p style="color: var(--text-secondary); margin-bottom: 1rem;">${(window.APP_COPY && window.APP_COPY.plan.emptyBody) || "還沒加入讀經計畫"}</p>
        <button class="primary-btn" onclick="appRouter.switchTab('plan-view')">${(window.APP_COPY && window.APP_COPY.plan.emptyCta) || "去找計畫"}</button>
      </div>
    `;
  }

  scheduleDashboardSecondaryWork();
}

async function renderPilgrimageTrail(customMembers = null, customPlan = null) {
  const canvas = document.getElementById("team-pilgrimage-canvas") || document.getElementById("pilgrimage-canvas");
  if (!canvas) return;

  const targetPlan = customPlan || state.activePlan || (Array.isArray(state.activePlans) ? state.activePlans[0] : null) || (Array.isArray(state.globalPlans) ? state.globalPlans[0] : null);
  let planDays = (targetPlan && Array.isArray(targetPlan.days) && targetPlan.days.length > 0) ? targetPlan.days : [];
  if (planDays.length === 0 && typeof window.createChurchCampaignStageDefinitions === "function" && typeof window.cloneChurchCampaign === "function") {
    try {
      const defaultCampaign = window.cloneChurchCampaign();
      const stages = window.createChurchCampaignStageDefinitions(defaultCampaign);
      if (stages && stages[0] && Array.isArray(stages[0].days)) {
        planDays = stages[0].days;
      }
    } catch (e) {
      console.warn("Fallback stage generation error:", e);
    }
  }

  if (planDays.length === 0) {
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const ctx = canvas.getContext("2d");
  const currentRound = (targetPlan && targetPlan.currentRound) || 1;

  const planChapters = [];
  let lastBook = null;
  planDays.forEach(day => {
    if (!day || !day.chapters) return;
    day.chapters.forEach(ch => {
      const isBookStart = ch.book !== lastBook;
      planChapters.push({
        bookName: ch.book,
        chapterNum: ch.chapter,
        isReadR1: ch.isReadR1 || false,
        isReadR2: ch.isReadR2 || false,
        isReadR3: ch.isReadR3 || false,
        isRead: ch.isRead || false,
        isBookStart
      });
      lastBook = ch.book;
    });
  });

  const TOTAL_PLAN_CHAPTERS = planChapters.length;
  if (TOTAL_PLAN_CHAPTERS === 0) return;

  const myR1Count = planChapters.filter(c => c.isReadR1).length;
  const myR2Count = planChapters.filter(c => c.isReadR2).length;
  const myR3Count = planChapters.filter(c => c.isReadR3).length;
  const myChaptersRead = currentRound === 3 ? myR3Count : (currentRound === 2 ? myR2Count : myR1Count);

  let groupMembers = [];
  if (Array.isArray(customMembers) && customMembers.length > 0) {
    groupMembers = customMembers.map(m => {
      const name = m.name || m.displayName || (m.profile && m.profile.name) || "隊友";
      const chapters_read = Number(m.chapters_read ?? m.completedChapters ?? m.readChapters ?? m.completed_chapters ?? m.completed ?? 0);
      return {
        name,
        chapters_read,
        isMe: Boolean(m.isMe || name === state.currentUser?.name)
      };
    });
  } else {
    let allUsers = await db.fetchMergedUsersList();
    const myZone = state.currentUser.pastoral_zone || "";
    groupMembers = myZone ? allUsers.filter(u => u.pastoral_zone === myZone) : [];
    if (!groupMembers || groupMembers.length === 0) {
      groupMembers = [{ name: state.currentUser.name, chapters_read: myChaptersRead }];
    }

    groupMembers = groupMembers.map(m =>
      m.name === state.currentUser?.name ? { ...m, chapters_read: myChaptersRead } : m
    );
    if (!groupMembers.some(m => m.name === state.currentUser?.name)) {
      groupMembers = [{ name: state.currentUser?.name || "我", chapters_read: myChaptersRead }, ...groupMembers];
    }
  }

  const maxChaptersRead = groupMembers.reduce((max, m) => Math.max(max, m.chapters_read || 0), 0);
  const maxDrawIndex = Math.min(Math.max(16, maxChaptersRead - 1 + 16), TOTAL_PLAN_CHAPTERS - 1);

  const brand = (window.NLC_DESIGN && window.NLC_DESIGN.brand) || "#04A9D2";
  const brandActive = (window.NLC_DESIGN && window.NLC_DESIGN.brandActive) || "#0396BA";
  const brandHover = (window.NLC_DESIGN && window.NLC_DESIGN.brandHover) || "#5BB8D4";
  const success = (window.NLC_DESIGN && window.NLC_DESIGN.success) || "var(--status-success, #04A9D2)";
  const successFg = (window.NLC_DESIGN && window.NLC_DESIGN.successForeground) || "#047857";
  const palette = {
    1: { myPath: brand, grpPath: "#8ED4EA", myFill: "rgba(4,169,210,0.15)", grpFill: "rgba(4,169,210,0.08)", myStroke: brand, grpStroke: brandHover, myText: brandActive, grpText: brandHover },
    2: { myPath: success, grpPath: "#A8F5C0", myFill: "rgba(102,247,143,0.15)", grpFill: "rgba(102,247,143,0.08)", myStroke: success, grpStroke: success, myText: successFg, grpText: successFg },
    3: { myPath: "#f59e0b", grpPath: "#fcd34d", myFill: "#fef3c7", grpFill: "#fffbeb", myStroke: "#d97706", grpStroke: "#ca8a04", myText: "#92400e", grpText: "#b45309" },
  };
  const pal = palette[Math.min(currentRound, 3)];

  const cols = 8;
  const spacingX = 72;
  const spacingY = 72;
  const rowsCount = Math.ceil((maxDrawIndex + 1) / cols);
  canvas.width = cols * spacingX + 15;
  canvas.height = rowsCount * spacingY + 15;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  function getTileCoords(index) {
    const row = Math.floor(index / cols);
    let col = index % cols;
    if (row % 2 === 1) col = cols - 1 - col;
    return { x: col * spacingX + 36, y: row * spacingY + 36 };
  }

  function drawPathLine(startIndex, endIndex, color, width = 7) {
    if (endIndex < startIndex) return;
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const s = getTileCoords(startIndex);
    ctx.moveTo(s.x, s.y);
    for (let i = startIndex + 1; i <= endIndex; i++) {
      const p = getTileCoords(i);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  drawPathLine(0, maxDrawIndex, "rgba(226, 232, 240, 0.8)", 7);
  if (currentRound >= 2 && myR1Count > 1) {
    drawPathLine(0, Math.min(myR1Count - 1, maxDrawIndex), "rgba(4, 169, 210, 0.2)", 5);
  }
  if (maxChaptersRead > 1) {
    drawPathLine(0, Math.min(maxChaptersRead - 1, maxDrawIndex), pal.grpPath, 6);
  }
  if (myChaptersRead > 1) {
    drawPathLine(0, Math.min(myChaptersRead - 1, maxDrawIndex), pal.myPath, 8);
  }

  for (let i = 0; i <= maxDrawIndex; i++) {
    const pos = getTileCoords(i);
    const ch = planChapters[i];
    if (!ch) continue;

    const isBookStart = ch.isBookStart;
    const r = isBookStart ? 22 : 13;

    let fillStyle = "#ffffff";
    let strokeStyle = "var(--border-card)";
    let textColor = "var(--text-secondary, #475569)";
    let isBold = false;
    let strokeW = isBookStart ? 2.5 : 1.5;

    const isMineRead = i < myChaptersRead;
    const isGrpRead = !isMineRead && i < maxChaptersRead;

    if (isMineRead) {
      fillStyle = pal.myFill;
      strokeStyle = pal.myStroke;
      textColor = pal.myText;
      isBold = true;
      strokeW = isBookStart ? 3.5 : 2.5;
    } else if (isGrpRead) {
      fillStyle = pal.grpFill;
      strokeStyle = pal.grpStroke;
      textColor = pal.grpText;
      strokeW = isBookStart ? 2.5 : 1.5;
    }

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fillStyle = fillStyle;
    ctx.fill();
    ctx.lineWidth = strokeW;
    ctx.strokeStyle = strokeStyle;
    ctx.stroke();

    ctx.fillStyle = textColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (isBookStart) {
      ctx.font = `bold 10px sans-serif`;
      ctx.fillText(ch.bookName.substring(0, 2), pos.x, pos.y);
    } else {
      ctx.font = isBold ? "bold 8px sans-serif" : "7px sans-serif";
      ctx.fillText(ch.chapterNum, pos.x, pos.y);
    }
  }

  const membersByPos = {};
  groupMembers.forEach(m => {
    const posIndex = Math.max(0, (m.chapters_read || 0) - 1);
    if (!membersByPos[posIndex]) membersByPos[posIndex] = [];
    membersByPos[posIndex].push(m);
  });

  Object.entries(membersByPos).forEach(([posStr, list]) => {
    const posIndex = parseInt(posStr, 10);
    if (posIndex > maxDrawIndex) return;
    const tilePos = getTileCoords(posIndex);
    const count = list.length;
    list.forEach((m, idx) => {
      const angle = count > 1 ? (idx * 2 * Math.PI) / count : 0;
      const offset = count > 1 ? 15 : 0;
      const x = tilePos.x + Math.cos(angle) * offset;
      const y = tilePos.y + Math.sin(angle) * offset;

      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.fillStyle = getMemberColor(m.name);
      ctx.fill();
      ctx.lineWidth = m.isMe ? 2 : 1;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 8px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(m.name || "").substring(0, 2), x, y);
    });
  });

  const legendEl = document.getElementById("team-pilgrimage-legend") || document.getElementById("pilgrimage-legend");
  if (legendEl) {
    legendEl.innerHTML = `
      <span class="px-2 py-0.5 rounded-full bg-slate-100/80 dark:bg-zinc-900/50 flex items-center gap-1" style="display:inline-flex;align-items:center;white-space:nowrap;"><span style="display:inline-block;width:6px;height:6px;background:${pal.myStroke};border-radius:50%;"></span>隊友軌跡</span>`;
  }
}

async function calculateAndRenderPersonalRankings() {
  const rankGroupEl = document.getElementById("rank-group");
  const rankZoneEl = document.getElementById("rank-zone");
  const rankRegionEl = document.getElementById("rank-region");
  const rankChurchEl = document.getElementById("rank-church");

  if (!rankGroupEl || !rankZoneEl || !rankRegionEl || !rankChurchEl) return;

  const hasPlan = state.activePlans && state.activePlans.length > 0;
  if (!hasPlan) {
    rankGroupEl.textContent = "未加入計畫";
    rankZoneEl.textContent = "未加入計畫";
    rankRegionEl.textContent = "未加入計畫";
    rankChurchEl.textContent = "未加入計畫";
    return;
  }

  try {
    const rankSkeleton = typeof ComponentSkeletonLoader !== "undefined"
      ? ComponentSkeletonLoader.getHtml("inline", { width: "5.5rem", height: "1.4rem" })
      : "—";
    rankGroupEl.innerHTML = rankSkeleton;
    rankZoneEl.innerHTML = rankSkeleton;
    rankRegionEl.innerHTML = rankSkeleton;
    rankChurchEl.innerHTML = rankSkeleton;

    const rankings = await db.getUserRankings();
    if (rankings) {
      rankGroupEl.textContent = rankings.groupRank > 0 ? `第 ${rankings.groupRank} 名 / 共 ${rankings.groupTotal} 人` : "尚無資料";
      rankZoneEl.textContent = rankings.zoneRank > 0 ? `第 ${rankings.zoneRank} 名 / 共 ${rankings.zoneTotal} 人` : "尚無資料";
      rankRegionEl.textContent = rankings.regionRank > 0 ? `第 ${rankings.regionRank} 名 / 共 ${rankings.regionTotal} 人` : "尚無資料";
      rankChurchEl.textContent = rankings.churchRank > 0 ? `第 ${rankings.churchRank} 名 / 共 ${rankings.churchTotal} 人` : "尚無資料";
    } else {
      rankGroupEl.textContent = "無資料";
      rankZoneEl.textContent = "無資料";
      rankRegionEl.textContent = "無資料";
      rankChurchEl.textContent = "無資料";
    }
  } catch (err) {
    console.error("Error rendering personal rankings:", err);
    rankGroupEl.textContent = "載入失敗";
    rankZoneEl.textContent = "載入失敗";
    rankRegionEl.textContent = "載入失敗";
    rankChurchEl.textContent = "載入失敗";
  }
}

function getAnnouncementCategory(rawTitle = "", isFirstItem = false) {
  const title = String(rawTitle || "").trim();

  if (/【重要】|\[重要\]|【緊急】|\[緊急\]/i.test(title)) {
    return {
      categoryName: "重要急件",
      badgeClass: "announcement-badge--danger",
      iconName: "flame",
      cleanTitle: title.replace(/【重要】|\[重要\]|【緊急】|\[緊急\]/gi, "").trim(),
      isFeatured: true,
    };
  }
  if (/【主日】|\[主日\]|【聚會】|\[聚會\]|【崇拜】|\[崇拜\]/i.test(title)) {
    return {
      categoryName: "主日消息",
      badgeClass: "announcement-badge--info",
      iconName: "church",
      cleanTitle: title.replace(/【主日】|\[主日\]|【聚會】|\[聚會\]|【崇拜】|\[崇拜\]/gi, "").trim(),
      isFeatured: isFirstItem,
    };
  }
  if (/【活動】|\[活動\]|【報名】|\[報名\]|【特會】|\[特會\]/i.test(title)) {
    return {
      categoryName: "活動報名",
      badgeClass: "announcement-badge--success",
      iconName: "party-popper",
      cleanTitle: title.replace(/【活動】|\[活動\]|【報名】|\[報名\]|【特會】|\[特會\]/gi, "").trim(),
      isFeatured: isFirstItem,
    };
  }
  if (/【提醒】|\[提醒\]|【通知】|\[通知\]|【注意事項】/i.test(title)) {
    return {
      categoryName: "溫馨提醒",
      badgeClass: "announcement-badge--warning",
      iconName: "bell",
      cleanTitle: title.replace(/【提醒】|\[提醒\]|【通知】|\[通知\]|【注意事項】/gi, "").trim(),
      isFeatured: isFirstItem,
    };
  }

  return {
    categoryName: isFirstItem ? "最新公告" : "教會消息",
    badgeClass: "announcement-badge--default",
    iconName: isFirstItem ? "sparkles" : "megaphone",
    cleanTitle: title,
    isFeatured: isFirstItem,
  };
}

function formatRelativeAnnouncementTime(dateString) {
  if (!dateString) return "";
  if (typeof formatTaiwanDateTime === "function") {
    return formatTaiwanDateTime(dateString, { relative: true });
  }
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit' });
}

async function renderChurchAnnouncements() {
  const container = document.getElementById("church-announcements-list");
  if (!container) return;

  const isAdmin = state.currentUser && getUserRoleCode(state.currentUser) === "admin";
  const announcements = await db.fetchAnnouncements();

  if (announcements.length === 0) {
    container.className = "announcements-list";
    container.innerHTML = `
      <div class="announcements-empty">
        <span class="announcements-empty__icon nlc-icon nlc-icon--md" data-icon="inbox" aria-hidden="true"></span>
        <p class="announcements-empty__text">目前尚無教會公告。</p>
      </div>`;
    if (typeof hydrateIcons === "function") hydrateIcons(container);
    return;
  }

  container.className = "announcements-list";
  container.innerHTML = "";

  announcements.forEach((ann, index) => {
    const item = document.createElement("div");
    const categoryInfo = getAnnouncementCategory(ann.title, index === 0);

    item.className = `announcement-item${categoryInfo.isFeatured ? " announcement-item--featured" : ""}`;

    const formattedTime = formatRelativeAnnouncementTime(ann.created_at);
    const displayTitle = categoryInfo.cleanTitle || ann.title;

    item.innerHTML = `
      <div class="announcement-item__header">
        <div class="announcement-item__header-left">
          <div class="announcement-item__icon-avatar" aria-hidden="true">
            <span class="nlc-icon nlc-icon--sm" data-icon="${categoryInfo.iconName}"></span>
          </div>
          <div class="announcement-item__title-group">
            <div class="announcement-item__tags">
              <span class="announcement-badge ${categoryInfo.badgeClass}">
                <span class="nlc-icon nlc-icon--sm" data-icon="${categoryInfo.iconName}" aria-hidden="true"></span>
                <span>${categoryInfo.categoryName}</span>
              </span>
            </div>
            <h4 class="announcement-item__title">${escapeHTML(displayTitle)}</h4>
          </div>
        </div>
        <div class="announcement-item__meta">
          <time class="announcement-item__time" datetime="${escapeHTML(ann.created_at || "")}">${formattedTime}</time>
          ${isAdmin ? `<button type="button" class="circular-action-btn btn-danger-soft announcement-item__delete" onclick="window.deleteAnnouncement('${ann.id}')" title="刪除公告" aria-label="刪除公告"><span class="nlc-icon nlc-icon--sm" data-icon="trash" aria-hidden="true"></span></button>` : ''}
        </div>
      </div>
      <p class="announcement-item__body">${escapeHTML(ann.content)}</p>
    `;
    container.appendChild(item);
  });

  if (typeof hydrateIcons === "function") hydrateIcons(container);
}

async function renderPastoralZoneRankingList() {
  const rankingContainer = document.getElementById("dashboard-pastoral-ranking");
  if (!rankingContainer) return;

  const hasPlan = state.activePlans && state.activePlans.length > 0;
  if (!hasPlan) {
    rankingContainer.innerHTML = `<div class="empty-state">請先加入計畫以查看排名</div>`;
    return;
  }

  rankingContainer.innerHTML = typeof ComponentSkeletonLoader !== "undefined"
    ? ComponentSkeletonLoader.getHtml("ranking", { count: 5 })
    : "";

  let pastoralStats = [];
  if (state.isSupabaseMode && state.supabase) {
    try {
      const { data } = await state.supabase.from("view_pastoral_zone_stats").select("pastoral_zone, total_chapters_read");
      if (data) {
        pastoralStats = data.map(item => ({
          name: item.pastoral_zone,
          total_chapters: item.total_chapters_read
        })).sort((a, b) => b.total_chapters - a.total_chapters);
      }
    } catch (e) {
      console.error("Failed to load pastoral zone stats:", e);
    }
  } else {
    const mockUser = {
      name: state.currentUser.name,
      great_region: state.currentUser.great_region || "",
      pastoral_zone: state.currentUser.pastoral_zone || "",
      small_group: state.currentUser.small_group || "",
      role_code: getUserRoleCode(state.currentUser) || "member",
      chapters_read: state.currentUser.chapters_read,
      plan_progress: state.currentUser.plan_progress,
      last_read: state.currentUser.last_read
    };
    pastoralStats = MockStatsService.getPastoralZoneStats(mockUser);
  }

  rankingContainer.innerHTML = "";
  if (pastoralStats.length === 0) {
    rankingContainer.innerHTML = `<div class="empty-state">尚無速讀數據</div>`;
    return;
  }

  pastoralStats.slice(0, 5).forEach((item, index) => {
    const rankClass = `rank-${index + 1}`;
    const rankItem = document.createElement("div");
    rankItem.className = "ranking-item";
    rankItem.innerHTML = `
      <div class="rank-number ${rankClass}">${index + 1}</div>
      <div class="rank-details">
        <div class="rank-name">${escapeHTML(item.name || item.pastoral_zone)}</div>
      </div>
      <div class="rank-value">${item.total_chapters || 0} 章</div>
    `;
    rankingContainer.appendChild(rankItem);
  });
}

async function loadTodayDevotional() {
  const textarea = document.getElementById("devotional-content");
  const countEl = document.getElementById("devotional-word-count");
  if (!textarea) return;

  textarea.value = "";
  if (countEl) countEl.textContent = "字數: 0 字";
  state.currentEditingNoteId = null;
}

let isSavingDevotional = false;

function initDevotionalControls() {
  const textarea = document.getElementById("devotional-content");
  const saveBtn = document.getElementById("btn-save-devotional");
  const countEl = document.getElementById("devotional-word-count");

  if (!textarea) return;

  textarea.addEventListener("input", () => {
    const text = textarea.value;
    if (countEl) countEl.textContent = `字數: ${text.length} 字`;
  });

  if (saveBtn) {
    saveBtn.addEventListener("click", (e) => {
      e.preventDefault();
      publishDevotionalNote();
    });
  }

  const toggleBtn = document.getElementById("btn-toggle-devotional-box");
  const devCard = document.querySelector(".devotional-card");
  if (toggleBtn && devCard) {
    toggleBtn.addEventListener("click", () => {
      devCard.classList.toggle("hidden");
      if (!devCard.classList.contains("hidden")) {
        // 💡 關鍵修復：點擊分享心得時清空輸入框，且不自動寫入資料庫
        textarea.value = "";
        if (countEl) countEl.textContent = "字數: 0 字";
        textarea.focus();
      }
    });
  }

  const searchInput = document.getElementById("member-today-search");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      renderProgressListFiltered(e.target.value);
    });
  }

  // 歷史靈修分享切換與篩選監聽器
  const tabToday = document.getElementById("btn-wall-tab-today");
  const tabHistory = document.getElementById("btn-wall-tab-history");
  const historyFilter = document.getElementById("wall-history-filter");

  if (tabToday && tabHistory) {
    const switchTab = (activeTab, inactiveTab, targetState) => {
      try {
        sharingController.tab = targetState;
      } catch (err) {
        console.error(err);
        return;
      }

      activeTab.classList.add("active");
      activeTab.style.background = "var(--bg-card)";
      activeTab.style.color = "var(--color-brand)";
      activeTab.style.boxShadow = "var(--shadow-sm)";
      activeTab.style.fontWeight = "600";

      inactiveTab.classList.remove("active");
      inactiveTab.style.background = "transparent";
      inactiveTab.style.color = "var(--text-secondary)";
      inactiveTab.style.boxShadow = "none";
      inactiveTab.style.fontWeight = "500";

      fetchPastoralVerseWall();
    };

    tabToday.addEventListener("click", () => switchTab(tabToday, tabHistory, "today"));
    tabHistory.addEventListener("click", () => switchTab(tabHistory, tabToday, "history"));
  }

  if (historyFilter) {
    historyFilter.addEventListener("change", () => {
      try {
        sharingController.filter = historyFilter.value;
      } catch (err) {
        console.error(err);
        return;
      }
      fetchPastoralVerseWall();
    });
  }
}

async function publishDevotionalNote() {
  const textarea = document.getElementById("devotional-content");
  const saveBtn = document.getElementById("btn-save-devotional");
  const countEl = document.getElementById("devotional-word-count");
  if (!textarea) return;

  let content;
  try {
    content = sharingController.validateContent(textarea.value);
  } catch (err) {
    alert(err.message);
    return;
  }


  if (isSavingDevotional) return;

  const todayStr = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');

  isSavingDevotional = true;
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.style.opacity = "0.6";
    const spanText = saveBtn.querySelector("span:not(.nlc-icon)");
    if (spanText) spanText.textContent = "發佈中...";
  }

  try {
    // 💡 關鍵修復：只在點擊「發佈」按鈕時才呼叫資料庫 API 新增一則心得（傳入 null 代表新增而非 update），
    // 徹底解決輸入中失去焦點或自動存檔導致在分享牆上跑出未寫完的草稿與產生重複留言的問題。
    await db.saveDevotionalNote(todayStr, content, null);

    // 發佈成功後清空欄位、關閉心得框並重整分享牆
    textarea.value = "";
    if (countEl) countEl.textContent = "字數: 0 字";

    const devCard = document.querySelector(".devotional-card");
    if (devCard) {
      devCard.classList.add("hidden");
    }

    if (typeof renderTodayGroupProgress === "function") {
      renderTodayGroupProgress();
    }
    if (typeof fetchPastoralVerseWall === "function") {
      await fetchPastoralVerseWall();
    }
  } catch (err) {
    console.error("Failed to publish devotional note:", err);
    alert("發佈失敗，請稍後再試！");
  } finally {
    isSavingDevotional = false;
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.style.opacity = "";
      const spanText = saveBtn.querySelector("span:not(.nlc-icon)");
      if (spanText) spanText.textContent = "發佈";
    }
  }
}

window.checkAndPromptTodayCompletion = async function () {
  // 保持靜默打卡已讀，不跳出干擾視覺的恭喜字幕與對話框
  return;
  if (!state.activePlan) return;

  const now = new Date();
  const todayYear = now.getFullYear();
  const todayMonth = now.getMonth() + 1;
  const todayDay = now.getDate();
  const todayDayObj = state.activePlan.days.find(d => {
    if (Number(d.year) !== todayYear || Number(d.month) !== todayMonth) return false;
    const parts = d.date.split('/');
    return parts.length === 2 && Number(parts[1]) === todayDay;
  });

  if (!todayDayObj || !todayDayObj.chapters || todayDayObj.chapters.length === 0) return;

  const currentRound = state.activePlan.currentRound || 1;
  const isTodayComplete = todayDayObj.chapters.every(ch => {
    const r = ch.round || currentRound;
    if (r === 1) return Boolean(ch.isReadR1 || ch.isRead);
    if (r === 2) return Boolean(ch.isReadR2);
    if (r >= 3) return Boolean(ch.isReadR3);
    return Boolean(ch.isRead);
  });

  if (!isTodayComplete) return;

  const todayStr = todayYear + '-' + String(todayMonth).padStart(2, '0') + '-' + String(todayDay).padStart(2, '0');
  const existingNote = await db.getDevotionalNote(todayStr);
  if (existingNote && existingNote.trim().length > 0) return;

  setTimeout(() => {
    if (typeof showToast === "function") {
      showToast("🎉 恭喜完成今日速讀！寫下今天最深刻的金句，分享給小組吧！", 5000);
    }
    const devContent = document.getElementById("devotional-content");
    if (devContent) {
      devContent.scrollIntoView({ behavior: 'smooth', block: 'center' });
      devContent.focus();
      const devCard = devContent.closest(".devotional-card");
      if (devCard) {
        devCard.style.outline = "2.5px solid var(--color-brand)";
        devCard.style.boxShadow = "var(--shadow-focus-ring)";
        setTimeout(() => {
          devCard.style.outline = "";
          devCard.style.boxShadow = "";
        }, 4000);
      }
    } else {
      (async () => {
        const confirmed = await window.showConfirmDialog({
          title: "🎉 恭喜完成今日速讀！",
          message: "是否前往「首頁」記錄你最印象深刻的今日金句並分享給小組？",
          confirmText: "前往分享",
          cancelText: "留在讀經"
        });
        if (confirmed) {
          appRouter.switchTab("dashboard-view");
          setTimeout(() => {
            const dc = document.getElementById("devotional-content");
            if (dc) {
              dc.scrollIntoView({ behavior: 'smooth', block: 'center' });
              dc.focus();
              const dcCard = dc.closest(".devotional-card");
              if (dcCard) {
                dcCard.style.outline = "2.5px solid var(--color-brand)";
                dcCard.style.boxShadow = "var(--shadow-focus-ring)";
                setTimeout(() => {
                  dcCard.style.outline = "";
                  dcCard.style.boxShadow = "";
                }, 4000);
              }
            }
          }, 300);
        }
      })();
    }
  }, 1000);
};

function showSaveSuccess(isAuto) {
  const statusEl = document.getElementById("devotional-save-status");
  if (!statusEl) return;

  const savedMarkup = (label) =>
    `<span class="devotional-save-status__dot" aria-hidden="true"></span>${label}`;

  statusEl.innerHTML = savedMarkup(isAuto ? "已自動儲存" : "儲存成功");
  statusEl.classList.add("text-success-fg");
  statusEl.classList.remove("text-danger");
  statusEl.style.opacity = "1";

  setTimeout(() => {
    statusEl.style.opacity = "0";
  }, 2000);
}

// Group Progress Handlers
async function renderTodayGroupProgress() {
  const listEl = document.getElementById("member-today-list");
  if (!listEl) return;

  const hasPlan = state.activePlans && state.activePlans.length > 0;
  if (!hasPlan) {
    listEl.innerHTML = `<div style="font-size: 0.88rem; color: var(--text-muted); text-align: center; padding: 2rem 0;">${(window.APP_COPY && window.APP_COPY.plan.joinProgressHint) || "請先至「計畫」加入計畫，以查看今日進度"}</div>`;
    return;
  }

  listEl.innerHTML = typeof ComponentSkeletonLoader !== "undefined"
    ? ComponentSkeletonLoader.getHtml("member-progress", { count: 4 })
    : "";

  const cardEl = listEl.closest('.glass-card');
  if (cardEl) {
    const cardTitleEl = cardEl.querySelector('.card-title');
    const searchBoxEl = cardEl.querySelector('.search-box-wrapper');

    if (state.currentUser && getUserRoleCode(state.currentUser) === 'member') {
      if (cardTitleEl) {
        cardTitleEl.innerHTML = `
          <span style="color: var(--primary-color);">${typeof renderIcon === "function" ? renderIcon("user", { size: "sm", className: "nlc-icon" }) : ""}</span>
          我的今日讀經進度
        `;
      }
      if (searchBoxEl) {
        searchBoxEl.style.display = 'none';
      }
    } else {
      if (cardTitleEl) {
        cardTitleEl.innerHTML = `
          <span style="color: var(--primary-color);">${typeof renderIcon === "function" ? renderIcon("people", { size: "sm", className: "nlc-icon" }) : ""}</span>
          小組今日讀經進度
        `;
      }
      if (searchBoxEl) {
        searchBoxEl.style.display = 'block';
      }
    }
  }

  let allUsers = await db.fetchMergedUsersList();

  const mockUser = {
    name: state.currentUser.name,
    great_region: state.currentUser.great_region || "",
    pastoral_zone: state.currentUser.pastoral_zone || "",
    small_group: state.currentUser.small_group || "",
    role_code: getUserRoleCode(state.currentUser) || "member"
  };

  let groupMembers = allUsers.filter(u =>
    u.pastoral_zone === mockUser.pastoral_zone &&
    u.small_group === mockUser.small_group
  );

  if (groupMembers.length === 0) {
    groupMembers = allUsers.slice(0, 10);
  }

  state.todayGroupMembers = groupMembers;
  renderProgressListFiltered("");
}

function renderProgressListFiltered(searchText) {
  const listEl = document.getElementById("member-today-list");
  if (!listEl || !state.todayGroupMembers) return;

  listEl.innerHTML = "";
  const todayStr = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
  const query = searchText.trim().toLowerCase();
  const filtered = state.todayGroupMembers.filter(m =>
    m.name.toLowerCase().includes(query)
  );

  if (filtered.length === 0) {
    listEl.innerHTML = '<div style="font-size: 0.875rem; color: var(--text-muted); text-align: center; padding: 1rem;">無相符成員</div>';
    return;
  }

  filtered.forEach(m => {
    const isRecentRead = m.last_read && (
      m.last_read === todayStr ||
      m.last_read === "2026-06-26" ||
      m.last_read === "2026-06-25"
    );

    const item = document.createElement("div");
    item.className = "member-progress-item";

    const nameInfo = document.createElement("div");
    nameInfo.className = "member-name-info";

    const nameSpan = document.createElement("span");
    nameSpan.className = "member-name";
    nameSpan.textContent = m.name;
    nameInfo.appendChild(nameSpan);

    const metaSpan = document.createElement("span");
    metaSpan.className = "member-meta";
    metaSpan.textContent = `連續讀經: ${m.streak || 0}天 | 總章數: ${m.chapters_read || 0}章`;
    nameInfo.appendChild(metaSpan);

    if (m.today_devotional) {
      const quoteDiv = document.createElement("div");
      quoteDiv.className = "member-quote";
      quoteDiv.style.cssText = "margin-top: 0.4rem; padding: 0.5rem 0.75rem; border-left: 3px solid var(--color-brand); background: var(--color-brand-muted); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; font-size: 0.875rem; color: var(--text-secondary); line-height: 1.5; font-style: italic;";
      quoteDiv.textContent = `「${m.today_devotional}」`;
      nameInfo.appendChild(quoteDiv);
    }

    item.appendChild(nameInfo);

    const badge = document.createElement("span");
    if (isRecentRead) {
      badge.className = "progress-badge completed";
      badge.innerHTML = `
        ${typeof renderIcon === "function" ? renderIcon("check", { size: "sm", className: "nlc-icon nlc-icon--inline" }) : ""}
        今日已讀
      `;
    } else {
      badge.className = "progress-badge pending";
      badge.textContent = "未打卡";
    }
    item.appendChild(badge);

    listEl.appendChild(item);
  });
}

state.pilgrimageZoom = 1.0;
state.pilgrimageControlsInit = false;

function getTileCoords(index) {
  const cols = 8;
  const spacingX = 72;
  const spacingY = 72;
  const startX = 40;
  const startY = 40;

  const row = Math.floor(index / cols);
  const col = index % cols;
  const isReversed = row % 2 === 1;
  const actualCol = isReversed ? (cols - 1 - col) : col;

  return {
    x: startX + actualCol * spacingX,
    y: startY + row * spacingY
  };
}

function getMemberColor(name) {
  if (name === state.currentUser.name) return (window.NLC_DESIGN && NLC_DESIGN.brand) || "#04A9D2";
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = window.NLC_MEMBER_COLORS || (window.NLC_DESIGN
    ? [window.NLC_DESIGN.brand, window.NLC_DESIGN.brandHover, window.NLC_DESIGN.success, window.NLC_DESIGN.warning, "#5BB8D4", window.NLC_DESIGN.brandActive, "#8ED4EA", window.NLC_DESIGN.danger]
    : ["#04A9D2", "#0396BA", "#FE7615", "#FC365A"]);
  const index = Math.abs(hash) % colors.length;
  return colors[index];
}

window.renderPilgrimageTrail = renderPilgrimageTrail;

function initPilgrimageControls() {
  const board = document.getElementById("pilgrimage-trail-board");
  const zoomIn = document.getElementById("increase-trail-zoom");
  const zoomOut = document.getElementById("decrease-trail-zoom");
  const zoomReset = document.getElementById("reset-trail-zoom");

  if (!board) return;

  const updateZoom = () => {
    board.style.transform = `scale(${state.pilgrimageZoom})`;
  };

  if (zoomIn) {
    zoomIn.onclick = () => {
      if (state.pilgrimageZoom < 2.0) {
        state.pilgrimageZoom += 0.15;
        updateZoom();
      }
    };
  }

  if (zoomOut) {
    zoomOut.onclick = () => {
      if (state.pilgrimageZoom > 0.6) {
        state.pilgrimageZoom -= 0.15;
        updateZoom();
      }
    };
  }

  if (zoomReset) {
    zoomReset.onclick = () => {
      state.pilgrimageZoom = 1.0;
      updateZoom();
    };
  }
}

window.openAnnouncementForm = function () {
  const form = document.getElementById("admin-announcement-form-container");
  if (form) form.classList.remove("hidden");
};

window.closeAnnouncementForm = function () {
  const form = document.getElementById("admin-announcement-form-container");
  if (form) form.classList.add("hidden");

  const titleInput = document.getElementById("announcement-title-input");
  const contentInput = document.getElementById("announcement-content-input");
  if (titleInput) titleInput.value = "";
  if (contentInput) contentInput.value = "";
};

window.saveAnnouncement = async function () {
  const titleInput = document.getElementById("announcement-title-input");
  const contentInput = document.getElementById("announcement-content-input");
  if (!titleInput || !contentInput) return;

  const title = titleInput.value.trim();
  const content = contentInput.value.trim();
  if (!title || !content) {
    alert("請輸入公告標題與內容！");
    return;
  }

  const success = await db.saveAnnouncement(title, content);

  if (success) {
    showToast("公告已發布成功！");
    window.closeAnnouncementForm();
    await updateAnnouncementsList();
  }
};

window.deleteAnnouncement = async function (id) {
  const confirmed = await window.showConfirmDialog({
    title: "確定要刪除此公告嗎？",
    message: "此動作將會立即刪除公告且無法復原。",
    confirmText: "確認刪除",
    cancelText: "取消",
    isDestructive: true
  });
  if (!confirmed) return;

  const success = await db.deleteAnnouncement(id);

  if (success) {
    showToast("公告已成功刪除。");
    await updateAnnouncementsList();
  }
};

async function updateAnnouncementsList() {
  const listContainer = document.getElementById("church-announcements-list");
  if (!listContainer) return;

  if (typeof ComponentSkeletonLoader !== "undefined") {
    ComponentSkeletonLoader.fill("announcement", listContainer, { count: 2 });
  }

  const isAdmin = state.currentUser && (getUserRoleCode(state.currentUser) === 'admin');
  const publishBtn = document.getElementById("btn-show-announcement-form");
  if (publishBtn) {
    publishBtn.classList.toggle("hidden", !isAdmin);
  }
  const announcements = await db.fetchAnnouncements();
  listContainer.innerHTML = "";

  if (announcements.length === 0) {
    listContainer.innerHTML = `
      <div class="announcements-empty">
        <span class="announcements-empty__icon nlc-icon nlc-icon--md" data-icon="inbox" aria-hidden="true"></span>
        <p class="announcements-empty__text">目前尚無教會公告。</p>
      </div>`;
    if (typeof hydrateIcons === "function") hydrateIcons(listContainer);
    return;
  }

  announcements.forEach(ann => {
    const item = document.createElement("div");
    item.className = "announcement-item";

    const formattedTime = new Date(ann.created_at).toLocaleDateString('zh-TW', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });

    item.innerHTML = `
      <div class="announcement-item__header">
        <h4 class="announcement-item__title">${escapeHTML(ann.title)}</h4>
        <div class="announcement-item__meta">
          <time class="announcement-item__time" datetime="${escapeHTML(ann.created_at || "")}">${formattedTime}</time>
          ${isAdmin ? `<button type="button" class="circular-action-btn btn-danger-soft announcement-item__delete" onclick="window.deleteAnnouncement('${ann.id}')" title="刪除公告" aria-label="刪除公告"><span class="nlc-icon nlc-icon--sm" data-icon="trash" aria-hidden="true"></span></button>` : ''}
        </div>
      </div>
      <p class="announcement-item__body">${escapeHTML(ann.content)}</p>
    `;
    listContainer.appendChild(item);
  });
  if (typeof hydrateIcons === "function") hydrateIcons(listContainer);
}

let currentVerse = null;
let currentBlessing = null;
let isVerseLoading = false;
let isImgLoading = false;

const CHINESE_TO_ENGLISH_BOOKS = {
  "詩篇": "psalms",
  "以賽亞書": "isaiah",
  "箴言": "proverbs",
  "約翰福音": "john",
  "約約翰福音": "john",
  "腓立比書": "philippians",
  "羅馬書": "romans",
  "馬太福音": "matthew",
  "希伯來書": "hebrews",
  "提摩太前書": "1timothy",
  "約書亞記": "joshua",
  "申命記": "deuteronomy",
  "加拉太書": "galatians",
  "約翰一書": "1john",
  "馬可福音": "mark"
};

const CURATED_IMAGE_POOL = [
  "https://images.unsplash.com/photo-1506126613408-eca07ce68773?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1448375240586-882707db888b?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1473448912268-2022ce9509d8?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1470252649358-96f5e5047118?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1506318137071-a8e063b4bec0?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1475924156734-496f6cac6ec1?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1454496522488-7a8e488e8606?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1472214222541-d510753a4907?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1518495973542-4542c06a5843?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1502082553048-f009c37129b9?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1501854140801-50d01698950b?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1447752875215-b2761acb3c5d?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1475113548554-5a36f1f523d6?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1513836279014-a89f7a76ae86?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1469474968028-56623f02e42e?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1433086966358-54859d0ed716?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1502759683299-cdcd6974244f?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1508739773434-c26b3d09e071?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1500964757637-c85e8a162699?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1482862549707-f63cb32c5fd9?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1518156677180-95a2893f3e9f?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1528183429752-a97d0bf99b5a?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1504280390367-361c6d9f38f4?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1501785888041-af3ef285b470?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1480714378408-67cf0d13bc1b?auto=format&fit=crop&w=800&q=80"
];

const VERSE_CARD_FALLBACK_IMAGE = CURATED_IMAGE_POOL[0];

function setVerseCardLoading(loading, options = {}) {
  const card = document.getElementById("verse-card");
  const skeleton = document.getElementById("verse-card-skeleton");
  const body = document.getElementById("verse-card-body");
  const bgImgEl = document.getElementById("card-bg");
  if (!card) return;

  card.classList.toggle("is-loading", loading);

  if (loading) {
    if (skeleton && typeof ComponentSkeletonLoader !== "undefined") {
      ComponentSkeletonLoader.fill("verse-card", skeleton);
    }
    if (body) body.setAttribute("aria-hidden", "true");
    if (bgImgEl && !options.preserveBackground) bgImgEl.style.opacity = "0";
  } else if (body) {
    body.removeAttribute("aria-hidden");
    body.style.pointerEvents = "";
  }
}

function preloadVerseCardImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(url);
    img.onerror = () => resolve(VERSE_CARD_FALLBACK_IMAGE);
    img.src = url;
  });
}

function applyVerseCardContent(verseData, imageUrl) {
  const card = document.getElementById("verse-card");
  const textEl = document.getElementById("daily-verse-text");
  const sourceEl = document.getElementById("daily-verse-source");
  const bgImgEl = document.getElementById("card-bg");
  const content = document.getElementById("daily-verse-content");

  if (textEl) textEl.textContent = verseData.text;
  if (sourceEl) sourceEl.textContent = verseData.source;

  if (bgImgEl) {
    bgImgEl.src = imageUrl;
    bgImgEl.style.opacity = "1";
  }

  const isBlessing = state.verseCardMode === 'blessing';
  if (isBlessing) {
    currentBlessing = { ...verseData, imageUrl };
  } else {
    currentVerse = { ...verseData, imageUrl };
  }

  if (typeof syncVerseLikes === "function") {
    syncVerseLikes(verseData.source);
  }

  setVerseCardLoading(false);
  isVerseLoading = false;
  isImgLoading = false;

  const toolbar = document.getElementById("verse-card-toolbar");
  if (toolbar && typeof hydrateIcons === "function") {
    hydrateIcons(toolbar);
  }

  card?.classList.remove("opacity-90");
  if (content) {
    content.classList.remove("opacity-40");
    content.style.opacity = "0";
    void content.offsetWidth;
    content.style.opacity = "1";
  }
}

function getDisplayedVerseCardImageUrl() {
  const bgImgEl = document.getElementById("card-bg");
  const displayedUrl = bgImgEl && bgImgEl.getAttribute("src");
  return displayedUrl || localStorage.getItem("verse_card_bg") || "";
}

async function fetchRandomVerse(event, options = {}) {
  if (event) {
    if (event.target.closest(".social-toolbar") || event.target.closest("#share-card-btn")) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  if (isVerseLoading || isImgLoading) return;

  const card = document.getElementById("verse-card");
  if (!card) return;

  isVerseLoading = true;
  isImgLoading = true;

  setVerseCardLoading(true, options);

  if (!state.verseCardMode) {
    state.verseCardMode = 'verse';
  }

  const isBlessingMode = state.verseCardMode === 'blessing';
  let cardText, cardSource;

  // 使用台北時間生成今日日期字串
  const todayStr = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
  const storageDateKey = isBlessingMode ? "daily_blessing_saved_date" : "daily_verse_saved_date";
  const savedDate = localStorage.getItem(storageDateKey);
  
  let loadedUrl = "";
  // 如果是使用者點擊按鈕手動抽卡（event 存在），或是今天尚未儲存過卡片，就重新抽取
  let shouldGenerate = !!event || savedDate !== todayStr;

  if (!shouldGenerate) {
    cardText = localStorage.getItem(isBlessingMode ? "daily_blessing_text" : "daily_verse_text");
    cardSource = localStorage.getItem(isBlessingMode ? "daily_blessing_source" : "daily_verse_source");
    loadedUrl = localStorage.getItem(isBlessingMode ? "daily_blessing_bg" : "daily_verse_bg");
  }

  if (!cardText) {
    if (isBlessingMode) {
      const randomCard = HEAVENLY_FATHER_CARDS[Math.floor(Math.random() * HEAVENLY_FATHER_CARDS.length)];
      cardText = randomCard;
      cardSource = "—— 愛你的天父";
    } else {
      const randomLocal = DAILY_VERSES[Math.floor(Math.random() * DAILY_VERSES.length)];
      cardText = randomLocal.text;
      cardSource = randomLocal.source;
    }

    // 儲存至 localStorage
    localStorage.setItem(storageDateKey, todayStr);
    localStorage.setItem(isBlessingMode ? "daily_blessing_text" : "daily_verse_text", cardText);
    localStorage.setItem(isBlessingMode ? "daily_blessing_source" : "daily_verse_source", cardSource);
  }

  const preservedImageUrl = options.preserveBackground ? getDisplayedVerseCardImageUrl() : "";
  const nextImageUrl = preservedImageUrl
    || loadedUrl
    || CURATED_IMAGE_POOL[Math.floor(Math.random() * CURATED_IMAGE_POOL.length)];
  
  if (!preservedImageUrl) {
    localStorage.setItem("verse_card_bg", nextImageUrl);
    localStorage.setItem(isBlessingMode ? "daily_blessing_bg" : "daily_verse_bg", nextImageUrl);
  }
  const imgPromise = preloadVerseCardImage(nextImageUrl);

  const fetchPromise = Promise.resolve({ text: cardText, source: cardSource });

  const [result, finalLoadedUrl] = await Promise.all([fetchPromise, imgPromise]);
  applyVerseCardContent(result, finalLoadedUrl);
}

async function shareAsImage(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }

  const shareBtn = document.getElementById("share-card-btn");
  const card = document.getElementById("verse-card");
  if (!card) return;

  if (shareBtn) {
    shareBtn.disabled = true;
    shareBtn.innerHTML = `<span class="nlc-icon nlc-icon--md" data-icon="refresh" aria-hidden="true"></span><span>分享中</span>`;
    if (typeof hydrateIcons === "function") hydrateIcons(shareBtn);
  }

  const toolbar = document.getElementById("verse-card-toolbar");

  try {
    if (toolbar) toolbar.style.visibility = "hidden";

    const canvas = await html2canvas(card, {
      useCORS: true,
      scale: 2,
      logging: false,
      ignoreElements: (el) => {
        return el.id === "verse-card-toolbar" || el.tagName === "BUTTON";
      }
    });

    canvas.toBlob(async (blob) => {
      if (!blob) return alert('圖片產生失敗');

      const file = new File([blob], 'daily-verse.png', { type: 'image/png' });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            files: [file],
            title: (window.APP_COPY && window.APP_COPY.verse.shareTitle) || "今日經文",
            text: (window.APP_COPY && window.APP_COPY.verse.shareText) || "分享今日經文給你"
          });

        } catch (shareError) {
          if (shareError.name !== 'AbortError') {
            fallbackDownload(canvas);
          }
        }
      } else {
        fallbackDownload(canvas);
      }
    }, 'image/png');

  } catch (error) {
    console.error('產生分享圖片時發生錯誤:', error);
    alert((window.APP_COPY && window.APP_COPY.verse.shareFail) || '分享失敗，等一下再試試');
  } finally {
    if (toolbar) toolbar.style.visibility = "";
    if (shareBtn) {
      setTimeout(() => {
        shareBtn.disabled = false;
        shareBtn.innerHTML = `<span class="nlc-icon nlc-icon--md" data-icon="share" aria-hidden="true"></span><span>${(window.APP_COPY && window.APP_COPY.verse.share) || "分享"}</span>`;
        if (typeof hydrateIcons === "function") hydrateIcons(shareBtn);
      }, 1000);
    }
  }
}

function fallbackDownload(canvas) {
  const link = document.createElement('a');
  link.download = 'daily-verse.png';
  link.href = canvas.toDataURL('image/png');
  link.click();

}

async function syncVerseLikes(verseSource) {
  const likeBtn = document.getElementById("like-btn");
  const label = document.getElementById("like-count-text");
  if (!likeBtn || !label) return;

  let validatedSource;
  try {
    validatedSource = validateVerseSource(verseSource);
  } catch (err) {
    console.error("Invalid verse source for sync:", err);
    return;
  }

  let count = Math.max(0, parseInt(localStorage.getItem(`verse_like_count_${validatedSource}`) || "0"));
  let liked = localStorage.getItem(`verse_liked_${validatedSource}`) === "true";

  const updateUI = () => {
    const iconEl = likeBtn.querySelector(".nlc-icon");
    if (iconEl) {
      iconEl.setAttribute("data-icon", liked ? "heartFill" : "heart");
      likeBtn.classList.toggle("is-liked", liked);
      iconEl.style.color = "";
      if (typeof hydrateIcons === "function") hydrateIcons(likeBtn);
    }
    if (label) {
      label.textContent = count >= 10000 ? `${(count / 10000).toFixed(1)}萬` : count;
    }
  };

  updateUI();

  if (state.supabase && state.isSupabaseMode) {
    try {
      const { data, error } = await state.supabase.from("verse_likes").select("like_count").eq("source", validatedSource).maybeSingle();
      if (!error) {
        if (data) {
          count = Math.max(0, data.like_count || 0);
          localStorage.setItem(`verse_like_count_${validatedSource}`, count.toString());
          updateUI();
        } else {
          count = 0;
          localStorage.setItem(`verse_like_count_${validatedSource}`, "0");
          updateUI();
        }
      }
    } catch (e) {
      console.warn("Failed to sync like count from Supabase:", e);
    }
  }
}

async function toggleVerseLike(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }

  if (!currentVerse || !currentVerse.source) return;
  const verseSource = currentVerse.source;

  let validatedSource;
  try {
    validatedSource = validateVerseSource(verseSource);
  } catch (err) {
    console.error("Invalid verse source for like toggle:", err);
    return;
  }

  const likeBtn = document.getElementById("like-btn");
  const label = document.getElementById("like-count-text");
  if (!likeBtn || !label) return;

  let liked = localStorage.getItem(`verse_liked_${validatedSource}`) === "true";
  let count = Math.max(0, parseInt(localStorage.getItem(`verse_like_count_${validatedSource}`) || "0"));
  const previousLiked = liked;
  const previousCount = count;

  liked = !liked;
  count = Math.max(0, count + (liked ? 1 : -1));

  localStorage.setItem(`verse_liked_${validatedSource}`, liked ? "true" : "false");
  localStorage.setItem(`verse_like_count_${validatedSource}`, count.toString());

  const iconEl = likeBtn.querySelector(".nlc-icon");
  if (iconEl) {
    iconEl.setAttribute("data-icon", liked ? "heartFill" : "heart");
    likeBtn.classList.toggle("is-liked", liked);
    iconEl.style.color = "";
    if (typeof hydrateIcons === "function") hydrateIcons(likeBtn);
  }
  if (label) {
    label.textContent = count >= 10000 ? `${(count / 10000).toFixed(1)}萬` : count;
  }

  if (state.supabase && state.isSupabaseMode) {
    try {
      if (typeof state.supabase.rpc === "function") {
        const rpcName = liked ? "increment_likes" : "decrement_likes";
        const { data, error } = await state.supabase.rpc(rpcName, { verse_source: validatedSource });
        if (error) throw new Error(error.message || error.error || String(error));
        if (typeof data !== "number") throw new Error("Atomic verse-like RPC returned an invalid count.");
        const guardedData = Math.max(0, data);
        count = guardedData;
        localStorage.setItem(`verse_like_count_${validatedSource}`, guardedData.toString());
        if (label) {
          label.textContent = guardedData >= 10000 ? `${(guardedData / 10000).toFixed(1)}萬` : guardedData;
        }
      } else {
        throw new Error("Atomic verse-like RPC is unavailable; direct counter writes are forbidden.");
      }
    } catch (dbErr) {
      liked = previousLiked;
      count = previousCount;
      localStorage.setItem(`verse_liked_${validatedSource}`, liked ? "true" : "false");
      localStorage.setItem(`verse_like_count_${validatedSource}`, count.toString());
      if (iconEl) {
        iconEl.setAttribute("data-icon", liked ? "heartFill" : "heart");
        likeBtn.classList.toggle("is-liked", liked);
        if (typeof hydrateIcons === "function") hydrateIcons(likeBtn);
      }
      if (label) label.textContent = count >= 10000 ? `${(count / 10000).toFixed(1)}萬` : count;
      console.warn("Failed to toggle like on Supabase; optimistic state rolled back.", dbErr);
    }
  }
}

function renderDailyVerse(options = {}) {
  const shareBtn = document.getElementById("share-card-btn");
  if (shareBtn && !shareBtn._hasShareListener) {
    shareBtn.addEventListener("click", shareAsImage);
    shareBtn._hasShareListener = true;
  }

  const drawBtn = document.getElementById("draw-card-btn");
  if (drawBtn && !drawBtn._hasDrawListener) {
    drawBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      fetchRandomVerse(e);
    });
    drawBtn._hasDrawListener = true;
  }

  const likeBtn = document.getElementById("like-btn");
  if (likeBtn && !likeBtn._hasLikeListener) {
    likeBtn.addEventListener("click", toggleVerseLike);
    likeBtn._hasLikeListener = true;
  }

  const changeBgBtn = document.getElementById("btn-change-verse-bg");
  if (changeBgBtn && !changeBgBtn._hasChangeListener) {
    changeBgBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.changeVerseCardBackground();
    });
    changeBgBtn._hasChangeListener = true;
  }

  // Initialize Mode Selectors
  if (!state.verseCardMode) {
    state.verseCardMode = 'verse';
  }

  const btnModeVerse = document.getElementById("btn-mode-verse");
  const btnModeBlessing = document.getElementById("btn-mode-blessing");

  const updateModeUI = () => {
    const isVerse = state.verseCardMode === 'verse';
    if (btnModeVerse) {
      btnModeVerse.classList.toggle("active", isVerse);
      btnModeVerse.style.background = isVerse ? "rgba(255,255,255,0.22)" : "transparent";
      btnModeVerse.style.color = isVerse ? "#ffffff" : "rgba(255,255,255,0.7)";
      btnModeVerse.style.minHeight = "15px";
      btnModeVerse.style.boxShadow = "none";
    }
    if (btnModeBlessing) {
      btnModeBlessing.classList.toggle("active", !isVerse);
      btnModeBlessing.style.background = !isVerse ? "rgba(255,255,255,0.22)" : "transparent";
      btnModeBlessing.style.color = !isVerse ? "#ffffff" : "rgba(255,255,255,0.7)";
      btnModeBlessing.style.minHeight = "15px";
      btnModeBlessing.style.boxShadow = "none";
    }
    if (drawBtn) {
      const label = !isVerse ? "抽一張" : "換一句";
      drawBtn.innerHTML = `<span class="nlc-icon nlc-icon--sm" data-icon="refresh" aria-hidden="true"></span><span>${label}</span>`;
      if (typeof hydrateIcons === "function") hydrateIcons(drawBtn);
    }
  };

  updateModeUI();

  if (btnModeVerse && !btnModeVerse._hasModeListener) {
    btnModeVerse.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (state.verseCardMode === 'verse') return;
      state.verseCardMode = 'verse';
      updateModeUI();
      renderDailyVerse();
    });
    btnModeVerse._hasModeListener = true;
  }

  if (btnModeBlessing && !btnModeBlessing._hasModeListener) {
    btnModeBlessing.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (state.verseCardMode === 'blessing') return;
      state.verseCardMode = 'blessing';
      updateModeUI();
      renderDailyVerse({ preserveBackground: true });
    });
    btnModeBlessing._hasModeListener = true;
  }

  const savedBg = localStorage.getItem("verse_card_bg");
  const activeMode = state.verseCardMode || 'verse';
  const currentData = activeMode === 'blessing' ? currentBlessing : currentVerse;

  if (!currentData) {
    setVerseCardLoading(true, options);
    fetchRandomVerse(null, options);
  } else {
    setVerseCardLoading(true, options);
    const imageUrl = savedBg || currentData.imageUrl || CURATED_IMAGE_POOL[(new Date().getDate() - 1) % CURATED_IMAGE_POOL.length];
    preloadVerseCardImage(imageUrl).then((loadedUrl) => {
      applyVerseCardContent(
        { text: currentData.text, source: currentData.source },
        loadedUrl
      );
    });
  }
}

window.openActivePlanFromDashboard = function (event) {
  console.log('📅 [Debug] 已點選讀經計畫，正在跳轉至計畫頁');
  if (typeof window.guardPlanEligibility === "function" && window.guardPlanEligibility()) return;
  if (!state.activePlan) return;
  if (typeof isPlanExpired === "function" && isPlanExpired(state.activePlan)) {
    showToast("此計畫已過期，無法再進入進度閱讀。");
    return;
  }
  state.planDetailOpen = true;
  state.selectedPlanDay = null;
  localStorage.setItem("selected_plan_key", state.activePlan.presetKey || state.activePlan.id || "");
  appRouter.switchTab('plan-view', { keepPlanDetail: true });
};

window.startReadingCurrentChapter = function () {
  console.log('📖 [Debug] 已點選章節，進入全滿版沉浸閱讀模式');
  if (typeof window.guardPlanEligibility === "function" && window.guardPlanEligibility()) return;
  try {
    if (typeof calculatePlanProgress === "function") {
      calculatePlanProgress();
    }
  } catch (e) {
    console.warn("[Home] calculatePlanProgress error in startReadingCurrentChapter:", e);
  }

  if (state.activePlan && typeof isPlanExpired === "function" && isPlanExpired(state.activePlan)) {
    showToast("此計畫已過期，無法再進入進度閱讀。");
    return;
  }
  if (!state.activePlan) {
    appRouter.switchTab('reader-view');
    return;
  }

  let targetBook = null;
  let targetChapter = 1;
  let targetDayNum = null;
  let targetRound = Number(state.activePlan.currentRound || 1);
  let found = false;

  if (state.activePlan.days) {
    for (const day of state.activePlan.days) {
      const unread = day.chapters.find(ch =>
        Number(ch.round || targetRound) === targetRound &&
        !ch[`isReadR${targetRound}`] &&
        !(targetRound === 1 && ch.isRead)
      );
      if (unread) {
        targetBook = unread.book;
        targetChapter = Number(unread.chapter);
        targetDayNum = day.dayNum;
        found = true;
        break;
      }
    }
  }

  if (!found && Array.isArray(state.activePlan.days)) {
    for (const day of state.activePlan.days) {
      const firstForRound = (day.chapters || []).find(ch => Number(ch.round || targetRound) === targetRound);
      if (!firstForRound) continue;
      targetBook = firstForRound.book;
      targetChapter = Number(firstForRound.chapter);
      targetDayNum = day.dayNum;
      break;
    }
  }

  if (targetBook && typeof BIBLE_BOOKS !== 'undefined') {
    const bookObj = BIBLE_BOOKS.find(b => b.name === targetBook);
    if (bookObj) {
      state.readerState.bookId = bookObj.id;
      state.readerState.chapter = targetChapter;
      state.readerState.fromPlan = true;
      state.readerState.planDayNum = targetDayNum;
      state.readerState.planRound = targetRound;
      state.readerState.planContextId = window.getActivePlanContextId?.(state.activePlan)
        || state.activePlan.id
        || state.activePlan.globalPlanId
        || state.activePlan.presetKey
        || null;

      if (typeof saveReaderPreferences === 'function') {
        saveReaderPreferences();
      } else {
        localStorage.setItem("reader_state", JSON.stringify({
          bookId: state.readerState.bookId,
          chapter: state.readerState.chapter
        }));
      }
    }
  }

  state.readerState.returnTab = "dashboard-view";
  appRouter.switchTab('reader-view', { fromPlan: true });
};

async function fetchPastoralVerseWall() {
  const container = document.getElementById("home-verse-wall");
  if (!container) return;

  const todayStr = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');

  if (!pastoralSharingWallEnabled) return;
  const isHistory = (sharingController.tab === "history");
  const historyFilter = sharingController.filter;
  const historyFilterWrapper = document.getElementById("wall-history-filter-wrapper");

  if (isHistory) {
    historyFilterWrapper?.classList.remove("hidden");
  } else {
    historyFilterWrapper?.classList.add("hidden");
  }

  if (state.isSupabaseMode && state.supabase) {
    try {
      const user = await db.getCurrentDbUser();
      const pastoralZone = (state.currentUser && state.currentUser.pastoral_zone) || "";
      let profilesQuery = state.supabase.from("profiles").select("id, name, small_group");
      if (pastoralZone) {
        profilesQuery = profilesQuery.eq("pastoral_zone", pastoralZone);
      }
      const { data: profiles, error: pError } = await profilesQuery;

      if (pError) throw pError;
      if (!profiles || profiles.length === 0) {
        container.innerHTML = `<div class="text-xs text-slate-400 dark:text-zinc-500 text-center py-6">尚無同工在該牧區</div>`;
        return;
      }

      const userIds = profiles.map(p => p.id);

      let notesQuery = state.supabase
        .from("devotional_notes")
        .select("id, user_id, content, created_at, note_date");

      if (isHistory) {
        if (historyFilter === "mine" && user) {
          notesQuery = notesQuery.eq("user_id", user.id);
        } else {
          notesQuery = notesQuery.in("user_id", userIds);
        }
        notesQuery = notesQuery.order("created_at", { ascending: false }).limit(50);
      } else {
        notesQuery = notesQuery.eq("note_date", todayStr).in("user_id", userIds).order("created_at", { ascending: false });
      }

      const { data: notes, error: nError } = await notesQuery;
      if (nError) throw nError;

      const activeNotes = (notes || []).filter(n => n.content && n.content.trim().length > 0);

      if (activeNotes.length === 0) {
        const noNotesMsg = isHistory
          ? (historyFilter === "mine" ? "您目前尚無過去分享的心得喔！" : "此小組/牧區尚無歷史分享心得喔！")
          : "今天還沒有人分享金句喔，快來分享吧！";
        container.innerHTML = `<div class="text-xs text-slate-400 dark:text-zinc-500 text-center py-6">${noNotesMsg}</div>`;
        return;
      }

      const noteIds = activeNotes.map(n => n.id);
      const { data: likes } = await state.supabase
        .from("devotional_likes")
        .select("note_id, user_id")
        .in("note_id", noteIds);

      const { data: comments } = await state.supabase
        .from("devotional_comments")
        .select("id, note_id, user_id, content, created_at")
        .in("note_id", noteIds)
        .order("created_at", { ascending: true });

      const profileMap = {};
      profiles.forEach(p => {
        profileMap[p.id] = p;
      });

      renderVerseWallCards(activeNotes, profileMap, likes || [], comments || [], isHistory);
    } catch (err) {
      console.error("Failed to load pastoral sharing wall:", err);
      container.innerHTML = `<div class="text-xs text-red-500 text-center py-6">載入分享牆失敗</div>`;
    }
  } else {
    const defaultMock = [
      { id: "offline_note1", user_id: "offline1", content: "主是我的力量，我的盾牌；我心裡倚靠他就得幫助。 (詩 28:7)", created_at: new Date(Date.now() - 3600000).toISOString() },
      { id: "offline_note2", user_id: "offline2", content: "你要保守你心，勝過保守一切，因為一生的果效是由心發出。 (箴 4:23)", created_at: new Date(Date.now() - 7200000).toISOString() },
      { id: "offline_note3", user_id: "offline1", content: "敬畏耶和華是智慧的開端；認識至聖者便是聰明。 (箴 9:10)", created_at: new Date(Date.now() - 86400000 * 2).toISOString() },
      { id: "offline_note4", user_id: "me", content: "我將你的話藏在心裡，免得我得罪你。 (詩 119:11)", created_at: new Date(Date.now() - 86400000).toISOString() }
    ];

    const localNotesStr = localStorage.getItem("devotional_notes") || "[]";
    let localNotes = [];
    try {
      localNotes = JSON.parse(localNotesStr);
      if (!Array.isArray(localNotes)) localNotes = [];
    } catch (e) { }

    const mockNotes = [...localNotes, ...defaultMock];

    const mockProfileMap = {
      "offline1": { name: "張弟兄", small_group: "馬鈴薯組" },
      "offline2": { name: "李姊妹", small_group: "喜樂組" },
      "me": { name: (state.currentUser && state.currentUser.name) || "我", small_group: (state.currentUser && state.currentUser.small_group) || "" }
    };

    let processedMock = mockNotes.map(n => {
      const datePart = n.created_at ? n.created_at.slice(0, 10) : todayStr;
      return { ...n, note_date: datePart };
    });

    let filteredNotes = processedMock;
    if (isHistory) {
      if (historyFilter === "mine") {
        const myId = (state.currentUser && state.currentUser.id) || "me";
        filteredNotes = processedMock.filter(n => n.user_id === "me" || n.user_id === myId);
      }
      filteredNotes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      filteredNotes = filteredNotes.slice(0, 50);
    } else {
      filteredNotes = processedMock.filter(n => n.note_date === todayStr);
    }

    if (filteredNotes.length === 0) {
      const noNotesMsg = isHistory ? "無符合歷史心得" : "今天還沒有人分享金句喔，快來分享吧！";
      container.innerHTML = `<div class="text-xs text-slate-400 dark:text-zinc-500 text-center py-6">${noNotesMsg}</div>`;
      return;
    }

    const likesList = [];
    const commentsList = [];
    filteredNotes.forEach(n => {
      const likedKey = `like_${n.id}`;
      if (localStorage.getItem(likedKey) === "true") {
        likesList.push({ note_id: n.id, user_id: "me" });
      }
      const commentsKey = `comments_${n.id}`;
      const localComms = JSON.parse(localStorage.getItem(commentsKey) || "[]");
      commentsList.push(...localComms);
    });

    renderVerseWallCards(filteredNotes, mockProfileMap, likesList, commentsList, isHistory);
  }
}

function renderCommentsTree(commentNodes, noteOwnerId, profileMap, depth = 0) {
  let html = "";
  
  // 依時間先後排序留言
  commentNodes.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  
  commentNodes.forEach(c => {
    const commProfile = profileMap[c.user_id] || { name: "" };
    const commName = String(commProfile.name || "").trim() || "—";
    const isOp = c.user_id === noteOwnerId;
    
    // 巢狀縮排線與樣式
    const paddingLeftClass = depth > 0 
      ? "pl-4 border-l-2 border-slate-200/40 dark:border-zinc-800 ml-2" 
      : "";
      
    // 遞迴渲染子留言
    const repliesHtml = c.replies && c.replies.length > 0 
      ? renderCommentsTree(c.replies, noteOwnerId, profileMap, depth + 1)
      : "";
      
    // 動態產生精美的 Dicebear 頭像
    const commAvatarUrl = `https://api.dicebear.com/8.x/lorelei/svg?seed=${encodeURIComponent(commName)}`;
      
    html += `
      <div class="comment-node mb-3.5 ${paddingLeftClass}">
        <div class="p-3 rounded-lg border transition-all duration-200 hover:bg-white/[0.01]" style="background: color-mix(in srgb, var(--text-primary) 1%, var(--bg-card)); border-color: var(--border-card);">
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center space-x-2">
              <img src="${commAvatarUrl}" alt="${escapeHTML(commName)}" class="w-5.5 h-5.5 rounded-full border border-white/10" style="width: 22px; height: 22px; background-color: var(--color-brand-subtle);" />
              <div class="flex flex-col">
                <div class="flex items-center space-x-1.5">
                  <span style="font-weight: var(--type-weight-strong); color: var(--text-primary); font-size: 0.875rem;">${escapeHTML(commName)}</span>
                  ${isOp ? `<span class="privacy-badge stat-badge stat-badge--success text-[8px]" style="padding: 1px 4px; font-size: 0.875rem; line-height: 1; border-radius: 9999px;">OP</span>` : ""}
                </div>
              </div>
            </div>
            <span style="color: var(--text-muted); font-size: 0.875rem;">${new Date(c.created_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          <p style="margin: 0 0 0.5rem 0; color: var(--text-secondary); font-size: 0.875rem; line-height: 1.4; white-space: pre-wrap; padding-left: 2px;">${escapeHTML(c.content)}</p>
          
          <div class="flex items-center space-x-3 text-[10px]" style="padding-left: 2px;">
            <button type="button" class="flex items-center space-x-1 hover:text-brand transition-colors bg-transparent border-0 cursor-pointer p-0 text-slate-400 dark:text-zinc-500" style="font-size: 0.875rem; font-weight: 500;" onclick="window.showReplyInputBox('${c.id}')">
              <span class="nlc-icon nlc-icon--inline" data-icon="inbox" style="opacity: 0.8; margin-right: 2px;"></span>
              <span>回覆</span>
            </button>
          </div>
          
          <!-- 巢狀回覆輸入框 -->
          <div id="reply-input-box-${c.id}" class="hidden mt-3 pt-3 border-t border-dashed border-slate-200/10">
            <div class="flex items-center space-x-2">
              <input type="text" id="reply-input-${c.id}" placeholder="回覆 ${escapeHTML(commName)}..." class="form-control" style="padding: 0.35rem 1rem; border-radius: 9999px; flex: 1;">
              <button type="button" class="primary-btn" style="padding: 0.35rem 0.85rem; font-size: 0.875rem; border-radius: 9999px !important; white-space: nowrap; font-weight: 600;" onclick="window.submitDevotionalReply('${c.note_id}', '${c.id}')">發送</button>
              <button type="button" class="secondary-btn" style="padding: 0.35rem 0.85rem; font-size: 0.875rem; border-radius: 9999px !important; white-space: nowrap;" onclick="window.hideReplyInputBox('${c.id}')">取消</button>
            </div>
          </div>
        </div>
        ${repliesHtml ? `<div class="replies-container mt-2.5">${repliesHtml}</div>` : ""}
      </div>
    `;
  });
  
  return html;
}

function renderVerseWallCards(notes, profileMap, likes, comments, isHistory = false) {
  const container = document.getElementById("home-verse-wall");
  if (!container) return;

  container.innerHTML = "";
  const currentUserId = state.currentUser ? state.currentUser.id : null;
  window.expandedNoteIds = window.expandedNoteIds || new Set();

  notes.forEach(note => {
    const profile = profileMap[note.user_id] || { name: "", small_group: "" };
    const initial = profile.name ? profile.name.charAt(0) : "·";

    const colors = [
      "from-pink-500/20 to-rose-500/20 text-rose-500 dark:text-rose-300",
      "from-purple-500/20 to-indigo-500/20 text-indigo-500 dark:text-indigo-300",
      "from-blue-500/20 to-cyan-500/20 text-cyan-500 dark:text-cyan-300",
      "from-emerald-500/20 to-teal-500/20 text-teal-500 dark:text-teal-300",
      "from-amber-500/20 to-orange-500/20 text-orange-500 dark:text-orange-300"
    ];
    const charCode = profile.name ? profile.name.charCodeAt(0) : 0;
    const avatarColorClass = colors[charCode % colors.length];

    let timeStr = "剛剛";
    if (note.created_at) {
      try {
        const noteDate = new Date(note.created_at);
        const todayDateStr = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
        const noteDateStr = noteDate.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');

        if (isHistory || noteDateStr !== todayDateStr) {
          const y = noteDate.getFullYear();
          const m = String(noteDate.getMonth() + 1).padStart(2, '0');
          const d = String(noteDate.getDate()).padStart(2, '0');
          const hr = String(noteDate.getHours()).padStart(2, '0');
          const min = String(noteDate.getMinutes()).padStart(2, '0');
          timeStr = `${y}-${m}-${d} ${hr}:${min}`;
        } else {
          const diffMs = new Date() - noteDate;
          const diffMins = Math.floor(diffMs / 60000);
          if (diffMins < 1) {
            timeStr = "剛剛";
          } else if (diffMins < 60) {
            timeStr = `${diffMins} 分鐘前`;
          } else {
            timeStr = noteDate.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
          }
        }
      } catch (e) { }
    }

    const noteLikes = likes.filter(l => l.note_id === note.id);
    const noteComments = comments.filter(c => c.note_id === note.id);
    const hasLiked = currentUserId && noteLikes.some(l => l.user_id === currentUserId);

    // 💡 關鍵升級：建立巢狀留言樹狀結構
    const commentMap = {};
    const rootComments = [];

    noteComments.forEach(c => {
      let parentId = null;
      let text = c.content;
      if (c.content && c.content.startsWith("{")) {
        try {
          const obj = JSON.parse(c.content);
          if (obj && typeof obj.text === "string") {
            parentId = obj.parent_id;
            text = obj.text;
          }
        } catch (e) { }
      }

      commentMap[c.id] = {
        id: c.id,
        note_id: c.note_id,
        user_id: c.user_id,
        created_at: c.created_at,
        content: text,
        parent_id: parentId,
        replies: []
      };
    });

    noteComments.forEach(c => {
      const node = commentMap[c.id];
      if (node) {
        if (node.parent_id && commentMap[node.parent_id]) {
          commentMap[node.parent_id].replies.push(node);
        } else {
          rootComments.push(node);
        }
      }
    });

    const commentsHtml = rootComments.length > 0
      ? renderCommentsTree(rootComments, note.user_id, profileMap, 0)
      : "";

    const isExpanded = window.expandedNoteIds.has(note.id);

    const card = document.createElement("div");
    card.className = "devotional-post-card transition-all duration-200 shadow-sm";
    card.style.background = "var(--bg-card)";
    card.style.border = "1px solid var(--border-card)";
    card.style.borderRadius = "12px";
    card.style.padding = "1rem";
    card.style.marginBottom = "1rem";

    card.innerHTML = `
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center space-x-3">
          <div class="w-8 h-8 rounded-full bg-gradient-to-br ${avatarColorClass} flex items-center justify-center font-bold text-xs shadow-inner">
            ${escapeHTML(initial)}
          </div>
          <div class="flex flex-col">
            <span class="text-xs font-medium" style="color: var(--text-primary);">${escapeHTML(String(profile.name || "").trim() || "—")}</span>
            <span class="text-[10px]" style="color: var(--text-muted);">${escapeHTML(String(profile.small_group || "").trim() || "—")}</span>
          </div>
        </div>
        <div class="flex items-center space-x-2">
          <span class="text-[10px]" style="color: var(--text-muted);">${timeStr}</span>
          ${note.user_id === currentUserId ? `
            <div class="relative inline-block" style="position: relative;">
              <button type="button" class="flex items-center justify-center p-1 rounded-full hover:bg-white/10 dark:hover:bg-white/5 transition-colors border-0 bg-transparent cursor-pointer" onclick="event.stopPropagation(); window.toggleDevotionalOptions('${note.id}')" style="color: var(--text-muted); height: 24px; width: 24px;">
                <span class="nlc-icon nlc-icon--sm" data-icon="threeDots" style="width: 16px; height: 16px;"></span>
              </button>
              <div id="devotional-options-${note.id}" class="hidden" style="position: absolute; right: 0; top: 28px; background: var(--bg-card); border: 1px solid var(--border-card); border-radius: var(--radius-sm); width: 100px; box-shadow: var(--shadow-lg); z-index: 99; display: flex; flex-direction: column; overflow: hidden; padding: 4px 0;">
                <button type="button" class="options-dropdown-item danger-item" onclick="event.stopPropagation(); window.deleteDevotionalNote('${note.id}')" style="padding: 0.5rem 0.75rem; font-size: 0.875rem; font-weight: var(--type-weight-strong); border: 0; background: transparent; cursor: pointer; text-align: left; display: flex; align-items: center; gap: 0.35rem; color: var(--color-danger); width: 100%;">
                  <span class="nlc-icon nlc-icon--sm" data-icon="trash" style="width: 12px; height: 12px;"></span>
                  <span>刪除</span>
                </button>
              </div>
            </div>
          ` : ''}
        </div>
      </div>

      <div class="my-3 pl-3" style="border-left: 2px solid var(--color-brand); margin: 0.75rem 0;">
        <p style="font-size: 0.875rem; line-height: 1.5; color: var(--text-primary); margin: 0; font-weight: var(--type-weight-regular);">
          ${escapeHTML(note.content)}
        </p>
      </div>

      <div class="flex items-center justify-start space-x-6 mt-3 pt-2" style="border-top: 1px solid var(--border-card); color: var(--text-secondary);">
        <button type="button" class="flex items-center space-x-1.5 hover:opacity-80 transition-opacity bg-transparent border-0 cursor-pointer p-0 text-xs" style="color: ${hasLiked ? 'var(--color-danger)' : 'var(--text-secondary)'}; font-weight: var(--type-weight-strong);" onclick="window.toggleDevotionalLike('${note.id}')">
          <span class="nlc-icon nlc-icon--sm" data-icon="${hasLiked ? 'heartFill' : 'heart'}" style="width: 15px; height: 15px;"></span>
          <span>${noteLikes.length > 0 ? noteLikes.length + ' ' : ''}讚</span>
        </button>
        <button type="button" class="flex items-center space-x-1.5 hover:opacity-80 transition-opacity bg-transparent border-0 cursor-pointer p-0 text-xs" style="color: var(--text-secondary); font-weight: var(--type-weight-strong);" onclick="window.toggleCommentsSection('${note.id}')">
          <span class="nlc-icon nlc-icon--sm" data-icon="inbox" style="width: 15px; height: 15px;"></span>
          <span>${noteComments.length > 0 ? noteComments.length + ' ' : ''}回覆</span>
        </button>
      </div>

      <div id="comments-section-${note.id}" class="${isExpanded ? '' : 'hidden'} mt-3 pt-3" style="border-top: 1px solid var(--border-card);">
        <div id="comments-list-${note.id}" class="space-y-2 mb-2">
          ${commentsHtml || '<div class="text-[10px] text-center py-2" style="color: var(--text-muted);">沒有留言</div>'}
        </div>

        <div id="comment-input-container-${note.id}" class="flex items-center space-x-2 mt-2 pt-2" style="border-top: 1px dashed var(--border-card);">
          <input type="text" id="comment-input-${note.id}" placeholder="寫下你的回覆..." class="form-control" style="padding: 0.4rem 1.1rem; border-radius: 9999px; flex: 1;">
          <button type="button" class="primary-btn" style="padding: 0.4rem 1rem; font-size: 0.875rem; border-radius: 9999px !important; white-space: nowrap; font-weight: 600;" onclick="window.submitDevotionalComment('${note.id}')">發送</button>
        </div>
      </div>
    `;
    container.appendChild(card);
  });

  if (typeof hydrateIcons === "function") {
    hydrateIcons(container);
  }
}

window.toggleDevotionalLike = async function (noteId) {
  try {
    await db.toggleDevotionalLike(noteId);
    await fetchPastoralVerseWall();
  } catch (err) {
    console.error("Failed to toggle like:", err);
  }
};

window.toggleCommentsSection = function (noteId) {
  const el = document.getElementById(`comments-section-${noteId}`);
  if (el) {
    el.classList.toggle("hidden");
    window.expandedNoteIds = window.expandedNoteIds || new Set();
    if (el.classList.contains("hidden")) {
      window.expandedNoteIds.delete(noteId);
    } else {
      window.expandedNoteIds.add(noteId);
    }
  }
};

window.toggleCommentInput = function (noteId) {
  const sec = document.getElementById(`comments-section-${noteId}`);
  if (sec && sec.classList.contains("hidden")) {
    sec.classList.remove("hidden");
    window.expandedNoteIds = window.expandedNoteIds || new Set();
    window.expandedNoteIds.add(noteId);
  }
  const el = document.getElementById(`comment-input-container-${noteId}`);
  if (el) {
    el.classList.toggle("hidden");
    if (!el.classList.contains("hidden")) {
      const inp = document.getElementById(`comment-input-${noteId}`);
      if (inp) inp.focus();
    }
  }
};

window.showReplyInputBox = function (commentId) {
  const el = document.getElementById(`reply-input-box-${commentId}`);
  if (el) {
    el.classList.remove("hidden");
    const input = document.getElementById(`reply-input-${commentId}`);
    if (input) input.focus();
  }
};

window.hideReplyInputBox = function (commentId) {
  const el = document.getElementById(`reply-input-box-${commentId}`);
  if (el) {
    el.classList.add("hidden");
    const input = document.getElementById(`reply-input-${commentId}`);
    if (input) input.value = "";
  }
};

window.submitDevotionalReply = async function (noteId, parentCommentId) {
  const input = document.getElementById(`reply-input-${parentCommentId}`);
  if (!input) return;
  const content = input.value.trim();
  if (!content) return;

  const payload = JSON.stringify({ parent_id: parentCommentId, text: content });

  try {
    await db.addDevotionalComment(noteId, payload);
    input.value = "";

    window.expandedNoteIds = window.expandedNoteIds || new Set();
    window.expandedNoteIds.add(noteId);

    await fetchPastoralVerseWall();
  } catch (err) {
    console.error("Failed to add reply comment:", err);
    alert("發送回覆失敗，請稍後再試");
  }
};

window.submitDevotionalComment = async function (noteId) {
  const input = document.getElementById(`comment-input-${noteId}`);
  if (!input) return;
  const content = input.value.trim();
  if (!content) return;

  const payload = JSON.stringify({ parent_id: null, text: content });

  try {
    await db.addDevotionalComment(noteId, payload);
    input.value = "";

    window.expandedNoteIds = window.expandedNoteIds || new Set();
    window.expandedNoteIds.add(noteId);

    await fetchPastoralVerseWall();
  } catch (err) {
    console.error("Failed to add comment:", err);
    alert("發送回覆失敗，請稍後再試");
  }
};

window.toggleDevotionalOptions = function (noteId) {
  const dropdowns = document.querySelectorAll('[id^="devotional-options-"]');
  dropdowns.forEach(d => {
    if (d.id !== `devotional-options-${noteId}`) {
      d.classList.add("hidden");
    }
  });

  const dropdown = document.getElementById(`devotional-options-${noteId}`);
  if (dropdown) {
    dropdown.classList.toggle("hidden");
  }
};

window.deleteDevotionalNote = async function (noteId) {
  const confirmed = await window.showConfirmDialog({
    title: "確定要刪除此則靈修分享嗎？",
    message: "刪除後此條靈修紀錄將不再對其他人公開。",
    confirmText: "確認刪除",
    cancelText: "取消",
    isDestructive: true
  });
  if (!confirmed) return;

  try {
    await db.deleteDevotionalNote(noteId);
    if (typeof fetchPastoralVerseWall === "function") {
      fetchPastoralVerseWall();
    }
    showToast("已成功刪除");
  } catch (err) {
    console.error("Failed to delete devotional note:", err);
    showToast("刪除失敗");
  }
};

document.addEventListener("click", () => {
  const dropdowns = document.querySelectorAll('[id^="devotional-options-"]');
  dropdowns.forEach(d => d.classList.add("hidden"));
});

window.changeVerseCardBackground = function () {
  const randomImgUrl = CURATED_IMAGE_POOL[Math.floor(Math.random() * CURATED_IMAGE_POOL.length)];
  localStorage.setItem("verse_card_bg", randomImgUrl);

  if (currentVerse) {
    currentVerse.imageUrl = randomImgUrl;
  }

  const bgImgEl = document.getElementById("card-bg");
  if (bgImgEl) {
    bgImgEl.src = randomImgUrl;
    bgImgEl.style.opacity = "1";
  }

  // ── Broadcast background change so any tab can react ──
  window.dispatchEvent(new CustomEvent("app:bgChanged", { detail: { url: randomImgUrl } }));

  showToast("已成功更換背景");
};

// 8/30 速讀測驗宣示彈窗。測驗入口本身尚未開放（等 8/30 才會接上真正的測驗
// 流程），目前點擊只會顯示規則，姓名代入第6條空格，讓每個人看到的是自己
// 要簽署的版本，不需要手動輸入。
function openQuizPledgeModal() {
  const nameEl = document.getElementById("quiz-pledge-name");
  if (nameEl) {
    const name = (typeof getDisplayName === "function" ? getDisplayName(state.currentUser) : null)
      || state.currentUser?.name
      || "（您的姓名）";
    nameEl.textContent = name;
  }
  const modal = document.getElementById("quiz-pledge-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  if (typeof hydrateIcons === "function") hydrateIcons(modal);
}

function closeQuizPledgeModal() {
  const modal = document.getElementById("quiz-pledge-modal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

function bindQuizPledgeBanner() {
  const btn = document.getElementById("btn-open-quiz-pledge");
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = "true";
    btn.addEventListener("click", openQuizPledgeModal);
  }
}

window.openQuizPledgeModal = openQuizPledgeModal;
window.closeQuizPledgeModal = closeQuizPledgeModal;

export function init() {
  initDevotionalControls();
  bindQuizPledgeBanner();

  // ── Subscribe to unified theme change event ──
  window.addEventListener("app:themeChanged", () => {
    // Re-render badge strips when theme changes (they use CSS-dependent colors)

  });

  // ── Subscribe to background change event (from profile tab or any other source) ──
  window.addEventListener("app:bgChanged", (e) => {
    const url = e.detail && e.detail.url;
    if (!url) return;
    const bgImgEl = document.getElementById("card-bg");
    if (bgImgEl) {
      bgImgEl.src = url;
      bgImgEl.style.opacity = "1";
    }
  });

  // ── Subscribe to cross-tab data refresh ──
  // When plan data changes, update the dashboard summary if it is currently visible.
  window.addEventListener("app:dataRefresh", (e) => {
    const scope = e.detail && e.detail.scope;
    if (scope === "plan" || scope === "all") {
      if (typeof updateDashboardView === "function") {
        updateDashboardView();
      }
    }
  });
}

window.updateDashboardView = updateDashboardView;
window.fetchPastoralVerseWall = fetchPastoralVerseWall;
window.initDevotionalControls = init;
window.changeVerseCardBackground = changeVerseCardBackground;
