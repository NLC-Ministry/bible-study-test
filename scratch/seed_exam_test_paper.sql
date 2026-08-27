-- ============================================================================
-- scratch/seed_exam_test_paper.sql
-- 在 Supabase SQL editor 執行：建立一份「測試模式、已發佈、現在開放」的小型大測驗
-- （每型 1〜2 題），讓「計劃管理 → 大測驗 → 以我的帳號預覽作答」可以整段跑通。
--
-- 前置：migration 0096 已套用、nlc-data 已部署、feature flag speed_reading_exam 已開。
-- 這支腳本用 SQL editor 的 superuser 直接寫表，不經 RPC 權限層。
-- 重跑前先清掉舊的：DELETE FROM public.exam_papers WHERE title = '大測驗（P1 測試卷）';
-- ============================================================================
DO $seed$
DECLARE
  v_paper UUID;
BEGIN
  INSERT INTO public.exam_papers (
    title, description, mode, status, open_at, close_at,
    duration_minutes, total_points, pledge, section_targets, published_at
  ) VALUES (
    '大測驗（P1 測試卷）',
    '每型 1〜2 題的小卷，用來驗證作答流程。',
    'test', 'published',
    NOW() - INTERVAL '1 minute',        -- 已開放
    NOW() + INTERVAL '24 hours',         -- 24 小時後關閉
    75, 17,
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
    jsonb_build_object(
      'truefalse', 2, 'single', 2, 'multiple', 1,
      'matching', 1, 'ordering', 1, 'shortanswer', 1
    ),
    NOW()
  )
  RETURNING id INTO v_paper;

  -- 一、是非題（answer_key = true / false）
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
    (v_paper, 'truefalse', 1, 1,
     jsonb_build_object('stem', '上帝在造萬物的第四天創造了太陽、月亮和眾星。'), to_jsonb(true)),
    (v_paper, 'truefalse', 2, 1,
     jsonb_build_object('stem', '以撒是亞伯拉罕的第一個兒子。'), to_jsonb(false));

  -- 二、單選題（answer_key = canonical 選項索引）
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
    (v_paper, 'single', 1, 1,
     jsonb_build_object('stem', '創世記的作者是誰？',
       'options', jsonb_build_array('亞當', '亞伯拉罕', '約瑟', '摩西')), to_jsonb(3)),
    (v_paper, 'single', 2, 1,
     jsonb_build_object('stem', '挪亞方舟在洪水退去後停留在何處？',
       'options', jsonb_build_array('沙漠', '亞拉臘山', '以色列', '埃及')), to_jsonb(1));

  -- 三、複選題（answer_key = 索引陣列；整組全對才給分）
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
    (v_paper, 'multiple', 1, 1,
     jsonb_build_object('stem', '上帝造人（亞當）後，給人的吩咐與祝福是什麼？',
       'options', jsonb_build_array(
         '要生養眾多，遍滿地面', '治理這地',
         '管理海裡的魚、空中的鳥，和地上各樣行動的活物', '工作與生活要有平衡')),
     jsonb_build_array(0, 1, 2));

  -- 四、連連看（answer_key = { 左id: 右id }）
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
    (v_paper, 'matching', 1, 1,
     jsonb_build_object('stem', '人物與事件配對',
       'left', jsonb_build_array(
         jsonb_build_object('id','L1','text','約瑟'),
         jsonb_build_object('id','L2','text','挪亞'),
         jsonb_build_object('id','L3','text','亞伯拉罕')),
       'right', jsonb_build_array(
         jsonb_build_object('id','R1','text','建造方舟'),
         jsonb_build_object('id','R2','text','解夢拯救埃及'),
         jsonb_build_object('id','R3','text','被神呼召離開本地、本族、父家'))),
     jsonb_build_object('L1','R2','L2','R1','L3','R3'));

  -- 五、事件排序（answer_key = 依時間先後的 id 陣列）
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
    (v_paper, 'ordering', 1, 1,
     jsonb_build_object('stem', '請依聖經記載的時間先後排列',
       'items', jsonb_build_array(
         jsonb_build_object('id','E1','text','創造天地'),
         jsonb_build_object('id','E2','text','挪亞洪水'),
         jsonb_build_object('id','E3','text','巴別塔'),
         jsonb_build_object('id','E4','text','出埃及'))),
     jsonb_build_array('E1','E2','E3','E4'));

  -- 六、簡答題（answer_key = NULL，人工評分；payload 帶參考答案與評分要點）
  INSERT INTO public.exam_questions (paper_id, section, position, points, payload, answer_key) VALUES
    (v_paper, 'shortanswer', 1, 10,
     jsonb_build_object(
       'stem', '請簡述「因信稱義」的意義，並舉一處經文佐證。',
       'referenceAnswer', '人不能靠行為在神面前被稱為義，乃是藉著信靠耶穌基督的救贖，白白得稱為義（羅3:23-24、弗2:8-9）。',
       'rubric', jsonb_build_array('說明不靠行為／靠恩典（3分）', '說明藉信基督（4分）', '正確引用一處經文（3分）'),
       'maxPoints', 10),
     NULL);

  RAISE NOTICE 'Seeded exam paper %', v_paper;
END
$seed$;

-- 確認
SELECT p.id, p.title, p.status, p.mode, p.open_at, p.close_at,
       (SELECT count(*) FROM public.exam_questions q WHERE q.paper_id = p.id) AS questions
FROM public.exam_papers p
WHERE p.title = '大測驗（P1 測試卷）';
