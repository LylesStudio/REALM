// Strict public-reader protocol fixture retargeted from the diagnostic harness.
// Every evidence statement is compared byte-for-byte to the production protocol;
// non-evidence dynamic SQL is frozen in the explicit registry below.
import { evidenceFields, evidenceHeaderSql, evidenceBodySql, readEvidenceRows, type EvidenceFamily } from "../database/postgres/runtime-evidence-resource-reader.ts";
import {
    RuntimeSectionWireLedger, countRuntimeSectionWireBytes,
    serializeRealmRuntimeSaveActionReceiptsV1, serializeRealmRuntimeSaveCharacterEffectsV1,
    serializeRealmRuntimeSaveObservationsV1,
} from "../modules/world-transfer/realm-runtime-save.ts";
const A2_MAP_SQL = "SELECT schema_version, world_version, content_hash, policy_version, project_key, milestone_key, project_id, milestone_id, story_id, record_id, link_kind FROM realmworld_command_materializations WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 ORDER BY project_key, milestone_key LIMIT 257";
const A2_CAPABILITY_SQL = "SELECT to_regclass('public.realmworld_command_materializations') IS NOT NULL AS command_materializations_available";
import { readFileSync } from "node:fs";
import { serializeRealmRuntimeSaveDomainV1, RealmRuntimeSaveDomainError } from "../modules/world-transfer/realm-runtime-domain-save.ts";
import { GOAL_TRANSPORT_CAPABILITY_SQL, LOAD_TRANSPORT_GOALS_SQL } from "../database/postgres/runtime-goal-binding-reader.ts";
import { topologyHeaderSql, topologyBodySql, type TopologyFamily } from "../database/postgres/runtime-topology-resource-reader.ts";
/** Production reader -> real ZIP -> parser -> unchanged restorer; explicit SQL protocol doubles, NOT PG. */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createPostgresRealmRuntimeSaveReader, RealmRuntimeSaveRepositoryError } from "../database/postgres/realm-runtime-save-repository.ts";
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive, type RealmRuntimeSaveArchive, type RealmRuntimeSaveTopologyV1 } from "../modules/world-transfer/realm-runtime-save.ts";
const registeredRuntimeSql = new Set<string>([
  "/* export character predecessor owners */ SELECT id,record_id,continuity_id,workspace_id,world_id,worldline_id FROM character_instances WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND id=ANY($4::text[]) ORDER BY id ASC LIMIT 1000",
  "/* memory resource epoch header */ SELECT c.id AS observer_continuity_id,COALESCE(e.epoch,0) AS epoch FROM character_continuities c LEFT JOIN memory_cache_epochs e ON e.workspace_id=c.workspace_id AND e.observer_continuity_id=c.id WHERE c.workspace_id=$1 AND c.world_id=$2 AND c.worldline_id=$3 AND c.id=ANY($4::text[]) ORDER BY c.id COLLATE \"C\" LIMIT 1000",
  "/* memory resource head */ SELECT head_tick,head_ordinal FROM worldlines WHERE workspace_id=$1 AND world_id=$2 AND id=$3",
  "/* memory resource header conclusions */ SELECT keys,invalid,lower_bytes,content_bytes,content_chars,fidelity_text, lower_bytes::numeric > 67108564 AS oversize, CASE WHEN lower_bytes::numeric > 67108564 THEN NULL ELSE wire_head END head FROM (SELECT CASE WHEN (COALESCE(octet_length(id),0)>512 OR COALESCE(octet_length(observer_continuity_id),0)>512 OR COALESCE(octet_length(source_record_id),0)>512 OR COALESCE(octet_length(source_observation_id),0)>512 OR COALESCE(octet_length(supersedes_memory_id),0)>512 OR length(observed_entity_key)>512 OR length(embedding_model)>256 OR EXISTS (SELECT 1 FROM unnest(keywords) value WHERE length(value)>256)) THEN NULL ELSE ARRAY[id] END keys, (COALESCE(octet_length(id),0)>512 OR COALESCE(octet_length(observer_continuity_id),0)>512 OR COALESCE(octet_length(source_record_id),0)>512 OR COALESCE(octet_length(source_observation_id),0)>512 OR COALESCE(octet_length(supersedes_memory_id),0)>512 OR length(observed_entity_key)>512 OR length(embedding_model)>256 OR EXISTS (SELECT 1 FROM unnest(keywords) value WHERE length(value)>256)) AS invalid,CASE WHEN (COALESCE(octet_length(id),0)>512 OR COALESCE(octet_length(observer_continuity_id),0)>512 OR COALESCE(octet_length(source_record_id),0)>512 OR COALESCE(octet_length(source_observation_id),0)>512 OR COALESCE(octet_length(supersedes_memory_id),0)>512 OR length(observed_entity_key)>512 OR length(embedding_model)>256 OR EXISTS (SELECT 1 FROM unnest(keywords) value WHERE length(value)>256)) THEN NULL ELSE jsonb_build_object('sourceMemoryId',id,'sourceObserverContinuityId',observer_continuity_id,'observedEntityKey',observed_entity_key,'sourceRecordId',source_record_id,'sourceObservationId',source_observation_id,'sourceSupersedesMemoryId',supersedes_memory_id,'operation',operation,'memoryKind',memory_kind,'embeddingModel',embedding_model,'occurredTick',occurred_tick,'occurredOrdinal',occurred_ordinal,'availableFromTick',available_from_tick,'availableFromOrdinal',available_from_ordinal,'content','\"\"'::jsonb,'keywords','[]'::jsonb,'semanticEmbedding','[]'::jsonb,'metadata','{}'::jsonb,'fidelity','0'::jsonb) END wire_head, octet_length(content)::bigint content_bytes,length(content) content_chars, fidelity::text fidelity_text, (octet_length(content)::bigint +(COALESCE((SELECT sum(octet_length(value)) FROM unnest(keywords) value),0) +CASE WHEN cardinality(keywords)>0 THEN 3::bigint*cardinality(keywords)-1 ELSE 0 END) +COALESCE((SELECT sum(octet_length(v #>> '{}')) FROM jsonb_path_query((CASE WHEN jsonb_typeof(metadata) <> 'object' THEN '{}'::jsonb WHEN EXISTS (SELECT 1 FROM jsonb_path_query(metadata,'strict $.** ? (@.type() == \"number\")') j(v) WHERE abs((v #>> '{}')::numeric) >= '179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792'::numeric) THEN '{}'::jsonb ELSE metadata END),'strict $.** ? (@.type() == \"string\")') j(v)),0) +COALESCE((SELECT sum(octet_length(v #>> '{}')) FROM jsonb_path_query((CASE WHEN jsonb_typeof(metadata) <> 'object' THEN '{}'::jsonb WHEN EXISTS (SELECT 1 FROM jsonb_path_query(metadata,'strict $.** ? (@.type() == \"number\")') j(v) WHERE abs((v #>> '{}')::numeric) >= '179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792'::numeric) THEN '{}'::jsonb ELSE metadata END),'strict $.** ? (@.type() == \"object\").keyvalue().key') j(v)),0))::text lower_bytes FROM memory_conclusions WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND (source_record_id IS NULL) ORDER BY id COLLATE \"C\" LIMIT 1000) memory_headers ORDER BY keys COLLATE \"C\"",
  "/* memory resource header conclusions */ SELECT keys,invalid,lower_bytes,content_bytes,content_chars,fidelity_text, lower_bytes::numeric > 67108564 AS oversize, CASE WHEN lower_bytes::numeric > 67108564 THEN NULL ELSE wire_head END head FROM (SELECT CASE WHEN (COALESCE(octet_length(id),0)>512 OR COALESCE(octet_length(observer_continuity_id),0)>512 OR COALESCE(octet_length(source_record_id),0)>512 OR COALESCE(octet_length(source_observation_id),0)>512 OR COALESCE(octet_length(supersedes_memory_id),0)>512 OR length(observed_entity_key)>512 OR length(embedding_model)>256 OR EXISTS (SELECT 1 FROM unnest(keywords) value WHERE length(value)>256)) THEN NULL ELSE ARRAY[id] END keys, (COALESCE(octet_length(id),0)>512 OR COALESCE(octet_length(observer_continuity_id),0)>512 OR COALESCE(octet_length(source_record_id),0)>512 OR COALESCE(octet_length(source_observation_id),0)>512 OR COALESCE(octet_length(supersedes_memory_id),0)>512 OR length(observed_entity_key)>512 OR length(embedding_model)>256 OR EXISTS (SELECT 1 FROM unnest(keywords) value WHERE length(value)>256)) AS invalid,CASE WHEN (COALESCE(octet_length(id),0)>512 OR COALESCE(octet_length(observer_continuity_id),0)>512 OR COALESCE(octet_length(source_record_id),0)>512 OR COALESCE(octet_length(source_observation_id),0)>512 OR COALESCE(octet_length(supersedes_memory_id),0)>512 OR length(observed_entity_key)>512 OR length(embedding_model)>256 OR EXISTS (SELECT 1 FROM unnest(keywords) value WHERE length(value)>256)) THEN NULL ELSE jsonb_build_object('sourceMemoryId',id,'sourceObserverContinuityId',observer_continuity_id,'observedEntityKey',observed_entity_key,'sourceRecordId',source_record_id,'sourceObservationId',source_observation_id,'sourceSupersedesMemoryId',supersedes_memory_id,'operation',operation,'memoryKind',memory_kind,'embeddingModel',embedding_model,'occurredTick',occurred_tick,'occurredOrdinal',occurred_ordinal,'availableFromTick',available_from_tick,'availableFromOrdinal',available_from_ordinal,'content','\"\"'::jsonb,'keywords','[]'::jsonb,'semanticEmbedding','[]'::jsonb,'metadata','{}'::jsonb,'fidelity','0'::jsonb) END wire_head, octet_length(content)::bigint content_bytes,length(content) content_chars, fidelity::text fidelity_text, (octet_length(content)::bigint +(COALESCE((SELECT sum(octet_length(value)) FROM unnest(keywords) value),0) +CASE WHEN cardinality(keywords)>0 THEN 3::bigint*cardinality(keywords)-1 ELSE 0 END) +COALESCE((SELECT sum(octet_length(v #>> '{}')) FROM jsonb_path_query((CASE WHEN jsonb_typeof(metadata) <> 'object' THEN '{}'::jsonb WHEN EXISTS (SELECT 1 FROM jsonb_path_query(metadata,'strict $.** ? (@.type() == \"number\")') j(v) WHERE abs((v #>> '{}')::numeric) >= '179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792'::numeric) THEN '{}'::jsonb ELSE metadata END),'strict $.** ? (@.type() == \"string\")') j(v)),0) +COALESCE((SELECT sum(octet_length(v #>> '{}')) FROM jsonb_path_query((CASE WHEN jsonb_typeof(metadata) <> 'object' THEN '{}'::jsonb WHEN EXISTS (SELECT 1 FROM jsonb_path_query(metadata,'strict $.** ? (@.type() == \"number\")') j(v) WHERE abs((v #>> '{}')::numeric) >= '179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792'::numeric) THEN '{}'::jsonb ELSE metadata END),'strict $.** ? (@.type() == \"object\").keyvalue().key') j(v)),0))::text lower_bytes FROM memory_conclusions WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND (source_record_id=$4) ORDER BY id COLLATE \"C\" LIMIT 1000) memory_headers ORDER BY keys COLLATE \"C\"",
  "/* memory resource header relationships */ SELECT keys,invalid,lower_bytes,content_bytes,content_chars,fidelity_text, lower_bytes::numeric > 67108564 AS oversize, CASE WHEN lower_bytes::numeric > 67108564 THEN NULL ELSE wire_head END head FROM (SELECT CASE WHEN (COALESCE(octet_length(observer_continuity_id),0)>512 OR COALESCE(octet_length(source_record_id),0)>512 OR COALESCE(octet_length(source_observation_id),0)>512 OR length(target_entity_key)>512) THEN NULL ELSE ARRAY[observer_continuity_id,target_entity_key,relation_kind] END keys, (COALESCE(octet_length(observer_continuity_id),0)>512 OR COALESCE(octet_length(source_record_id),0)>512 OR COALESCE(octet_length(source_observation_id),0)>512 OR length(target_entity_key)>512) AS invalid,CASE WHEN (COALESCE(octet_length(observer_continuity_id),0)>512 OR COALESCE(octet_length(source_record_id),0)>512 OR COALESCE(octet_length(source_observation_id),0)>512 OR length(target_entity_key)>512) THEN NULL ELSE jsonb_build_object('sourceObserverContinuityId',observer_continuity_id,'targetEntityKey',target_entity_key,'relationKind',relation_kind,'sourceRecordId',source_record_id,'sourceObservationId',source_observation_id,'occurredTick',occurred_tick,'occurredOrdinal',occurred_ordinal,'availableFromTick',available_from_tick,'availableFromOrdinal',available_from_ordinal,'content','\"\"'::jsonb,'fidelity','0'::jsonb) END wire_head, octet_length(content)::bigint content_bytes,length(content) content_chars, fidelity::text fidelity_text, (octet_length(content)::bigint )::text lower_bytes FROM relationship_states WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND (source_record_id IS NULL) ORDER BY observer_continuity_id COLLATE \"C\",target_entity_key COLLATE \"C\",relation_kind COLLATE \"C\" LIMIT 1000) memory_headers ORDER BY keys COLLATE \"C\"",
  "/* memory resource header relationships */ SELECT keys,invalid,lower_bytes,content_bytes,content_chars,fidelity_text, lower_bytes::numeric > 67108564 AS oversize, CASE WHEN lower_bytes::numeric > 67108564 THEN NULL ELSE wire_head END head FROM (SELECT CASE WHEN (COALESCE(octet_length(observer_continuity_id),0)>512 OR COALESCE(octet_length(source_record_id),0)>512 OR COALESCE(octet_length(source_observation_id),0)>512 OR length(target_entity_key)>512) THEN NULL ELSE ARRAY[observer_continuity_id,target_entity_key,relation_kind] END keys, (COALESCE(octet_length(observer_continuity_id),0)>512 OR COALESCE(octet_length(source_record_id),0)>512 OR COALESCE(octet_length(source_observation_id),0)>512 OR length(target_entity_key)>512) AS invalid,CASE WHEN (COALESCE(octet_length(observer_continuity_id),0)>512 OR COALESCE(octet_length(source_record_id),0)>512 OR COALESCE(octet_length(source_observation_id),0)>512 OR length(target_entity_key)>512) THEN NULL ELSE jsonb_build_object('sourceObserverContinuityId',observer_continuity_id,'targetEntityKey',target_entity_key,'relationKind',relation_kind,'sourceRecordId',source_record_id,'sourceObservationId',source_observation_id,'occurredTick',occurred_tick,'occurredOrdinal',occurred_ordinal,'availableFromTick',available_from_tick,'availableFromOrdinal',available_from_ordinal,'content','\"\"'::jsonb,'fidelity','0'::jsonb) END wire_head, octet_length(content)::bigint content_bytes,length(content) content_chars, fidelity::text fidelity_text, (octet_length(content)::bigint )::text lower_bytes FROM relationship_states WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND (source_record_id=$4) ORDER BY observer_continuity_id COLLATE \"C\",target_entity_key COLLATE \"C\",relation_kind COLLATE \"C\" LIMIT 1000) memory_headers ORDER BY keys COLLATE \"C\"",
  "/* memory resource header snapshots */ SELECT keys,invalid,lower_bytes,content_bytes,content_chars,fidelity_text, lower_bytes::numeric > 67108564 AS oversize, CASE WHEN lower_bytes::numeric > 67108564 THEN NULL ELSE wire_head END head FROM (SELECT CASE WHEN (COALESCE(octet_length(id),0)>512 OR COALESCE(octet_length(observer_continuity_id),0)>512 OR EXISTS (SELECT 1 FROM unnest(item_ids) value WHERE length(value)>512)) THEN NULL ELSE ARRAY[id] END keys, (COALESCE(octet_length(id),0)>512 OR COALESCE(octet_length(observer_continuity_id),0)>512 OR EXISTS (SELECT 1 FROM unnest(item_ids) value WHERE length(value)>512)) AS invalid,CASE WHEN (COALESCE(octet_length(id),0)>512 OR COALESCE(octet_length(observer_continuity_id),0)>512 OR EXISTS (SELECT 1 FROM unnest(item_ids) value WHERE length(value)>512)) THEN NULL ELSE jsonb_build_object('sourceSnapshotId',id,'sourceObserverContinuityId',observer_continuity_id,'snapshotKind',snapshot_kind,'cursorTick',cursor_tick,'cursorOrdinal',cursor_ordinal,'cacheEpoch',cache_epoch,'tokenCount',token_count,'content','\"\"'::jsonb,'sourceItemIds','[]'::jsonb) END wire_head, octet_length(content)::bigint content_bytes,length(content) content_chars, NULL::text fidelity_text, (octet_length(content)::bigint +(COALESCE((SELECT sum(octet_length(value)) FROM unnest(item_ids) value),0) +CASE WHEN cardinality(item_ids)>0 THEN 3::bigint*cardinality(item_ids)-1 ELSE 0 END) )::text lower_bytes FROM memory_snapshots WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND (true) ORDER BY id COLLATE \"C\" LIMIT 1000) memory_headers ORDER BY keys COLLATE \"C\"",
  "/* runtime event headers */ SELECT record_version, record_ordinal, world_tick, world_ordinal, actor_participant_id IS NULL AS actor_is_null, COALESCE(octet_length(id),0) AS id_bytes, COALESCE(length(id),0) AS id_chars, CASE WHEN octet_length(id)<=256 THEN id ELSE NULL END AS id,COALESCE(octet_length(event_kind),0) AS event_kind_bytes, COALESCE(length(event_kind),0) AS event_kind_chars, CASE WHEN octet_length(event_kind)<=256 THEN event_kind ELSE NULL END AS event_kind,COALESCE(octet_length(speaker_name),0) AS speaker_name_bytes, COALESCE(length(speaker_name),0) AS speaker_name_chars, CASE WHEN octet_length(speaker_name)<=256 THEN speaker_name ELSE NULL END AS speaker_name,COALESCE(octet_length(actor_participant_id),0) AS actor_participant_id_bytes, COALESCE(length(actor_participant_id),0) AS actor_participant_id_chars, CASE WHEN octet_length(actor_participant_id)<=256 THEN actor_participant_id ELSE NULL END AS actor_participant_id,COALESCE(octet_length(scene_id),0) AS scene_id_bytes, COALESCE(length(scene_id),0) AS scene_id_chars, CASE WHEN octet_length(scene_id)<=256 THEN scene_id ELSE NULL END AS scene_id,COALESCE(octet_length(visibility_policy_id),0) AS visibility_policy_id_bytes, COALESCE(length(visibility_policy_id),0) AS visibility_policy_id_chars, CASE WHEN octet_length(visibility_policy_id)<=256 THEN visibility_policy_id ELSE NULL END AS visibility_policy_id,COALESCE(octet_length(calendar_id),0) AS calendar_id_bytes, COALESCE(length(calendar_id),0) AS calendar_id_chars, CASE WHEN octet_length(calendar_id)<=256 THEN calendar_id ELSE NULL END AS calendar_id,COALESCE(octet_length(display_time),0) AS display_time_bytes, COALESCE(length(display_time),0) AS display_time_chars, CASE WHEN octet_length(display_time)<=256 THEN display_time ELSE NULL END AS display_time,COALESCE(octet_length(content),0) AS content_bytes, COALESCE(length(content),0) AS content_chars, CASE WHEN octet_length(content)<=256 THEN content ELSE NULL END AS content, CASE WHEN octet_length((CASE WHEN jsonb_path_exists(payload, 'strict $.** ? (@.type() == \"number\" && (@ >= 179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792 || @ <= -179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792))') THEN '{}'::jsonb ELSE payload END)::text)<=256 THEN (CASE WHEN jsonb_path_exists(payload, 'strict $.** ? (@.type() == \"number\" && (@ >= 179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792 || @ <= -179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792))') THEN '{}'::jsonb ELSE payload END) ELSE NULL END AS payload, octet_length(convert_to((CASE WHEN jsonb_path_exists(payload, 'strict $.** ? (@.type() == \"number\" && (@ >= 179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792 || @ <= -179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792))') THEN '{}'::jsonb ELSE payload END)::text, 'UTF8')) AS payload_bytes FROM events WHERE workspace_id=$1 AND record_id=$2 AND ($3::bigint IS NULL OR (record_ordinal,id)>($3::bigint,$4::text)) ORDER BY record_ordinal ASC, id ASC LIMIT 1000",
  "/* runtime outbox headers; outbox preflight; outbox bounded envelope */ SELECT ctid::text AS row_locator, created_at::text AS created_at, COALESCE(length(id),0) AS id_chars, COALESCE(octet_length(id),0) AS id_bytes, CASE WHEN octet_length(id)<=256 THEN id ELSE NULL END AS id,COALESCE(length(event_id),0) AS event_id_chars, COALESCE(octet_length(event_id),0) AS event_id_bytes, CASE WHEN octet_length(event_id)<=256 THEN event_id ELSE NULL END AS event_id, event_id IS NULL AS event_id_is_null, (CASE WHEN dedupe_key IS NULL THEN true WHEN length(dedupe_key)>512 THEN false ELSE (SELECT COALESCE(sum(CASE WHEN ascii(ch)>65535 THEN 2 ELSE 1 END),0)<=512 FROM regexp_split_to_table(dedupe_key, '') AS characters(ch)) END) AS dedupe_key_valid, CASE WHEN (CASE WHEN dedupe_key IS NULL THEN true WHEN length(dedupe_key)>512 THEN false ELSE (SELECT COALESCE(sum(CASE WHEN ascii(ch)>65535 THEN 2 ELSE 1 END),0)<=512 FROM regexp_split_to_table(dedupe_key, '') AS characters(ch)) END) THEN dedupe_key ELSE NULL END AS dedupe_key,(CASE WHEN topic IS NULL THEN true WHEN length(topic)>256 THEN false ELSE (SELECT COALESCE(sum(CASE WHEN ascii(ch)>65535 THEN 2 ELSE 1 END),0)<=256 FROM regexp_split_to_table(topic, '') AS characters(ch)) END) AS topic_valid, CASE WHEN (CASE WHEN topic IS NULL THEN true WHEN length(topic)>256 THEN false ELSE (SELECT COALESCE(sum(CASE WHEN ascii(ch)>65535 THEN 2 ELSE 1 END),0)<=256 FROM regexp_split_to_table(topic, '') AS characters(ch)) END) THEN topic ELSE NULL END AS topic,(CASE WHEN lease_owner IS NULL THEN true WHEN length(lease_owner)>256 THEN false ELSE (SELECT COALESCE(sum(CASE WHEN ascii(ch)>65535 THEN 2 ELSE 1 END),0)<=256 FROM regexp_split_to_table(lease_owner, '') AS characters(ch)) END) AS lease_owner_valid, CASE WHEN (CASE WHEN lease_owner IS NULL THEN true WHEN length(lease_owner)>256 THEN false ELSE (SELECT COALESCE(sum(CASE WHEN ascii(ch)>65535 THEN 2 ELSE 1 END),0)<=256 FROM regexp_split_to_table(lease_owner, '') AS characters(ch)) END) THEN lease_owner ELSE NULL END AS lease_owner,(CASE WHEN last_error_code IS NULL THEN true WHEN length(last_error_code)>128 THEN false ELSE (SELECT COALESCE(sum(CASE WHEN ascii(ch)>65535 THEN 2 ELSE 1 END),0)<=128 FROM regexp_split_to_table(last_error_code, '') AS characters(ch)) END) AS last_error_code_valid, CASE WHEN (CASE WHEN last_error_code IS NULL THEN true WHEN length(last_error_code)>128 THEN false ELSE (SELECT COALESCE(sum(CASE WHEN ascii(ch)>65535 THEN 2 ELSE 1 END),0)<=128 FROM regexp_split_to_table(last_error_code, '') AS characters(ch)) END) THEN last_error_code ELSE NULL END AS last_error_code,(CASE WHEN last_error_message IS NULL THEN true WHEN length(last_error_message)>4096 THEN false ELSE (SELECT COALESCE(sum(CASE WHEN ascii(ch)>65535 THEN 2 ELSE 1 END),0)<=4096 FROM regexp_split_to_table(last_error_message, '') AS characters(ch)) END) AS last_error_message_valid, CASE WHEN (CASE WHEN last_error_message IS NULL THEN true WHEN length(last_error_message)>4096 THEN false ELSE (SELECT COALESCE(sum(CASE WHEN ascii(ch)>65535 THEN 2 ELSE 1 END),0)<=4096 FROM regexp_split_to_table(last_error_message, '') AS characters(ch)) END) THEN last_error_message ELSE NULL END AS last_error_message, state, attempt_count, available_at, lease_expires_at, last_error_at FROM outbox WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4 AND state IN ('pending', 'delivering', 'retryable', 'failed') AND ($5::timestamptz IS NULL OR (created_at,id)>($5::timestamptz,$6::text)) ORDER BY created_at ASC, id ASC LIMIT 1000",
  "/* runtime topology participants headers */ WITH topology_source AS NOT MATERIALIZED (SELECT participant.ctid::text AS locator, participant.id AS participant_id, participant.participant_kind, participant.character_instance_id AS participant_character_instance_id, participant.principal_id AS participant_principal_id, participant.controller_mode AS participant_controller_mode, participant.is_active AS participant_is_active, participant.speaking_order AS participant_speaking_order, participant.shared_control_enabled AS participant_shared_control_enabled, instance.id AS instance_id, instance.continuity_id AS instance_continuity_id, instance.predecessor_instance_id AS instance_predecessor_id, instance.controller_mode AS instance_controller_mode, instance.status AS instance_status, instance.instantiated_tick AS instance_instantiated_tick, instance.instantiated_ordinal AS instance_instantiated_ordinal, instance.inheritance_cutoff_tick AS instance_inheritance_cutoff_tick, instance.inheritance_cutoff_ordinal AS instance_inheritance_cutoff_ordinal, instance.retired_tick AS instance_retired_tick, instance.retired_ordinal AS instance_retired_ordinal, instance.state AS instance_state, continuity.continuity_key, continuity.status AS continuity_status, continuity.born_tick AS continuity_born_tick, continuity.born_ordinal AS continuity_born_ordinal, continuity.ended_tick AS continuity_ended_tick, continuity.ended_ordinal AS continuity_ended_ordinal, definition.id AS definition_id, definition.display_name AS definition_display_name, definition.source_format AS definition_source_format, definition.profile AS definition_profile FROM participants AS participant LEFT JOIN LATERAL ( SELECT * FROM character_instances AS instance WHERE instance.workspace_id = participant.workspace_id AND instance.world_id = participant.world_id AND instance.worldline_id = participant.worldline_id AND instance.record_id = participant.record_id AND instance.id = participant.character_instance_id LIMIT 1 ) AS instance ON TRUE LEFT JOIN LATERAL ( SELECT * FROM character_continuities AS continuity WHERE continuity.workspace_id = instance.workspace_id AND continuity.world_id = instance.world_id AND continuity.worldline_id = instance.worldline_id AND continuity.id = instance.continuity_id LIMIT 1 ) AS continuity ON TRUE LEFT JOIN LATERAL ( SELECT * FROM character_definitions AS definition WHERE definition.workspace_id = continuity.workspace_id AND definition.world_id = continuity.world_id AND definition.id = continuity.definition_id LIMIT 1 ) AS definition ON TRUE WHERE participant.workspace_id = $1 AND participant.world_id = $2 AND participant.worldline_id = $3 AND participant.record_id = $4) SELECT locator, participant_is_active,participant_speaking_order,participant_shared_control_enabled,instance_instantiated_tick,instance_instantiated_ordinal,instance_inheritance_cutoff_tick,instance_inheritance_cutoff_ordinal,instance_retired_tick,instance_retired_ordinal,continuity_born_tick,continuity_born_ordinal,continuity_ended_tick,continuity_ended_ordinal, (SELECT count(*)::text FROM topology_source) AS source_count, ($5::bigint IS NULL OR (participant_speaking_order,participant_id)>($5::bigint,$6::text)) AS cursor_progress, (participant_id) IS NULL AS participant_id_is_null, COALESCE(octet_length(participant_id),0) AS participant_id_bytes, COALESCE(length(participant_id),0) AS participant_id_chars, CASE WHEN octet_length(participant_id)<=256 THEN participant_id ELSE NULL END AS participant_id,(participant_kind) IS NULL AS participant_kind_is_null, COALESCE(octet_length(participant_kind),0) AS participant_kind_bytes, COALESCE(length(participant_kind),0) AS participant_kind_chars, CASE WHEN octet_length(participant_kind)<=256 THEN participant_kind ELSE NULL END AS participant_kind,(participant_character_instance_id) IS NULL AS participant_character_instance_id_is_null, COALESCE(octet_length(participant_character_instance_id),0) AS participant_character_instance_id_bytes, COALESCE(length(participant_character_instance_id),0) AS participant_character_instance_id_chars, CASE WHEN octet_length(participant_character_instance_id)<=256 THEN participant_character_instance_id ELSE NULL END AS participant_character_instance_id,(participant_principal_id) IS NULL AS participant_principal_id_is_null, COALESCE(octet_length(participant_principal_id),0) AS participant_principal_id_bytes, COALESCE(length(participant_principal_id),0) AS participant_principal_id_chars, CASE WHEN octet_length(participant_principal_id)<=256 THEN participant_principal_id ELSE NULL END AS participant_principal_id,(participant_controller_mode) IS NULL AS participant_controller_mode_is_null, COALESCE(octet_length(participant_controller_mode),0) AS participant_controller_mode_bytes, COALESCE(length(participant_controller_mode),0) AS participant_controller_mode_chars, CASE WHEN octet_length(participant_controller_mode)<=256 THEN participant_controller_mode ELSE NULL END AS participant_controller_mode,(instance_id) IS NULL AS instance_id_is_null, COALESCE(octet_length(instance_id),0) AS instance_id_bytes, COALESCE(length(instance_id),0) AS instance_id_chars, CASE WHEN octet_length(instance_id)<=256 THEN instance_id ELSE NULL END AS instance_id,(instance_continuity_id) IS NULL AS instance_continuity_id_is_null, COALESCE(octet_length(instance_continuity_id),0) AS instance_continuity_id_bytes, COALESCE(length(instance_continuity_id),0) AS instance_continuity_id_chars, CASE WHEN octet_length(instance_continuity_id)<=256 THEN instance_continuity_id ELSE NULL END AS instance_continuity_id,(instance_predecessor_id) IS NULL AS instance_predecessor_id_is_null, COALESCE(octet_length(instance_predecessor_id),0) AS instance_predecessor_id_bytes, COALESCE(length(instance_predecessor_id),0) AS instance_predecessor_id_chars, CASE WHEN octet_length(instance_predecessor_id)<=256 THEN instance_predecessor_id ELSE NULL END AS instance_predecessor_id,(instance_controller_mode) IS NULL AS instance_controller_mode_is_null, COALESCE(octet_length(instance_controller_mode),0) AS instance_controller_mode_bytes, COALESCE(length(instance_controller_mode),0) AS instance_controller_mode_chars, CASE WHEN octet_length(instance_controller_mode)<=256 THEN instance_controller_mode ELSE NULL END AS instance_controller_mode,(instance_status) IS NULL AS instance_status_is_null, COALESCE(octet_length(instance_status),0) AS instance_status_bytes, COALESCE(length(instance_status),0) AS instance_status_chars, CASE WHEN octet_length(instance_status)<=256 THEN instance_status ELSE NULL END AS instance_status,(continuity_key) IS NULL AS continuity_key_is_null, COALESCE(octet_length(continuity_key),0) AS continuity_key_bytes, COALESCE(length(continuity_key),0) AS continuity_key_chars, CASE WHEN octet_length(continuity_key)<=256 THEN continuity_key ELSE NULL END AS continuity_key,(continuity_status) IS NULL AS continuity_status_is_null, COALESCE(octet_length(continuity_status),0) AS continuity_status_bytes, COALESCE(length(continuity_status),0) AS continuity_status_chars, CASE WHEN octet_length(continuity_status)<=256 THEN continuity_status ELSE NULL END AS continuity_status,(definition_id) IS NULL AS definition_id_is_null, COALESCE(octet_length(definition_id),0) AS definition_id_bytes, COALESCE(length(definition_id),0) AS definition_id_chars, CASE WHEN octet_length(definition_id)<=256 THEN definition_id ELSE NULL END AS definition_id,(definition_display_name) IS NULL AS definition_display_name_is_null, COALESCE(octet_length(definition_display_name),0) AS definition_display_name_bytes, COALESCE(length(definition_display_name),0) AS definition_display_name_chars, CASE WHEN octet_length(definition_display_name)<=256 THEN definition_display_name ELSE NULL END AS definition_display_name,(definition_source_format) IS NULL AS definition_source_format_is_null, COALESCE(octet_length(definition_source_format),0) AS definition_source_format_bytes, COALESCE(length(definition_source_format),0) AS definition_source_format_chars, CASE WHEN octet_length(definition_source_format)<=256 THEN definition_source_format ELSE NULL END AS definition_source_format,((CASE WHEN jsonb_typeof(instance_state)='object' AND NOT jsonb_path_exists(instance_state, 'strict $.** ? (@.type() == \"number\" && (@ >= 179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792 || @ <= -179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792))') THEN instance_state ELSE '{}'::jsonb END)::text) IS NULL AS instance_state_is_null, COALESCE(octet_length((CASE WHEN jsonb_typeof(instance_state)='object' AND NOT jsonb_path_exists(instance_state, 'strict $.** ? (@.type() == \"number\" && (@ >= 179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792 || @ <= -179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792))') THEN instance_state ELSE '{}'::jsonb END)::text),0) AS instance_state_bytes, COALESCE(length((CASE WHEN jsonb_typeof(instance_state)='object' AND NOT jsonb_path_exists(instance_state, 'strict $.** ? (@.type() == \"number\" && (@ >= 179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792 || @ <= -179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792))') THEN instance_state ELSE '{}'::jsonb END)::text),0) AS instance_state_chars, CASE WHEN octet_length((CASE WHEN jsonb_typeof(instance_state)='object' AND NOT jsonb_path_exists(instance_state, 'strict $.** ? (@.type() == \"number\" && (@ >= 179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792 || @ <= -179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792))') THEN instance_state ELSE '{}'::jsonb END)::text)<=256 THEN (CASE WHEN jsonb_typeof(instance_state)='object' AND NOT jsonb_path_exists(instance_state, 'strict $.** ? (@.type() == \"number\" && (@ >= 179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792 || @ <= -179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792))') THEN instance_state ELSE '{}'::jsonb END)::text ELSE NULL END AS instance_state,((CASE WHEN jsonb_typeof(definition_profile)='object' AND NOT jsonb_path_exists(definition_profile, 'strict $.** ? (@.type() == \"number\" && (@ >= 179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792 || @ <= -179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792))') THEN definition_profile ELSE '{}'::jsonb END)::text) IS NULL AS definition_profile_is_null, COALESCE(octet_length((CASE WHEN jsonb_typeof(definition_profile)='object' AND NOT jsonb_path_exists(definition_profile, 'strict $.** ? (@.type() == \"number\" && (@ >= 179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792 || @ <= -179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792))') THEN definition_profile ELSE '{}'::jsonb END)::text),0) AS definition_profile_bytes, COALESCE(length((CASE WHEN jsonb_typeof(definition_profile)='object' AND NOT jsonb_path_exists(definition_profile, 'strict $.** ? (@.type() == \"number\" && (@ >= 179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792 || @ <= -179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792))') THEN definition_profile ELSE '{}'::jsonb END)::text),0) AS definition_profile_chars, CASE WHEN octet_length((CASE WHEN jsonb_typeof(definition_profile)='object' AND NOT jsonb_path_exists(definition_profile, 'strict $.** ? (@.type() == \"number\" && (@ >= 179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792 || @ <= -179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792))') THEN definition_profile ELSE '{}'::jsonb END)::text)<=256 THEN (CASE WHEN jsonb_typeof(definition_profile)='object' AND NOT jsonb_path_exists(definition_profile, 'strict $.** ? (@.type() == \"number\" && (@ >= 179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792 || @ <= -179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792))') THEN definition_profile ELSE '{}'::jsonb END)::text ELSE NULL END AS definition_profile FROM topology_source WHERE ($5::bigint IS NULL OR (participant_speaking_order,participant_id)>($5::bigint,$6::text)) ORDER BY participant_speaking_order ASC, participant_id ASC LIMIT 1000",
  "/* runtime topology scenes headers */ WITH topology_source AS NOT MATERIALIZED (SELECT ctid::text AS locator, id AS scene_id, title, status, location, objective, tension, weather, display_time, start_tick, start_ordinal, end_tick, end_ordinal FROM scenes WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4) SELECT locator, start_tick,start_ordinal,end_tick,end_ordinal, (SELECT count(*)::text FROM topology_source) AS source_count, ($5::bigint IS NULL OR (start_tick,start_ordinal,scene_id)>($5::bigint,$6::bigint,$7::text)) AS cursor_progress, (scene_id) IS NULL AS scene_id_is_null, COALESCE(octet_length(scene_id),0) AS scene_id_bytes, COALESCE(length(scene_id),0) AS scene_id_chars, CASE WHEN octet_length(scene_id)<=256 THEN scene_id ELSE NULL END AS scene_id,(title) IS NULL AS title_is_null, COALESCE(octet_length(title),0) AS title_bytes, COALESCE(length(title),0) AS title_chars, CASE WHEN octet_length(title)<=256 THEN title ELSE NULL END AS title,(status) IS NULL AS status_is_null, COALESCE(octet_length(status),0) AS status_bytes, COALESCE(length(status),0) AS status_chars, CASE WHEN octet_length(status)<=256 THEN status ELSE NULL END AS status,(location) IS NULL AS location_is_null, COALESCE(octet_length(location),0) AS location_bytes, COALESCE(length(location),0) AS location_chars, CASE WHEN octet_length(location)<=256 THEN location ELSE NULL END AS location,(objective) IS NULL AS objective_is_null, COALESCE(octet_length(objective),0) AS objective_bytes, COALESCE(length(objective),0) AS objective_chars, CASE WHEN octet_length(objective)<=256 THEN objective ELSE NULL END AS objective,(tension) IS NULL AS tension_is_null, COALESCE(octet_length(tension),0) AS tension_bytes, COALESCE(length(tension),0) AS tension_chars, CASE WHEN octet_length(tension)<=256 THEN tension ELSE NULL END AS tension,(weather) IS NULL AS weather_is_null, COALESCE(octet_length(weather),0) AS weather_bytes, COALESCE(length(weather),0) AS weather_chars, CASE WHEN octet_length(weather)<=256 THEN weather ELSE NULL END AS weather,(display_time) IS NULL AS display_time_is_null, COALESCE(octet_length(display_time),0) AS display_time_bytes, COALESCE(length(display_time),0) AS display_time_chars, CASE WHEN octet_length(display_time)<=256 THEN display_time ELSE NULL END AS display_time FROM topology_source WHERE ($5::bigint IS NULL OR (start_tick,start_ordinal,scene_id)>($5::bigint,$6::bigint,$7::text)) ORDER BY start_tick ASC, start_ordinal ASC, scene_id ASC LIMIT 1000",
  "/* runtime topology visibility headers */ WITH topology_source AS NOT MATERIALIZED (SELECT ctid::text AS locator, id AS policy_id, policy_key, policy_version, policy_kind, scene_id, restricted_domain_id, private_character_instance_id, audience_character_instance_ids FROM visibility_policies WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4) SELECT locator, policy_version, (SELECT count(*)::text FROM topology_source) AS source_count, ($5::text IS NULL OR (policy_key,policy_version,policy_id)>($5::text,$6::bigint,$7::text)) AS cursor_progress, (policy_id) IS NULL AS policy_id_is_null, COALESCE(octet_length(policy_id),0) AS policy_id_bytes, COALESCE(length(policy_id),0) AS policy_id_chars, CASE WHEN octet_length(policy_id)<=256 THEN policy_id ELSE NULL END AS policy_id,(policy_key) IS NULL AS policy_key_is_null, COALESCE(octet_length(policy_key),0) AS policy_key_bytes, COALESCE(length(policy_key),0) AS policy_key_chars, CASE WHEN octet_length(policy_key)<=256 THEN policy_key ELSE NULL END AS policy_key,(policy_kind) IS NULL AS policy_kind_is_null, COALESCE(octet_length(policy_kind),0) AS policy_kind_bytes, COALESCE(length(policy_kind),0) AS policy_kind_chars, CASE WHEN octet_length(policy_kind)<=256 THEN policy_kind ELSE NULL END AS policy_kind,(scene_id) IS NULL AS scene_id_is_null, COALESCE(octet_length(scene_id),0) AS scene_id_bytes, COALESCE(length(scene_id),0) AS scene_id_chars, CASE WHEN octet_length(scene_id)<=256 THEN scene_id ELSE NULL END AS scene_id,(restricted_domain_id) IS NULL AS restricted_domain_id_is_null, COALESCE(octet_length(restricted_domain_id),0) AS restricted_domain_id_bytes, COALESCE(length(restricted_domain_id),0) AS restricted_domain_id_chars, CASE WHEN octet_length(restricted_domain_id)<=256 THEN restricted_domain_id ELSE NULL END AS restricted_domain_id,(private_character_instance_id) IS NULL AS private_character_instance_id_is_null, COALESCE(octet_length(private_character_instance_id),0) AS private_character_instance_id_bytes, COALESCE(length(private_character_instance_id),0) AS private_character_instance_id_chars, CASE WHEN octet_length(private_character_instance_id)<=256 THEN private_character_instance_id ELSE NULL END AS private_character_instance_id,((to_jsonb(audience_character_instance_ids))::text) IS NULL AS audience_character_instance_ids_is_null, COALESCE(octet_length((to_jsonb(audience_character_instance_ids))::text),0) AS audience_character_instance_ids_bytes, COALESCE(length((to_jsonb(audience_character_instance_ids))::text),0) AS audience_character_instance_ids_chars, CASE WHEN octet_length((to_jsonb(audience_character_instance_ids))::text)<=256 THEN (to_jsonb(audience_character_instance_ids))::text ELSE NULL END AS audience_character_instance_ids FROM topology_source WHERE ($5::text IS NULL OR (policy_key,policy_version,policy_id)>($5::text,$6::bigint,$7::text)) ORDER BY policy_key ASC, policy_version ASC, policy_id ASC LIMIT 1000",
  "BEGIN ISOLATION LEVEL REPEATABLE READ",
  "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  "COMMIT",
  "SELECT 1 AS unsupported_scoped_goal FROM goal_instances AS goal WHERE goal.workspace_id = $1 AND goal.world_id = $2 AND goal.worldline_id = $3 AND goal.record_id IS NULL AND ((goal.scope_kind = 'worldline' AND goal.story_id IS NULL) OR (goal.scope_kind = 'story' AND ($4::text IS NULL OR goal.story_id = $4) AND EXISTS (SELECT 1 FROM stories AS owner_story WHERE owner_story.workspace_id = goal.workspace_id AND owner_story.world_id = goal.world_id AND owner_story.worldline_id = goal.worldline_id AND owner_story.id = goal.story_id))) LIMIT 1",
  "SELECT EXISTS(SELECT 1 FROM records WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND id<>$4) AS mixed",
  "SELECT EXISTS(SELECT 1 FROM story_definition_bindings WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND story_id=$4) AS bound",
  "SELECT asset.record_id, asset.character_instance_id, asset.asset_definition_id, definition.asset_key, definition.rule_pack_key, asset.quantity, asset.revision, asset.metadata FROM character_assets AS asset JOIN asset_definitions AS definition ON definition.workspace_id = asset.workspace_id AND definition.world_id = asset.world_id AND definition.id = asset.asset_definition_id WHERE asset.workspace_id = $1 AND asset.world_id = $2 AND asset.worldline_id = $3 AND asset.record_id = $4 ORDER BY asset.character_instance_id ASC, asset.asset_definition_id ASC",
  "SELECT ca.record_id, ca.character_instance_id, ca.asset_definition_id, ad.asset_key, ad.rule_pack_key, ca.quantity, ca.revision, ca.metadata FROM character_assets ca JOIN asset_definitions ad ON ad.workspace_id = ca.workspace_id AND ad.world_id = ca.world_id AND ad.id = ca.asset_definition_id WHERE ca.workspace_id = $1 AND ca.world_id = $2 AND ca.worldline_id = $3 ORDER BY ca.character_instance_id ASC, ca.asset_definition_id ASC",
  "SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND record_id=$2 ORDER BY goal_id,definition_version",
  "SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4 ORDER BY goal_id,definition_version",
  "SELECT effect.id, effect.character_instance_id, effect.effect_definition_id, definition.effect_key, effect.source_action_receipt_id, effect.status, effect.applied_tick, effect.applied_ordinal, effect.ended_tick, effect.ended_ordinal, effect.revision, effect.metadata FROM character_effects AS effect JOIN effect_definitions AS definition ON definition.workspace_id = effect.workspace_id AND definition.world_id = effect.world_id AND definition.id = effect.effect_definition_id WHERE effect.workspace_id = $1 AND effect.world_id = $2 AND effect.worldline_id = $3 AND effect.record_id = $4 ORDER BY effect.applied_tick ASC, effect.applied_ordinal ASC, effect.id ASC",
  "SELECT id, account_id, kind, direction, amount_minor, currency, category, memo, project_id, source_record_id, source_event_id, occurred_at, idempotency_key FROM ledger_entries WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 ORDER BY occurred_at ASC, id ASC",
  "SELECT id, currency, status, opening_balance_minor FROM finance_accounts WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 ORDER BY id ASC",
  "SELECT id, goal_instance_id, source_event_id, source, status, result, evidence_event_ids, evidence_head_version, evidence_head_ordinal, evidence_snapshot_hash, policy_version FROM goal_assessments WHERE workspace_id = $1 AND record_id = $2 ORDER BY created_at ASC, id ASC",
  "SELECT id, goal_key, state, revision, progress, outcome, policy_version, definition_source,definition_id,resolution_kind,evidence_start_version,evidence_start_ordinal, attempt,supersedes_instance_id FROM goal_instances WHERE workspace_id = $1 AND record_id = $2 ORDER BY id ASC",
  "SELECT id, goal_key, state, revision, progress, outcome, policy_version, definition_source,definition_id,resolution_kind,evidence_start_version,evidence_start_ordinal,attempt,supersedes_instance_id FROM goal_instances WHERE workspace_id = $1 AND record_id = $2 ORDER BY id ASC",
  "SELECT id, kind, status, stage, title, currency, deadline::text, version FROM projects AS project WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 ORDER BY id ASC",
  "SELECT id, kind, status, stage, title, currency, deadline::text, version FROM projects WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = ANY($4::text[]) ORDER BY id ASC",
  "SELECT id, observer_character_instance_id, source_event_id, dedupe_key, observation_kind, content, fidelity, occurred_tick, occurred_ordinal, available_from_tick, available_from_ordinal, learned_at, metadata FROM observations WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4 ORDER BY occurred_tick ASC, occurred_ordinal ASC, id ASC",
  "SELECT id, observer_continuity_id, observed_entity_key, source_record_id, source_observation_id, supersedes_memory_id, operation, memory_kind, content, keywords, semantic_embedding::text AS semantic_embedding, embedding_model, fidelity, occurred_tick, occurred_ordinal, available_from_tick, available_from_ordinal, metadata FROM memory_conclusions WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND (source_record_id IS NULL OR source_record_id = $4) ORDER BY occurred_tick ASC, occurred_ordinal ASC, id ASC",
  "SELECT id, observer_continuity_id, snapshot_kind, content, item_ids, cursor_tick, cursor_ordinal, cache_epoch, token_count FROM memory_snapshots WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 ORDER BY cursor_tick ASC, cursor_ordinal ASC, id ASC",
  "SELECT id, project_id, category, amount_minor, currency, version FROM budget_allocations WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND project_id = ANY($4::text[]) ORDER BY project_id ASC, category ASC, id ASC",
  "SELECT id, project_id, kind, status, principal_minor, outstanding_minor, share_bps, undelivered_count, due_on::text, version FROM obligations WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND (project_id IS NULL OR project_id = ANY($4::text[])) ORDER BY id ASC",
  "SELECT id, project_id, sequence, title, status, due_on::text, completion_record_id, completion_event_id FROM project_milestones WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND project_id = ANY($4::text[]) ORDER BY project_id ASC, sequence ASC, id ASC",
  "SELECT id, project_id, story_id, link_kind FROM project_story_links WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND project_id = ANY($4::text[]) ORDER BY project_id ASC, id ASC",
  "SELECT id, project_id, story_id, link_kind FROM project_story_links WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND story_id = $4 ORDER BY id ASC",
  "SELECT id, project_id, story_id, link_kind FROM project_story_links WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 ORDER BY project_id ASC, id ASC",
  "SELECT id, record_id, policy_version, score, evidence_event_ids, evidence_snapshot_hash, command_id FROM performance_assessments WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4 ORDER BY created_at ASC, id ASC",
  "SELECT id, record_id, policy_version, score, evidence_event_ids, evidence_snapshot_hash, command_id FROM performance_assessments WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 ORDER BY created_at ASC, id ASC",
  "SELECT id, state, beat_budget, beats_completed, requested_by, last_error FROM record_self_play_sessions WHERE workspace_id = $1 AND record_id = $2 AND world_id = $3 ORDER BY created_at ASC, id ASC",
  "SELECT id, story_id, node_key, state, revision, record_id, definition_hash, unlock_evidence_event_ids, unlock_evidence FROM story_node_instances WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND story_id = $4 ORDER BY node_key ASC",
  "SELECT id, story_id, node_key, state, revision, record_id, definition_hash, unlock_evidence_event_ids, unlock_evidence FROM story_node_instances WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 ORDER BY story_id ASC, node_key ASC",
  "SELECT id, story_id, story_node_instance_id, node_key, transition, idempotency_key, record_id, evidence_event_ids, evidence_hash, evidence FROM story_unlock_ledger WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND story_id = $4 ORDER BY created_at ASC, id ASC",
  "SELECT id, story_id, story_node_instance_id, node_key, transition, idempotency_key, record_id, evidence_event_ids, evidence_hash, evidence FROM story_unlock_ledger WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 ORDER BY created_at ASC, id ASC",
  "SELECT id, subject_entity_key, object_entity_key, relation_kind, revision_ordinal, source_event_id, source_record_id, occurred_tick, occurred_ordinal, command_id FROM member_relationship_revisions WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND source_record_id = $4 ORDER BY subject_entity_key ASC, object_entity_key ASC, relation_kind ASC, revision_ordinal ASC",
  "SELECT id, subject_entity_key, object_entity_key, relation_kind, revision_ordinal, source_event_id, source_record_id, occurred_tick, occurred_ordinal, command_id FROM member_relationship_revisions WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 ORDER BY subject_entity_key ASC, object_entity_key ASC, relation_kind ASC, revision_ordinal ASC",
  "SELECT id, title, status, premise FROM stories WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 ORDER BY id ASC",
  "SELECT id, transaction_id, call_fingerprint, actor_character_instance_id, source_event_id, receipt, world_tick, world_ordinal, recorded_at FROM action_receipts WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4 ORDER BY world_tick ASC, world_ordinal ASC, id ASC",
  "SELECT linked_record_id FROM records WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4",
  "SELECT observer_continuity_id, target_entity_key, relation_kind, content, fidelity, source_record_id, source_observation_id, occurred_tick, occurred_ordinal, available_from_tick, available_from_ordinal FROM relationship_states WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND (source_record_id IS NULL OR source_record_id = $4) ORDER BY observer_continuity_id ASC, target_entity_key ASC, relation_kind ASC",
  "SELECT record.id FROM records record WHERE record.workspace_id=$1 AND record.world_id=$2 AND record.worldline_id=$3 AND (EXISTS(SELECT 1 FROM record_goal_definitions definition WHERE definition.workspace_id=record.workspace_id AND definition.record_id=record.id) OR EXISTS(SELECT 1 FROM events event WHERE event.workspace_id=record.workspace_id AND event.record_id=record.id AND event.event_kind='narration.committed' AND (event.payload#>'{__realmRuntimePayload,narrativeState}' IS NOT NULL OR event.payload->'narrativeState' IS NOT NULL))) ORDER BY record.id LIMIT $4",
  "SELECT record.id, record.story_id, record.title, record.status, record.world_version, record.start_tick, record.start_ordinal, record.timeline_kind, record.linked_record_id, head.record_version, head.next_record_ordinal, head.last_event_id, head.last_world_tick, head.last_world_ordinal FROM records AS record JOIN record_heads AS head ON head.workspace_id = record.workspace_id AND head.record_id = record.id WHERE record.workspace_id = $1 AND record.world_id = $2 AND record.worldline_id = $3 AND record.id = ANY($4::text[]) ORDER BY record.start_tick ASC, record.start_ordinal ASC, record.id ASC",
  "SELECT record.world_id, record.worldline_id, record.id AS record_id, record.story_id, record.world_version, head.record_version, head.next_record_ordinal FROM records AS record JOIN worlds AS world ON world.workspace_id = record.workspace_id AND world.id = record.world_id JOIN record_heads AS head ON head.workspace_id = record.workspace_id AND head.record_id = record.id WHERE record.workspace_id = $1 AND record.id = $2",
  "SELECT record.world_id, record.worldline_id, record.id AS record_id, record.story_id, record.world_version, head.record_version, head.next_record_ordinal FROM records AS record JOIN worlds AS world ON world.workspace_id = record.workspace_id AND world.id = record.world_id JOIN record_heads AS head ON head.workspace_id = record.workspace_id AND head.record_id = record.id WHERE record.workspace_id = $1 AND record.id = $2 AND EXISTS ( SELECT 1 FROM player_world_memberships AS backup_membership WHERE backup_membership.workspace_id = record.workspace_id AND backup_membership.world_id = record.world_id AND backup_membership.principal_id = $3 AND backup_membership.role = 'owner' )",
  "SELECT role FROM player_world_memberships WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3",
  "SELECT set_config('realm.workspace_id', $1, true)",
  "SELECT settlement.id, settlement.obligation_id, settlement.ledger_entry_id, settlement.kind, settlement.amount_minor FROM obligation_settlements AS settlement JOIN obligations AS obligation ON obligation.workspace_id = settlement.workspace_id AND obligation.world_id = settlement.world_id AND obligation.worldline_id = settlement.worldline_id AND obligation.id = settlement.obligation_id WHERE settlement.workspace_id = $1 AND settlement.world_id = $2 AND settlement.worldline_id = $3 AND (obligation.project_id IS NULL OR obligation.project_id = ANY($4::text[])) ORDER BY settlement.created_at ASC, settlement.id ASC",
  "SELECT state, attempts, hook_content, suggestions, context FROM record_first_nights WHERE workspace_id = $1 AND record_id = $2 AND world_id = $3",
  "SELECT status FROM records WHERE workspace_id = $1 AND id = $2",
  "SELECT story_id, definition_hash, definition, origin, source_workspace_id, source_story_id, source_definition_hash FROM story_definition_bindings WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND story_id = ANY($4::text[]) ORDER BY story_id ASC",
  "SELECT workspace_id, world_id, worldline_id, id, idempotency_key, request_fingerprint, kind, CASE WHEN octet_length(result_manifest::text) <= $4 THEN result_manifest ELSE NULL END AS result_manifest, octet_length(result_manifest::text) > $4 AS receipt_oversized FROM committed_fact_commands WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 ORDER BY created_at ASC, id ASC",
  "SELECT workspace_id, world_id, worldline_id, id, idempotency_key, request_fingerprint, state, CASE WHEN octet_length(result_manifest::text) <= $4 THEN result_manifest ELSE NULL END AS result_manifest, octet_length(result_manifest::text) > $4 AS receipt_oversized, rejection_code, policy_version, source_record_id FROM project_finance_command_groups WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 ORDER BY created_at ASC, id ASC",
  "SELECT workspace_id,world_id,worldline_id,false AS receipt_oversized, id, idempotency_key, request_fingerprint, kind, result_manifest FROM committed_fact_commands WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 ORDER BY created_at ASC, id ASC",
  "SELECT workspace_id,world_id,worldline_id,false AS receipt_oversized, id, idempotency_key, request_fingerprint, state, result_manifest, rejection_code, policy_version, source_record_id FROM project_finance_command_groups WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 ORDER BY created_at ASC, id ASC"
]);
const SCOPED_GOAL_EXPORT_REFUSAL_SQL = `SELECT 1 AS unsupported_scoped_goal
     FROM goal_instances AS goal
     WHERE goal.workspace_id = $1 AND goal.world_id = $2 AND goal.worldline_id = $3
       AND goal.record_id IS NULL
       AND ((goal.scope_kind = 'worldline' AND goal.story_id IS NULL)
         OR (goal.scope_kind = 'story' AND ($4::text IS NULL OR goal.story_id = $4)
           AND EXISTS (SELECT 1 FROM stories AS owner_story
             WHERE owner_story.workspace_id = goal.workspace_id AND owner_story.world_id = goal.world_id
               AND owner_story.worldline_id = goal.worldline_id AND owner_story.id = goal.story_id)))
     LIMIT 1`.replace(/\s+/g, ' ').trim();
