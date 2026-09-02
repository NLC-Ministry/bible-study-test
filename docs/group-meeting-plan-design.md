# 小組聚會經營 — 週計畫

> 狀態：**已實作，未部署 / 未 commit**（2026-09-03，版本 `20260903_group_meeting_plan`）。
> 交付：`supabase/migrations/0148_group_meeting_plan.sql`、`nlc-data/index.ts`（`GROUP_MEETING_RPC_FUNCTIONS`）、
> `js/db.js`（`_callGroupMeetingRpc` + 6 wrapper + flag allowedKeys + `groupMeetingFutureOpen`）、
> `js/modules/plan.js`（`isGroupMeetingFeatureEnabled` / `isGroupMeetingPlanVisibleToUser` / `isGroupMeetingPlanDevMode` /
> `previewGroupMeetingPlanAsMember` / `renderGroupMeetingViewer` + `showGroupMeetingViewerRoot` / `exitGroupMeetingViewer`；
> 探索 filter、卡片 render 用 `isViewerPlan` / `viewerDevMode`、`enterPlanDetailState` 分支）、
> `js/modules/admin.js`（功能開關 `admin-group-meeting-feature-*`、`ADMIN_SECTIONS` `group-meeting`、
> `renderAdminGroupMeetingPlan` 逐週表單）、`index.html`（toggle row + `#admin-section-group-meeting`）、
> `index.css`（`.group-meeting-view*` / `.gm-week-chip*`）、`scratch/seed_group_meeting_plan_2026_h2.sql`（27 週，`is_published=TRUE`）。
> build + 1091 tests pass。`campaign-stage-release-control.test` 的 source 斷言從 `isDevotional` 改成 `isViewerPlan`。
> 未做 runtime 驗證。

## 部署順序
1. SQL editor 跑 `0148_group_meeting_plan.sql`
2. SQL editor 跑 `scratch/seed_group_meeting_plan_2026_h2.sql`
3. **重新部署 nlc-data**（不然 6 支 RPC 被擋 `forbidden_rpc`）
4. 部署前端
5. （可選）管理 → 小組聚會 → 核對 27 週內容
6. 要對會友開放時：系統管理 → 功能開放設定 → 開「小組聚會週計畫」

---

## 原始設計（供參考）

> 使用者已貼完整內容（見本檔末「已解析的 27 週資料」）並回覆決策點。

## 定案（2026-09-03）
1. 週的鍵：`week_index`。
2. 信息／奉獻經文：站內段落預覽 ＋「查看完整章節」（比照每日靈修）。
3. **不做「已完成／已聚會」勾選**——純顯示。日曆格只標 今天 / 過去週。
4. 可見性比照每日靈修：flag 開 → 全會友；flag 關 → 只有 admin/pastor（卡片黃色「開發中」badge）。
5. 管理端：**逐週表單填**（不需要批次貼上匯入的 parser）。但因為 27 週 × 5 欄手動輸入很累，會附一支 `scratch/seed_group_meeting_plan_2026_h2.sql` 把 27 週先建好。
6. 每月有「月主題」（如七月＝耶穌被賣的那一夜），每週有小標（如「設立主聖餐」）。
7. **日期不綁死**：每週的顯示標籤用 `date_label`（例「7/1–7/2」，直接照教會材料），內容鍵是 `week_index`。
8. **日曆以「一週（日～六）」呈現**。小組現在是週三／四聚會，但畫面就顯示整個 Sun–Sat 週。
   - 計畫 `start_date` = 第 1 週那個「日～六」週的**星期日** = **2026-06-28**（7/1 是週三，所在週的週日是 6/28）。
   - 第 N 週的日～六區間 = `start_date + (N-1)*7` 到 `+6`；「本週」= 今天（Asia/Taipei）落在哪個區間。
   - `end_date` = 第 27 週的週六 = **2027-01-02**（第 27 週 = 12/27 日～1/2 六）。
   - 27 週全部是連續的（每週 +7 天），Wed 錨點都對得上（抽查：W14=9/30、W27=12/30）。

## 目標

新增一種**週計畫** `plan_kind = 'group_meeting'`，給小組長預備聚會用。每週呈現：

1. **信息經文**（可點開看該段經文，再「查看完整章節」進讀經系統）
2. **奉獻經文**（同上）
3. **敬拜讚美詩歌**（詩歌清單：代碼＋可選標題／連結）

排版沿用其他計畫（日曆＋區塊），並有**功能開關**（feature flag，預設關）。

## 這是「每日靈修」的近親

整體結構＝把已上線的 **每日靈修**（migration `0145_devotional_plan.sql`）複製一份，改成：

