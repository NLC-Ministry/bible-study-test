-- 0122 部署後只讀驗證（不修改任何資料）

-- 1. 新欄位應全部存在
SELECT table_name,column_name,data_type
FROM information_schema.columns
WHERE table_schema='public' AND(
  (table_name='exam_papers' AND column_name IN('practice_retake_enabled','closed_at','closed_by','close_reason'))
  OR(table_name='exam_attempts' AND column_name IN('attempt_kind','attempt_no','official_attempt_id','practice_acknowledged_at','practice_completed_at'))
)
ORDER BY table_name,column_name;

-- 2. 每人一筆 official / practice 的唯一索引應存在
SELECT indexname,indexdef FROM pg_indexes
WHERE schemaname='public' AND indexname IN('idx_exam_attempts_one_official','idx_exam_attempts_one_practice');

-- 3. 核心 RPC / helper 應存在
SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN(
  '_exam_close_paper','_exam_close_expired_papers','exam_start_practice',
  'exam_mark_practice_complete','exam_get_practice_records','exam_get_practice_detail'
)
ORDER BY p.proname;

-- 4. 每分鐘自動關閉排程應有一筆 active=true
SELECT jobid,jobname,schedule,command,active
FROM cron.job WHERE jobname='exam-auto-close';

-- 5. 舊資料應全部被回填成 official；此查詢應回 0
SELECT COUNT(*) AS invalid_existing_attempts
FROM public.exam_attempts
WHERE attempt_kind<>'official' AND official_attempt_id IS NULL;

-- 6. 目前正式/練習筆數（僅供核對）
SELECT pr.title,pr.mode,a.attempt_kind,COUNT(*) AS attempts
FROM public.exam_attempts a JOIN public.exam_papers pr ON pr.id=a.paper_id
GROUP BY pr.id,pr.title,pr.mode,a.attempt_kind
ORDER BY pr.title,pr.mode,a.attempt_kind;

