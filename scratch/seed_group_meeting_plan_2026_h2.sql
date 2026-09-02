-- 建立「小組聚會經營（2026 7-12月）」這份 group_meeting 週計畫 + 27 週內容。
-- 前置：migration 0148_group_meeting_plan.sql 已跑（plan_kind 允許 'group_meeting'）。
--
-- 日期不綁死：畫面顯示用 date_label（「7/1–7/2」照教會材料）；日曆以「一週 Sun–Sat」呈現，
-- 第 N 週的日～六 = start_date + (week_index-1)*7 ~ +6。
-- start_date = 2026-06-28（第 1 週那個「日～六」週的週日；7/1 是週三）。
-- end_date   = 2027-01-02（第 27 週的週六）。
--
-- 27 週已預先建好、且 is_published=TRUE（內容已核對）。之後要改用管理端「小組聚會」逐週編輯。
-- 七月第 3 週（7/15–7/16）是 Pastor Greg 特會 → 無經文 / 詩歌，只放備註。
-- 九月整月沒有奉獻經文。
--
-- Supabase Dashboard → SQL Editor 執行。冪等（ON CONFLICT DO UPDATE）。

INSERT INTO public.global_plans
  (id, name, description, start_date, end_date, target_books, plan_kind, is_hidden, rules)
VALUES (
  '00000000-0000-0000-9e21-000000000001',
  '小組聚會經營（2026 7-12月）',
  '每週小組聚會的信息經文、奉獻經文與敬拜讚美詩歌。',
  DATE '2026-06-28',
  DATE '2027-01-02',
  ARRAY['馬太福音','馬可福音','路加福音','約翰福音','使徒行傳','創世記','出埃及記','尼希米記','歷代志上','撒母耳記下','希伯來書','雅各書']::TEXT[],
  'group_meeting',
  FALSE,
  jsonb_build_object('groupMeetingFutureOpen', FALSE)
)
ON CONFLICT (id) DO UPDATE SET
  name         = EXCLUDED.name,
  description  = EXCLUDED.description,
  start_date   = EXCLUDED.start_date,
  end_date     = EXCLUDED.end_date,
  target_books = EXCLUDED.target_books,
  plan_kind    = EXCLUDED.plan_kind,
  rules        = public.global_plans.rules || EXCLUDED.rules,
  updated_at   = NOW();

INSERT INTO public.plan_group_meeting_weeks
  (global_plan_id, week_index, date_label, month_theme, message_topic, message_passage_label,
   message_passage_refs, offering_topic, offering_passage_label, offering_passage_refs,
   songs, note, is_published)
