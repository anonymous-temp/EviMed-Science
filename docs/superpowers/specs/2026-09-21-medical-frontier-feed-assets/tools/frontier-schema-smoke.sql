-- Smoke data and the queries the read path relies on. Run by check_schema.sh.
INSERT INTO evimed_control.users VALUES ('u1');
INSERT INTO evimed_frontier.sources (id, name, lane, source_type, access, egress, launch_tier, registry_sha256,
  poll_interval_s, poll_floor_s, poll_ceiling_s)
VALUES ('j-nejm', 'NEJM', 'evidence', 'journal', 'crossref-issn', 'direct', 'P0', repeat('a', 64), 10800, 3600, 86400);
INSERT INTO evimed_frontier.items (public_id, primary_source_id, canonical_url, identity_key, doi, title_raw, title_zh, lang, lane,
  source_type, specialties, entity_keys, first_seen_at, timeline_at, state, selected, visible_at)
SELECT 'it' || lpad(g::text, 12, '0'), 'j-nejm', 'https://example.org/' || g, 'doi:10.1000/x' || g, '10.1000/x' || g, 'Title ' || g,
  '标题 ' || g, 'en', CASE WHEN g % 3 = 0 THEN 'safety' ELSE 'evidence' END, 'journal',
  ARRAY[CASE WHEN g % 2 = 0 THEN 'cardiology' ELSE 'oncology' END], ARRAY['drug:semaglutide'],
  now() - g * interval '7 minutes', now() - g * interval '7 minutes', 'published', g % 10 = 0, now()
FROM generate_series(1, 20000) g;
INSERT INTO evimed_frontier.item_vectors (item_id, model_key, embedding)
SELECT id, 'qwen3.7-text-embedding@1024', (SELECT array_agg(random())::real[] FROM generate_series(1, 1024) WHERE id > 0)::halfvec(1024)
FROM evimed_frontier.items WHERE id <= 3000;
INSERT INTO evimed_frontier.user_state (user_id, item_id, starred_at) SELECT 'u1', id, now() FROM evimed_frontier.items WHERE id % 500 = 0;
ANALYZE;
-- 1. the selected list, keyset-paged
EXPLAIN (COSTS OFF) SELECT id, title_zh FROM evimed_frontier.items
 WHERE state = 'published' AND selected AND (timeline_at, id) < (now(), 9223372036854775807)
 ORDER BY timeline_at DESC, id DESC LIMIT 30;
-- 2. a lane + specialty filter
EXPLAIN (COSTS OFF) SELECT id FROM evimed_frontier.items
 WHERE state = 'published' AND lane = 'evidence' AND specialties && ARRAY['cardiology']
 ORDER BY timeline_at DESC, id DESC LIMIT 30;
-- 3. the per-user overlay for one page
EXPLAIN (COSTS OFF) SELECT item_id, starred_at, hidden_at, read_at FROM evimed_frontier.user_state
 WHERE user_id = 'u1' AND item_id = ANY (ARRAY[500, 1000, 1500]::bigint[]);
-- 4. cluster candidates: same entity, last 7 days, nearest vectors (exact scan inside the window)
EXPLAIN (COSTS OFF) SELECT i.id FROM evimed_frontier.items i JOIN evimed_frontier.item_vectors v ON v.item_id = i.id
 WHERE i.timeline_at > now() - interval '7 days' AND i.entity_keys && ARRAY['drug:semaglutide']
 ORDER BY v.embedding <=> (SELECT embedding FROM evimed_frontier.item_vectors WHERE item_id = 1) LIMIT 20;
-- 5. the collection queue
EXPLAIN (COSTS OFF) SELECT id FROM evimed_frontier.sources
 WHERE enabled AND retired_at IS NULL AND egress = 'direct' AND next_poll_at <= now()
   AND (lease_until IS NULL OR lease_until < now())
 ORDER BY next_poll_at LIMIT 8 FOR UPDATE SKIP LOCKED;
SELECT 'items: ' || pg_size_pretty(pg_total_relation_size('evimed_frontier.items')) || ' for 20000 rows; vectors: ' ||
       pg_size_pretty(pg_total_relation_size('evimed_frontier.item_vectors')) || ' for 3000 rows';
