-- ============================================================================
-- scratch/seed_mock_paper_questions.sql
-- 寫入「題目 + 答案」到你已建好的模擬卷（標題：模擬測驗卷）。
--   題型一～五各 2 題，共 10 題，每題 1 分。
--   ★ 只動 exam_questions，完全不碰 exam_papers 的任何設定。
--   會先刪掉這份卷現有的題目再重寫（可重跑）。
--
-- Supabase SQL editor 執行即可。
-- ============================================================================
DO $seed$
DECLARE
  v_title TEXT := '模擬測驗卷';
  v_paper UUID;
BEGIN
  SELECT id INTO v_paper FROM public.exam_papers WHERE title = v_title;
  IF v_paper IS NULL THEN
    RAISE EXCEPTION '找不到標題為 % 的試卷', v_title;
  END IF;

  DELETE FROM public.exam_questions WHERE paper_id = v_paper;

  -- ── 一、是非題（answer_key: true=O 對 / false=X 錯）──
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
   (v_paper,'truefalse',1,1, jsonb_build_object('stem','神吩咐挪亞把潔淨的牲畜每樣帶七公七母、不潔淨的每樣帶一公一母進方舟。'), to_jsonb(true)),
   (v_paper,'truefalse',2,1, jsonb_build_object('stem','雅各的十二個兒子都是在巴旦亞蘭（哈蘭）出生的。'), to_jsonb(false));

  -- ── 二、單選題（answer_key: 選項索引，0 起算）──
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
   (v_paper,'single',1,1, jsonb_build_object('stem','撒拉去世後，亞伯拉罕續娶的妻子名叫什麼？',
     'options',jsonb_build_array('夏甲','基土拉','利百加','底拿')), to_jsonb(1)),
   (v_paper,'single',2,1, jsonb_build_object('stem','約瑟去世時享年幾歲？',
     'options',jsonb_build_array('一百一十歲','一百二十歲','一百三十歲','一百四十七歲')), to_jsonb(0));

  -- ── 三、複選題（answer_key: 索引陣列；整組全對才給分）──
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

  -- ── 四、連連看（answer_key: { 左id: 右id }）──
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

  -- ── 五、事件排序（answer_key: 依時間先後的 id 陣列）──
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

  -- 每題配分以「試卷設定 → 題型與配分」(exam_papers.sections[].pointsPer) 為準，
  -- 不用上面 INSERT 寫死的 1。這樣自動計分才會跟你設定的配分一致。
  UPDATE public.exam_questions q
  SET points = COALESCE((
    SELECT (e ->> 'pointsPer')::numeric
    FROM public.exam_papers p, jsonb_array_elements(p.sections) e
    WHERE p.id = q.paper_id AND e ->> 'type' = q.section
  ), q.points)
  WHERE q.paper_id = v_paper;

  RAISE NOTICE 'Inserted 10 questions (with answers) into paper %; points synced from sections config', v_paper;
END
$seed$;

SELECT section, count(*) AS n
FROM public.exam_questions
WHERE paper_id = (SELECT id FROM public.exam_papers WHERE title = '模擬測驗卷')
GROUP BY section ORDER BY section;