| 每日靈修 | 小組聚會週計畫 |
|---|---|
| `plan_kind='devotional'` | `plan_kind='group_meeting'` |
| `day_index`（第 N 天） | `week_index`（第 N 週） |
| 顯示日期 = `start_date + (day_index-1)` | 顯示週 = `start_date + (week_index-1)*7`，標成 `M/D–M/D` |
| 經文進度 / 思想經文 / 影片 | 信息經文 / 奉獻經文 / 敬拜讚美詩歌 |
| flag `daily_devotion` | flag `group_meeting_plan` |
| `rules.devotionFutureOpen` | `rules.groupMeetingFutureOpen` |
| `_devotion_actor_can_manage` | `_group_meeting_actor_can_manage`（admin/pastor） |
| 6 支 RPC（get/list/upsert/delete/bulk/set_future_open） | 同樣 6 支，換前綴 |
| localStorage 勾「已讀／已思想」 | **見決策點 4** |

## 資料模型（migration `0148_group_meeting_plan.sql`，草案）

- `global_plans.plan_kind` CHECK += `'group_meeting'`
- 新表 `plan_group_meeting_weeks`
  | 欄 | 說明 |
  |---|---|
  | `id` uuid pk |
  | `global_plan_id` → global_plans ON DELETE CASCADE |
  | `week_index` int CHECK ≥ 1 |
  | `date_label` text | 顯示用「7/01–7/02」（也可留空由 start_date 推算） |
  | `message_passage_label` text | 「馬太福音 26:26-28」 |
  | `message_passage_refs` jsonb | `[{book,chapterFrom,verseFrom,chapterTo,verseTo}]`（給讀經器跳轉） |
  | `offering_passage_label` text |
  | `offering_passage_refs` jsonb |
  | `songs` jsonb | `[{code, title, url}]`，title/url 可空 |
  | `speaker` text | 可空（"Pastor Greg"） |
  | `note` text | 可空 |
  | `is_published` bool default false |
  | `created_by/updated_by/created_at/updated_at` |
  | UNIQUE(global_plan_id, week_index) |
  RLS enabled、無 policy（只走 service-role + RPC，比照 `plan_devotion_days`）。
- `app_feature_settings` 插入 `('group_meeting_plan', FALSE, ...)`
- `_group_meeting_actor_can_manage(p_actor_id)` = `role_code(...) IN ('admin','pastor')`
- RPC（都進 nlc-data allowlist，**需重部署**）：
  - `get_group_meeting_plan(p_global_plan_id, p_actor_id)` → `{planId,name,description,startDate,endDate,futureOpen,thisWeekIndex,isManager,weeks:[{weekIndex,dateLabel,messagePassageLabel,messagePassageRefs,offeringPassageLabel,offeringPassageRefs,songs,speaker,note,isPublished,locked}]}`（weeks filtered `is_published OR is_mgr`；`locked = NOT is_mgr AND NOT future_open AND week_start > today`）
  - `list_group_meeting_weeks` / `upsert_group_meeting_week(p_payload)` / `delete_group_meeting_week(p_id)` / `bulk_upsert_group_meeting_weeks(p_global_plan_id, p_rows)` / `set_group_meeting_plan_future_open(p_global_plan_id, p_open)`

## 前端（草案，比照每日靈修）

- `js/db.js`：`_callGroupMeetingRpc` + 6 wrapper + `_groupMeetingErrorMessage`；`group_meeting_plan` 進 `getFeatureSetting`/`updateFeatureSetting` allowedKeys；`mapGlobalPlanRecord` 帶出 `groupMeetingFutureOpen`。
- `js/modules/admin.js`：功能開放設定加「小組聚會週計畫」toggle；`ADMIN_SECTIONS` 加 `{id:'group-meeting', group:'內容管理', label:'小組聚會', sub:'group-meeting', flag:'groupMeeting'}`；`renderAdminGroupMeetingPlan(root)`（計畫選擇器／開放未來週次 toggle／逐週編輯表單／貼文字批次匯入／預覽會友畫面）。
- `js/modules/plan.js`：`isGroupMeetingFeatureEnabled()` 懶讀＋快取；`isGroupMeetingPlanVisibleToUser(plan)`（flag 開→所有人；flag 關→admin/pastor）；探索清單 filter；卡片 render（flag 關時黃色「開發中・會友看不到」badge，比照 devotional）；`previewGroupMeetingPlanAsMember(id)`；`enterPlanDetailState` 對 `planKind==='group_meeting'` 分支 → `renderGroupMeetingViewer(plan)`。
- `renderGroupMeetingViewer(plan)`：獨立容器（比照 `#devotion-view-root` 的 `showDevotionViewerRoot`/`exitDevotionViewer`，避免洗掉一般計畫詳情）。內容：
  - **週日曆**：沿用 `.calendar-component.plan-calendar` 類別，但格子是「週」（一格代表一整週，label 用該週的日期，`.active/.today/.completed/.past-unread`）。
  - 三區塊用 `.plan-task-item`（圈圈 `.task-checkbox` + `.task-open-button`）：
    - 信息經文：點列 → 站內段落預覽（比照靈修的 `renderDevotionPassageInline`）→「查看完整章節」進讀經器
    - 奉獻經文：同上
    - 敬拜讚美詩歌：清單，每首「代碼　標題」＋若有 `url` 則「▶ 開連結」（外開，不動 CSP）
  - 未開放的週：顯示「這一週 <日期> 開放」（比照 devotional locked）
