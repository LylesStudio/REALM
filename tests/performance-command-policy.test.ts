/** Approved server assembly only; does not constitute target schema/transport runtime acceptance. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as application from '../modules/application/performance-command-executor.ts';
import type { PerformanceCommandTrust } from '../modules/application/performance-command-executor.ts';

type Factory = (scope: PerformanceCommandTrust['scope'], principalId: string) => PerformanceCommandTrust;
function factory(): Factory {
  assert.equal(typeof (application as Record<string, unknown>).createPerformanceCommandTrust, 'function', 'server policy assembly must replace the unresolved null policy');
  return (application as unknown as { createPerformanceCommandTrust: Factory }).createPerformanceCommandTrust;
}
const scope = { workspaceId: 'ws', worldId: 'world', worldlineId: 'line' };

test('approved server policy enables completed durable transport without claiming target schema readiness', () => {
  const trust = factory()(scope, 'principal');
  assert.deepEqual(trust.evidencePolicy, { mode: 'engine-authoritative-v1', policyId: 'performance:engine-authoritative:v1' });
  assert.deepEqual(trust.scope, scope);
  assert.equal(trust.principalId, 'principal');
  assert.equal(trust.enablement?.schema, true); // Actual target readiness still requires the exact SQL probe.
  assert.equal(trust.enablement?.durableTransport, true);
});

test('server assembly detaches caller scope and protects shared policy/enablement from mutation', () => {
  const original = { ...scope };
  const a = factory()(original, 'principal');
  original.worldlineId = 'mutated';
  assert.equal(a.scope.worldlineId, 'line');
  assert.equal(Object.isFrozen(a.evidencePolicy), true);
  assert.equal(Object.isFrozen(a.enablement), true);
  assert.throws(() => Object.assign(a.evidencePolicy!, { mode: 'viewer-limited-v1' }), TypeError);
  assert.throws(() => Object.assign(a.enablement!, { durableTransport: false }), TypeError);
  assert.equal(factory()(scope, 'other').evidencePolicy?.mode, 'engine-authoritative-v1');
});

test('real fact route obtains trusted policy only from server assembly before generic domain authorization', () => {
  const route = readFileSync(new URL('../app/api/bridge/v1/facts/commands/route.ts', import.meta.url), 'utf8');
  assert.match(route, /createPerformanceCommandTrust\(context\.scope, context\.principalId\)/);
  assert.doesNotMatch(route, /evidencePolicy:\s*null|body\.evidencePolicy|body\.enablement/);
  assert.ok(route.indexOf('createPerformanceCommandTrust(context.scope') < route.indexOf('await authorizeProjectFinanceWrite'));
});

test('default runtime save, backup, restore and native branch consume only the shared trusted capability', () => {
  assert.deepEqual(application.performanceTransportConsumerOptions(), { performanceWitnessesSchemaVersion: 1 });
  for (const name of ['save', 'backup', 'restore']) {
    const route = readFileSync(new URL(`../app/api/record/${name}/route.ts`, import.meta.url), 'utf8');
    assert.match(route, /createPostgresRealmRuntimeSave(?:Reader|Restorer)\(/);
    assert.doesNotMatch(route, /input\.performanceWitnessesSchemaVersion|body\.performanceWitnessesSchemaVersion/);
  }
  const repository = readFileSync(new URL('../database/postgres/realm-runtime-save-repository.ts', import.meta.url), 'utf8');
  assert.equal((repository.match(/options = \{ \.\.\.performanceTransportConsumerOptions\(\), \.\.\.options \};/g) ?? []).length, 2);
  const library = readFileSync(new URL('../modules/application/library-service.ts', import.meta.url), 'utf8');
  assert.match(library, /createPostgresRealmRuntimeSaveReader\(client,/);
  assert.match(library, /createPostgresRealmRuntimeSaveRestorer\(client,/);
  assert.doesNotMatch(library, /input\.performanceWitnessesSchemaVersion/);
});
