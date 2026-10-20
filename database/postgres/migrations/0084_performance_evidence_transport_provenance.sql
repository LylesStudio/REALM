-- Candidate private envelope-v1 storage; no backfill and no body-v2 reinterpretation.
-- The codec verifies source receipts before projection. These invoker guards bind
-- canonical integrity and the complete stored target tuple, not source authenticity.
CREATE TABLE IF NOT EXISTS performance_evidence_transport_provenance (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  command_id text NOT NULL,
  assessment_id text NOT NULL,
  source_workspace_id text NOT NULL,
  source_world_id text NOT NULL,
  source_worldline_id text NOT NULL,
  source_record_id text NOT NULL,
  source_command_id text NOT NULL,
  source_assessment_id text NOT NULL,
  version integer NOT NULL CHECK (version=1),
  envelope_canonical text NOT NULL CHECK (octet_length(envelope_canonical) BETWEEN 2 AND 67108864),
  envelope_hash text NOT NULL CHECK (envelope_hash ~ '^[0-9a-f]{64}$'),
  source_manifest_hash text NOT NULL CHECK (source_manifest_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id,assessment_id),
  UNIQUE (workspace_id,world_id,worldline_id,command_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (workspace_id,world_id,worldline_id,record_id)
    REFERENCES records(workspace_id,world_id,worldline_id,id),
  FOREIGN KEY (workspace_id,world_id,worldline_id,command_id)
    REFERENCES committed_fact_commands(workspace_id,world_id,worldline_id,id),
  FOREIGN KEY (workspace_id,world_id,worldline_id,assessment_id)
    REFERENCES performance_assessments(workspace_id,world_id,worldline_id,id)
);

-- All schema keys are ASCII; C ordering equals the codec's JS key sort here.
-- Values retain JSON strings verbatim; the v1 witness remains a quoted original
-- canonical string. Numbers in this family are safe integers, never PG floats.
CREATE FUNCTION performance_transport_canonical(p jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,public AS $$
DECLARE result text; n numeric;
BEGIN
  CASE jsonb_typeof(p)
    WHEN 'object' THEN
      IF EXISTS(SELECT 1 FROM jsonb_object_keys(p) AS k WHERE k !~ '^[A-Za-z][A-Za-z0-9]*$') THEN
        RAISE EXCEPTION 'PERFORMANCE_TRANSPORT_SHAPE';
      END IF;
      SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public.performance_transport_canonical(value),',' ORDER BY key COLLATE "C"),'')||'}'
        INTO result FROM jsonb_each(p);
    WHEN 'array' THEN
      SELECT '['||coalesce(string_agg(public.performance_transport_canonical(value),',' ORDER BY ord),'')||']'
        INTO result FROM jsonb_array_elements(p) WITH ORDINALITY AS a(value,ord);
    WHEN 'number' THEN
      n := (p#>>'{}')::numeric;
      IF n<>trunc(n) OR abs(n)>9007199254740991 THEN RAISE EXCEPTION 'PERFORMANCE_TRANSPORT_SHAPE'; END IF;
      result := n::bigint::text;
    ELSE result := p::text;
  END CASE;
  RETURN result;
END; $$;
CREATE FUNCTION performance_transport_keys(p jsonb, expected text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  RETURN (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(p) AS k)
    IS NOT DISTINCT FROM (SELECT array_agg(k ORDER BY k COLLATE "C") FROM unnest(expected) AS k);
END; $$;

CREATE FUNCTION guard_performance_transport_provenance_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE e jsonb := NEW.envelope_canonical::jsonb; o jsonb; p jsonb; s jsonb; r jsonb; h jsonb;
        a public.performance_assessments%ROWTYPE; c public.committed_fact_commands%ROWTYPE;
        pair jsonb; wanted jsonb; ids text[]; source_ids text[];
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM public.realm_current_workspace_id() THEN RAISE EXCEPTION 'PERFORMANCE_TRANSPORT_SCOPE'; END IF;
  IF NOT public.performance_transport_keys(e,ARRAY['version','origin','projection','digest'])
    OR e->'version' IS DISTINCT FROM '1'::jsonb
    OR public.performance_transport_canonical(e) IS DISTINCT FROM NEW.envelope_canonical
    OR e->>'digest' IS DISTINCT FROM NEW.envelope_hash
    OR NEW.envelope_hash IS DISTINCT FROM encode(public.digest(convert_to('realm-runtime-performance-witness-envelope:v1','UTF8')||decode('00','hex')||convert_to(public.performance_transport_canonical(e-'digest'),'UTF8'),'sha256'),'hex')
  THEN RAISE EXCEPTION 'PERFORMANCE_TRANSPORT_CANONICAL'; END IF;
  o:=e->'origin'; p:=e->'projection'; r:=p->'relation';
  IF NOT public.performance_transport_keys(o,ARRAY['scope','commandId','requestFingerprint','request','result','marker','witness','assessment'])
    OR NOT public.performance_transport_keys(p,ARRAY['scope','recordId','storyId','commandId','assessmentId','request','requestFingerprint','result','assessment','history','relation'])
    OR NOT public.performance_transport_keys(r,ARRAY['version','originScope','currentScope','identities'])
    OR NOT public.performance_transport_keys(o->'scope',ARRAY['workspaceId','worldId','worldlineId'])
    OR NOT public.performance_transport_keys(p->'scope',ARRAY['workspaceId','worldId','worldlineId'])
    OR NOT public.performance_transport_keys(o->'marker',ARRAY['version','manifestHash'])
    OR NOT public.performance_transport_keys(o->'witness',ARRAY['version','recordId','commandId','assessmentId','manifestCanonical','manifestHash'])
    OR p->>'history' IS DISTINCT FROM 'origin-only' OR r->'version' IS DISTINCT FROM '1'::jsonb
    OR r->'originScope' IS DISTINCT FROM o->'scope' OR r->'currentScope' IS DISTINCT FROM p->'scope'
    OR jsonb_typeof(r->'identities') IS DISTINCT FROM 'array'
    OR jsonb_typeof(o#>'{witness,manifestCanonical}') IS DISTINCT FROM 'string'
    OR octet_length(o#>>'{witness,manifestCanonical}') NOT BETWEEN 2 AND 262144
  THEN RAISE EXCEPTION 'PERFORMANCE_TRANSPORT_SHAPE'; END IF;
  s:=(o#>>'{witness,manifestCanonical}')::jsonb;
  IF NOT public.performance_transport_keys(s,ARRAY['version','scope','assessmentId','commandId','requestFingerprint','policyVersion','admission','binding','head','worldlineHead','currentScene','headEvent','evidence','factors','milestoneWitness'])
    OR NOT public.performance_transport_keys(s->'scope',ARRAY['workspaceId','worldId','worldlineId','recordId'])
    OR NOT public.performance_transport_keys(s->'admission',ARRAY['principalId','role','evidencePolicyId','evidenceMode'])
    OR NOT public.performance_transport_keys(s->'binding',ARRAY['storyId','worldVersion'])
    OR NOT public.performance_transport_keys(s->'head',ARRAY['recordVersion','nextRecordOrdinal','lastEventId','lastWorldTick','lastWorldOrdinal','effectiveTick','effectiveOrdinal'])
    OR NOT public.performance_transport_keys(s->'worldlineHead',ARRAY['tick','ordinal'])
    OR NOT public.performance_transport_keys(s->'currentScene',ARRAY['id','startTick','startOrdinal','status'])
    OR NOT public.performance_transport_keys(s->'factors',ARRAY['evidenceCount','milestoneCompleted','score'])
    OR jsonb_typeof(s->'evidence') IS DISTINCT FROM 'array'
    OR public.performance_transport_canonical(s) IS DISTINCT FROM o#>>'{witness,manifestCanonical}'
    OR NEW.source_manifest_hash IS DISTINCT FROM encode(public.digest(convert_to('performance-evidence-snapshot:v1','UTF8')||decode('00','hex')||convert_to(o#>>'{witness,manifestCanonical}','UTF8'),'sha256'),'hex')
  THEN RAISE EXCEPTION 'PERFORMANCE_TRANSPORT_ORIGIN'; END IF;
  FOR h IN SELECT value FROM jsonb_array_elements(s->'evidence') LOOP
    IF NOT public.performance_transport_keys(h,ARRAY['id','sceneId','visibilityPolicyId','policyVersion','policyKind','recordVersion','recordOrdinal','worldTick','worldOrdinal','sceneStartTick','sceneStartOrdinal']) THEN RAISE EXCEPTION 'PERFORMANCE_TRANSPORT_SHAPE'; END IF;
  END LOOP;
  IF NOT public.performance_transport_keys(s->'headEvent',ARRAY['id','sceneId','visibilityPolicyId','policyVersion','policyKind','recordVersion','recordOrdinal','worldTick','worldOrdinal'])
    OR (s->'milestoneWitness'<>'null'::jsonb AND NOT public.performance_transport_keys(s->'milestoneWitness',ARRAY['id','projectId','completionRecordId','completionEventId','completionHeader']))
  THEN RAISE EXCEPTION 'PERFORMANCE_TRANSPORT_SHAPE'; END IF;
  FOREACH wanted IN ARRAY ARRAY[o,p] LOOP
    IF NOT public.performance_transport_keys(wanted->'request',ARRAY['command','recordId','policyVersion','score','evidenceEventIds'])
      OR NOT public.performance_transport_keys(wanted->'result',ARRAY['status','commandId','assessmentId','score','evidenceSnapshotHash','goalTransition'])
      OR NOT public.performance_transport_keys(wanted->'assessment',ARRAY['id','recordId','commandId','policyVersion','score','evidenceEventIds','evidenceSnapshotHash'])
    THEN RAISE EXCEPTION 'PERFORMANCE_TRANSPORT_SHAPE'; END IF;
  END LOOP;
  SELECT array_agg(value->>'id' ORDER BY ord) INTO source_ids FROM jsonb_array_elements(s->'evidence') WITH ORDINALITY AS q(value,ord);
  IF (
    s->'version'='1'::jsonb AND o#>'{witness,version}'='1'::jsonb AND o#>'{marker,version}'='1'::jsonb
    AND s#>>'{scope,workspaceId}'=NEW.source_workspace_id AND s#>>'{scope,worldId}'=NEW.source_world_id
    AND s#>>'{scope,worldlineId}'=NEW.source_worldline_id AND s#>>'{scope,recordId}'=NEW.source_record_id
    AND o->'scope'=((s->'scope')-'recordId') AND o->>'commandId'=NEW.source_command_id
    AND s->>'commandId'=NEW.source_command_id AND s->>'assessmentId'=NEW.source_assessment_id
    AND o#>>'{witness,commandId}'=NEW.source_command_id AND o#>>'{witness,assessmentId}'=NEW.source_assessment_id
    AND o#>>'{witness,recordId}'=NEW.source_record_id
    AND o#>>'{witness,manifestHash}'=NEW.source_manifest_hash AND o#>>'{marker,manifestHash}'=NEW.source_manifest_hash
    AND o->>'requestFingerprint'=s->>'requestFingerprint'
    AND o->>'requestFingerprint'=encode(public.digest(convert_to('committed-fact-command:v1','UTF8')||decode('00','hex')||convert_to(public.performance_transport_canonical(jsonb_build_object('scope',o->'scope','request',o->'request')),'UTF8'),'sha256'),'hex')
    AND o#>>'{request,command}'='performance.assessed' AND o#>>'{request,recordId}'=NEW.source_record_id
    AND o#>>'{request,policyVersion}'=s->>'policyVersion' AND s->>'policyVersion'='structured-factors:v1'
    AND o#>'{request,score}'=s#>'{factors,score}' AND o#>'{request,evidenceEventIds}'=to_jsonb(source_ids)
    AND o#>'{assessment,evidenceEventIds}'=to_jsonb(source_ids)
    AND o#>>'{assessment,id}'=NEW.source_assessment_id AND o#>>'{assessment,commandId}'=NEW.source_command_id
    AND o#>>'{assessment,recordId}'=NEW.source_record_id AND o#>'{assessment,score}'=o#>'{request,score}'
    AND o#>>'{assessment,policyVersion}'=s->>'policyVersion'
    AND o#>>'{result,commandId}'=NEW.source_command_id AND o#>>'{result,assessmentId}'=NEW.source_assessment_id
    AND o#>'{result,score}'=o#>'{request,score}' AND o#>'{result,goalTransition}'='null'::jsonb
    AND o#>>'{result,status}' IN ('committed','replayed')
    AND cardinality(source_ids) BETWEEN 1 AND 32
    AND length(s#>>'{admission,principalId}')>0 AND s#>>'{admission,role}' IN ('owner','player')
    AND s#>>'{admission,evidenceMode}' IN ('engine-authoritative-v1','viewer-limited-v1')
    AND o#>>'{result,evidenceSnapshotHash}'=o#>>'{assessment,evidenceSnapshotHash}'
    AND o#>>'{result,evidenceSnapshotHash}'=encode(public.digest(convert_to('performance-assessment:v1','UTF8')||decode('00','hex')||(SELECT string_agg(convert_to(v,'UTF8'),decode('00','hex') ORDER BY ord) FROM unnest(source_ids) WITH ORDINALITY AS u(v,ord)),'sha256'),'hex')
  ) IS NOT TRUE THEN RAISE EXCEPTION 'PERFORMANCE_TRANSPORT_ORIGIN'; END IF;

  -- Explicit typed identity relation. Repeated IDs in different namespaces are
  -- legal; duplicate origins/targets inside one namespace are never inferred.
  FOR pair IN SELECT value FROM jsonb_array_elements(r->'identities') LOOP
    IF NOT public.performance_transport_keys(pair,ARRAY['kind','originId','currentId']) OR (
      pair->>'kind' IN ('record','story','command','assessment','event','scene','policy','project','milestone')
      AND jsonb_typeof(pair->'originId')='string' AND jsonb_typeof(pair->'currentId')='string'
      AND length(pair->>'originId') BETWEEN 1 AND 256 AND length(pair->>'currentId') BETWEEN 1 AND 256
      AND pair->>'originId' ~ '^[A-Za-z0-9._:-]+$' AND pair->>'currentId' ~ '^[A-Za-z0-9._:-]+$'
      AND pair->>'originId' NOT IN ('.','..') AND pair->>'currentId' NOT IN ('.','..')
      AND (o->'scope'<>p->'scope' OR pair->>'originId'=pair->>'currentId')
    ) IS NOT TRUE THEN RAISE EXCEPTION 'PERFORMANCE_TRANSPORT_RELATION'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(r->'identities') AS q GROUP BY q->>'kind',q->>'originId' HAVING count(*)<>1)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(r->'identities') AS q GROUP BY q->>'kind',q->>'currentId' HAVING count(*)<>1)
  THEN RAISE EXCEPTION 'PERFORMANCE_TRANSPORT_RELATION'; END IF;
  -- Coverage is built from actual origin roles, including the historical Scene.
  SELECT jsonb_agg(DISTINCT v) INTO wanted FROM (
    SELECT jsonb_build_object('kind',k,'originId',v) AS v FROM (VALUES
      ('record',NEW.source_record_id),('story',s#>>'{binding,storyId}'),('command',NEW.source_command_id),
      ('assessment',NEW.source_assessment_id),('scene',s#>>'{currentScene,id}')) AS z(k,v)
    UNION ALL
    SELECT jsonb_build_object('kind',role.k,'originId',headers.h->>role.field) FROM (
      SELECT s->'headEvent' AS h UNION ALL SELECT value FROM jsonb_array_elements(s->'evidence')
      UNION ALL SELECT s#>'{milestoneWitness,completionHeader}' WHERE s->'milestoneWitness'<>'null'::jsonb
    ) AS headers CROSS JOIN (VALUES ('event','id'),('scene','sceneId'),('policy','visibilityPolicyId')) AS role(k,field)
    UNION ALL SELECT jsonb_build_object('kind',k,'originId',s#>>ARRAY['milestoneWitness',field])
      FROM (VALUES ('milestone','id'),('project','projectId')) AS role(k,field) WHERE s->'milestoneWitness'<>'null'::jsonb
  ) AS refs;
  IF (SELECT jsonb_agg(q-'currentId' ORDER BY (q-'currentId')::text) FROM jsonb_array_elements(r->'identities') AS q)
    IS DISTINCT FROM (SELECT jsonb_agg(q ORDER BY q::text) FROM jsonb_array_elements(wanted) AS q)
  THEN RAISE EXCEPTION 'PERFORMANCE_TRANSPORT_RELATION'; END IF;
  FOR pair IN SELECT value FROM jsonb_array_elements(r->'identities') LOOP
    IF pair->>'kind' IN ('record','story','command','assessment') AND pair->>'currentId' IS DISTINCT FROM
      p->>(CASE pair->>'kind' WHEN 'record' THEN 'recordId' WHEN 'story' THEN 'storyId' WHEN 'command' THEN 'commandId' ELSE 'assessmentId' END)
    THEN RAISE EXCEPTION 'PERFORMANCE_TRANSPORT_RELATION'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(o#>'{request,evidenceEventIds}') AS origin_event(value)
    WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'identities') AS mapped(value)
      WHERE mapped.value->>'kind'='event' AND mapped.value->'originId'=origin_event.value AND p#>'{request,evidenceEventIds}' @> jsonb_build_array(mapped.value->'currentId')))
    OR jsonb_array_length(p#>'{request,evidenceEventIds}') IS DISTINCT FROM cardinality(source_ids)
  THEN RAISE EXCEPTION 'PERFORMANCE_TRANSPORT_RELATION'; END IF;

  SELECT * INTO a FROM public.performance_assessments WHERE workspace_id=NEW.workspace_id AND world_id=NEW.world_id AND worldline_id=NEW.worldline_id AND id=NEW.assessment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERFORMANCE_TRANSPORT_TUPLE'; END IF;
  SELECT * INTO c FROM public.committed_fact_commands WHERE workspace_id=NEW.workspace_id AND world_id=NEW.world_id AND worldline_id=NEW.worldline_id AND id=NEW.command_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERFORMANCE_TRANSPORT_TUPLE'; END IF;
  SELECT array_agg(v ORDER BY ord) INTO ids FROM jsonb_array_elements_text(p#>'{request,evidenceEventIds}') WITH ORDINALITY AS q(v,ord);
  IF (
    p#>>'{scope,workspaceId}'=NEW.workspace_id AND p#>>'{scope,worldId}'=NEW.world_id AND p#>>'{scope,worldlineId}'=NEW.worldline_id
    AND p->>'recordId'=NEW.record_id AND p->>'commandId'=NEW.command_id AND p->>'assessmentId'=NEW.assessment_id
    AND a.record_id=NEW.record_id AND a.command_id=NEW.command_id AND c.kind='performance_assessed'
    AND p->>'requestFingerprint'=c.request_fingerprint
    AND p->>'requestFingerprint'=encode(public.digest(convert_to('committed-fact-command:v1','UTF8')||decode('00','hex')||convert_to(public.performance_transport_canonical(jsonb_build_object('scope',p->'scope','request',p->'request')),'UTF8'),'sha256'),'hex')
    AND p->'request'=c.result_manifest->'request' AND p->'result'=c.result_manifest->'result'
    AND c.result_manifest->'performanceTransport'=jsonb_build_object('version',1,'digest',NEW.envelope_hash)
    AND p->'assessment'=jsonb_build_object('id',a.id,'recordId',a.record_id,'commandId',a.command_id,'policyVersion',a.policy_version,'score',a.score,'evidenceEventIds',a.evidence_event_ids,'evidenceSnapshotHash',a.evidence_snapshot_hash)
    AND p#>>'{request,command}'='performance.assessed' AND p#>>'{request,recordId}'=NEW.record_id
    AND p#>>'{request,policyVersion}'=a.policy_version AND p#>'{request,score}'=to_jsonb(a.score)
    AND p#>'{request,score}'=o#>'{request,score}' AND p#>'{request,policyVersion}'=o#>'{request,policyVersion}'
    AND ids=a.evidence_event_ids AND p#>>'{result,assessmentId}'=a.id AND p#>>'{result,commandId}'=c.id
    AND p#>'{result,score}'=to_jsonb(a.score) AND p#>>'{result,evidenceSnapshotHash}'=a.evidence_snapshot_hash
    AND p#>'{result,goalTransition}'='null'::jsonb AND p#>'{result,status}'=o#>'{result,status}'
    AND a.evidence_snapshot_hash=encode(public.digest(convert_to('performance-assessment:v1','UTF8')||decode('00','hex')||(SELECT string_agg(convert_to(v,'UTF8'),decode('00','hex') ORDER BY ord) FROM unnest(ids) WITH ORDINALITY AS u(v,ord)),'sha256'),'hex')
    AND EXISTS(SELECT 1 FROM public.records WHERE workspace_id=NEW.workspace_id AND world_id=NEW.world_id AND worldline_id=NEW.worldline_id AND id=NEW.record_id AND story_id=p->>'storyId')
  ) IS NOT TRUE THEN RAISE EXCEPTION 'PERFORMANCE_TRANSPORT_TUPLE'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER performance_transport_provenance_insert_guard BEFORE INSERT ON performance_evidence_transport_provenance
  FOR EACH ROW EXECUTE FUNCTION guard_performance_transport_provenance_insert();
CREATE FUNCTION guard_performance_transport_provenance_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'performance transport provenance is append-only'; END; $$;
CREATE TRIGGER performance_transport_provenance_append_only BEFORE UPDATE OR DELETE ON performance_evidence_transport_provenance
  FOR EACH ROW EXECUTE FUNCTION guard_performance_transport_provenance_append_only();
CREATE TRIGGER performance_transport_provenance_no_truncate BEFORE TRUNCATE ON performance_evidence_transport_provenance
  FOR EACH STATEMENT EXECUTE FUNCTION guard_performance_transport_provenance_append_only();
ALTER TABLE performance_evidence_transport_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_evidence_transport_provenance FORCE ROW LEVEL SECURITY;
CREATE POLICY realm_workspace_isolation ON performance_evidence_transport_provenance
  USING (workspace_id=realm_current_workspace_id()) WITH CHECK (workspace_id=realm_current_workspace_id());
REVOKE ALL ON performance_evidence_transport_provenance FROM PUBLIC,realm_runtime,realm_transfer,realm_control;
GRANT SELECT,INSERT ON performance_evidence_transport_provenance TO realm_runtime;
REVOKE ALL ON FUNCTION performance_transport_canonical(jsonb),performance_transport_keys(jsonb,text[]),guard_performance_transport_provenance_insert(),guard_performance_transport_provenance_append_only() FROM PUBLIC,realm_transfer,realm_control;
GRANT EXECUTE ON FUNCTION performance_transport_canonical(jsonb),performance_transport_keys(jsonb,text[]) TO realm_runtime;
COMMENT ON TABLE performance_evidence_transport_provenance IS
  'Private envelope-v1 origin/current relation. Historical actors are source-scoped data, never local account/member references. Requires a future body-v3 consumer; no v1 local snapshot admission or body-v2 replay implied.';