- `index.html`：admin toggle row + `#admin-section-group-meeting` panel（`#admin-group-meeting-root`）。
- `index.css`：`.group-meeting-view*`（沿用 `.devotion-view*` 樣式，週日曆格子稍寬）。
- `scratch/seed_group_meeting_plan_2026_h2.sql`：建計畫列（`plan_kind='group_meeting'`、`start_date` = 第一週的週六、`end_date` 12 月最後一週、`rules.groupMeetingFutureOpen=FALSE`），週資料等使用者貼文字後用批次匯入。

## 部署順序（跟每日靈修一樣）

1. SQL editor 跑 `0148`
2. 跑 seed（建計畫列）
3. **重新部署 nlc-data**
4. 部署前端
5. 管理 → 小組聚會 → 選計畫 → 貼文字批次匯入每週內容 → 逐週勾「發佈」
6. 要對會友開放時：系統管理 → 功能開放設定 → 開「小組聚會週計畫」

## 資料表最終欄位（`plan_group_meeting_weeks`）

`id` / `global_plan_id` / `week_index` / `date_label`(「7/1–7/2」，顯示用) /
`month_theme`(可空，該月主題) /
`message_topic`(可空，週小標) / `message_passage_label` / `message_passage_refs` jsonb /
`offering_topic`(可空) / `offering_passage_label`(可空) / `offering_passage_refs` jsonb(可空) /
`songs` jsonb `[{code,title}]` /
`note`(可空，放「Pastor Greg 特會」這類) /
`is_published` bool / 稽核欄 / UNIQUE(global_plan_id, week_index)

`get_group_meeting_plan` 每週回：`weekIndex, dateLabel, weekStart(=start_date+(weekIndex-1)*7,週日),
weekEnd(+6,週六), isThisWeek, isPast, locked, monthTheme, messageTopic, messagePassageLabel,
messagePassageRefs, offeringTopic, offeringPassageLabel, offeringPassageRefs, songs, note, isPublished`。
日曆一格 = 一週（Sun–Sat），label 顯示 `dateLabel`；`isThisWeek` 上色、`isPast` 淡色。

## 已解析的 27 週資料（請使用者核對）

書卷簡稱：太=馬太福音、可=馬可福音、路=路加福音、約=約翰福音、徒=使徒行傳、
創=創世記、出=出埃及記、尼=尼希米記、代上=歷代志上、撒下=撒母耳記下、來=希伯來書、雅=雅各書。

### 七月　月主題：耶穌被賣的那一夜
| 週 | 日期 | 詩歌 | 信息經文（小組經文） | 奉獻經文 |
|---|---|---|---|---|
| 1 | 7/01–7/02 | C3 讚美救主耶穌、C44 頌讚全能上帝 | 設立主聖餐　太 26:17-29 | 擘餅與分杯　太 26:26-28 |
| 2 | 7/08–7/09 | C61 被救贖的百姓、C4 每當我瞻仰祢 | 為門徒洗腳　約 13:1-20 | 愛他們到底　約 13:1 |
| 3 | 7/15–7/16 | — | — | — （note：Pastor Greg 特會，本週無小組經文／詩歌單） |
| 4 | 7/22–7/23 | C18 先求祂的國、C38 更新我心意 | 客西馬尼園的禱告　可 14:32-42 | 照祢的意思　可 14:36 |
| 5 | 7/29–7/30 | C26 耶穌的愛真是奇妙、C14 親近更親近 | 被猶大出賣與被捕　路 22:47-54 | 耶穌被出賣　路 22:47-48 |

### 八月　月主題：聖靈充滿
| 週 | 日期 | 詩歌 | 信息經文 | 奉獻經文 |
|---|---|---|---|---|
| 6 | 8/05–8/06 | C36 聖靈我們真歡迎祢、C59 在主裡的時刻 | 聖靈的洗—人人都要受靈洗　徒 11:4-18 | 聖靈降在人身上　徒 11:15-16 |
| 7 | 8/12–8/13 | C58 一群大能的子民、C27 開啟雙眼 | 聖靈充滿—保羅被聖靈充滿　徒 13:6-12 | 稀奇就信了　徒 13:12 |
| 8 | 8/19–8/20 | C5 耶穌耶穌我心樂歌、C1 舉目仰望 | 方言禱告—聖靈所賜的口才　徒 2:1-11 | 聖靈如大風吹過　徒 2:1-2 |
| 9 | 8/26–8/27 | C42 我知道我救贖主活著、C35 犧牲的愛 | 滿有聖靈—有大能的司提反　徒 6:5-10 | 神的道興旺起來　徒 6:7 |

