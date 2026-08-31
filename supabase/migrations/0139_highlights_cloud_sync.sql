-- Migration 0139: Cloud-synced verse highlights
--
-- The original public.highlights table (migration 0059) was never actually
-- wired up by the client — js/modules/bible.js has always stored highlight
-- colors purely in localStorage ("bible_highlights", keyed "book_chapter_verse"
-- -> color hex). That table's schema (chapter_id/start_offset/end_offset/
-- selected_text) doesn't even match how the app represents a highlight, so it
-- holds no real rows from app usage. Replacing it with a shape symmetric to
-- verse_notes (0075) so a highlight is addressable the same way a note is:
-- one row per (user, book, chapter, verse).

DROP TABLE IF EXISTS public.highlights;

CREATE TABLE public.highlights (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  book TEXT NOT NULL,
  chapter INTEGER NOT NULL,
  verse INTEGER NOT NULL,
  color TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  UNIQUE(user_id, book, chapter, verse)
);

CREATE INDEX idx_highlights_user_chapter ON public.highlights(user_id, book, chapter);

CREATE TRIGGER trg_highlights_updated_at
  BEFORE UPDATE ON public.highlights
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.highlights ENABLE ROW LEVEL SECURITY;

CREATE POLICY highlights_manage_own ON public.highlights
  FOR ALL TO authenticated
  USING (user_id = public.current_profile_id())
  WITH CHECK (user_id = public.current_profile_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.highlights TO authenticated;
