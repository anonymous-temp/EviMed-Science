-- Public feed material only. Incumbent labels are agreement targets, not gold.
-- Run before the 30-day retention sweep; keep the output in private eval state.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60s';
SELECT json_build_object('kind','snapshot','schemaVersion',1,'capturedAt',now(),
  'labelSource','incumbent-model-unless-operator','containsUserData',false);
SELECT json_build_object('kind','screening','row',row_to_json(t)) FROM (
  SELECT e.id,e.title_raw,left(e.summary_raw,20000) AS summary_raw,e.source_id,
    e.lang,e.lane_hint,e.state,e.state_reason,e.content_sha256,e.received_at,
    e.item_id,i.lane,i.specialties,i.flags,i.editor_version,i.editor_model
  FROM evimed_frontier.entries e LEFT JOIN evimed_frontier.items i ON i.id=e.item_id
  WHERE e.state='screened-out' OR i.id IS NOT NULL ORDER BY e.id
) t;
SELECT json_build_object('kind','event-item','row',row_to_json(t)) FROM (
  SELECT ei.event_id,ei.item_id,ei.role,ei.joined_by,ei.joined_at,
    i.title_raw,i.summary_zh,i.doi,i.pmid,i.registry_ids,i.published_at,
    e.title_zh AS event_title,e.digest_zh,e.merged_into,e.merged_at
  FROM evimed_frontier.event_items ei JOIN evimed_frontier.items i ON i.id=ei.item_id
  JOIN evimed_frontier.events e ON e.id=ei.event_id ORDER BY ei.event_id,ei.item_id
) t;
SELECT json_build_object('kind','event-link','row',row_to_json(t)) FROM (
  SELECT from_event_id,to_event_id,relation,asserted_by,linked_at
  FROM evimed_frontier.event_links ORDER BY from_event_id,to_event_id,relation
) t;
SELECT json_build_object('kind','event-revision','row',row_to_json(t)) FROM (
  SELECT event_id,revision,digest_zh,cause,written_at
  FROM evimed_frontier.event_revisions ORDER BY event_id,revision
) t;
COMMIT;