const fixtureStaticSql = new Set<string>([A2_MAP_SQL,A2_CAPABILITY_SQL]);
fixtureStaticSql.add(GOAL_TRANSPORT_CAPABILITY_SQL.replace(/\s+/g, ' ').trim());
fixtureStaticSql.add(LOAD_TRANSPORT_GOALS_SQL.replace(/\s+/g, ' ').trim());
for (const file of ['realm-runtime-save-repository.ts', 'workspace-transaction.ts'])
    for (const match of readFileSync(new URL(`../database/postgres/${file}`, import.meta.url), 'utf8').matchAll(/`([^`]*?)`/g)) {
        if (!match[1]!.includes('${'))
            fixtureStaticSql.add(match[1]!.replace(/\s+/g, ' ').trim());
    }
fixtureStaticSql.add("SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4 ORDER BY goal_id,definition_version");
fixtureStaticSql.add(`SELECT
             record.world_id,
             record.worldline_id,
             record.id AS record_id,
             record.story_id,
             record.world_version,
             head.record_version,
             head.next_record_ordinal
           FROM records AS record
           JOIN worlds AS world
             ON world.workspace_id = record.workspace_id
            AND world.id = record.world_id
           JOIN record_heads AS head
             ON head.workspace_id = record.workspace_id
            AND head.record_id = record.id
           WHERE record.workspace_id = $1
             AND record.id = $2
             AND EXISTS (
               SELECT 1 FROM player_world_memberships AS backup_membership
               WHERE backup_membership.workspace_id = record.workspace_id
                 AND backup_membership.world_id = record.world_id
                 AND backup_membership.principal_id = $3
                 AND backup_membership.role = 'owner'
             )`.replace(/\s+/g," ").trim());
const protocolFields = {
    "participants": {
        "text": [
            "participant_id",
            "participant_kind",
            "participant_character_instance_id",
            "participant_principal_id",
            "participant_controller_mode",
            "instance_id",
            "instance_continuity_id",
            "instance_predecessor_id",
            "instance_controller_mode",
            "instance_status",
            "continuity_key",
            "continuity_status",
            "definition_id",
            "definition_display_name",
            "definition_source_format"
        ],
        "json": [
            "instance_state",
            "definition_profile"
        ],
        "scalars": [
            "participant_is_active",
            "participant_speaking_order",
            "participant_shared_control_enabled",
            "instance_instantiated_tick",
            "instance_instantiated_ordinal",
            "instance_inheritance_cutoff_tick",
            "instance_inheritance_cutoff_ordinal",
            "instance_retired_tick",
            "instance_retired_ordinal",
            "continuity_born_tick",
            "continuity_born_ordinal",
            "continuity_ended_tick",
            "continuity_ended_ordinal"
        ],
        "keys": [
            "participant_speaking_order",
            "participant_id"
        ]
    },
    "scenes": {
        "text": [
            "scene_id",
            "title",
            "status",
            "location",
            "objective",
            "tension",
            "weather",
            "display_time"
        ],
        "json": [],
        "scalars": [
            "start_tick",
            "start_ordinal",
            "end_tick",
            "end_ordinal"
        ],
        "keys": [
            "start_tick",
            "start_ordinal",
            "scene_id"
        ]
    },
    "visibility": {
        "text": [
            "policy_id",
            "policy_key",
            "policy_kind",
            "scene_id",
            "restricted_domain_id",
            "private_character_instance_id"
        ],
        "json": [
            "audience_character_instance_ids"
        ],
        "scalars": [
            "policy_version"
        ],
        "keys": [
            "policy_key",
            "policy_version",
            "policy_id"
        ]
    }
} as const;
function headerRows(family: TopologyFamily, source: unknown[], values: unknown[], rawJson: Record<string, string> = {}) {
    const d = protocolFields[family], all = source as Record<string, unknown>[];
    const after = values.slice(4);
    const compare = (row: Record<string, unknown>) => { for (let i = 0; i < d.keys.length; i++) {
        const a = row[d.keys[i]!], b = after[i];
        if (String(a) === String(b))
            continue;
        return typeof a === 'number' ? a - Number(b) : String(a) < String(b) ? -1 : 1;
    } return 0; };
    return all.map((row, i) => ({ row, locator: `(0,${i + 1})` })).filter(({ row }) => after[0] === null || compare(row) > 0).slice(0, 1000).map(({ row, locator }) => ({ locator, source_count: String(all.length), cursor_progress: true, ...Object.fromEntries(d.scalars.map(k => [k, row[k]])), ...Object.fromEntries([...d.text, ...d.json].flatMap(k => {
            const raw = row[k] ?? null, value = d.json.includes(k as never) ? (rawJson[k] ?? JSON.stringify(raw === null && k !== 'audience_character_instance_ids' ? {} : raw)) : raw as string | null;
            const bytes = value === null ? 0 : Buffer.byteLength(value);
            return [[k, value !== null && bytes <= 256 ? value : null], [`${k}_is_null`, value === null], [`${k}_bytes`, bytes], [`${k}_chars`, value === null ? 0 : value.length - [...value.matchAll(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)].length]];
        })) }));
}
const resourceSql = new Map<string,string>([["SELECT id, transaction_id, call_fingerprint, actor_character_instance_id, source_event_id, receipt, world_tick, world_ordinal, recorded_at FROM action_receipts WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4 ORDER BY world_tick ASC, world_ordinal ASC, id ASC", "action_receipts"], ["SELECT effect.id, effect.character_instance_id, effect.effect_definition_id, definition.effect_key, effect.source_action_receipt_id, effect.status, effect.applied_tick, effect.applied_ordinal, effect.ended_tick, effect.ended_ordinal, effect.revision, effect.metadata FROM character_effects AS effect JOIN effect_definitions AS definition ON definition.workspace_id = effect.workspace_id AND definition.world_id = effect.world_id AND definition.id = effect.effect_definition_id WHERE effect.workspace_id = $1 AND effect.world_id = $2 AND effect.worldline_id = $3 AND effect.record_id = $4 ORDER BY effect.applied_tick ASC, effect.applied_ordinal ASC, effect.id ASC", "character_effects"], ["SELECT id, observer_character_instance_id, source_event_id, dedupe_key, observation_kind, content, fidelity, occurred_tick, occurred_ordinal, available_from_tick, available_from_ordinal, learned_at, metadata FROM observations WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4 ORDER BY occurred_tick ASC, occurred_ordinal ASC, id ASC", "observations"]]);
const scope = { workspaceId: 'ws-f4c', worldId: 'world-f4c', worldlineId: 'line-f4c', recordId: 'record-f4c' };
type Participant = RealmRuntimeSaveTopologyV1["participants"][number];
type Entry = {
    id: string;
    people: Participant[];
};
type Call = {
    sql: string;
    values: unknown[];
    returned?: number;
    bytes?: number;
    maxString?: number;
    maxBuffer?: number;
};
function participant(id: string, parent: string | null = null, continuity = 'continuity-f4c'): Participant {
    return { sourceParticipantId: `participant-${id}`, participantKind: 'character', sourcePrincipalId: null, controllerMode: 'ai', isActive: true, speakingOrder: 0, sharedControlEnabled: false,
        character: { sourceCharacterInstanceId: id, sourceContinuityId: continuity, sourcePredecessorInstanceId: parent, sourceDefinitionId: 'definition-f4c',
            definition: { displayName: '角色前驱对照', sourceFormat: 'native', profile: { literal: 'leave parent IDs in prose unchanged' } },
            continuity: { continuityKey: continuity, status: 'active', bornTick: 0, bornOrdinal: 0, endedTick: null, endedOrdinal: null },
            instance: { controllerMode: 'ai', status: 'present', instantiatedTick: 0, instantiatedOrdinal: 0, inheritanceCutoffTick: 0, inheritanceCutoffOrdinal: 0, retiredTick: null, retiredOrdinal: null, state: { literalParent: parent } } } };
}
function topologyRow(p: Participant) {
    const c = p.character!;
    return {
        participant_id: p.sourceParticipantId, participant_kind: 'character', participant_principal_id: null, participant_controller_mode: 'ai', participant_is_active: true, participant_speaking_order: 0, participant_shared_control_enabled: false,
        instance_id: c.sourceCharacterInstanceId, instance_continuity_id: c.sourceContinuityId, instance_predecessor_id: c.sourcePredecessorInstanceId, instance_controller_mode: 'ai', instance_status: 'present', instance_instantiated_tick: 0, instance_instantiated_ordinal: 0, instance_inheritance_cutoff_tick: 0, instance_inheritance_cutoff_ordinal: 0, instance_retired_tick: null, instance_retired_ordinal: null, instance_state: c.instance.state,
        continuity_key: c.continuity.continuityKey, continuity_status: 'active', continuity_born_tick: 0, continuity_born_ordinal: 0, continuity_ended_tick: null, continuity_ended_ordinal: null,
        definition_id: c.sourceDefinitionId, definition_display_name: c.definition.displayName, definition_source_format: 'native', definition_profile: c.definition.profile
    };
}
function narratorRow(p: Participant) {
    assert.equal(p.participantKind, 'narrator');
    assert.equal(p.character, null);
    return {
        ...Object.fromEntries(Object.keys(topologyRow(participant('shape'))).map(key => [key, null])),
        participant_id: p.sourceParticipantId,
        participant_kind: p.participantKind,
        participant_character_instance_id: null,
        participant_principal_id: p.sourcePrincipalId,
        participant_controller_mode: p.controllerMode,
        participant_is_active: p.isActive,
        participant_speaking_order: p.speakingOrder,
        participant_shared_control_enabled: p.sharedControlEnabled
    };
}
function reader(entries: Entry[], options: {
    resourceRows?: Record<string, Record<string, unknown>[]>;
    closeError?: boolean;
    role?: string;
    rawJson?: Record<string, string>;
    mutate?: (sql: string, rows: Record<string, unknown>[]) => Record<string, unknown>[];
    sceneRows?: Record<string, unknown>[];
    policyRows?: Record<string, unknown>[];
    ownerOverride?: {
        id: string;
        record_id: string;
        continuity_id: string;
        workspace_id: string;
        world_id: string;
        worldline_id: string;
    }[];
} = {}) {
    const calls: Call[] = [];
    type EvidenceCursor = {kind:'headers'; family:EvidenceFamily; source:Record<string,unknown>[]; offset:number} | {kind:'body';bytes:Buffer;offset:number};
    const evidenceCursors = new Map<string,EvidenceCursor>();
    const evidenceSources = new Map<string,Record<string,unknown>[]>();
    let acquired = 0, released = 0, active = false;
    const topologySources = new Map<TopologyFamily, unknown[]>(), topologyCursors = new Map<string, {
        bytes: Buffer;
        offset: number;
    }>();
    const owners = options.ownerOverride ?? entries.flatMap(entry => entry.people.flatMap(p => p.character ? [{ id: p.character.sourceCharacterInstanceId,
            record_id: entry.id, continuity_id: p.character.sourceContinuityId, workspace_id: scope.workspaceId, world_id: scope.worldId, worldline_id: scope.worldlineId }] : []));
    const emptyTables = new Set(['events', 'goal_instances', 'goal_assessments', 'record_goal_definitions',
        'memory_conclusions', 'memory_snapshots', 'relationship_states', 'outbox', 'record_first_nights', 'record_self_play_sessions', 'projects', 'project_milestones',
        'project_story_links', 'budget_allocations', 'finance_accounts', 'ledger_entries', 'project_finance_command_groups', 'obligations', 'obligation_settlements',
        'story_node_instances', 'story_unlock_ledger', 'committed_fact_commands', 'performance_assessments', 'member_relationship_revisions', 'character_assets',
        'story_definition_bindings', 'record_archives', 'worldlines', 'records']);
    const client = { release() { released++; }, async query(sql: string, values: unknown[] = []) {
            assert.equal(active, false, 'same client sequential SQL');
            active = true;
            calls.push({ sql, values });
            try {
                const normalized = sql.replace(/\s+/g, ' ').trim();
                const evidenceProtocol = sql.startsWith('/* runtime evidence ') || sql.startsWith('CLOSE realm_evidence_');
                if (!evidenceProtocol && !registeredRuntimeSql.has(normalized) && !fixtureStaticSql.has(normalized)) throw Error('UNKNOWN_SQL_TEXT:'+normalized);
                if (!evidenceProtocol && !fixtureStaticSql.has(normalized) && !sql.startsWith('/* runtime topology') && !sql.startsWith('CLOSE realm_topology_')
                    && !sql.startsWith('/* runtime event headers */') && !sql.startsWith('/* runtime outbox headers;') && !sql.startsWith('/* memory resource')

                    && !new Set(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'BEGIN ISOLATION LEVEL REPEATABLE READ', 'COMMIT', 'ROLLBACK', "SELECT set_config('realm.workspace_id', $1, true)"]).has(sql))
                    throw Error('UNKNOWN_SQL_TEXT:' + normalized);
                let rows: unknown[] = [];
                if (sql.startsWith('/* runtime evidence ') && sql.includes('DECLARE ')) {
                    const name = /DECLARE (\w+)/.exec(sql)![1]!;
                    const family = /runtime evidence (action_receipts|character_effects|observations)/.exec(sql)![1] as EvidenceFamily;
                    assert.deepEqual(values.slice(0,3),[scope.workspaceId,scope.worldId,scope.worldlineId]);
                    assert.ok(entries.some(e=>e.id===values[3]));
                    if(sql.includes(' headers */')) {
                        assert.equal(sql,evidenceHeaderSql(family,name)); assert.equal(values.length,4);
                        const source=options.resourceRows?.[`${values[3]}:${family}`]??[];
                        evidenceSources.set(`${values[3]}:${family}`,source);
                        evidenceCursors.set(name,{kind:'headers',family,source,offset:0});
                    } else {
                        const column=/runtime evidence \w+ (\w+) body/.exec(sql)![1]!;
                        assert.equal(sql,evidenceBodySql(family,column,name));assert.equal(values.length,5);
                        const source=evidenceSources.get(`${values[3]}:${family}`)!;
                        const index=Number(/,([0-9]+)\)/.exec(String(values[4]))![1])-1;
                        const row=source[index]!;
                        const value=evidenceFields[family].json.includes(column as never)?normalJson(row[column],options.rawJson?.[column]):String(row[column]);
                        evidenceCursors.set(name,{kind:'body',bytes:Buffer.from(value),offset:0});
                    }
                }
                else if(sql.startsWith('/* runtime evidence headers */')) {
                    const name=/FROM (\w+)/.exec(sql)![1]!;assert.equal(sql,`/* runtime evidence headers */ FETCH FORWARD 1000 FROM ${name}`);assert.deepEqual(values,[]);
                    const cursor=evidenceCursors.get(name);assert.ok(cursor && cursor.kind==='headers');
                    rows=cursor.source.slice(cursor.offset,cursor.offset+1000).map((row,i)=>evidenceHeader(cursor.family,row,cursor.offset+i,options.rawJson));cursor.offset+=rows.length;
                }
                else if(sql.startsWith('/* runtime evidence body */')) {
                    const name=/FROM (\w+)/.exec(sql)![1]!;assert.equal(sql,`/* runtime evidence body */ FETCH FORWARD 1 FROM ${name}`);assert.deepEqual(values,[]);
                    const cursor=evidenceCursors.get(name);assert.ok(cursor && cursor.kind==='body');
                    if(cursor.offset<cursor.bytes.length) {rows=[{chunk_start:cursor.offset+1,value:cursor.bytes.subarray(cursor.offset,cursor.offset+65536)}];cursor.offset+=65536;}
                }
                else if(sql.startsWith('CLOSE realm_evidence_')) {
                    assert.match(sql,/^CLOSE realm_evidence_[a-f0-9]+$/);assert.deepEqual(values,[]);
                    assert.ok(evidenceCursors.delete(sql.slice(6)));if(options.closeError) throw Error('injected close error');
                }
                else if(normalized===A2_CAPABILITY_SQL) {assert.deepEqual(values,[]);rows=[{command_materializations_available:true}];}
                // Explicit Goal32 fixture adaptation: installed transport schema,
                // no persisted Goal instances in this resource-only fixture.
                else if(normalized===GOAL_TRANSPORT_CAPABILITY_SQL.replace(/\s+/g, ' ').trim()) {
                    assert.deepEqual(values, []); rows=[{available:true}];
                }
                else if(normalized===LOAD_TRANSPORT_GOALS_SQL.replace(/\s+/g, ' ').trim()) {
                    assert.deepEqual(values, [scope.workspaceId,scope.worldId,scope.worldlineId,
                        ['story-f4c'],entries.map(entry=>entry.id).sort()]);
                    rows=[];
                }
                else if(normalized===A2_MAP_SQL) {assert.deepEqual(values,[scope.workspaceId,scope.worldId,scope.worldlineId]);rows=[];}
                else if (sql.includes('/* runtime topology') && sql.includes(' cursor */')) {
                    const match = /runtime topology (participants|scenes|visibility) (\w+) cursor/.exec(sql)!;
                    const family = match[1] as TopologyFamily, column = match[2]!, name = /DECLARE (\w+)/.exec(sql)![1]!;
                    assert.equal(sql, topologyBodySql(family, column, name));
                    assert.equal(values.length, 5);
                    assert.deepEqual(values.slice(0, 3), [scope.workspaceId, scope.worldId, scope.worldlineId]);
                    assert.ok(entries.some(e => e.id === values[3]));
                    const index = Number(/,([0-9]+)\)/.exec(String(values[4]))![1]) - 1;
                    const row = topologySources.get(family)![index] as Record<string, unknown>;
                    const value = protocolFields[family].json.includes(column as never) ? (options.rawJson?.[column] ?? JSON.stringify(row[column] ?? {})) : String(row[column]);
                    topologyCursors.set(name, { bytes: Buffer.from(value), offset: 0 });
                }
                else if (sql.startsWith('/* runtime topology chunk */')) {
                    assert.match(sql, /^\/\* runtime topology chunk \*\/ FETCH FORWARD 1 FROM realm_topology_[a-f0-9]+$/);
                    assert.deepEqual(values, []);
                    const name = /FROM (\w+)/.exec(sql)![1]!, c = topologyCursors.get(name);
                    assert.ok(c);
                    if (c.offset < c.bytes.length) {
                        rows = [{ chunk_start: c.offset + 1, value: c.bytes.subarray(c.offset, c.offset + 65536) }];
                        c.offset += 65536;
                    }
                }
                else if (sql.startsWith('CLOSE realm_topology_')) {
                    assert.ok(topologyCursors.delete(sql.slice(6)));
                    assert.deepEqual(values, []);
                }
                else if (sql.replace(/\s+/g, ' ').trim() === SCOPED_GOAL_EXPORT_REFUSAL_SQL) {
                    assert.deepEqual(values.slice(0, 3), [scope.workspaceId, scope.worldId, scope.worldlineId]);
                    assert.equal(values.length, 4);
                    assert.ok(values[3] === 'story-f4c' || values[3] === null);
                    rows = []; // Explicitly no persisted Story/worldline Goal facts in this Character fixture.
                }
                else if (sql.includes('record.id AS record_id'))
                    rows = sql.includes('backup_membership') && options.role !== undefined && options.role !== 'owner' ? [] : [{ world_id: scope.worldId, worldline_id: scope.worldlineId, record_id: scope.recordId, story_id: 'story-f4c', world_version: '1.2.0', record_version: 1, next_record_ordinal: 1 }];
                else if (sql.includes('FROM player_world_memberships'))
                    rows = [{ role: options.role ?? 'owner' }];
                else if (sql.includes('AS mixed'))
                    rows = [{ mixed: false }];
                else if (sql.includes('AS bound'))
                    rows = [{ bound: false }];
                else if (sql.startsWith('/* runtime event headers */')) {
                    assert.deepEqual(values.slice(0,2), [scope.workspaceId, values[1]]);
                    assert.ok(entries.some(e => e.id === values[1]));
                    if (values[2] === null) {
                        const row = eventRow(String(values[1]));
                        rows = [{record_version:'1',record_ordinal:'0',world_tick:'0',world_ordinal:'0',actor_is_null:true,
                          ...Object.fromEntries(['id','event_kind','content','speaker_name','actor_participant_id','scene_id','visibility_policy_id','calendar_id','display_time'].flatMap(k => {
                            const value=row[k] as string|null;return [[k,value],[`${k}_chars`,value===null?0:[...value].length],[`${k}_bytes`,value===null?0:Buffer.byteLength(value)]];
                          })),payload:row.payload,payload_bytes:2}];
                    }
                }
                else if (resourceSql.has(normalized)) {
                    assert.equal(values.length,4);
                    assert.deepEqual(values.slice(0,3),[scope.workspaceId,scope.worldId,scope.worldlineId]);
                    assert.ok(entries.some(e=>e.id===values[3]));
                    const table=resourceSql.get(normalized)!;
                    rows=options.resourceRows?.[`${values[3]}:${table}`]??[]; // Explicit per-table fixture; all target tables handled here, never empty fallback.
                }
                else if (sql.includes('FROM participants AS participant'))
                    rows = (entries.find(e => e.id === values[3])?.people ?? []).toSorted((a, b) => a.speakingOrder - b.speakingOrder || a.sourceParticipantId.localeCompare(b.sourceParticipantId)).map(p => p.character ? topologyRow(p) : narratorRow(p));
                else if (sql.includes('FROM scenes'))
                    rows = options.sceneRows ?? [{ scene_id: `scene-${values[3]}`, title: 'Scene', status: 'active', location: '', objective: '', tension: '', weather: '', display_time: '', start_tick: 0, start_ordinal: 0, end_tick: null, end_ordinal: null }];
                else if (sql.includes('FROM visibility_policies'))
                    rows = options.policyRows ?? [{ policy_id: `policy-${values[3]}`, policy_key: `public-${values[3]}`, policy_version: 1, policy_kind: 'public', scene_id: null, restricted_domain_id: null as string | null, private_character_instance_id: null, audience_character_instance_ids: [] as string[] }];
                else if (sql.includes('FROM stories'))
                    rows = [{ id: 'story-f4c', title: 'F4c', status: 'active', premise: '' }];
                else if (sql.includes('memory resource epoch header'))
                    rows = (values[3] as string[]).map(id => ({ observer_continuity_id: id, epoch: 0 }));
                else if (sql.includes('SELECT record.id, record.story_id, record.title'))
                    rows = entries.filter(e => (values[3] as string[]).includes(e.id)).map(e => ({ id: e.id, story_id: 'story-f4c', title: 'Sibling', status: 'active', world_version: '1.2.0', start_tick: 0, start_ordinal: 0, timeline_kind: 'primary', linked_record_id: null, record_version: 1, next_record_ordinal: 1, last_event_id: `event-${e.id}`, last_world_tick: 0, last_world_ordinal: 0 }));
                else if (sql.includes('/* export character predecessor owners */')) {
                    assert.match(sql, /workspace_id=\$1 AND world_id=\$2 AND worldline_id=\$3/);
                    assert.match(sql, /id=ANY\(\$4::text\[\]\)/);
                    assert.match(sql, /LIMIT 1000/);
                    assert.ok((values[3] as string[]).length <= 1000);
                    rows = owners.filter(o => o.workspace_id === values[0] && o.world_id === values[1] && o.worldline_id === values[2] && (values[3] as string[]).includes(o.id));
                }
                else if (/^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT|SELECT set_config|SELECT current_setting)/.test(sql)) { /* Explicit transaction protocol: no returned domain rows. */ }
                else {
                    const table = [...sql.matchAll(/\bFROM\s+(\w+)/ig)].at(-1)?.[1];
                    if (!table || !emptyTables.has(table))
                        throw new Error(`UNEXPECTED_READER_SQL: ${sql}`);
                    // Any new Character query must be explicitly modeled above.
                    assert.doesNotMatch(sql, /FROM character_instances/);
                    if (/\b(?:action_receipts|character_effects|observations)\b/.test(sql)) throw Error('TARGET_NOT_EXPLICITLY_MODELED:'+sql);
                }
                if (sql.includes(' headers */') && sql.startsWith('/* runtime topology')) {
                    const family = /runtime topology (participants|scenes|visibility)/.exec(sql)![1] as TopologyFamily;
                    assert.equal(sql, topologyHeaderSql(family));
                    assert.equal(values.length, 4 + protocolFields[family].keys.length);
                    assert.deepEqual(values.slice(0, 3), [scope.workspaceId, scope.worldId, scope.worldlineId]);
                    topologySources.set(family, rows);
                    rows = headerRows(family, rows, values, options.rawJson);
                }
                if (options.mutate)
                    rows = options.mutate(sql, rows as Record<string, unknown>[]);
                calls.at(-1)!.returned = rows.length;
                const cells=rows.flatMap(row=>Object.values(row as object));
                calls.at(-1)!.maxString=Math.max(0,...cells.filter((v):v is string=>typeof v==='string').map(v=>Buffer.byteLength(v)));
                calls.at(-1)!.maxBuffer=Math.max(0,...cells.filter(Buffer.isBuffer).map(v=>v.length));
                if(resourceSql.has(normalized)) Object.assign(calls.at(-1)!,{maxFieldBytes:Math.max(0,...rows.flatMap(r=>Object.values(r as object).map(v=>v===null?0:typeof v==='string'?Buffer.byteLength(v):typeof v==='object'?Buffer.byteLength(JSON.stringify(v)):8))),jsonBodies:rows.filter(r=>['receipt','metadata'].some(k=>Object.hasOwn(r as object,k))).length});
                calls.at(-1)!.bytes = rows.reduce((sum: number, row) => sum + Object.values(row as Record<string, unknown>).reduce((n: number, v) => n + (Buffer.isBuffer(v) ? v.length : typeof v === 'string' ? Buffer.byteLength(v) : 8), 0), 0);
                return { rows, rowCount: rows.length };
            }
            finally {
                active = false;
            }
        } };
    const database = { async connect() { acquired++; return client; } };
    async function load(purpose: 'record-export' | 'native-record-branch' | 'whole-closure-backup' = 'record-export') {
        return createPostgresRealmRuntimeSaveReader(database as never).load({ workspaceId: scope.workspaceId, recordId: scope.recordId, principalId: 'owner-f4c', purpose, ...(purpose === 'native-record-branch' ? { sessionProof: 'protocol-proof' } : {}) });
    }
    return { load, calls, evidenceCursors, query: client.query.bind(client), cursors: topologyCursors, counts: () => ({ acquired, released }) };
}
async function loadPurpose(f: ReturnType<typeof reader>, purpose: 'record-export' | 'native-record-branch' | 'whole-closure-backup') {
    const old = process.env.REALM_OPERATOR_PRINCIPALS;
    process.env.REALM_OPERATOR_PRINCIPALS = 'owner-f4c';
    try {
        return await f.load(purpose);
    }
    finally {
        if (old === undefined)
            delete process.env.REALM_OPERATOR_PRINCIPALS;
        else
            process.env.REALM_OPERATOR_PRINCIPALS = old;
    }
}


function eventRow(id: string):Record<string,unknown> { return {id:`event-${id}`,record_version:'1',record_ordinal:'0',event_kind:'narration.committed',payload:{},content:'Legal fact',speaker_name:'',actor_participant_id:null,scene_id:`scene-${id}`,visibility_policy_id:`policy-${id}`,world_tick:'0',world_ordinal:'0',calendar_id:'calendar',display_time:''}; }

function normalJson(value: unknown, raw?:string):string {
    if(raw!==undefined) {const parsed=JSON.parse(raw);return validObject(parsed)?raw:'{}';}
    return JSON.stringify(validObject(value)?value:{});
}
function validObject(value:unknown):boolean {
    return value!==null && typeof value==='object' && !Array.isArray(value) && finiteJson(value);
}
function finiteJson(value:unknown):boolean {
    return typeof value==='number'?Number.isFinite(value):value!==null&&typeof value==='object'?Object.values(value).every(finiteJson):true;
}
function evidenceHeader(family:EvidenceFamily,row:Record<string,unknown>,index:number,rawJson:Record<string,string>={}) {
    const d=evidenceFields[family];
    return {locator:`(0,${index+1})`,row_position:String(index+1),...Object.fromEntries(d.scalars.map(k=>[k,row[k]])),...Object.fromEntries([...d.text,...d.json].flatMap(k=>{
        const value=d.json.includes(k as never)?normalJson(row[k],rawJson[k]):row[k] as string|null;
        const bytes=value===null?0:Buffer.byteLength(value);
        return [[k,value!==null&&bytes<=256?value:null],[`${k}_is_null`,value===null],[`${k}_bytes`,bytes],[`${k}_chars`,value===null?0:[...value].length]];
    }))};
}
function fixtureRows(recordId:string,count=1,big=false) {
    const receipt:Record<string,unknown>[]=[],effect:Record<string,unknown>[]=[],observation:Record<string,unknown>[]=[];
    const text=big?Array.from({length:16384},(_,i)=>createHash('sha256').update(String(i)).digest('hex')).join(''):' valid content ';
    for(let i=0;i<count;i++) {
        const suffix=String(i).padStart(6,'0');
        receipt.push({id:`receipt-${recordId}-${suffix}`,transaction_id:`tx-${i}`,call_fingerprint:' spaced \uFEFF ',actor_character_instance_id:recordId==='sibling'?'parent':'actor',source_event_id:`event-${recordId}`,receipt:i===0?{text}:{},world_tick:'0',world_ordinal:'0',recorded_at:'2026-01-01T00:00:00.000Z'});
        effect.push({id:`effect-${recordId}-${suffix}`,character_instance_id:recordId==='sibling'?'parent':'actor',effect_definition_id:'definition-effect',effect_key:'buff',source_action_receipt_id:`receipt-${recordId}-${suffix}`,status:'expired',applied_tick:'0',applied_ordinal:'0',ended_tick:'0',ended_ordinal:'0',revision:'0',metadata:i===0?{text}:{}});
        observation.push({id:`observation-${recordId}-${suffix}`,observer_character_instance_id:recordId==='sibling'?'parent':'actor',source_event_id:`event-${recordId}`,dedupe_key:`dedupe-${i}`,observation_kind:'direct',content:i===0?text:'small',fidelity:'1',occurred_tick:'0',occurred_ordinal:'0',available_from_tick:'0',available_from_ordinal:'0',learned_at:'2026-01-01T00:00:00.000Z',metadata:{}});
    }
    return {[`${recordId}:action_receipts`]:receipt,[`${recordId}:character_effects`]:effect,[`${recordId}:observations`]:observation};
}
test('N3 preserves leading FEFF in chunked database text through real ZIP', async () => {
    const source = fixtureRows(scope.recordId);
    const transaction = '\uFEFF' + 't'.repeat(300);
    const fingerprint = '\uFEFF' + 'f'.repeat(300);
    // Put the astral code point across the 65536-byte driver chunk boundary.
    const content = '\uFEFF' + Array.from({ length: 1024 }, (_, i) => createHash('sha256').update(`FEFF-${i}`).digest('hex')).join('').slice(0, 65532) + '😀tail';
    source[`${scope.recordId}:action_receipts`]![0]!.transaction_id = transaction;
    source[`${scope.recordId}:action_receipts`]![0]!.call_fingerprint = fingerprint;
    source[`${scope.recordId}:observations`]![0]!.content = content;
    const f = fixture(1, false, false, { resourceRows: source });
    const archive = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive((await loadPurpose(f, 'record-export'))!));
    assert.equal(archive.actionReceipts!.receipts[0]!.transactionId, transaction);
    assert.equal(archive.actionReceipts!.receipts[0]!.callFingerprint, fingerprint);
    assert.equal(archive.observations!.observations[0]!.content, content);
    assert.ok(f.calls.filter(c => c.sql.startsWith('/* runtime evidence body */')).length > 3);
    assertCleanup(f, true);
});

test('N3 public reader retains a narrator participant alongside evidence', async () => {
    const actor = participant('actor');
    const narrator: Participant = { ...actor, sourceParticipantId: 'narrator-evidence', participantKind: 'narrator', speakingOrder: 1, character: null };
    const f = reader([{ id: scope.recordId, people: [actor, narrator] }], { resourceRows: fixtureRows(scope.recordId) });
    const archive = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive((await loadPurpose(f, 'record-export'))!));
    const actual = archive.topology!.participants.find(p => p.sourceParticipantId === narrator.sourceParticipantId);
    assert.ok(actual);
    assert.equal(actual.participantKind, 'narrator');
    assert.equal(actual.speakingOrder, 1);
    assert.equal(actual.character, null);
    assertCleanup(f, true);
});

function fixture(count=1,big=false,sibling=false,options:Parameters<typeof reader>[1]={}) {
    const entries:Entry[]=[{id:scope.recordId,people:[participant('actor',sibling?'parent':null)]}];
    const resourceRows=fixtureRows(scope.recordId,count,big);
    if(sibling) {entries.push({id:'sibling',people:[participant('parent')]});Object.assign(resourceRows,fixtureRows('sibling',count,big));}
    return reader(entries,{resourceRows,...options});
}
function assertCleanup(f:ReturnType<typeof reader>,success:boolean) {
    assert.deepEqual(f.counts(),{acquired:1,released:1});assert.equal(f.evidenceCursors.size,0);
    assert.ok(f.calls.some(c=>c.sql===(success?'COMMIT':'ROLLBACK')));
}
for(const purpose of ['record-export','native-record-branch','whole-closure-backup'] as const)
    test(`N3 public ${purpose} pages every row and bounds all fields`,async()=>{
        const f=fixture(2001,true,purpose==='whole-closure-backup');
        const a=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive((await loadPurpose(f,purpose))!));
        assert.equal(a.actionReceipts!.receipts.length,2001);assert.equal(a.characterEffects!.effects.length,2001);assert.equal(a.observations!.observations.length,2001);
        assert.equal(a.actionReceipts!.receipts[2000]!.sourceReceiptId,`receipt-${scope.recordId}-002000`);
        assert.equal(a.actionReceipts!.receipts[0]!.callFingerprint,' spaced \uFEFF ');
        if(purpose==='whole-closure-backup') assert.equal(a.domain!.records![0]!.bundle.actionReceipts!.receipts.length,2001);
        const headers=f.calls.filter(c=>c.sql.startsWith('/* runtime evidence headers */'));
        assert.ok(headers.every(c=>(c.returned??0)<=1000 && (c.maxString??0)<=256));
        assert.equal(headers.length,purpose==='whole-closure-backup'?24:12);
        const bodies=f.calls.filter(c=>c.sql.startsWith('/* runtime evidence body */'));
        assert.ok(bodies.length>30);assert.ok(bodies.every(c=>(c.returned??0)<=1&&(c.maxBuffer??0)<=65536));
        assertCleanup(f,true);
    });
test('N3 strict registry rejects unknown SQL rather than producing an empty fixture',async()=>{
    const f=fixture();await assert.rejects(f.query('SELECT unsupported_probe'),/UNKNOWN_SQL_TEXT/);
});
for(const limit of [512,513]) test(`N3 UTF16 transaction boundary ${limit}`,async()=>{
    const source=fixtureRows(scope.recordId);source[`${scope.recordId}:action_receipts`]![0]!.transaction_id='😀'.repeat(256)+(limit===513?'x':'');
    const f=fixture(1,false,false,{resourceRows:source});
    if(limit===513) {await assert.rejects(loadPurpose(f,'record-export'));assertCleanup(f,false);assert.equal(f.calls.filter(c=>c.sql.includes('receipt body */')).length,0);}
    else {const a=(await loadPurpose(f,'record-export'))!;assert.equal(a.actionReceipts!.receipts[0]!.transactionId.length,512);assertCleanup(f,true);}
});
test('N3 JSON whole-object overflow fallback and long safe identity survive public formatter',async()=>{
    const source=fixtureRows(scope.recordId);const receipt=source[`${scope.recordId}:action_receipts`]![0]!;
    receipt.receipt={before:'x'.repeat(70000),nested:{overflow:Infinity}};
    receipt.id='long-'+ 'a'.repeat(10000);
    source[`${scope.recordId}:character_effects`]![0]!.source_action_receipt_id=receipt.id;
    const f=fixture(1,false,false,{resourceRows:source});const a=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive((await loadPurpose(f,'record-export'))!));
    assert.deepEqual(a.actionReceipts!.receipts[0]!.receipt,{});assert.equal(a.actionReceipts!.receipts[0]!.sourceReceiptId,receipt.id);assert.equal(a.observations!.observations[0]!.content,' valid content ');assertCleanup(f,true);
});
for(const fault of ['position','truncated','bad-utf8','extra','header-position','header-length','fetch-error','primary-close'] as const)
    test(`N3 public protocol ${fault} fails closed and releases`,async()=>{
        let injected=false;
        const f=fixture(1,true,false,{closeError:fault==='primary-close',mutate(sql,rows){
            if(!injected && fault.startsWith('header-') && sql.startsWith('/* runtime evidence headers */') && rows.length) {injected=true;return rows.map((r,i)=>i? r:{...r,...(fault==='header-position'?{row_position:'2'}:{id_bytes:999})});}
            if(sql.startsWith('/* runtime evidence body */')) {
                if(fault==='extra' && !rows.length) return [{chunk_start:1,value:Buffer.from('x')}];
                if(!injected&&rows.length) {injected=true;
                    if(fault==='fetch-error'||fault==='primary-close') throw Error('primary fetch error');
                    if(fault==='position') return [{...rows[0],chunk_start:2}];
                    if(fault==='truncated') return [];
                    if(fault==='bad-utf8') return [{...rows[0],value:Buffer.alloc((rows[0]!.value as Buffer).length,255)}];
                }
            } return rows;
        }});
        if (fault === 'primary-close') await assert.rejects(loadPurpose(f, 'record-export'), /primary fetch error/);
        else await assert.rejects(loadPurpose(f, 'record-export'));
        assertCleanup(f,false);
    });
test('N3 original database order, full scope, inner definition lookup and once-converted body SQL',()=>{
    const cursor='realm_evidence_abcdef';
    for(const family of ['action_receipts','character_effects','observations'] as const) {
        const sql=evidenceHeaderSql(family,cursor);assert.ok(sql.endsWith(`ORDER BY ${evidenceFields[family].keys.map(k=>`${k} ASC`).join(', ')}`));assert.doesNotMatch(sql,/COLLATE|OFFSET|source_count/);
        const body=evidenceBodySql(family,evidenceFields[family].json[0],cursor);
        assert.match(body,/e.workspace_id=\$1 AND e.world_id=\$2 AND e.worldline_id=\$3 AND e.record_id=\$4 AND e.ctid=\$5::tid/);
        assert.equal((body.match(/convert_to\(/g)??[]).length,1);
    }
    const sql=evidenceHeaderSql('character_effects',cursor);assert.match(sql,/JOIN LATERAL/);assert.doesNotMatch(sql,/LEFT JOIN/);assert.match(sql,/definition.id=e.effect_definition_id LIMIT 1/);
    assert.match(sql,/\) AS bound_definition WHERE bound_definition.world_id=e.world_id/);
});
test('N3 all sibling contributions consume the same domain capacity',async()=>{
    const ledger=new RuntimeSectionWireLedger('runtime/domain.json','normalized-domain',undefined,1000);
    const source={id:'a',content:'x'.repeat(600)};
    const makeClient=()=>{let n=0;return {async query(sql:string){
        if(sql.includes('DECLARE ')) return {rows:[]};
        if(sql.includes('FETCH FORWARD 1000')) return {rows:n++?[]:[evidenceHeader('observations',{...fixtureRows(scope.recordId)[`${scope.recordId}:observations`]![0],content:source.content},0)]};
        if(sql.includes('FETCH FORWARD 1')) return {rows:n++===1?[{chunk_start:1,value:Buffer.from(source.content)}]:[]};
        return {rows:[]};
    }}};
    const project=(r:Record<string,unknown>)=>({id:r.id,content:r.content});
    await readEvidenceRows(makeClient() as never,'observations',['w','v','l','r'],ledger,project);
    assert.equal(ledger.acceptedBytes,countRuntimeSectionWireBytes(project({...fixtureRows(scope.recordId)[`${scope.recordId}:observations`]![0],content:source.content}),'normalized-domain'));
    await assert.rejects(readEvidenceRows(makeClient() as never,'observations',['w','v','l','s'],ledger,project));
});
for (const units of [4096,4097]) test(`N3 UTF16 fingerprint boundary ${units} before JSON transfer`,async()=>{
    const source=fixtureRows(scope.recordId,1,true);
    source[`${scope.recordId}:action_receipts`]![0]!.call_fingerprint='😀'.repeat(2048)+(units===4097?'x':'');
    const f=fixture(1,false,false,{resourceRows:source});
    if(units===4097) {await assert.rejects(loadPurpose(f,'record-export'));assert.equal(f.calls.filter(c=>c.sql.includes('receipt body */')).length,0);assertCleanup(f,false);}
    else {const a=(await loadPurpose(f,'record-export'))!;assert.equal(a.actionReceipts!.receipts[0]!.callFingerprint.length,4096);assertCleanup(f,true);}
});
test('N3 long PostgreSQL decimal spelling charges normalized JSON bytes',async()=>{
    const raw='{"tiny":0.'+'0'.repeat(16000)+'1,"astral":"😀"}';
    const f=fixture(1,false,false,{rawJson:{receipt:raw}});
    const a=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive((await loadPurpose(f,'record-export'))!));
    assert.deepEqual(a.actionReceipts!.receipts[0]!.receipt,{tiny:0,astral:'😀'});assertCleanup(f,true);
});
test('N3 successful header consumption followed by CLOSE failure rolls back',async()=>{
    const f=fixture(1,false,false,{closeError:true});await assert.rejects(loadPurpose(f,'record-export'),/injected close error/);assertCleanup(f,false);
});

test('N3 default shared domain 64MiB crosses family and file boundaries without fresh budgets', async () => {
    const limit = 64 * 1024 * 1024;
    assert.equal(new RuntimeSectionWireLedger('runtime/domain.json', 'normalized-domain').limitBytes, limit);
    const sourceWithTexts = (receiptText: string, effectText: string) => {
        const source = { ...fixtureRows(scope.recordId), ...fixtureRows('sibling') };
        source['sibling:action_receipts']![0]!.receipt = { text: receiptText };
        source['sibling:character_effects']![0]!.metadata = { text: effectText };
        return source;
    };
    const nested = (archive: RealmRuntimeSaveArchive) => {
        const record = archive.domain?.records?.find(row => row.recordId === 'sibling');
        assert.ok(record, 'select the scoped sibling by identity, not array position');
        return record.bundle;
    };
    const baselineReader = fixture(1, false, true, { resourceRows: sourceWithTexts('', '') });
    const minimum = (await loadPurpose(baselineReader, 'whole-closure-backup'))!;
    assertCleanup(baselineReader, true);
    assert.equal(nested(minimum).actionReceipts!.receipts[0]!.receipt.text, '');
    assert.equal(nested(minimum).characterEffects!.effects[0]!.metadata.text, '');
    const overhead = Buffer.byteLength(serializeRealmRuntimeSaveDomainV1(minimum.domain!));
    const paddingBytes = limit - overhead;
    assert.ok(paddingBytes > 0);
    const receiptBytes = Math.floor(paddingBytes / 2);
    const effectBytes = paddingBytes - receiptBytes;
    const block = Array.from({ length: 1024 }, (_, i) => createHash('sha256').update(`N3-domain-capacity-${i}`).digest('hex')).join('');
    const padding = (bytes: number) => block.repeat(Math.ceil(bytes / block.length)).slice(0, bytes);
    const receiptText = padding(receiptBytes), effectText = padding(effectBytes);
    const exactReader = fixture(1, false, true, { resourceRows: sourceWithTexts(receiptText, effectText) });
    const exact = (await loadPurpose(exactReader, 'whole-closure-backup'))!;
    assertCleanup(exactReader, true);
    assert.equal(Buffer.byteLength(serializeRealmRuntimeSaveDomainV1(exact.domain!)), limit);
    // Both nested families are individually well below a file limit. Their
    // shared enclosing domain, including real framing, is exactly one limit.
    const child = nested(exact);
    assert.ok(Buffer.byteLength(serializeRealmRuntimeSaveActionReceiptsV1(child.actionReceipts!)) < limit);
    assert.ok(Buffer.byteLength(serializeRealmRuntimeSaveCharacterEffectsV1(child.characterEffects!)) < limit);
    const roundTrip = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(exact));
    const restoredChild = nested(roundTrip);
    assert.equal(restoredChild.actionReceipts!.receipts[0]!.receipt.text, receiptText);
    assert.equal(restoredChild.characterEffects!.effects[0]!.metadata.text, effectText);
    assert.equal(roundTrip.actionReceipts!.receipts[0]!.receipt.text, ' valid content ');
    assert.equal(Buffer.byteLength(serializeRealmRuntimeSaveDomainV1(roundTrip.domain!)), limit);
    const bodyCalls = exactReader.calls.filter(call => call.sql.startsWith('/* runtime evidence body */'));
    assert.ok(bodyCalls.length > 1000);
    assert.ok(bodyCalls.every(call => (call.returned ?? 0) <= 1 && (call.maxBuffer ?? 0) <= 65536));

    // The reader's complete-domain validation and the standalone archive
    // builder must both refuse +1 byte, although each child still fits alone.
    const fileOverReader = fixture(1, false, true, { resourceRows: sourceWithTexts(receiptText, effectText + 'f') });
    await assert.rejects(loadPurpose(fileOverReader, 'whole-closure-backup'), (error: unknown) =>
        error instanceof RealmRuntimeSaveRepositoryError && error.code === 'RUNTIME_SAVE_INVALID');
    assertCleanup(fileOverReader, false);
    const fileOverDomain = {
        ...exact.domain!,
        records: exact.domain!.records!.map(record => record.recordId !== 'sibling' ? record : {
            ...record,
            bundle: {
                ...record.bundle,
                characterEffects: {
                    ...record.bundle.characterEffects!,
                    effects: record.bundle.characterEffects!.effects.map(effect => ({
                        ...effect, metadata: { ...effect.metadata, text: effectText + 'f' },
                    })),
                },
            },
        }),
    };
    assert.equal(countRuntimeSectionWireBytes(fileOverDomain, 'normalized-domain'), limit + 1);
    const domainOverflow = (error: unknown) => error instanceof RealmRuntimeSaveDomainError
        && error.code === 'INVALID_DOMAIN_SAVE' && error.message.includes('domain.byteBudget');
    assert.throws(() => serializeRealmRuntimeSaveDomainV1(fileOverDomain), domainOverflow);
    assert.throws(() => buildRealmRuntimeSaveArchive({ ...exact, domain: fileOverDomain }), domainOverflow);

    // Exceed the earlier shared evidence allowance as well. Each family still
    // fits alone; combining them must fail while cursors/transaction are owned.
    const evidenceOverReader = fixture(1, false, true, {
        resourceRows: sourceWithTexts(receiptText, effectText + 'f'.repeat(overhead + 1)),
    });
    await assert.rejects(loadPurpose(evidenceOverReader, 'whole-closure-backup'), (error: unknown) =>
        error instanceof RealmRuntimeSaveRepositoryError && error.code === 'RUNTIME_SAVE_INVALID');
    assertCleanup(evidenceOverReader, false);
});

// Original default-capacity controls: no injected/reduced limit, no production edits.
// These are strict SQL protocol tests, not live PostgreSQL or aggregate-budget proof.
type N3EvidenceBundle = Pick<RealmRuntimeSaveArchive, 'actionReceipts' | 'characterEffects' | 'observations'>;
const n3DefaultCapacityCases = [
    {
        family: 'action_receipts', field: 'receipt',
        serialize: (bundle: N3EvidenceBundle) => serializeRealmRuntimeSaveActionReceiptsV1(bundle.actionReceipts!),
        text: (bundle: N3EvidenceBundle) => bundle.actionReceipts!.receipts[0]!.receipt.text,
    },
    {
        family: 'character_effects', field: 'metadata',
        serialize: (bundle: N3EvidenceBundle) => serializeRealmRuntimeSaveCharacterEffectsV1(bundle.characterEffects!),
        text: (bundle: N3EvidenceBundle) => bundle.characterEffects!.effects[0]!.metadata.text,
    },
    {
        family: 'observations', field: 'content',
        serialize: (bundle: N3EvidenceBundle) => serializeRealmRuntimeSaveObservationsV1(bundle.observations!),
        text: (bundle: N3EvidenceBundle) => bundle.observations!.observations[0]!.content,
    },
] as const;
for (const entry of n3DefaultCapacityCases) {
    test(`N3 default 64MiB and +1 root ${entry.family}`, async () => {
        const limit = 64 * 1024 * 1024;
        const sectionPaths = { action_receipts: 'runtime/action-receipts.json', character_effects: 'runtime/character-effects.json', observations: 'runtime/observations.json' };
        assert.equal(new RuntimeSectionWireLedger(sectionPaths[entry.family], 'canonical-runtime').limitBytes, limit);
        const sourceWithText = (text: string) => {
            const source = fixtureRows(scope.recordId);
            source[`${scope.recordId}:${entry.family}`]![0]![entry.field] = entry.field === 'content' ? text : { text };
            return source;
        };
        // Derive exact wire overhead from the real production serializer, not a
        // hand-copied envelope or JSON.stringify with the wrong formatter.
        const minimumText = entry.field === 'content' ? 'f' : '';
        const smallReader = fixture(1, false, false, { resourceRows: sourceWithText(minimumText) });
        const small = (await loadPurpose(smallReader, 'record-export'))!;
        const overhead = Buffer.byteLength(entry.serialize(small)) - Buffer.byteLength(minimumText);
        assertCleanup(smallReader, true);
        const textBytes = limit - overhead;
        assert.ok(textBytes > 0);
        // A 64KiB deterministic hash block avoids highly-compressible padding
        // without storing a large fixture file or relaxing ZIP ratio guards.
        const block = Array.from({ length: 1024 }, (_, i) => createHash('sha256').update(`N3-capacity-${i}`).digest('hex')).join('');
        const text = block.repeat(Math.ceil(textBytes / block.length)).slice(0, textBytes);
        const exactReader = fixture(1, false, false, { resourceRows: sourceWithText(text) });
        const exact = (await loadPurpose(exactReader, 'record-export'))!;
        assert.equal(Buffer.byteLength(entry.serialize(exact)), limit);
        assert.equal(entry.text(exact), text);
        const roundTrip = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(exact));
        assert.equal(entry.text(roundTrip), text);
        assertCleanup(exactReader, true);
        const bodyCalls = exactReader.calls.filter(c => c.sql.startsWith('/* runtime evidence body */'));
        assert.ok(bodyCalls.length > 1000);
        assert.ok(bodyCalls.every(c => (c.returned ?? 0) <= 1 && (c.maxBuffer ?? 0) <= 65536));

        const oversizedReader = fixture(1, false, false, { resourceRows: sourceWithText(text + 'f') });
        await assert.rejects(loadPurpose(oversizedReader, 'record-export'), (error: unknown) =>
            error instanceof RealmRuntimeSaveRepositoryError && error.code === 'RUNTIME_SAVE_INVALID');
        assertCleanup(oversizedReader, false);
    });
}