### 九月　月主題：興起建造　（本月無奉獻經文）
| 週 | 日期 | 詩歌 | 信息經文 |
|---|---|---|---|
| 10 | 9/02–9/03 | D30 我已被贖回、D5 萬國都要來讚美主 | 奉獻的服事　創 18:1-5 |
| 11 | 9/09–9/10 | D26 偉大奇妙神、D21 我要屈膝敬拜 | 國度公民權　出 30:11-16 |
| 12 | 9/16–9/17 | D42 我必須有主、D6 超越過一切 | 一手拿兵器　尼 4:7-17 |
| 13 | 9/23–9/24 | D67 我就是來讚美主、D52 神的聖靈 | 阿珥楠服事　代上 21:20-24 |
| 14 | 9/30–10/01 | D33 我是主羊、D65 我要歌頌 | 迎回主約櫃　撒下 6:1-12 |

### 十月　月主題：基督的反合性
| 週 | 日期 | 詩歌 | 信息經文 | 奉獻經文 |
|---|---|---|---|---|
| 15 | 10/07–10/08 | E3 我們高舉雙手、E12 我們是你的百姓 | 驢駒與君王　約 12:12-16 | 出去迎接耶穌　約 12:12-13 |
| 16 | 10/14–10/15 | E14 我用主的愛、E1 你是榮耀君王 | 死與生　約 12:23-26 | 結出許多子粒　約 12:24 |
| 17 | 10/21–10/22 | E16 靠著耶穌聖名、E5 他已被尊崇 | 失敗與勝利　約 12:30-33 | 主耶穌被高舉　約 12:32 |
| 18 | 10/28–10/29 | E15 感謝我們復活主、E9 惟有你 | 隱藏與顯露　約 12:34-43 | 成為光明之子　約 12:36 |

### 十一月　月主題：國度的倍增
| 週 | 日期 | 詩歌 | 信息經文 | 奉獻經文 |
|---|---|---|---|---|
| 19 | 11/04–11/05 | G8 與耶穌同行、G47 擁戴祂為王 | 倍增基本款—麥子的比喻　太 13:1-9 | 奉獻有百倍收成　太 13:8-9 |
| 20 | 11/11–11/12 | G45 神真是我力量、G20 我敬拜你全能神 | 分辨真與假—稗子的比喻　太 13:24-30 | 小心奉獻的稗子　太 13:24-25 |
| 21 | 11/18–11/19 | G51 盡心盡力來敬拜、G21 神要開道路 | 倍增進階款—芥菜種比喻　太 13:31-32 | 像芥菜種的奉獻　太 13:31-32 |
| 22 | 11/25–11/26 | G33 來慶賀、G1 我願你來 | 倍增吸引力—寶貝與珠子　太 13:44-46 | 付上代價的奉獻　太 13:44 |

### 十二月　月主題：在信的人凡事都能
| 週 | 日期 | 詩歌 | 信息經文 | 奉獻經文 |
|---|---|---|---|---|
| 23 | 12/02–12/03 | A4 來高聲唱、A9 我站立敬畏你 | 神喜悅有信心的人　來 11:1-7 | 信他賞賜尋求的人　來 11:6 |
| 24 | 12/09–12/10 | A25 敬拜主、A12 歌頌祢聖名 | 我信不足求主幫助　可 9:14-29 | 在信的人凡事都能　可 9:23 |
| 25 | 12/16–12/17 | A35 神掌權、A15 讓我靈自由 | 律法和先知的道理　太 7:7-12 | 凡祈求的就給你們　太 7:7 |
| 26 | 12/23–12/24 | A10 興起歡唱、A8 主祢本為大 | 要有信心要有行為　雅 2:14-26 | 信心必定要有行為　雅 2:17 |
| 27 | 12/30–12/31 | A32 速開心門、A3 神羔羊 | 要情詞迫切的直求　路 11:5-13 | 照他所需要的給他　路 11:8 |

**已定**：`start_date = 2026-06-28`（第 1 週那個 Sun–Sat 週的週日）、`end_date = 2027-01-02`。畫面每週顯示的字用上表的 `date_label`（7/1–7/2 …）。十一月的錯位已依「主題↔經節」對回，使用者確認正確。
