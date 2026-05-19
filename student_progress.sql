-- =============================================================================
-- Per-student progress / personalization state.
--
-- One row per student, keyed by phone. read_question_ids is a deduplicated
-- text array of every question the student has marked as read. Future
-- personalization fields (last_seen_at, score_per_subject jsonb, etc.) live
-- on this same row.
--
-- ~10× more space-efficient than the row-per-mark layout. RPCs below do
-- atomic mark/unmark via array_append + array_remove so concurrent toggles
-- don't clobber each other.
--
-- Idempotent — safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.student_progress (
  student_phone     text PRIMARY KEY,
  read_question_ids text[] NOT NULL DEFAULT '{}',
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.student_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "student progress select" ON public.student_progress;
DROP POLICY IF EXISTS "student progress write"  ON public.student_progress;

CREATE POLICY "student progress select"
  ON public.student_progress FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "student progress write"
  ON public.student_progress FOR ALL
  TO anon, authenticated
  USING (true) WITH CHECK (true);

-- Mark a question as read (idempotent — no duplicates added).
CREATE OR REPLACE FUNCTION public.mark_question_read(
  p_phone       text,
  p_question_id text
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.student_progress (student_phone, read_question_ids, updated_at)
  VALUES (p_phone, ARRAY[p_question_id], now())
  ON CONFLICT (student_phone) DO UPDATE
  SET
    read_question_ids = CASE
      WHEN p_question_id = ANY(public.student_progress.read_question_ids)
        THEN public.student_progress.read_question_ids
      ELSE array_append(public.student_progress.read_question_ids, p_question_id)
    END,
    updated_at = now();
END;
$$;

-- Unmark a question as read.
CREATE OR REPLACE FUNCTION public.unmark_question_read(
  p_phone       text,
  p_question_id text
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.student_progress
  SET read_question_ids = array_remove(read_question_ids, p_question_id),
      updated_at = now()
  WHERE student_phone = p_phone;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_question_read(text, text)   TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unmark_question_read(text, text) TO anon, authenticated;
