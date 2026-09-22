-- Smoke data and the queries the read path relies on. Run by check_schema.sh.
INSERT INTO evimed_control.users VALUES ('u1');
INSERT INTO evimed_frontier.sources (id, name, lane, source_type, access, egress, launch_tier, owner_entity, registry_sha256)
VALUES ('j-nejm', 'NEJM', 'evidence', 'journal', 'crossref-issn', 'direct', 'P0', 'Massachusetts Medical Society', repeat('a', 64));
INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, source_id, identity_key, url, canonical_url, title_raw, first_seen_at, content_sha256, state)
SELECT 'j-nejm:' || lpad(g::text, 32, '0'), g, 'j-nejm', 'doi:10.1000/e' || g, 'https://example.org/e' || g, 'https://example.org/e' || g,
  'Entry ' || g, now(), repeat('b', 64), CASE WHEN g % 4 = 0 THEN 'received' ELSE 'promoted' END FROM generate_series(1, 4000) g;
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
-- 5. the processing queue (what the plugin delivered and nobody has claimed yet)
EXPLAIN (COSTS OFF) SELECT id FROM evimed_frontier.entries
 WHERE state IN ('received', 'held') AND (hold_until IS NULL OR hold_until <= now())
 ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED;
-- 6. the second time axis
EXPLAIN (COSTS OFF) SELECT id FROM evimed_frontier.items
 WHERE state = 'published' AND published_at IS NOT NULL AND (published_at, id) < (now(), 9223372036854775807)
 ORDER BY published_at DESC, id DESC LIMIT 30;
-- 7. an absorbed event's old id still resolves
INSERT INTO evimed_frontier.events (public_id, title_zh, lane, first_at, last_at) VALUES ('ev1', '事件一', 'safety', now(), now()), ('ev2', '事件二', 'safety', now(), now());
INSERT INTO evimed_frontier.event_aliases SELECT public_id, id FROM evimed_frontier.events;
UPDATE evimed_frontier.events SET merged_into = (SELECT id FROM evimed_frontier.events WHERE public_id = 'ev1'), merged_at = now() WHERE public_id = 'ev2';
SELECT 'alias ev2 -> ' || e.public_id FROM evimed_frontier.event_aliases a JOIN evimed_frontier.events e0 ON e0.id = a.event_id
  JOIN evimed_frontier.events e ON e.id = coalesce(e0.merged_into, e0.id) WHERE a.public_id = 'ev2';
SELECT 'items: ' || pg_size_pretty(pg_total_relation_size('evimed_frontier.items')) || ' for 20000 rows; vectors: ' ||
       pg_size_pretty(pg_total_relation_size('evimed_frontier.item_vectors')) || ' for 3000 rows';
