import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { finalize, prepare, queryErrors, validateAgent } from './demo.mjs';

const task = { operationName: 'getOrder', method: 'query' };
const validQuery = 'query getOrder($id: ID!) { getOrder(id: $id) { id total status } }';
let baseDirectory;

beforeEach(async () => {
  baseDirectory = await mkdtemp(join(tmpdir(), 'query-demo-test-'));
  await prepare(baseDirectory, 'test-1');
  await mkdir(join(baseDirectory, 'output'));
});

afterEach(async () => {
  await rm(baseDirectory, { recursive: true, force: true });
});

async function writeCandidate(text = validQuery) {
  await writeFile(join(baseDirectory, 'output', 'getOrder.graphql'), text);
}

test('prepare selects sample, existing query, and only the missing operation for agent work', async () => {
  const state = JSON.parse(await readFile(join(baseDirectory, 'input', 'tasks.json'), 'utf8'));
  assert.deepEqual(state.operations.map((operation) => operation.source), ['sample', 'existing', 'agent']);
  assert.deepEqual(state.tasks.map((operation) => operation.operationName), ['getOrder']);
});

test('validates aliases and local fragments using actual schema fields', () => {
  assert.deepEqual(queryErrors('query getOrder($id: ID!) { result: getOrder(id: $id) { ...OrderFields } } fragment OrderFields on Order { id total }', task), []);
});

test('rejects unknown response fields, missing arguments, and incompatible variable types', () => {
  for (const text of [
    'query getOrder($id: ID!) { getOrder(id: $id) { missing } }',
    'query getOrder { getOrder { id } }',
    'query getOrder($id: Int!) { getOrder(id: $id) { id } }',
  ]) assert(queryErrors(text, task).length > 0);
});

test('rejects a schema-valid query for the wrong root operation', () => {
  assert(queryErrors('query getOrder($id: ID!) { getProduct(id: $id) { id } }', task)
    .includes('Expected only root field getOrder'));
});

test('rejects multiple operations, missing fragments, and typename-only selections', () => {
  for (const text of [
    `${validQuery} query another { getOrder(id: "1") { id } }`,
    'query getOrder($id: ID!) { getOrder(id: $id) { ...Missing } }',
    'query getOrder($id: ID!) { getOrder(id: $id) { __typename } }',
  ]) assert(queryErrors(text, task).length > 0);
});

test('normal handoff publishes three independently validated queries and a source summary', async () => {
  await writeCandidate();
  const summary = await finalize(baseDirectory, 'test-1');
  assert.equal(summary.passed, true);
  assert.equal(summary.agentValidationAttempts, 0);
  assert.equal(summary.validationOwner, 'finalize');
  const report = JSON.parse(await readFile(join(baseDirectory, 'publish', 'query-demo-result', 'validation.json'), 'utf8'));
  assert.equal(report.owner, 'finalize');
  assert.equal(report.passed, true);
  assert.equal(report.results.length, 3);
  for (const operation of ['getProduct', 'getStore', 'getOrder']) {
    assert((await readFile(join(baseDirectory, 'publish', 'query-demo-result', 'families', 'demo', 'graphql', operation, 'query.graphql'), 'utf8')).includes(operation));
  }
  assert((await readFile(join(baseDirectory, 'pr-body.md'), 'utf8')).includes('Independent final GraphQL validation: PASS'));
});

test('records validation failure and successful repair', async () => {
  await writeCandidate('query getOrder { getOrder { id } }');
  assert.equal((await validateAgent(baseDirectory, 'test-1')).passed, false);
  await writeCandidate();
  const report = await validateAgent(baseDirectory, 'test-1');
  assert.equal(report.passed, true);
  assert.equal(report.attempts.length, 2);
});

test('enforces at most three agent-side validation attempts', async () => {
  await writeCandidate();
  for (let attempt = 0; attempt < 3; attempt += 1) await validateAgent(baseDirectory, 'test-1');
  await assert.rejects(validateAgent(baseDirectory, 'test-1'), /attempt limit/);
});

