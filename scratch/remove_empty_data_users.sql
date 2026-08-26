-- STEP 2：確認 STEP 1（find_empty_data_users.sql）名單正確無誤後，才執行這一段
-- ────────────────────────────────────────────────────────────
-- 判斷條件必須跟 find_empty_data_users.sql 完全一致，否則 STEP 1 看到的
-- 「符合條件人數」跟這裡實際刪除的人數會對不上。
BEGIN;

-- 用一張暫存表把目標 id 先「凍結」下來，避免刪除過程中
-- 因為關聯資料被砍掉，導致下面的條件判斷結果中途改變。
CREATE TEMP TABLE _cleanup_target_ids AS
SELECT p.id
FROM public.profiles p
WHERE p.is_demo = false
  AND p.role_id = '10000000-0000-4000-8000-000000000001'
  AND (
    NULLIF(btrim(p.name), '') IS NULL
    OR p.name IN ('NLC User', '尚未取得姓名', '未命名使用者', '教會肢體')
    OR NULLIF(btrim(p.pastoral_zone), '') IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.reading_team_members rtm WHERE rtm.user_id = p.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.reading_plans rp WHERE rp.user_id = p.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.reading_logs rl WHERE rl.user_id = p.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.devotional_notes dn WHERE dn.user_id = p.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.verse_notes vn WHERE vn.user_id = p.id
  );

-- 再次確認人數跟 STEP 1 看到的一致：
SELECT count(*) AS 即將刪除人數 FROM _cleanup_target_ids;

-- 最後一道防線：就算前面的條件有漏洞，這裡再次直接擋下任何一位
-- 「其實有讀經紀錄」的人，寧可讓這次清理少刪一點，也不要重演誤刪。
DO $$
DECLARE
  leaked_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO leaked_count
  FROM _cleanup_target_ids t
  WHERE EXISTS (SELECT 1 FROM public.reading_logs WHERE user_id = t.id)
     OR EXISTS (SELECT 1 FROM public.reading_plans WHERE user_id = t.id)
     OR EXISTS (SELECT 1 FROM public.reading_team_members WHERE user_id = t.id)
     OR EXISTS (SELECT 1 FROM public.devotional_notes WHERE user_id = t.id)
     OR EXISTS (SELECT 1 FROM public.verse_notes WHERE user_id = t.id);

  IF leaked_count > 0 THEN
    RAISE EXCEPTION '安全檢查失敗：% 筆目標資料其實有讀經/計畫/筆記紀錄，已中止（不會刪除任何資料）。請重新檢查條件。', leaked_count;
  END IF;
END $$;

-- highlights.user_id 沒有外鍵/CASCADE（純文字欄位），要手動清：
DELETE FROM public.highlights h
WHERE h.user_id IN (SELECT id::text FROM _cleanup_target_ids);

-- 刪除 profiles 這筆資料時，以下資料表都設定了 ON DELETE CASCADE，
-- 資料庫會自動連帶清乾淨，不用另外處理：
--   user_identities、reading_plans、reading_logs、devotional_notes、
--   devotional_likes、devotional_comments、care_reminders（寄件+收件）、
--   reading_teams（隊長）／reading_team_members、verse_notes
-- issue_reports.user_id 是 ON DELETE SET NULL，回報紀錄會保留、只是變成匿名，
-- 不會被砍掉。
DELETE FROM public.profiles p
WHERE p.id IN (SELECT id FROM _cleanup_target_ids);

-- 最後檢查一次：這裡應該要是 0
SELECT count(*) AS 應該歸零 FROM public.profiles p
WHERE p.id IN (SELECT id FROM _cleanup_target_ids);

-- 一切正常才下這行，正式生效：
COMMIT;

-- 如果任何一步看起來不對，改成執行這行來取消，資料不會有任何變動：
-- ROLLBACK;
