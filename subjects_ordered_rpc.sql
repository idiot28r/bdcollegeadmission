-- =============================================================================
-- fetch_questions_feed
--
-- Returns paginated questions with custom ordering controlled from the client:
--   - subjects ordered by their position in p_group_subjects
--   - within a subject, year descending (parsed from "2024" / "2024-25" etc.;
--     non-numeric like "Practice" sorts last within the subject)
--   - within a year, institution ordered by p_institution_order
--   - then type, then numeric serial
--
-- Pass NULL for p_group_subjects / p_institution_order to fall back to
-- alphabetical/lexicographic order for that dimension. Pass p_include_hidden
-- = true for the admin view. p_search applies ILIKE matching across question,
-- stimulus, topic, options, parts, explanation, and solution.
--
-- Returns: { "rows": [...], "count": <total matches> }
--
-- Idempotent — safe to re-run.
-- =============================================================================

-- Drop older signatures so re-running this file always upgrades cleanly.
DROP FUNCTION IF EXISTS public.fetch_questions_feed(text[], text[], text[], text[], text[], text[], boolean, int, int);
DROP FUNCTION IF EXISTS public.fetch_questions_feed(text[], text[], text[], text[], text[], text[], boolean, text, int, int);

CREATE OR REPLACE FUNCTION public.fetch_questions_feed(
  p_group_subjects     text[]  DEFAULT NULL,
  p_institution_order  text[]  DEFAULT NULL,
  p_inst_filter        text[]  DEFAULT NULL,
  p_subject_filter     text[]  DEFAULT NULL,
  p_type_filter        text[]  DEFAULT NULL,
  p_year_filter        text[]  DEFAULT NULL,
  p_include_hidden     boolean DEFAULT false,
  p_search             text    DEFAULT NULL,
  p_offset             int     DEFAULT 0,
  p_limit              int     DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_result  jsonb;
  v_pattern text;
BEGIN
  v_pattern := CASE
    WHEN p_search IS NULL OR length(trim(p_search)) = 0 THEN NULL
    ELSE '%' || trim(p_search) || '%'
  END;

  WITH ranked AS (
    SELECT
      q.id,
      ROW_NUMBER() OVER (
        ORDER BY
          COALESCE(
            array_position(COALESCE(p_group_subjects, ARRAY[]::text[]), q.subject),
            99999
          ),
          q.subject,
          CASE WHEN split_part(q.year::text, '-', 1) ~ '^[0-9]+$'
               THEN split_part(q.year::text, '-', 1)::int
               ELSE NULL END DESC NULLS LAST,
          COALESCE(
            array_position(COALESCE(p_institution_order, ARRAY[]::text[]), q.institution),
            99999
          ),
          q.institution,
          q.type,
          CASE WHEN q.serial::text ~ '^[0-9]+$'
               THEN q.serial::text::int
               ELSE 999999 END
      ) AS rn,
      COUNT(*) OVER () AS total
    FROM public.questions q
    WHERE (p_include_hidden OR q.hidden = false)
      AND (p_group_subjects IS NULL OR q.subject     = ANY(p_group_subjects))
      AND (p_inst_filter    IS NULL OR q.institution = ANY(p_inst_filter))
      AND (p_subject_filter IS NULL OR q.subject     = ANY(p_subject_filter))
      AND (p_type_filter    IS NULL OR q.type        = ANY(p_type_filter))
      AND (p_year_filter    IS NULL OR q.year::text  = ANY(p_year_filter))
      AND (
        v_pattern IS NULL
        OR COALESCE(q.question,    '') ILIKE v_pattern
        OR COALESCE(q.stimulus,    '') ILIKE v_pattern
        OR COALESCE(q.topic,       '') ILIKE v_pattern
        OR COALESCE(q.explanation, '') ILIKE v_pattern
        OR COALESCE(q.solution,    '') ILIKE v_pattern
        OR COALESCE(q.options::text, '') ILIKE v_pattern
        OR COALESCE(q.parts::text,   '') ILIKE v_pattern
      )
  )
  SELECT jsonb_build_object(
    'rows', COALESCE(
      (SELECT jsonb_agg(to_jsonb(qq.*) ORDER BY r.rn)
       FROM ranked r
       JOIN public.questions qq ON qq.id = r.id
       WHERE r.rn > p_offset AND r.rn <= p_offset + p_limit),
      '[]'::jsonb
    ),
    'count', COALESCE((SELECT MAX(total) FROM ranked), 0)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fetch_questions_feed(text[], text[], text[], text[], text[], text[], boolean, text, int, int)
  TO anon, authenticated;
