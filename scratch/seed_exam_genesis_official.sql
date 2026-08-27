-- ============================================================================
-- scratch/seed_exam_genesis_official.sql
-- 建立「正式版」大測驗：聖經速讀測驗_創世記
--   · mode = 'live'（正式）、status = 'draft'（草稿，題庫可再改）
--   · 預告文已填入（announcement_published = FALSE；要上線請到後台按「發佈預告文」）
--   · 73 題全部帶入 + answer_key 先由 AI 依創世記內容代填
--     ⚠️ 答案為「暫定」，請務必逐題 check 後再「發佈測驗」
--
-- 前置：migrations 0096–0105 已套用、nlc-data 已部署、feature flag speed_reading_exam 已開。
-- 在 Supabase SQL editor 執行（superuser 直接寫表，不經 RPC）。
-- 重跑前先清掉舊的：
--   DELETE FROM public.exam_papers WHERE title = '聖經速讀測驗_創世記';
-- ============================================================================
DO $seed$
DECLARE
  v_paper UUID;
BEGIN
  DELETE FROM public.exam_papers WHERE title = '聖經速讀測驗_創世記';

  INSERT INTO public.exam_papers (
    title, description, mode, status,
    open_at, close_at, duration_minutes, total_points,
    pledge, sections, section_targets,
    announcement, announcement_published
  ) VALUES (
    '聖經速讀測驗_創世記',
    '新生命小組教會聖經速讀計畫 — 創世記大測驗。一～五大題自動計分（70 分），第六大題簡答人工評分（30 分）。',
    'live', 'draft',
    '2026-08-30 00:00:00+08', '2026-08-31 00:00:00+08', 75, 100,
    jsonb_build_object(
      'openText', '本次測驗開放時間為 8/30 零時起 24 小時內，本試卷作答時間為 75 分鐘。',
      'rules', jsonb_build_array(
        '可以 OPEN 紙本聖經──接受測驗的過程當中，除了紙本聖經，我不會借助其他工具來進行答題。',
        '我清楚本次測驗開放時間為 8/30 零時起 24 小時內，本試卷作答時間為 75 分鐘。',
        '我將不會重複作答，亦即當完成測驗送交答案之後，我不會以各樣的理由要求重新接受測驗（測驗記錄亦將以第一次為準）。',
        '不管是個人或三人六人組隊，我都是獨立接受測驗，不會與其他人就測驗內容進行討論及溝通。',
        '在測驗關閉前（8/30 晚上 23 時 59 分 59 秒前）我將不會以任何的方式將題目內容洩漏給其他人。'
      ),
      'consentTemplate', '{name} 清楚以上測驗規則，亦會遵守規則來完成本次測驗。'
    ),
    jsonb_build_array(
      jsonb_build_object('type','truefalse',  'count',20,'pointsPer',1),
      jsonb_build_object('type','single',     'count',20,'pointsPer',1),
      jsonb_build_object('type','multiple',   'count',10,'pointsPer',1),
      jsonb_build_object('type','matching',   'count',10,'pointsPer',1),
      jsonb_build_object('type','ordering',   'count',10,'pointsPer',1),
      jsonb_build_object('type','shortanswer','count',3, 'pointsPer',10)
    ),
    jsonb_build_object('truefalse',20,'single',20,'multiple',10,'matching',10,'ordering',10,'shortanswer',3),
    jsonb_build_object(
      'headline', '聖經速讀測驗_創世記｜8/30 登場',
      'body', '本次測驗開放時間為 8/30 零時起 24 小時內，本試卷作答時間為 75 分鐘。作答前請先詳閱並同意測驗宣示規則。不管個人或三人／六人組隊，皆為獨立作答，記錄以第一次為準。',
      'ctaLabel', '進入測驗'
    ),
    FALSE
  )
  RETURNING id INTO v_paper;

  -- ══════════════════════════════ 一、是非題（answer_key: true=O 對 / false=X 錯）
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
   (v_paper,'truefalse', 1,1, jsonb_build_object('stem','上帝用六天創造萬物，並且為萬物命名，然後第七天就安息了。'), to_jsonb(false)),
   (v_paper,'truefalse', 2,1, jsonb_build_object('stem','亞當夏娃吃了分別善惡樹的果子，發現自己赤身露體，就用獸的皮做衣服遮掩。'), to_jsonb(false)),
   (v_paper,'truefalse', 3,1, jsonb_build_object('stem','人造巴別塔，是為了避免分散各地，並且可以敬拜神，傳揚上帝的名。'), to_jsonb(false)),
   (v_paper,'truefalse', 4,1, jsonb_build_object('stem','撒拉得子後，欲把夏甲與以實馬利趕出家門，神對此非常不喜悅，因此命定以實馬利將成為大國。'), to_jsonb(false)),
   (v_paper,'truefalse', 5,1, jsonb_build_object('stem','面對兄長聯手陷害、波提乏夫人陷害、牢獄之災等困境，約瑟決心攀至高位，展開報復解心頭之恨。'), to_jsonb(false)),
   (v_paper,'truefalse', 6,1, jsonb_build_object('stem','創世記中記載了十項誡命（十誡）。'), to_jsonb(false)),
   (v_paper,'truefalse', 7,1, jsonb_build_object('stem','挪亞有三個兒子，分別叫做喇米、哈米和雅弗。'), to_jsonb(false)),
   (v_paper,'truefalse', 8,1, jsonb_build_object('stem','以撒是亞伯拉罕的第一個兒子。'), to_jsonb(false)),
   (v_paper,'truefalse', 9,1, jsonb_build_object('stem','上帝在造萬物的第三天創造了太陽、月亮和眾星，用來普照大地、分晝夜、作記號。'), to_jsonb(false)),
   (v_paper,'truefalse',10,1, jsonb_build_object('stem','蛇誘惑夏娃時，夏娃回答神說「不可吃，也不可摸，免得你們死」，這與神起初的吩咐一字不差。'), to_jsonb(false)),
   (v_paper,'truefalse',11,1, jsonb_build_object('stem','挪亞在洪水退去時，先放出一隻鴿子，鴿子找不著落腳之處飛回，後來才放出一隻烏鴉。'), to_jsonb(false)),
   (v_paper,'truefalse',12,1, jsonb_build_object('stem','上帝呼召亞伯蘭出哈蘭時，亞伯蘭當時已經99歲了。'), to_jsonb(false)),
   (v_paper,'truefalse',13,1, jsonb_build_object('stem','撒拉因不能生育，主動建議亞伯蘭納使女夏甲為妾；夏甲懷孕後，撒拉依然對她非常溫柔體貼。'), to_jsonb(false)),
   (v_paper,'truefalse',14,1, jsonb_build_object('stem','以撒娶利百加時年40歲，利百加婚後立刻為以撒生下雙胞胎以掃與雅各。'), to_jsonb(false)),
   (v_paper,'truefalse',15,1, jsonb_build_object('stem','雅各為了娶心愛的拉結，答應服事拉班七年，新婚次日早晨才發現拉班把大女兒利亞給了他。'), to_jsonb(true)),
   (v_paper,'truefalse',16,1, jsonb_build_object('stem','酒政和膳長在獄中同夜各做了一夢，約瑟為他們解夢，三天後膳長官復原職，酒政則被掛在木頭上。'), to_jsonb(false)),
   (v_paper,'truefalse',17,1, jsonb_build_object('stem','建造巴別塔的人的主要目的是要分散到全地。'), to_jsonb(false)),
   (v_paper,'truefalse',18,1, jsonb_build_object('stem','雅各為拉結服事拉班七年，拉班就先把拉結給了他。'), to_jsonb(false)),
   (v_paper,'truefalse',19,1, jsonb_build_object('stem','雅各在毗努伊勒與神摔跤後，被稱為以色列。'), to_jsonb(true)),
   (v_paper,'truefalse',20,1, jsonb_build_object('stem','該隱是牧羊人，亞伯是種地的。'), to_jsonb(false));

  -- ══════════════════════════════ 二、單選題（answer_key: canonical 選項索引，0 起算）
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
   (v_paper,'single', 1,1, jsonb_build_object('stem','創世記的作者是誰？','options',jsonb_build_array('亞當','亞伯拉罕','約瑟','摩西')), to_jsonb(3)),
   (v_paper,'single', 2,1, jsonb_build_object('stem','聖經記載第一個向上帝獻祭的人是誰？','options',jsonb_build_array('亞當','塞特','亞伯拉罕','該隱')), to_jsonb(3)),
   (v_paper,'single', 3,1, jsonb_build_object('stem','聖經記載第一個「築壇」獻祭的人是誰？','options',jsonb_build_array('亞伯拉罕','以撒','雅各','挪亞')), to_jsonb(3)),
   (v_paper,'single', 4,1, jsonb_build_object('stem','根據聖經對創世記人物壽命的計算，亞當最遠能看到自己的第幾代子孫出生？','options',jsonb_build_array('以諾（第七代）','瑪土撒拉（第八代）','拉麥（第九代）','挪亞（第十代）')), to_jsonb(1)),
   (v_paper,'single', 5,1, jsonb_build_object('stem','根據聖經對創世記人物壽命的計算，哪一位人物在世的時間與亞伯拉罕、以撒、雅各都有重疊？','options',jsonb_build_array('挪亞','閃','他拉')), to_jsonb(1)),
   (v_paper,'single', 6,1, jsonb_build_object('stem','根據聖經對創世記人物壽命的計算，下列哪一位人物有最多「白髮人送黑髮人」的經歷？','options',jsonb_build_array('挪亞','閃','他拉')), to_jsonb(1)),
   (v_paper,'single', 7,1, jsonb_build_object('stem','出方舟後，挪亞做的第一件事情是什麼？','options',jsonb_build_array('尋找食物','建立房屋','築壇獻祭','生兒養女')), to_jsonb(2)),
   (v_paper,'single', 8,1, jsonb_build_object('stem','根據聖經記載，第一個獻上「什一奉獻」的人物是誰？','options',jsonb_build_array('亞伯','挪亞','亞伯拉罕','雅各')), to_jsonb(2)),
   (v_paper,'single', 9,1, jsonb_build_object('stem','根據聖經描述，第一個被明確記載「因信稱義」的人物是誰？','options',jsonb_build_array('挪亞','亞伯拉罕','以撒','雅各')), to_jsonb(1)),
   (v_paper,'single',10,1, jsonb_build_object('stem','在上帝毀滅所多瑪和蛾摩拉時，羅得帶著一家人逃離，哪一個人回頭看而變成鹽柱沒有存活？','options',jsonb_build_array('羅得','妻子','大女兒','小女兒')), to_jsonb(1)),
   (v_paper,'single',11,1, jsonb_build_object('stem','舊約亞伯拉罕上山獻以撒與福音書中耶穌進耶路撒冷，都使用了相同的坐騎，是什麼？','options',jsonb_build_array('馬','羊','騾','驢')), to_jsonb(3)),
   (v_paper,'single',12,1, jsonb_build_object('stem','亞伯拉罕的老僕人為以撒挑選妻子，向神禱告中所展現的考驗標準是什麼？','options',jsonb_build_array('容貌美麗','身材姣好','口齒清晰','好服事人（願主動打水給僕人與駱駝喝）')), to_jsonb(3)),
   (v_paper,'single',13,1, jsonb_build_object('stem','雅各為得父親以撒的祝福假扮以掃，哪件事情讓以撒起疑？','options',jsonb_build_array('衣服的香氣','身體的毛','烹飪的手藝','說話的聲音')), to_jsonb(3)),
   (v_paper,'single',14,1, jsonb_build_object('stem','下列哪一位「不是」利亞所生的兒子？','options',jsonb_build_array('流便','西緬','便雅憫','猶大')), to_jsonb(2)),
   (v_paper,'single',15,1, jsonb_build_object('stem','雅各何時改名叫「以色列」？','options',jsonb_build_array('以紅豆湯換取長子名分時','投靠拉班路上夢見天梯時','離開拉班回迦南路上在雅博渡口與天使摔跤後','兒子們報復示劍城之後')), to_jsonb(2)),
   (v_paper,'single',16,1, jsonb_build_object('stem','當兄長們企圖殺害約瑟時，誰先站出來提議將他丟進坑裡以保全他的性命？','options',jsonb_build_array('流便','利未','猶大','便雅憫')), to_jsonb(0)),
   (v_paper,'single',17,1, jsonb_build_object('stem','約瑟解法老之夢後，法老對此給予了什麼評價？','options',jsonb_build_array('約瑟有智慧與聰明','約瑟有治理的才能','約瑟有強大的團隊','約瑟有神的靈在他裏頭')), to_jsonb(3)),
   (v_paper,'single',18,1, jsonb_build_object('stem','約瑟的兄長們為了買糧，總共往返迦南與埃及之間幾次（進埃及買糧的次數）？','options',jsonb_build_array('一次','兩次','三次','四次')), to_jsonb(1)),
   (v_paper,'single',19,1, jsonb_build_object('stem','誰挺身而出自願留在埃及作僕人，以代替便雅憫平安返回？','options',jsonb_build_array('猶大','迦得','西布倫','流便')), to_jsonb(0)),
   (v_paper,'single',20,1, jsonb_build_object('stem','挪亞方舟在洪水退去後停留在何處？','options',jsonb_build_array('沙漠','亞拉臘山','以色列','埃及')), to_jsonb(1));

  -- ══════════════════════════════ 三、複選題（answer_key: 索引陣列；整組全對才給分）
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
   (v_paper,'multiple', 1,1, jsonb_build_object('stem','上帝造人（亞當）後，給人的吩咐與祝福是什麼？','options',jsonb_build_array('要生養眾多，遍滿地面','治理這地','管理海裡的魚、空中的鳥，和地上各樣行動的活物','工作與生活要有平衡')), jsonb_build_array(0,1,2)),
   (v_paper,'multiple', 2,1, jsonb_build_object('stem','聖經如何描述挪亞？','options',jsonb_build_array('行公義、好憐憫、存謙卑的心','與神同行','是個義人','是完全人')), jsonb_build_array(1,2,3)),
   (v_paper,'multiple', 3,1, jsonb_build_object('stem','亞伯拉罕跟以撒有哪些共同的經歷？','options',jsonb_build_array('遭遇嚴重的飢荒','都去過埃及以躲避飢荒','為求自保，謊稱妻子是「妹子」','妻子都曾面臨「不孕」的考驗')), jsonb_build_array(0,2,3)),
   (v_paper,'multiple', 4,1, jsonb_build_object('stem','上帝用哪些大自然的事物來比喻亞伯拉罕後裔的繁多？','options',jsonb_build_array('地上的塵土','天上的星','海邊的沙','葡萄園的葡萄')), jsonb_build_array(0,1,2)),
   (v_paper,'multiple', 5,1, jsonb_build_object('stem','雅各回迦南地面對以掃可能帶來的危險，他做了哪些應對措施？','options',jsonb_build_array('將隊伍分隊安排','預備牲畜為豐盛的禮物','謙卑自己向以掃俯伏下拜','將長子的名份歸還給以掃')), jsonb_build_array(0,1,2)),
   (v_paper,'multiple', 6,1, jsonb_build_object('stem','約瑟被賣去埃及後，歷任過哪些職務/角色？','options',jsonb_build_array('護衛長波提乏的管家','司獄管理囚犯的幫手','全埃及治理事務的宰相','埃及地方分區的省長')), jsonb_build_array(0,1,2)),
   (v_paper,'multiple', 7,1, jsonb_build_object('stem','關於巴別塔事件，哪些敘述正確？','options',jsonb_build_array('當時全地的人語言相同','人想建造城和塔，塔頂通天','人想傳揚自己的名','上帝變亂人的口音','人因此被聚集在同一座城，永不分散')), jsonb_build_array(0,1,2,3)),
   (v_paper,'multiple', 8,1, jsonb_build_object('stem','關於雅各的經歷，哪些正確？','options',jsonb_build_array('他曾用紅豆湯取得以掃的長子名分','他曾藉著欺騙取得以撒給長子的祝福','他在伯特利夢見通天的梯子','他曾與神摔跤，後被稱為以色列','他從未離開過迦南地')), jsonb_build_array(0,1,2,3)),
   (v_paper,'multiple', 9,1, jsonb_build_object('stem','關於約瑟被賣到埃及以前，哪些正確？','options',jsonb_build_array('雅各偏愛約瑟','雅各送給約瑟一件特別的彩衣','約瑟曾作夢，夢見禾捆和天上的星月向他下拜','約瑟的哥哥們因此嫉妒他','約瑟是雅各最小的兒子')), jsonb_build_array(0,1,2,3)),
   (v_paper,'multiple',10,1, jsonb_build_object('stem','下列哪些主題貫穿創世記？','options',jsonb_build_array('上帝創造並賦予人使命','人犯罪後仍需要上帝的憐憫與救贖','上帝藉著約與應許推進祂的計畫','上帝在人的罪惡與困境中仍掌管歷史','家庭衝突、饒恕與和好')), jsonb_build_array(0,1,2,3,4));

  -- ══════════════════════════════ 四、連連看（answer_key: { 左id: 右id }）
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
   (v_paper,'matching', 1,1, jsonb_build_object('stem','人物與事件',
     'left', jsonb_build_array(jsonb_build_object('id','L1','text','亞當'),jsonb_build_object('id','L2','text','挪亞'),jsonb_build_object('id','L3','text','約瑟'),jsonb_build_object('id','L4','text','亞伯拉罕')),
     'right',jsonb_build_array(jsonb_build_object('id','R1','text','解夢拯救埃及'),jsonb_build_object('id','R2','text','建造方舟'),jsonb_build_object('id','R3','text','犯罪後躲避神'),jsonb_build_object('id','R4','text','被神呼召離開本地、本族、父家'))),
     jsonb_build_object('L1','R3','L2','R2','L3','R1','L4','R4')),
   (v_paper,'matching', 2,1, jsonb_build_object('stem','地點與事件',
     'left', jsonb_build_array(jsonb_build_object('id','L1','text','伊甸園'),jsonb_build_object('id','L2','text','巴別'),jsonb_build_object('id','L3','text','伯特利'),jsonb_build_object('id','L4','text','所多瑪')),
     'right',jsonb_build_array(jsonb_build_object('id','R1','text','雅各夢見天梯'),jsonb_build_object('id','R2','text','亞當、夏娃犯罪'),jsonb_build_object('id','R3','text','人要建造通天的塔'),jsonb_build_object('id','R4','text','羅得居住的罪惡之城'))),
     jsonb_build_object('L1','R2','L2','R3','L3','R1','L4','R4')),
   (v_paper,'matching', 3,1, jsonb_build_object('stem','人物與關鍵事件',
     'left', jsonb_build_array(jsonb_build_object('id','L1','text','雅各'),jsonb_build_object('id','L2','text','約瑟'),jsonb_build_object('id','L3','text','亞伯'),jsonb_build_object('id','L4','text','挪亞')),
     'right',jsonb_build_array(jsonb_build_object('id','R1','text','獻上頭生羊群蒙悅納'),jsonb_build_object('id','R2','text','雅博渡口與神摔跤'),jsonb_build_object('id','R3','text','被賣到埃及'),jsonb_build_object('id','R4','text','遵命建造方舟'))),
     jsonb_build_object('L1','R2','L2','R3','L3','R1','L4','R4')),
   (v_paper,'matching', 4,1, jsonb_build_object('stem','雅各臨終前的祝福與兒子',
     'left', jsonb_build_array(jsonb_build_object('id','L1','text','出肥美的糧食'),jsonb_build_object('id','L2','text','圭必不離、君王后裔'),jsonb_build_object('id','L3','text','必追趕敵軍的腳跟'),jsonb_build_object('id','L4','text','泉旁多結果子的枝條、得天與深淵之福'),jsonb_build_object('id','L5','text','屈身臥在羊圈當中的強壯之驢')),
     'right',jsonb_build_array(jsonb_build_object('id','R1','text','亞設'),jsonb_build_object('id','R2','text','猶大'),jsonb_build_object('id','R3','text','迦得'),jsonb_build_object('id','R4','text','約瑟'),jsonb_build_object('id','R5','text','以薩迦'))),
     jsonb_build_object('L1','R1','L2','R2','L3','R3','L4','R4','L5','R5')),
   (v_paper,'matching', 5,1, jsonb_build_object('stem','人物／概念與主題配對（一）',
     'left', jsonb_build_array(jsonb_build_object('id','L1','text','挪亞'),jsonb_build_object('id','L2','text','亞伯拉罕'),jsonb_build_object('id','L3','text','麥基洗德'),jsonb_build_object('id','L4','text','以撒'),jsonb_build_object('id','L5','text','便雅憫'),jsonb_build_object('id','L6','text','以實瑪利'),jsonb_build_object('id','L7','text','撒拉'),jsonb_build_object('id','L8','text','約瑟'),jsonb_build_object('id','L9','text','迦南地'),jsonb_build_object('id','L10','text','巴別塔')),
     'right',jsonb_build_array(jsonb_build_object('id','R1','text','祭司與王'),jsonb_build_object('id','R2','text','應許流奶與蜜之地'),jsonb_build_object('id','R3','text','囚犯至宰相之逆境得勝'),jsonb_build_object('id','R4','text','亞伯拉罕的應許之子'),jsonb_build_object('id','R5','text','妾夏甲所生之長子'),jsonb_build_object('id','R6','text','耶和華立約之後裔源頭'),jsonb_build_object('id','R7','text','洪水世代中的義人全家得救'),jsonb_build_object('id','R8','text','雅各最小的第十二個兒子'),jsonb_build_object('id','R9','text','亞伯拉罕的原配妻子'),jsonb_build_object('id','R10','text','人類驕傲建造之塔'))),
     jsonb_build_object('L1','R7','L2','R6','L3','R1','L4','R4','L5','R8','L6','R5','L7','R9','L8','R3','L9','R2','L10','R10')),
   (v_paper,'matching', 6,1, jsonb_build_object('stem','人物／概念與主題配對（二）',
     'left', jsonb_build_array(jsonb_build_object('id','L1','text','為便雅憫在約瑟面前代求，願意代替弟弟留下'),jsonb_build_object('id','L2','text','以撒的妻子，曾在井旁為僕人和駱駝打水'),jsonb_build_object('id','L3','text','雅各所愛的妻子，約瑟的母親'),jsonb_build_object('id','L4','text','埃及的君王，作了七隻肥牛和七隻瘦牛的夢'),jsonb_build_object('id','L5','text','被該隱殺害的牧羊人'),jsonb_build_object('id','L6','text','曾與神摔跤，後來被稱為以色列'),jsonb_build_object('id','L7','text','亞伯拉罕的姪兒，曾住在所多瑪'),jsonb_build_object('id','L8','text','上帝所造的第一個男人'),jsonb_build_object('id','L9','text','第一個女人，亞當的妻子'),jsonb_build_object('id','L10','text','殺害兄弟亞伯的哥哥')),
     'right',jsonb_build_array(jsonb_build_object('id','R1','text','亞當'),jsonb_build_object('id','R2','text','夏娃'),jsonb_build_object('id','R3','text','該隱'),jsonb_build_object('id','R4','text','羅得'),jsonb_build_object('id','R5','text','利百加'),jsonb_build_object('id','R6','text','雅各'),jsonb_build_object('id','R7','text','拉結'),jsonb_build_object('id','R8','text','法老'),jsonb_build_object('id','R9','text','猶大'),jsonb_build_object('id','R10','text','亞伯'))),
     jsonb_build_object('L1','R9','L2','R5','L3','R7','L4','R8','L5','R10','L6','R6','L7','R4','L8','R1','L9','R2','L10','R3')),
   (v_paper,'matching', 7,1, jsonb_build_object('stem','人物與綽號／別名／新名字',
     'left', jsonb_build_array(jsonb_build_object('id','L1','text','亞伯蘭'),jsonb_build_object('id','L2','text','撒萊'),jsonb_build_object('id','L3','text','雅各'),jsonb_build_object('id','L4','text','以掃')),
     'right',jsonb_build_array(jsonb_build_object('id','R1','text','以色列'),jsonb_build_object('id','R2','text','亞伯拉罕'),jsonb_build_object('id','R3','text','以東'),jsonb_build_object('id','R4','text','撒拉'))),
     jsonb_build_object('L1','R2','L2','R4','L3','R1','L4','R3')),
   (v_paper,'matching', 8,1, jsonb_build_object('stem','人物與壽命',
     'left', jsonb_build_array(jsonb_build_object('id','L1','text','亞當'),jsonb_build_object('id','L2','text','挪亞'),jsonb_build_object('id','L3','text','亞伯拉罕'),jsonb_build_object('id','L4','text','以諾'),jsonb_build_object('id','L5','text','瑪土撒拉')),
     'right',jsonb_build_array(jsonb_build_object('id','R1','text','175歲'),jsonb_build_object('id','R2','text','930歲'),jsonb_build_object('id','R3','text','950歲'),jsonb_build_object('id','R4','text','365歲'),jsonb_build_object('id','R5','text','969歲'))),
     jsonb_build_object('L1','R2','L2','R3','L3','R1','L4','R4','L5','R5')),
   (v_paper,'matching', 9,1, jsonb_build_object('stem','父與子',
     'left', jsonb_build_array(jsonb_build_object('id','L1','text','挪亞'),jsonb_build_object('id','L2','text','亞伯拉罕'),jsonb_build_object('id','L3','text','希伯'),jsonb_build_object('id','L4','text','雅各')),
     'right',jsonb_build_array(jsonb_build_object('id','R1','text','以實馬利'),jsonb_build_object('id','R2','text','法勒'),jsonb_build_object('id','R3','text','閃'),jsonb_build_object('id','R4','text','約瑟'))),
     jsonb_build_object('L1','R3','L2','R1','L3','R2','L4','R4')),
   (v_paper,'matching',10,1, jsonb_build_object('stem','配偶',
     'left', jsonb_build_array(jsonb_build_object('id','L1','text','利百加'),jsonb_build_object('id','L2','text','撒拉'),jsonb_build_object('id','L3','text','拉結'),jsonb_build_object('id','L4','text','亞西納')),
     'right',jsonb_build_array(jsonb_build_object('id','R1','text','以撒'),jsonb_build_object('id','R2','text','雅各'),jsonb_build_object('id','R3','text','亞伯拉罕'),jsonb_build_object('id','R4','text','約瑟'))),
     jsonb_build_object('L1','R1','L2','R3','L3','R2','L4','R4'));

  -- ══════════════════════════════ 五、事件排序（answer_key: 依時間先後的 id 陣列）
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
   (v_paper,'ordering', 1,1, jsonb_build_object('stem','請依時間先後排列亞伯拉罕的生平事件',
     'items',jsonb_build_array(jsonb_build_object('id','E1','text','亞伯蘭改名亞伯拉罕'),jsonb_build_object('id','E2','text','羅得離開亞伯拉罕'),jsonb_build_object('id','E3','text','神與亞伯蘭立約（割禮之約）'),jsonb_build_object('id','E4','text','以撒出生'))),
     jsonb_build_array('E2','E3','E1','E4')),
   (v_paper,'ordering', 2,1, jsonb_build_object('stem','請依時間先後排列雅各的生平事件',
     'items',jsonb_build_array(jsonb_build_object('id','E1','text','騙取父親以撒的祝福'),jsonb_build_object('id','E2','text','以紅豆湯換取長子名分'),jsonb_build_object('id','E3','text','與利亞、拉結結婚'),jsonb_build_object('id','E4','text','雅博渡口與神摔跤'),jsonb_build_object('id','E5','text','伯特利夢見天梯'))),
     jsonb_build_array('E2','E1','E5','E3','E4')),
   (v_paper,'ordering', 3,1, jsonb_build_object('stem','請依時間先後排列約瑟的生平事件',
     'items',jsonb_build_array(jsonb_build_object('id','E1','text','被弟兄賣到埃及'),jsonb_build_object('id','E2','text','被波提乏妻子誣告下監'),jsonb_build_object('id','E3','text','為酒政解夢，但酒政出獄後忘記約瑟'),jsonb_build_object('id','E4','text','為法老解夢並被立為埃及宰相'),jsonb_build_object('id','E5','text','雅各全家遷居埃及歌珊地'))),
     jsonb_build_array('E1','E2','E3','E4','E5')),
   (v_paper,'ordering', 4,1, jsonb_build_object('stem','請將下列創世記重大歷史事件按發生順序排列',
     'items',jsonb_build_array(jsonb_build_object('id','E1','text','約瑟被賣到埃及'),jsonb_build_object('id','E2','text','挪亞建方舟'),jsonb_build_object('id','E3','text','亞伯拉罕與神立約'),jsonb_build_object('id','E4','text','以撒的誕生'),jsonb_build_object('id','E5','text','雅各得以撒的祝福'))),
     jsonb_build_array('E2','E3','E4','E5','E1')),
   (v_paper,'ordering', 5,1, jsonb_build_object('stem','上帝創造的次序',
     'items',jsonb_build_array(jsonb_build_object('id','E1','text','造日、月、眾星'),jsonb_build_object('id','E2','text','造人'),jsonb_build_object('id','E3','text','造光'),jsonb_build_object('id','E4','text','造旱地、海和植物'),jsonb_build_object('id','E5','text','造天空'),jsonb_build_object('id','E6','text','安息'),jsonb_build_object('id','E7','text','造飛鳥、海中生物和地上的走獸'))),
     jsonb_build_array('E3','E5','E4','E1','E7','E2','E6')),
   (v_paper,'ordering', 6,1, jsonb_build_object('stem','創世記太古史重要事件排序',
     'items',jsonb_build_array(jsonb_build_object('id','E1','text','巴別塔變亂口音'),jsonb_build_object('id','E2','text','亞當夏娃被逐出伊甸園'),jsonb_build_object('id','E3','text','挪亞出方舟築壇獻祭'),jsonb_build_object('id','E4','text','該隱殺亞伯'),jsonb_build_object('id','E5','text','洪水氾濫全地'))),
     jsonb_build_array('E2','E4','E5','E3','E1')),
   (v_paper,'ordering', 7,1, jsonb_build_object('stem','神與人立約的先後順序',
     'items',jsonb_build_array(jsonb_build_object('id','E1','text','彩虹之約'),jsonb_build_object('id','E2','text','割禮作為立約記號'),jsonb_build_object('id','E3','text','女人後裔的應許'),jsonb_build_object('id','E4','text','神應許亞伯蘭萬國得福'))),
     jsonb_build_array('E3','E1','E4','E2')),
   (v_paper,'ordering', 8,1, jsonb_build_object('stem','創世記中家族的遷徙',
     'items',jsonb_build_array(jsonb_build_object('id','E1','text','雅各全家下埃及'),jsonb_build_object('id','E2','text','亞當夏娃離開伊甸園'),jsonb_build_object('id','E3','text','亞伯拉罕離開本地本族父家'),jsonb_build_object('id','E4','text','挪亞一家離開方舟'))),
     jsonb_build_array('E2','E4','E3','E1')),
   (v_paper,'ordering', 9,1, jsonb_build_object('stem','創世記重要的文明事件',
     'items',jsonb_build_array(jsonb_build_object('id','E1','text','建造方舟'),jsonb_build_object('id','E2','text','發明樂器與鑄造銅鐵器'),jsonb_build_object('id','E3','text','建造巴別塔'),jsonb_build_object('id','E4','text','建造第一座城'))),
     jsonb_build_array('E4','E2','E1','E3')),
   (v_paper,'ordering',10,1, jsonb_build_object('stem','創世記中耶穌基督預表的出現順序',
     'items',jsonb_build_array(jsonb_build_object('id','E1','text','上帝為亞當夏娃用皮子所剪裁出的衣服'),jsonb_build_object('id','E2','text','挪亞造的方舟'),jsonb_build_object('id','E3','text','替代以撒的公羊'),jsonb_build_object('id','E4','text','雅各的天梯'))),
     jsonb_build_array('E1','E2','E3','E4'));

  -- ══════════════════════════════ 六、簡答題（answer_key = NULL，人工評分；payload 帶暫定參考答案與評分要點）
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
   (v_paper,'shortanswer', 1,10, jsonb_build_object(
     'stem','若從創世記50章就架構上分為兩大部分，各大部分下的結構及主題各為何，並請列出章數起迄？',
     'referenceAnswer','（暫定）創世記可分兩大部分：一、太古史／原始歷史（1–11 章），主題為創造、墮落、洪水、列國分散；結構：創造（1–2）、墮落與該隱（3–4）、亞當後裔至洪水（5–9）、列國表與巴別塔（10–11）。二、族長史（12–50 章），主題為神揀選一個家族、藉約與應許展開救贖；結構：亞伯拉罕（12–25:18）、以撒與雅各（25:19–36）、約瑟（37–50）。（也有以 11:27「他拉的後代」作第二部分起點的分法。）',
     'rubric', jsonb_build_array('正確分為兩大部分並標明章數起迄（4 分）','第一部分（1–11）主題與結構說明正確（3 分）','第二部分（12–50）主題與結構說明正確（3 分）'),
     'maxPoints',10), NULL),
   (v_paper,'shortanswer', 2,10, jsonb_build_object(
     'stem','創世記與以色列這個國家的關係如何──從其起源、歷史、身份……來看？',
     'referenceAnswer','（暫定）起源：以色列民族源自神呼召亞伯拉罕，經以撒、雅各（雅各改名以色列），其十二子成為十二支派的源頭。歷史：創世記末雅各全家七十人下埃及，為出埃及記中的民族形成鋪路。身份：以色列是神所揀選、與之立約的子民，承受迦南地的應許，並要成為萬國得福的管道。創世記為以色列提供家譜、神學根基（揀選、約、應許）與應許之地的依據。',
     'rubric', jsonb_build_array('起源：亞伯拉罕—以撒—雅各／以色列—十二支派（4 分）','歷史：下埃及、為出埃及與民族形成鋪路（3 分）','身份：揀選之民、立約、應許之地、萬國得福（3 分）'),
     'maxPoints',10), NULL),
   (v_paper,'shortanswer', 3,10, jsonb_build_object(
     'stem','從基督教信仰的角度如何來詮釋創世記？',
     'referenceAnswer','（暫定）創世記是救贖歷史的開端：神是創造主，人按神形象受造、領受使命（1–2）；罪與死藉人的悖逆進入世界（3），而 3:15「女人的後裔」是首個福音預示，指向基督勝過撒但。此後神藉挪亞之約、亞伯拉罕之約推進救贖，應許萬國因亞伯拉罕的後裔得福（加 3:8、16 應用於基督）。多處被視為基督的預表：皮子的衣服（代罪遮蓋）、方舟（救恩）、被獻的以撒與替代的公羊（父獻子、代贖）、雅各的天梯（約 1:51）、約瑟（受苦後得榮、拯救全家）。全書確立神的主權、人的墮落與恩典救贖的必要。',
     'rubric', jsonb_build_array('創造與人的地位／使命（2 分）','墮落與 3:15 原始福音（3 分）','約與應許指向基督（含新約引用）（3 分）','基督預表之舉例（2 分）'),
     'maxPoints',10), NULL);

  RAISE NOTICE 'Seeded official Genesis exam paper: %', v_paper;
END
$seed$;

-- 確認（題數應為 73：20/20/10/10/10/3）
SELECT p.id, p.title, p.status, p.mode, p.total_points,
       p.announcement_published,
       (SELECT count(*) FROM public.exam_questions q WHERE q.paper_id = p.id)                          AS q_total,
       (SELECT count(*) FROM public.exam_questions q WHERE q.paper_id = p.id AND q.section='truefalse')   AS tf,
       (SELECT count(*) FROM public.exam_questions q WHERE q.paper_id = p.id AND q.section='single')      AS single,
       (SELECT count(*) FROM public.exam_questions q WHERE q.paper_id = p.id AND q.section='multiple')    AS multiple,
       (SELECT count(*) FROM public.exam_questions q WHERE q.paper_id = p.id AND q.section='matching')    AS matching,
       (SELECT count(*) FROM public.exam_questions q WHERE q.paper_id = p.id AND q.section='ordering')    AS ordering,
       (SELECT count(*) FROM public.exam_questions q WHERE q.paper_id = p.id AND q.section='shortanswer') AS shortanswer
FROM public.exam_papers p
WHERE p.title = '聖經速讀測驗_創世記';
