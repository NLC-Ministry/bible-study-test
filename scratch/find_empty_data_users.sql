-- STEP 1：預覽名單（安全，不會真的刪除任何東西，看完自動 ROLLBACK）
-- ────────────────────────────────────────────────────────────
-- 這支取代先前只用「牧區是否空白」+「有沒有加入第一階段官方計畫」
-- 來判斷「空白帳號」的版本。舊版排除條件太窄，只保護：
--   1) 已加入 reading_team_members（小家/小組）的人
--   2) reading_plans 剛好掛在「第一階段」這一個 global_plan_id/preset_key 的人
-- 沒有檢查使用者是不是「真的讀過任何一節經文」，也沒檢查小組以外的個人
-- 自訂計畫（global_plan_id 可以是 NULL），導致真正在讀經、只是牧區還沒被
-- Member Hub 同步好，或用個人自訂計畫的正常會友也會被誤判成空白資料。
--
-- 這一版改成：只要有任何 reading_logs／reading_plans／devotional_notes／
-- verse_notes 紀錄，一律視為「有在用」，不列入候選名單；且預覽會直接秀出
-- 閱讀紀錄筆數與最後閱讀時間，讓人工複核時看得到這個關鍵安全訊號。
BEGIN;

WITH target_profiles AS (
  SELECT p.id, p.name, p.email, p.pastoral_zone, p.great_region, p.small_group,
         p.is_active, p.created_at
  FROM public.profiles p
  WHERE p.is_demo = false
    AND p.role_id = '10000000-0000-4000-8000-000000000001' -- 只鎖定一般會友，絕不動到幹部/管理員角色
    AND (
      NULLIF(btrim(p.name), '') IS NULL
      OR p.name IN ('NLC User', '尚未取得姓名', '未命名使用者', '教會肢體')
      OR NULLIF(btrim(p.pastoral_zone), '') IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.reading_team_members rtm WHERE rtm.user_id = p.id
    )
    AND NOT EXISTS (
      -- 不再只認第一階段那一個 global_plan_id/preset_key，
      -- 只要有任何一筆 reading_plans（包含個人自訂計畫）就不算空白。
      SELECT 1 FROM public.reading_plans rp WHERE rp.user_id = p.id
    )
    AND NOT EXISTS (
      -- 最直接的安全訊號：這個人有沒有真的讀過經文。
      SELECT 1 FROM public.reading_logs rl WHERE rl.user_id = p.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.devotional_notes dn WHERE dn.user_id = p.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.verse_notes vn WHERE vn.user_id = p.id
    )
)
SELECT count(*) AS 符合條件人數 FROM target_profiles;

-- 把上面那行的數字看過一遍，覺得數量合理再往下看完整名單：
WITH target_profiles AS (
  SELECT p.id, p.name, p.email, p.pastoral_zone, p.great_region, p.small_group,
         p.is_active, p.created_at
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
    )
)
SELECT
  tp.*,
  -- 就算上面的 NOT EXISTS 都已經排除掉有紀錄的人，這裡還是把數字秀出來，
  -- 讓人工複核時能親眼確認「這幾欄應該都是 0」，而不是憑空信任篩選條件。
  (SELECT COUNT(*) FROM public.reading_logs WHERE user_id = tp.id) AS reading_log_count,
  (SELECT MAX(read_at) FROM public.reading_logs WHERE user_id = tp.id) AS last_read_at,
  (SELECT COUNT(*) FROM public.reading_plans WHERE user_id = tp.id) AS reading_plan_count,
  (SELECT COUNT(*) FROM public.devotional_notes WHERE user_id = tp.id) AS devotional_note_count,
  (SELECT COUNT(*) FROM public.verse_notes WHERE user_id = tp.id) AS verse_note_count
FROM target_profiles tp
ORDER BY tp.created_at;

-- 看完名單，不管結果如何，先 ROLLBACK（這一步本來就不該真的改資料）：
ROLLBACK;
