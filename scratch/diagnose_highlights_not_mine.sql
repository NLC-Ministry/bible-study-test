-- 診斷用：只查詢，不會修改任何資料。
-- 目的：分清楚「不是我的螢光紀錄」是哪一種狀況：
--   A) 我的帳號(profile)底下真的被寫入了別人的紀錄（例如帳號連結出過問題，
--      多個登入被誤連到同一個 profile，或有人的操作被誤記到你的帳號）
--   B) 後端查詢真的把「別人 profile 底下」的資料也回傳給前端了（純粹是
--      查詢範圍沒有正確限制在自己身上）

-- ── 第 1 步：找出你自己的 profile id ──────────────────────────────────────
-- 把 'YOUR_EMAIL' 換成你登入用的 email。
SELECT id, name, email, role_id
FROM public.profiles
WHERE email = 'YOUR_EMAIL';

-- ── 第 2 步：這個 profile 底下總共有幾筆螢光紀錄、跨了幾本書卷 ──────────────
-- 把下面的 'YOUR_PROFILE_ID' 換成第 1 步查到的 id。
-- 如果數字明顯比你自己實際標記過的多很多，就偏向 A（帳號被混到別人的操作）。
SELECT COUNT(*) AS total_rows,
       COUNT(DISTINCT book) AS distinct_books,
       MIN(created_at) AS earliest,
       MAX(created_at) AS latest
FROM public.highlights
WHERE user_id = 'YOUR_PROFILE_ID';

-- ── 第 3 步：關鍵測試——挑一筆你確定「不是我標的」的紀錄，查這個書卷/章/節
--     在整張表裡實際上有幾筆、分別是誰標的 ────────────────────────────────
-- 把 book/chapter/verse 換成你在「我的螢光＆筆記」畫面看到的那一筆。
SELECT h.id, h.user_id, p.name AS owner_name, p.email AS owner_email,
       h.color, h.created_at, h.updated_at
FROM public.highlights h
LEFT JOIN public.profiles p ON p.id = h.user_id
WHERE h.book = '書卷名稱' AND h.chapter = 章數 AND h.verse = 節數;
-- 如果這裡只查到「一筆」、owner 就是你自己 → 代表資料庫裡這筆本來就記在你
--   帳號底下，是 A 的情況（帳號連結/操作歸屆有問題，不是查詢外洩）。
-- 如果查到「兩筆或以上」、owner 是別人 → 代表資料庫裡本來就有別人的那一筆，
--   是你的畫面把別人的那筆也顯示出來了，是 B 的情況（查詢範圍沒鎖好）。

-- ── 第 4 步（只在懷疑 A 時才需要）：這個 profile 底下連結了幾個登入身分 ──
-- 如果 count > 1，代表有不只一個登入方式/帳號被連到同一個 profile，
-- 那些「不是你自己操作」的紀錄有可能是透過另一個身分寫進來的。
SELECT ui.provider, ui.provider_user_id, ui.created_at
FROM public.user_identities ui
WHERE ui.profile_id = 'YOUR_PROFILE_ID';