VALUES
  ('00000000-0000-0000-9e21-000000000001', 1, '7/1–7/2', '耶穌被賣的那一夜', '設立主聖餐', '馬太福音 26:17-29', '[{"book":"馬太福音","chapterFrom":26,"verseFrom":17,"chapterTo":26,"verseTo":29}]'::jsonb, '擘餅與分杯', '馬太福音 26:26-28', '[{"book":"馬太福音","chapterFrom":26,"verseFrom":26,"chapterTo":26,"verseTo":28}]'::jsonb, '[{"code":"C3","title":"讚美救主耶穌"},{"code":"C44","title":"頌讚全能上帝"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 2, '7/8–7/9', '耶穌被賣的那一夜', '為門徒洗腳', '約翰福音 13:1-20', '[{"book":"約翰福音","chapterFrom":13,"verseFrom":1,"chapterTo":13,"verseTo":20}]'::jsonb, '愛他們到底', '約翰福音 13:1', '[{"book":"約翰福音","chapterFrom":13,"verseFrom":1,"chapterTo":13,"verseTo":1}]'::jsonb, '[{"code":"C61","title":"被救贖的百姓"},{"code":"C4","title":"每當我瞻仰祢"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 3, '7/15–7/16', '耶穌被賣的那一夜', '', '', '[]'::jsonb, '', '', '[]'::jsonb, '[]'::jsonb, 'Pastor Greg 特會（本週無小組經文與詩歌單）', TRUE),
  ('00000000-0000-0000-9e21-000000000001', 4, '7/22–7/23', '耶穌被賣的那一夜', '客西馬尼園的禱告', '馬可福音 14:32-42', '[{"book":"馬可福音","chapterFrom":14,"verseFrom":32,"chapterTo":14,"verseTo":42}]'::jsonb, '照祢的意思', '馬可福音 14:36', '[{"book":"馬可福音","chapterFrom":14,"verseFrom":36,"chapterTo":14,"verseTo":36}]'::jsonb, '[{"code":"C18","title":"先求祂的國"},{"code":"C38","title":"更新我心意"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 5, '7/29–7/30', '耶穌被賣的那一夜', '被猶大出賣與被捕', '路加福音 22:47-54', '[{"book":"路加福音","chapterFrom":22,"verseFrom":47,"chapterTo":22,"verseTo":54}]'::jsonb, '耶穌被出賣', '路加福音 22:47-48', '[{"book":"路加福音","chapterFrom":22,"verseFrom":47,"chapterTo":22,"verseTo":48}]'::jsonb, '[{"code":"C26","title":"耶穌的愛真是奇妙"},{"code":"C14","title":"親近更親近"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 6, '8/5–8/6', '聖靈充滿', '聖靈的洗—人人都要受靈洗', '使徒行傳 11:4-18', '[{"book":"使徒行傳","chapterFrom":11,"verseFrom":4,"chapterTo":11,"verseTo":18}]'::jsonb, '聖靈降在人身上', '使徒行傳 11:15-16', '[{"book":"使徒行傳","chapterFrom":11,"verseFrom":15,"chapterTo":11,"verseTo":16}]'::jsonb, '[{"code":"C36","title":"聖靈我們真歡迎祢"},{"code":"C59","title":"在主裡的時刻"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 7, '8/12–8/13', '聖靈充滿', '聖靈充滿—保羅被聖靈充滿', '使徒行傳 13:6-12', '[{"book":"使徒行傳","chapterFrom":13,"verseFrom":6,"chapterTo":13,"verseTo":12}]'::jsonb, '稀奇就信了', '使徒行傳 13:12', '[{"book":"使徒行傳","chapterFrom":13,"verseFrom":12,"chapterTo":13,"verseTo":12}]'::jsonb, '[{"code":"C58","title":"一群大能的子民"},{"code":"C27","title":"開啟雙眼"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 8, '8/19–8/20', '聖靈充滿', '方言禱告—聖靈所賜的口才', '使徒行傳 2:1-11', '[{"book":"使徒行傳","chapterFrom":2,"verseFrom":1,"chapterTo":2,"verseTo":11}]'::jsonb, '聖靈如大風吹過', '使徒行傳 2:1-2', '[{"book":"使徒行傳","chapterFrom":2,"verseFrom":1,"chapterTo":2,"verseTo":2}]'::jsonb, '[{"code":"C5","title":"耶穌耶穌我心樂歌"},{"code":"C1","title":"舉目仰望"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 9, '8/26–8/27', '聖靈充滿', '滿有聖靈—有大能的司提反', '使徒行傳 6:5-10', '[{"book":"使徒行傳","chapterFrom":6,"verseFrom":5,"chapterTo":6,"verseTo":10}]'::jsonb, '神的道興旺起來', '使徒行傳 6:7', '[{"book":"使徒行傳","chapterFrom":6,"verseFrom":7,"chapterTo":6,"verseTo":7}]'::jsonb, '[{"code":"C42","title":"我知道我救贖主活著"},{"code":"C35","title":"犧牲的愛"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 10, '9/2–9/3', '興起建造', '奉獻的服事', '創世記 18:1-5', '[{"book":"創世記","chapterFrom":18,"verseFrom":1,"chapterTo":18,"verseTo":5}]'::jsonb, '', '', '[]'::jsonb, '[{"code":"D30","title":"我已被贖回"},{"code":"D5","title":"萬國都要來讚美主"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 11, '9/9–9/10', '興起建造', '國度公民權', '出埃及記 30:11-16', '[{"book":"出埃及記","chapterFrom":30,"verseFrom":11,"chapterTo":30,"verseTo":16}]'::jsonb, '', '', '[]'::jsonb, '[{"code":"D26","title":"偉大奇妙神"},{"code":"D21","title":"我要屈膝敬拜"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 12, '9/16–9/17', '興起建造', '一手拿兵器', '尼希米記 4:7-17', '[{"book":"尼希米記","chapterFrom":4,"verseFrom":7,"chapterTo":4,"verseTo":17}]'::jsonb, '', '', '[]'::jsonb, '[{"code":"D42","title":"我必須有主"},{"code":"D6","title":"超越過一切"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 13, '9/23–9/24', '興起建造', '阿珥楠服事', '歷代志上 21:20-24', '[{"book":"歷代志上","chapterFrom":21,"verseFrom":20,"chapterTo":21,"verseTo":24}]'::jsonb, '', '', '[]'::jsonb, '[{"code":"D67","title":"我就是來讚美主"},{"code":"D52","title":"神的聖靈"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 14, '9/30–10/1', '興起建造', '迎回主約櫃', '撒母耳記下 6:1-12', '[{"book":"撒母耳記下","chapterFrom":6,"verseFrom":1,"chapterTo":6,"verseTo":12}]'::jsonb, '', '', '[]'::jsonb, '[{"code":"D33","title":"我是主羊"},{"code":"D65","title":"我要歌頌"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 15, '10/7–10/8', '基督的反合性', '驢駒與君王', '約翰福音 12:12-16', '[{"book":"約翰福音","chapterFrom":12,"verseFrom":12,"chapterTo":12,"verseTo":16}]'::jsonb, '出去迎接耶穌', '約翰福音 12:12-13', '[{"book":"約翰福音","chapterFrom":12,"verseFrom":12,"chapterTo":12,"verseTo":13}]'::jsonb, '[{"code":"E3","title":"我們高舉雙手"},{"code":"E12","title":"我們是你的百姓"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 16, '10/14–10/15', '基督的反合性', '死與生', '約翰福音 12:23-26', '[{"book":"約翰福音","chapterFrom":12,"verseFrom":23,"chapterTo":12,"verseTo":26}]'::jsonb, '結出許多子粒', '約翰福音 12:24', '[{"book":"約翰福音","chapterFrom":12,"verseFrom":24,"chapterTo":12,"verseTo":24}]'::jsonb, '[{"code":"E14","title":"我用主的愛"},{"code":"E1","title":"你是榮耀君王"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 17, '10/21–10/22', '基督的反合性', '失敗與勝利', '約翰福音 12:30-33', '[{"book":"約翰福音","chapterFrom":12,"verseFrom":30,"chapterTo":12,"verseTo":33}]'::jsonb, '主耶穌被高舉', '約翰福音 12:32', '[{"book":"約翰福音","chapterFrom":12,"verseFrom":32,"chapterTo":12,"verseTo":32}]'::jsonb, '[{"code":"E16","title":"靠著耶穌聖名"},{"code":"E5","title":"他已被尊崇"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 18, '10/28–10/29', '基督的反合性', '隱藏與顯露', '約翰福音 12:34-43', '[{"book":"約翰福音","chapterFrom":12,"verseFrom":34,"chapterTo":12,"verseTo":43}]'::jsonb, '成為光明之子', '約翰福音 12:36', '[{"book":"約翰福音","chapterFrom":12,"verseFrom":36,"chapterTo":12,"verseTo":36}]'::jsonb, '[{"code":"E15","title":"感謝我們復活主"},{"code":"E9","title":"惟有你"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 19, '11/4–11/5', '國度的倍增', '倍增基本款—麥子的比喻', '馬太福音 13:1-9', '[{"book":"馬太福音","chapterFrom":13,"verseFrom":1,"chapterTo":13,"verseTo":9}]'::jsonb, '奉獻有百倍收成', '馬太福音 13:8-9', '[{"book":"馬太福音","chapterFrom":13,"verseFrom":8,"chapterTo":13,"verseTo":9}]'::jsonb, '[{"code":"G8","title":"與耶穌同行"},{"code":"G47","title":"擁戴祂為王"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 20, '11/11–11/12', '國度的倍增', '分辨真與假—稗子的比喻', '馬太福音 13:24-30', '[{"book":"馬太福音","chapterFrom":13,"verseFrom":24,"chapterTo":13,"verseTo":30}]'::jsonb, '小心奉獻的稗子', '馬太福音 13:24-25', '[{"book":"馬太福音","chapterFrom":13,"verseFrom":24,"chapterTo":13,"verseTo":25}]'::jsonb, '[{"code":"G45","title":"神真是我力量"},{"code":"G20","title":"我敬拜你全能神"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 21, '11/18–11/19', '國度的倍增', '倍增進階款—芥菜種比喻', '馬太福音 13:31-32', '[{"book":"馬太福音","chapterFrom":13,"verseFrom":31,"chapterTo":13,"verseTo":32}]'::jsonb, '像芥菜種的奉獻', '馬太福音 13:31-32', '[{"book":"馬太福音","chapterFrom":13,"verseFrom":31,"chapterTo":13,"verseTo":32}]'::jsonb, '[{"code":"G51","title":"盡心盡力來敬拜"},{"code":"G21","title":"神要開道路"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 22, '11/25–11/26', '國度的倍增', '倍增吸引力—寶貝與珠子', '馬太福音 13:44-46', '[{"book":"馬太福音","chapterFrom":13,"verseFrom":44,"chapterTo":13,"verseTo":46}]'::jsonb, '付上代價的奉獻', '馬太福音 13:44', '[{"book":"馬太福音","chapterFrom":13,"verseFrom":44,"chapterTo":13,"verseTo":44}]'::jsonb, '[{"code":"G33","title":"來慶賀"},{"code":"G1","title":"我願你來"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 23, '12/2–12/3', '在信的人凡事都能', '神喜悅有信心的人', '希伯來書 11:1-7', '[{"book":"希伯來書","chapterFrom":11,"verseFrom":1,"chapterTo":11,"verseTo":7}]'::jsonb, '信他賞賜尋求的人', '希伯來書 11:6', '[{"book":"希伯來書","chapterFrom":11,"verseFrom":6,"chapterTo":11,"verseTo":6}]'::jsonb, '[{"code":"A4","title":"來高聲唱"},{"code":"A9","title":"我站立敬畏你"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 24, '12/9–12/10', '在信的人凡事都能', '我信不足求主幫助', '馬可福音 9:14-29', '[{"book":"馬可福音","chapterFrom":9,"verseFrom":14,"chapterTo":9,"verseTo":29}]'::jsonb, '在信的人凡事都能', '馬可福音 9:23', '[{"book":"馬可福音","chapterFrom":9,"verseFrom":23,"chapterTo":9,"verseTo":23}]'::jsonb, '[{"code":"A25","title":"敬拜主"},{"code":"A12","title":"歌頌祢聖名"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 25, '12/16–12/17', '在信的人凡事都能', '律法和先知的道理', '馬太福音 7:7-12', '[{"book":"馬太福音","chapterFrom":7,"verseFrom":7,"chapterTo":7,"verseTo":12}]'::jsonb, '凡祈求的就給你們', '馬太福音 7:7', '[{"book":"馬太福音","chapterFrom":7,"verseFrom":7,"chapterTo":7,"verseTo":7}]'::jsonb, '[{"code":"A35","title":"神掌權"},{"code":"A15","title":"讓我靈自由"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 26, '12/23–12/24', '在信的人凡事都能', '要有信心要有行為', '雅各書 2:14-26', '[{"book":"雅各書","chapterFrom":2,"verseFrom":14,"chapterTo":2,"verseTo":26}]'::jsonb, '信心必定要有行為', '雅各書 2:17', '[{"book":"雅各書","chapterFrom":2,"verseFrom":17,"chapterTo":2,"verseTo":17}]'::jsonb, '[{"code":"A10","title":"興起歡唱"},{"code":"A8","title":"主祢本為大"}]'::jsonb, NULL, TRUE),
  ('00000000-0000-0000-9e21-000000000001', 27, '12/30–12/31', '在信的人凡事都能', '要情詞迫切的直求', '路加福音 11:5-13', '[{"book":"路加福音","chapterFrom":11,"verseFrom":5,"chapterTo":11,"verseTo":13}]'::jsonb, '照他所需要的給他', '路加福音 11:8', '[{"book":"路加福音","chapterFrom":11,"verseFrom":8,"chapterTo":11,"verseTo":8}]'::jsonb, '[{"code":"A32","title":"速開心門"},{"code":"A3","title":"神羔羊"}]'::jsonb, NULL, TRUE)
ON CONFLICT (global_plan_id, week_index) DO UPDATE SET
  date_label             = EXCLUDED.date_label,
  month_theme            = EXCLUDED.month_theme,
  message_topic          = EXCLUDED.message_topic,
  message_passage_label  = EXCLUDED.message_passage_label,
  message_passage_refs   = EXCLUDED.message_passage_refs,
  offering_topic         = EXCLUDED.offering_topic,
  offering_passage_label = EXCLUDED.offering_passage_label,
  offering_passage_refs  = EXCLUDED.offering_passage_refs,
  songs                  = EXCLUDED.songs,
  note                   = EXCLUDED.note,
  is_published           = EXCLUDED.is_published,
  updated_at             = NOW();

SELECT week_index, date_label, month_theme, message_passage_label, offering_passage_label,
       jsonb_array_length(songs) AS songs
FROM public.plan_group_meeting_weeks
WHERE global_plan_id = '00000000-0000-0000-9e21-000000000001'
ORDER BY week_index;
