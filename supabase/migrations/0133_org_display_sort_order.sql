-- 0133_org_display_sort_order.sql
-- 補上大區／牧區的顯示排序（sort_order 欄位在 0001 就已經存在，但從未真正
-- 賦值過，一直維持預設的 0）。這裡填入教會指定的固定順序，純粹只影響
-- 「統計畫面上大區/牧區要用什麼順序列出來」，不影響任何排行榜/名次計算——
-- 名次一律還是照分數/章數排，跟這個欄位無關。
--
-- nlc-session 在會員登入時對 great_regions/pastoral_zones 做的 upsert
-- （見 supabase/functions/nlc-session/index.ts resolveLocalOrgLinks）payload
-- 裡不含 sort_order，PostgREST 的 upsert 在衝突時只會更新 payload 裡出現的
-- 欄位，所以這裡設定的值不會被之後的登入同步覆蓋掉；只有「全新建立」的
-- 大區/牧區才會沿用資料表預設值 0。

BEGIN;

WITH great_region_order(name, display_order) AS (
  VALUES
    ('東區', 1), ('西區', 2), ('南區', 3), ('北區', 4), ('青少年', 5),
    ('慶典', 6), ('創藝', 7), ('花蓮', 8), ('桃園', 9), ('未設定', 10)
)
UPDATE public.great_regions gr
SET sort_order = o.display_order,
    updated_at = NOW()
FROM great_region_order o
WHERE gr.name = o.name;

WITH pastoral_zone_order(name, display_order) AS (
  VALUES
    ('大安1', 1), ('大安2', 2), ('大安3', 3), ('大安4', 4), ('大安6', 5),
    ('大安7', 6), ('大安8', 7), ('大安9', 8), ('大安10', 9), ('大安11', 10),
    ('大安12', 11), ('中正1', 12), ('中正2', 13), ('中正3', 14), ('中正4', 15),
    ('中正5', 16), ('中山1', 17), ('中山2', 18), ('中山3', 19), ('中山5', 20),
    ('信義2', 21), ('信義3', 22), ('士林', 23), ('松山1', 24), ('松山2', 25),
    ('南港', 26), ('內湖', 27), ('文山', 28), ('新烏1', 29), ('新烏2', 30),
    ('新烏3', 31), ('新烏4', 32), ('中永和', 33), ('三重', 34), ('青少年教會', 35),
    ('慶典1', 36), ('慶典2', 37), ('創藝', 38), ('新莊1', 39), ('新莊2', 40),
    ('新莊3', 41), ('花蓮', 42), ('桃園', 43), ('未設定牧區', 44)
)
UPDATE public.pastoral_zones pz
SET sort_order = o.display_order,
    updated_at = NOW()
FROM pastoral_zone_order o
WHERE pz.name = o.name;

COMMIT;
