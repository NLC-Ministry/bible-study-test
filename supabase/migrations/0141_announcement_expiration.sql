-- 公告管理：重要／緊急公告可設定到期時間；一般公告維持長期顯示。
ALTER TABLE public.church_announcements
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_church_announcements_active_expiry
  ON public.church_announcements (is_published, expires_at, published_at DESC);

COMMENT ON COLUMN public.church_announcements.expires_at IS
  '公告到期時間；主要供重要／緊急公告自動從首頁隱藏。NULL 表示不自動到期。';
