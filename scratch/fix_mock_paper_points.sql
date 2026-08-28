-- ============================================================================
-- scratch/fix_mock_paper_points.sql
-- 修「模擬測驗卷」自動計分錯誤：先前 seed 把每題 points 寫死成 1，
-- 但你在「題型與配分」設的是每題 10 分 → 分數短少 10 倍。
--
-- 這支：① 把每題 points 依 exam_papers.sections[].pointsPer 對正
--        ② 清掉這份測試卷的作答紀錄（測試卷才行），讓你重新作答拿到正確分數
--
-- Supabase SQL editor 執行。
-- ============================================================================
DO $fix$
DECLARE
  v_title TEXT := '模擬測驗卷';
  v_paper UUID;
  n INT;
BEGIN
  SELECT id INTO v_paper FROM public.exam_papers WHERE title = v_title;
  IF v_paper IS NULL THEN RAISE EXCEPTION '找不到 %', v_title; END IF;

  -- ① 每題配分對正「題型與配分」設定
  UPDATE public.exam_questions q
  SET points = COALESCE((
    SELECT (e ->> 'pointsPer')::numeric
    FROM public.exam_papers p, jsonb_array_elements(p.sections) e
    WHERE p.id = q.paper_id AND e ->> 'type' = q.section
  ), q.points)
  WHERE q.paper_id = v_paper;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'points 已更新：% 題', n;

  -- ② 清掉舊作答（僅測試卷；exam_answers 會 cascade）
  IF (SELECT mode FROM public.exam_papers WHERE id = v_paper) = 'test' THEN
    DELETE FROM public.exam_attempts WHERE paper_id = v_paper;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE '已清除作答紀錄：% 筆', n;
  ELSE
    RAISE NOTICE '非測試卷，未清除作答紀錄';
  END IF;
END
$fix$;

-- 確認每題配分
SELECT section, position, points
FROM public.exam_questions
WHERE paper_id = (SELECT id FROM public.exam_papers WHERE title = '模擬測驗卷')
ORDER BY section, position;
