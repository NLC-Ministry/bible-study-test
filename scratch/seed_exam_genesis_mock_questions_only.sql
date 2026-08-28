-- ============================================================================
-- scratch/seed_exam_genesis_mock_questions_only.sql
-- 只寫入「題目」到你已經建好的模擬試卷（不含答案 answer_key = NULL）。
--   題型一～五各 2 題，共 10 題，每題 1 分。
--   答案之後在後台「題庫編輯」逐題補（或另跑一支 UPDATE）。
--
-- 使用前：把 v_title 改成你那份模擬卷的實際標題。
-- 會先刪掉這份卷現有的題目再重寫（方便重跑）——若你已在後台手動加過題目，請注意。
-- ============================================================================
DO $seed$
DECLARE
  v_title TEXT := '聖經速讀模擬測驗_創世記';   -- ← 改成你的模擬卷標題
  v_paper UUID;
BEGIN
  SELECT id INTO v_paper FROM public.exam_papers WHERE title = v_title;
  IF v_paper IS NULL THEN
    RAISE EXCEPTION '找不到標題為 % 的試卷，請先確認 v_title', v_title;
  END IF;

  DELETE FROM public.exam_questions WHERE paper_id = v_paper;

  -- ── 一、是非題（payload 只有 stem；answer_key 留 NULL）──
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
   (v_paper,'truefalse',1,1, jsonb_build_object('stem','神吩咐挪亞把潔淨的牲畜每樣帶七公七母、不潔淨的每樣帶一公一母進方舟。'), NULL),
   (v_paper,'truefalse',2,1, jsonb_build_object('stem','雅各的十二個兒子都是在巴旦亞蘭（哈蘭）出生的。'), NULL);

  -- ── 二、單選題（payload: stem + options）──
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
   (v_paper,'single',1,1, jsonb_build_object('stem','撒拉去世後，亞伯拉罕續娶的妻子名叫什麼？',
     'options',jsonb_build_array('夏甲','基土拉','利百加','底拿')), NULL),
   (v_paper,'single',2,1, jsonb_build_object('stem','約瑟去世時享年幾歲？',
     'options',jsonb_build_array('一百一十歲','一百二十歲','一百三十歲','一百四十七歲')), NULL);

  -- ── 三、複選題（payload: stem + options）──
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
   (v_paper,'multiple',1,1, jsonb_build_object('stem','關於約瑟治理埃及（創世記 41、47 章），下列哪些正確？',
     'options',jsonb_build_array(
       '法老把手上的戒指戴在約瑟手上，給他穿細麻衣、戴金鏈',
       '約瑟侍立在法老面前的時候，年三十歲',
       '法老給約瑟起埃及名「撒發那忒巴內亞」，並將安城祭司波提非拉的女兒亞西納賜他為妻',
       '七個荒年間，約瑟無償把糧食發給埃及百姓',
       '約瑟為法老解夢，說七個豐年之後必接著七個荒年')), NULL),
   (v_paper,'multiple',2,1, jsonb_build_object('stem','關於所多瑪、蛾摩拉被毀（創世記 18、19 章），下列哪些正確？',
     'options',jsonb_build_array(
       '亞伯拉罕為城裡的義人向神求情，從五十個一路減到十個',
       '兩位天使進所多瑪，羅得請他們到家裡住宿',
       '耶和華將硫磺與火從天上降與所多瑪和蛾摩拉',
       '羅得的女婿們一聽見要毀城，就立刻跟著逃命',
       '神記念亞伯拉罕，就打發羅得從傾覆之中出來')), NULL);

  -- ── 四、連連看（payload: stem + left[] + right[]）──
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
       jsonb_build_object('id','R4','text','關在監裡的酒政'))), NULL),
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
       jsonb_build_object('id','R4','text','拉結'))), NULL);

  -- ── 五、事件排序（payload: stem + items[]）──
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
   (v_paper,'ordering',1,1, jsonb_build_object('stem','請依經文記載，排列約瑟與眾兄弟在埃及相認的經過（創世記 42–45 章）',
     'items',jsonb_build_array(
       jsonb_build_object('id','E3','text','哥哥們帶著便雅憫再下埃及去見約瑟'),
       jsonb_build_object('id','E1','text','十個哥哥下埃及買糧，向約瑟俯伏下拜'),
       jsonb_build_object('id','E5','text','猶大挺身而出，願意代替便雅憫留下作奴僕'),
       jsonb_build_object('id','E2','text','約瑟認出哥哥卻裝作陌生人，指控他們是奸細，並扣下西緬'),
       jsonb_build_object('id','E6','text','約瑟屏退左右，向眾弟兄表明「我是約瑟」'),
       jsonb_build_object('id','E4','text','約瑟吩咐把銀杯藏進便雅憫的糧袋裡'))), NULL),
   (v_paper,'ordering',2,1, jsonb_build_object('stem','請依經文記載，排列洪水的時間刻度（創世記 7–8 章）',
     'items',jsonb_build_array(
       jsonb_build_object('id','E4','text','七月十七日，方舟停在亞拉臘山上'),
       jsonb_build_object('id','E2','text','大淵的泉源都裂開、天上的窗戶敞開，大雨下了四十晝夜'),
       jsonb_build_object('id','E6','text','挪亞一家與眾生物出方舟，挪亞為耶和華築壇獻祭'),
       jsonb_build_object('id','E1','text','神吩咐挪亞全家與動物進方舟，七天後洪水來到地上'),
       jsonb_build_object('id','E3','text','水勢浩大，在地上共一百五十天'),
       jsonb_build_object('id','E5','text','挪亞開了方舟的窗戶，放出一隻烏鴉'))), NULL);

  RAISE NOTICE 'Inserted 10 questions (no answer_key) into paper %', v_paper;
END
$seed$;

SELECT section, count(*)
FROM public.exam_questions
WHERE paper_id = (SELECT id FROM public.exam_papers WHERE title = '聖經速讀模擬測驗_創世記')
GROUP BY section ORDER BY section;