test('finalizer revalidates query content instead of trusting an earlier PASS report', async () => {
  await writeCandidate();
  await validateAgent(baseDirectory, 'test-1');
  await writeCandidate('query getOrder($id: ID!) { getOrder(id: $id) { nonexistent } }');
  const summary = await finalize(baseDirectory, 'test-1');
  assert.equal(summary.passed, false);
  assert(summary.errors.some((error) => error.includes('nonexistent')));
});

test('rejects unexpected output files and symbolic links', async () => {
  await writeCandidate();
  const unexpected = join(baseDirectory, 'output', 'script.mjs');
  await writeFile(unexpected, 'throw new Error("must not run")');
  await assert.rejects(validateAgent(baseDirectory, 'test-1'), /Unexpected output/);
  await rm(unexpected);
  await rm(join(baseDirectory, 'output', 'getOrder.graphql'));
  await symlink(join(baseDirectory, 'input', 'schema.graphql'), join(baseDirectory, 'output', 'getOrder.graphql'));
  await assert.rejects(validateAgent(baseDirectory, 'test-1'), /Unexpected output/);
});

test('rejects changed schema and stale task manifests', async () => {
  await writeCandidate();
  await assert.rejects(validateAgent(baseDirectory, 'another-run'), /manifest changed/);
  await writeFile(join(baseDirectory, 'input', 'schema.graphql'), 'type Query { injected: String }');
  await assert.rejects(validateAgent(baseDirectory, 'test-1'), /schema changed/);
});

test('rejects modified sample queries without requiring an agent report', async () => {
  await writeCandidate();
  await writeFile(join(baseDirectory, 'input', 'candidates', 'getProduct.graphql'), validQuery);
  await assert.rejects(finalize(baseDirectory, 'test-1'), /Prepared query changed/);
});

test('ignores a stale agent report and generates its own validation result', async () => {
  await writeCandidate();
  await validateAgent(baseDirectory, 'test-1');
  const reportPath = join(baseDirectory, 'output', 'validation.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  report.runKey = 'another-run';
  await writeFile(reportPath, JSON.stringify(report));
  const summary = await finalize(baseDirectory, 'test-1');
  assert.equal(summary.passed, true);
  assert.equal(summary.agentValidationAttempts, 0);
});

test('CLI validates handoff and writes the Actions draft output', async () => {
  await writeCandidate();
  const outputPath = join(baseDirectory, 'actions-output.txt');
  const environment = { ...process.env, GITHUB_RUN_ID: 'test', GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: outputPath };
  const scriptPath = fileURLToPath(new URL('./demo.mjs', import.meta.url));
  const finalization = spawnSync(process.execPath, [scriptPath, 'finalize', baseDirectory], { env: environment, encoding: 'utf8' });
  assert.equal(finalization.status, 0, finalization.stderr);
  assert.equal(await readFile(outputPath, 'utf8'), 'draft=false\n');
});

test('CLI reports invalid query as draft without an agent validation report', async () => {
  await writeCandidate('query getOrder($id: ID!) { getOrder(id: $id) { nonexistent } }');
  const outputPath = join(baseDirectory, 'actions-output.txt');
  const scriptPath = fileURLToPath(new URL('./demo.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [scriptPath, 'finalize', baseDirectory], {
    env: { ...process.env, GITHUB_RUN_ID: 'test', GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: outputPath },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(outputPath, 'utf8'), 'draft=true\n');
  const report = JSON.parse(await readFile(join(baseDirectory, 'publish', 'query-demo-result', 'validation.json'), 'utf8'));
  assert.equal(report.passed, false);
  assert(report.results.some((result) => result.errors.some((error) => error.includes('nonexistent'))));
  assert((await readFile(join(baseDirectory, 'pr-body.md'), 'utf8')).includes('Automatic repair was not attempted'));
});