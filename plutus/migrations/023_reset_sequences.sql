-- =============================================================
-- 023_reset_sequences.sql -- plutus_reset_sequences() RPC (2026-10-02)
-- =============================================================
-- The personal-data restore (plutus/scripts/restore_personal.py) upserts
-- rows WITH their original ids through PostgREST, so journal trades keep
-- pointing at their opportunities and expenses at their categories. That
-- leaves every BIGSERIAL sequence behind the restored max(id); the next
-- insert from the app would collide. PostgREST cannot run setval, hence
-- this function: bump each public id sequence to max(id) of its table.
--
-- Service-role only (the restore script runs with the service key); anon
-- and authenticated cannot call it.
-- =============================================================

CREATE OR REPLACE FUNCTION plutus_reset_sequences()
RETURNS TABLE (table_name text, sequence_name text, new_value bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    r RECORD;
    seq text;
    mx bigint;
BEGIN
    FOR r IN
        SELECT c.table_name AS tbl
          FROM information_schema.columns c
          JOIN information_schema.tables t
            ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         WHERE c.table_schema = 'public'
           AND c.column_name = 'id'
           AND t.table_type = 'BASE TABLE'
           AND c.column_default LIKE 'nextval(%'
    LOOP
        seq := pg_get_serial_sequence(format('public.%I', r.tbl), 'id');
        IF seq IS NULL THEN
            CONTINUE;
        END IF;
        EXECUTE format('SELECT COALESCE(MAX(id), 0) FROM public.%I', r.tbl) INTO mx;
        -- setval(seq, n, true) => next nextval() returns n + 1.
        PERFORM setval(seq, GREATEST(mx, 1), mx > 0);
        table_name := r.tbl;
        sequence_name := seq;
        new_value := GREATEST(mx, 1);
        RETURN NEXT;
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION plutus_reset_sequences() FROM PUBLIC;
REVOKE ALL ON FUNCTION plutus_reset_sequences() FROM anon;
REVOKE ALL ON FUNCTION plutus_reset_sequences() FROM authenticated;
GRANT EXECUTE ON FUNCTION plutus_reset_sequences() TO service_role;
