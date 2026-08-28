-- ============================================================================
-- scratch/seed_exam_genesis_mock.sql
-- 建立「模擬試題卷」：聖經速讀模擬測驗_創世記
--   · 題型一～五各 2 題（共 10 題，每題 1 分，滿分 10）；沒有簡答題
--   · 題目內容與正式版（聖經速讀測驗_創世記）不重複
--   · mode = 'test'、status = 'published'、announcement_published = TRUE，
--     開放時間設很寬 → 佈署後管理員可立刻用「實際作答（走完整流程）」測試
--   · answer_key 已依創世記內容填好（仍建議自行 check 一次）
--
-- 前置：migrations 0096–0106 已套用、nlc-data 已部署、feature flag speed_reading_exam 已開。
-- 在 Supabase SQL editor 執行。重跑前先清舊的：
--   DELETE FROM public.exam_papers WHERE title = '聖經速讀模擬測驗_創世記';
-- ============================================================================
DO $seed$
DECLARE
  v_paper UUID;
BEGIN
  DELETE FROM public.exam_papers WHERE title = '聖經速讀模擬測驗_創世記';

  INSERT INTO public.exam_papers (
    title, description, mode, status,
    open_at, close_at, duration_minutes, total_points,
    pledge, sections, section_targets,
    announcement, announcement_published, announced_at, published_at
  ) VALUES (
    '聖經速讀模擬測驗_創世記',
    '創世記模擬練習卷：題型一～五各 2 題，每題 1 分。內容不與正式測驗重複，供事前熟悉作答介面與流程使用。',
    'test', 'published',
    NOW() - INTERVAL '1 minute', NOW() + INTERVAL '365 days', 30, 10,
    jsonb_build_object(
      'openText', '這是模擬練習卷，用來熟悉作答介面。正式測驗開放時間為 8/30 零時起 24 小時內。',
      'rules', jsonb_build_array(
        '可以 OPEN 紙本聖經──作答過程中，除了紙本聖經，我不會借助其他工具答題。',
        '這是模擬卷，作答結果僅供自己參考，不列入正式成績。',
        '不管個人或三人六人組隊，我都是獨立作答，不與其他人討論題目內容。'
      ),
      'consentTemplate', '{name} 清楚這是模擬練習，並會以正式測驗的態度完成。'
    ),
    jsonb_build_array(
      jsonb_build_object('type','truefalse','count',2,'pointsPer',1),
      jsonb_build_object('type','single',   'count',2,'pointsPer',1),
      jsonb_build_object('type','multiple', 'count',2,'pointsPer',1),
      jsonb_build_object('type','matching', 'count',2,'pointsPer',1),
      jsonb_build_object('type','ordering', 'count',2,'pointsPer',1)
    ),
    jsonb_build_object('truefalse',2,'single',2,'multiple',2,'matching',2,'ordering',2),
    jsonb_build_object(
      'headline', '創世記模擬練習卷',
      'body', '題型一～五各 2 題，用來事前熟悉作答介面與計時流程。作答結果不列入正式成績。',
      'ctaLabel', '開始模擬'
    ),
    TRUE, NOW(), NOW()
  )
  RETURNING id INTO v_paper;

  -- ══════════════════════════════ 一、是非題
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
   (v_paper,'truefalse',1,1, jsonb_build_object('stem','神吩咐挪亞把潔淨的牲畜每樣帶七公七母、不潔淨的每樣帶一公一母進方舟。'), to_jsonb(true)),
   (v_paper,'truefalse',2,1, jsonb_build_object('stem','雅各的十二個兒子都是在巴旦亞蘭（哈蘭）出生的。'), to_jsonb(false));

  -- ══════════════════════════════ 二、單選題（answer_key = 選項索引，0 起算）
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
   (v_paper,'single',1,1, jsonb_build_object('stem','撒拉去世後，亞伯拉罕續娶的妻子名叫什麼？',
     'options',jsonb_build_array('夏甲','基土拉','利百加','底拿')), to_jsonb(1)),
   (v_paper,'single',2,1, jsonb_build_object('stem','約瑟去世時享年幾歲？',
     'options',jsonb_build_array('一百一十歲','一百二十歲','一百三十歲','一百四十七歲')), to_jsonb(0));

  -- ══════════════════════════════ 三、複選題（answer_key = 索引陣列；整組全對才給分）
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
   (v_paper,'multiple',1,1, jsonb_build_object('stem','關於約瑟治理埃及（創世記 41、47 章），下列哪些正確？',
     'options',jsonb_build_array(
       '法老把手上的戒指戴在約瑟手上，給他穿細麻衣、戴金鏈',
       '約瑟侍立在法老面前的時候，年三十歲',
       '法老給約瑟起埃及名「撒發那忒巴內亞」，並將安城祭司波提非拉的女兒亞西納賜他為妻',
       '七個荒年間，約瑟無償把糧食發給埃及百姓',
       '約瑟為法老解夢，說七個豐年之後必接著七個荒年')),
     jsonb_build_array(0,1,2,4)),
   (v_paper,'multiple',2,1, jsonb_build_object('stem','關於所多瑪、蛾摩拉被毀（創世記 18、19 章），下列哪些正確？',
     'options',jsonb_build_array(
       '亞伯拉罕為城裡的義人向神求情，從五十個一路減到十個',
       '兩位天使進所多瑪，羅得請他們到家裡住宿',
       '耶和華將硫磺與火從天上降與所多瑪和蛾摩拉',
       '羅得的女婿們一聽見要毀城，就立刻跟著逃命',
       '神記念亞伯拉罕，就打發羅得從傾覆之中出來')),
     jsonb_build_array(0,1,2,4));

  -- ══════════════════════════════ 四、連連看（answer_key = { 左id: 右id }）
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
   (v_paper,'matching',1,1, jsonb_build_object('stem','創世記中的「夢」與作夢的人',
     'left', jsonb_build_array(
       jsonb_build_object('id','L1','text','夢見一個梯子立在地上、梯頂通天，有神的使者上去下來'),
       jsonb_build_object('id','L2','text','夢見田間禾捆，別人的禾捆都圍著向自己的禾捆下拜'),
       jsonb_build_object('id','L3','text','夢見七隻肥牛從河裡上來，又有七隻瘦牛把牠們吃盡'),
       jsonb_build_object('id','L4','text','夢見三根葡萄枝發芽開花結果，把葡萄汁擠在杯中遞給主人')),
     'right',jsonb_build_array(
       jsonb_build_object('id','R1','text','雅各'),
       jsonb_build_object('id','R2','text','少年約瑟'),
       jsonb_build_object('id','R3','text','埃及法老'),
       jsonb_build_object('id','R4','text','關在監裡的酒政'))),
     jsonb_build_object('L1','R1','L2','R2','L3','R3','L4','R4')),
   (v_paper,'matching',2,1, jsonb_build_object('stem','雅各的兒子與生母',
     'left', jsonb_build_array(
       jsonb_build_object('id','L1','text','流便'),
       jsonb_build_object('id','L2','text','但'),
       jsonb_build_object('id','L3','text','迦得'),
       jsonb_build_object('id','L4','text','約瑟')),
     'right',jsonb_build_array(
       jsonb_build_object('id','R1','text','利亞'),
       jsonb_build_object('id','R2','text','辟拉（拉結的使女）'),
       jsonb_build_object('id','R3','text','悉帕（利亞的使女）'),
       jsonb_build_object('id','R4','text','拉結'))),
     jsonb_build_object('L1','R1','L2','R2','L3','R3','L4','R4'));

  -- ══════════════════════════════ 五、事件排序（answer_key = 依時間先後的 id 陣列）
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
   (v_paper,'ordering',1,1, jsonb_build_object('stem','請依經文記載，排列約瑟與眾兄弟在埃及相認的經過（創世記 42–45 章）',
     'items',jsonb_build_array(
       jsonb_build_object('id','E3','text','哥哥們帶著便雅憫再下埃及去見約瑟'),
       jsonb_build_object('id','E1','text','十個哥哥下埃及買糧，向約瑟俯伏下拜'),
       jsonb_build_object('id','E5','text','猶大挺身而出，願意代替便雅憫留下作奴僕'),
       jsonb_build_object('id','E2','text','約瑟認出哥哥卻裝作陌生人，指控他們是奸細，並扣下西緬'),
       jsonb_build_object('id','E6','text','約瑟屏退左右，向眾弟兄表明「我是約瑟」'),
       jsonb_build_object('id','E4','text','約瑟吩咐把銀杯藏進便雅憫的糧袋裡'))),
     jsonb_build_array('E1','E2','E3','E4','E5','E6')),
   (v_paper,'ordering',2,1, jsonb_build_object('stem','請依經文記載，排列洪水的時間刻度（創世記 7–8 章）',
     'items',jsonb_build_array(
       jsonb_build_object('id','E4','text','七月十七日，方舟停在亞拉臘山上'),
       jsonb_build_object('id','E2','text','大淵的泉源都裂開、天上的窗戶敞開，大雨下了四十晝夜'),
       jsonb_build_object('id','E6','text','挪亞一家與眾生物出方舟，挪亞為耶和華築壇獻祭'),
       jsonb_build_object('id','E1','text','神吩咐挪亞全家與動物進方舟，七天後洪水來到地上'),
       jsonb_build_object('id','E3','text','水勢浩大，在地上共一百五十天'),
       jsonb_build_object('id','E5','text','挪亞開了方舟的窗戶，放出一隻烏鴉'))),
     jsonb_build_array('E1','E2','E3','E4','E5','E6'));

  RAISE NOTICE 'Seeded mock Genesis exam paper: %', v_paper;
END
$seed$;

-- 確認（題數應為 10：2/2/2/2/2）
SELECT p.id, p.title, p.status, p.mode, p.total_points, p.announcement_published,
       (SELECT count(*) FROM public.exam_questions q WHERE q.paper_id = p.id) AS q_total
FROM public.exam_papers p
WHERE p.title = '聖經速讀模擬測驗_創世記';
