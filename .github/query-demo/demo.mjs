import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertValidSchema, buildSchema, Kind, parse, validate } from 'graphql';

const supportDirectory = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(await readFile(join(supportDirectory, 'fixture.json'), 'utf8'));
const schema = buildSchema(fixture.schema);
assertValidSchema(schema);

async function readData(filePath) {
  const metadata = await lstat(filePath);
  assert(metadata.isFile() && metadata.nlink === 1, `Not a regular unlinked file: ${filePath}`);
  assert(metadata.size <= 131072, `File is too large: ${filePath}`);
  return readFile(filePath, 'utf8');
}

async function writeData(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, { flag: 'wx' });
}

async function checkFiles(directory, allowedFiles, allowedDirectories = []) {
  const metadata = await lstat(directory);
  assert(metadata.isDirectory() && !metadata.isSymbolicLink(), `Not a regular directory: ${directory}`);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && allowedDirectories.includes(entry.name)) continue;
    assert(entry.isFile() && allowedFiles.includes(entry.name), `Unexpected output: ${entry.name}`);
    await readData(join(directory, entry.name));
  }
}

function manifest(runKey) {
  assert(/^[a-zA-Z0-9-]+$/.test(runKey), 'Invalid run key');
  const operations = fixture.operations.map((operation) => {
    const source = fixture.samples[operation.operationName] ? 'sample'
      : fixture.existing[operation.operationName] ? 'existing' : 'agent';
    const reason = source === 'sample' ? 'Synthetic documentation sample'
      : source === 'existing' ? 'No sample; reuse the existing query'
        : 'No sample or existing query; agent generation required';
    return { ...operation, source, reason };
  });
  return { runKey, operations, tasks: operations.filter((operation) => operation.source === 'agent') };
}

export function queryErrors(text, task) {
  try {
    const document = parse(text);
    const errors = validate(schema, document).map((error) => error.message);
    const operations = document.definitions.filter((definition) => definition.kind === Kind.OPERATION_DEFINITION);
    if (operations.length !== 1) return [...errors, 'Exactly one executable operation is required'];
    const operation = operations[0];
    if (operation.operation !== task.method || operation.name?.value !== task.operationName) {
      errors.push(`Expected named ${task.method} ${task.operationName}`);
    }
    const fragments = new Map(document.definitions
      .filter((definition) => definition.kind === Kind.FRAGMENT_DEFINITION)
      .map((definition) => [definition.name.value, definition]));
    const roots = [];
    const visited = new Set();
    function collectRoots(selectionSet) {
      for (const selection of selectionSet.selections) {
        if (selection.directives?.length) errors.push('Conditional root selections are not allowed in this demo');
        if (selection.kind === Kind.FIELD) roots.push(selection.name.value);
        else if (selection.kind === Kind.INLINE_FRAGMENT) collectRoots(selection.selectionSet);
        else if (!visited.has(selection.name.value)) {
          visited.add(selection.name.value);
          const fragment = fragments.get(selection.name.value);
          if (fragment) collectRoots(fragment.selectionSet);
        }
      }
    }
    collectRoots(operation.selectionSet);
    if (roots.length !== 1 || roots[0] !== task.operationName) errors.push(`Expected only root field ${task.operationName}`);
    const fields = [];
    const visitedResponses = new Set();
    function collectResponseFields(selectionSet) {
      for (const selection of selectionSet.selections) {
        if (selection.kind === Kind.FIELD) {
          fields.push(selection.name.value);
          if (selection.selectionSet) collectResponseFields(selection.selectionSet);
        } else if (selection.kind === Kind.INLINE_FRAGMENT) collectResponseFields(selection.selectionSet);
        else if (!visitedResponses.has(selection.name.value)) {
          visitedResponses.add(selection.name.value);
          const fragment = fragments.get(selection.name.value);
          if (fragment) collectResponseFields(fragment.selectionSet);
        }
      }
    }
    collectResponseFields(operation.selectionSet);
    if (!fields.some((field) => field !== task.operationName && field !== '__typename')) {
      errors.push('Select at least one concrete response field');
    }
    return errors;
  } catch (error) {
    return [error.message];
  }
}

export async function prepare(baseDirectory, runKey) {
  const state = manifest(runKey);
  const inputDirectory = join(baseDirectory, 'input');
  await writeData(join(inputDirectory, 'schema.graphql'), fixture.schema);
  await writeData(join(inputDirectory, 'tasks.json'), JSON.stringify(state, null, 2));
  for (const operation of state.operations.filter((entry) => entry.source !== 'agent')) {
    const text = (operation.source === 'sample' ? fixture.samples : fixture.existing)[operation.operationName];
    assert.deepEqual(queryErrors(text, operation), []);
    await writeData(join(inputDirectory, 'candidates', `${operation.operationName}.graphql`), text);
  }
  return state;
}

async function readState(baseDirectory, runKey) {
  const inputDirectory = join(baseDirectory, 'input');
  const expected = manifest(runKey);
  const state = JSON.parse(await readData(join(inputDirectory, 'tasks.json')));
  assert.deepEqual(state, expected, 'Prepared task manifest changed');
  assert.equal(await readData(join(inputDirectory, 'schema.graphql')), fixture.schema, 'Prepared schema changed');
  await checkFiles(inputDirectory, ['schema.graphql', 'tasks.json'], ['candidates']);
  return state;
}

async function inspectAgentOutput(baseDirectory, state) {
  const outputDirectory = join(baseDirectory, 'output');
  await checkFiles(outputDirectory, [...state.tasks.map((task) => `${task.operationName}.graphql`), 'validation.json']);
  return Promise.all(state.tasks.map(async (task) => {
    let errors;
    try {
      errors = queryErrors(await readData(join(outputDirectory, `${task.operationName}.graphql`)), task);
    } catch (error) {
      errors = [error.message];
    }
    return { operationName: task.operationName, errors };
  }));
}

export async function validateAgent(baseDirectory, runKey) {
  const state = await readState(baseDirectory, runKey);
  const reportPath = join(baseDirectory, 'output', 'validation.json');
  let attempts = [];
  try {
    const previous = JSON.parse(await readData(reportPath));
    assert.equal(previous.runKey, runKey);
    assert(Array.isArray(previous.attempts) && previous.attempts.length < 3, 'Validation attempt limit reached');
    attempts = previous.attempts;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const results = await inspectAgentOutput(baseDirectory, state);
  const passed = results.every((result) => result.errors.length === 0);
  const report = { runKey, attempts: [...attempts, { results }], passed };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  return report;
}

export async function finalize(baseDirectory, runKey) {
  const state = await readState(baseDirectory, runKey);
  const candidatesDirectory = join(baseDirectory, 'input', 'candidates');
  await checkFiles(candidatesDirectory, state.operations.filter((operation) => operation.source !== 'agent')
    .map((operation) => `${operation.operationName}.graphql`));
  const results = await inspectAgentOutput(baseDirectory, state);
  const files = [];
  for (const operation of state.operations) {
    const filename = `${operation.operationName}.graphql`;
    const text = await readData(join(operation.source === 'agent' ? join(baseDirectory, 'output') : candidatesDirectory, filename));
    if (operation.source !== 'agent') {
      assert.equal(text, (operation.source === 'sample' ? fixture.samples : fixture.existing)[operation.operationName],
        `Prepared query changed: ${filename}`);
      results.push({ operationName: operation.operationName, errors: queryErrors(text, operation) });
    }
    files.push({ path: `query-demo-result/families/${operation.family}/graphql/${operation.operationName}/query.graphql`, text });
  }
  const errors = results.flatMap((result) => result.errors.map((error) => `${result.operationName}: ${error}`));
  const summary = {
    runKey,
    passed: errors.length === 0,
    agentValidationAttempts: 0,
    validationOwner: 'finalize',
    validationAttempts: 1,
    operations: state.operations,
    errors,
  };
  for (const file of files) await writeData(join(baseDirectory, 'publish', file.path), file.text);
  await writeData(join(baseDirectory, 'publish', 'query-demo-result', 'schema.graphql'), fixture.schema);
  await writeData(join(baseDirectory, 'publish', 'query-demo-result', 'summary.json'), JSON.stringify(summary, null, 2));
  await writeData(join(baseDirectory, 'publish', 'query-demo-result', 'validation.json'),
    JSON.stringify({ runKey, owner: 'finalize', passed: summary.passed, results }, null, 2));
  const body = [
    '## Synthetic Query Sync Demo', '',
    `Run: ${runKey}. No business source files or real API data are involved.`, '',
    '## Summary', '',
    'Affected family: demo. Added queries: getProduct, getStore, getOrder.', '',
    '## Sources', '',
    '| Operation | Source | Reference / fallback reason |',
    '| --- | --- | --- |',
    ...state.operations.map((operation) => `| ${operation.operationName} | ${operation.source} | ${operation.reason} |`), '',
    '## Validation', '',
    `Independent final GraphQL validation: ${summary.passed ? 'PASS' : 'FAIL'}.`,
    `Agent-side recorded validation attempts: ${summary.agentValidationAttempts}.`,
    `Validation owner: Finalize. Validation attempts: ${summary.validationAttempts}. Automatic repair was not attempted.`,
    'Sample and existing query contents were checked for exact preservation.', '',
    ...errors.map((error) => `- ${error.replaceAll('`', "'").replaceAll('\n', ' ')}`), '',
    '## Follow-up', '',
    summary.passed ? 'None. Synthetic family assignments are resolved.' : 'Repair the errors before this draft can be merged.', '',
    '## Diff', '',
    'The Files changed tab contains the synthetic schema, three query files, the validation report, and the structured summary.', '',
  ].join('\n');
  await writeData(join(baseDirectory, 'pr-body.md'), body);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const commands = { prepare, 'validate-agent': validateAgent, finalize };
  const command = commands[process.argv[2]];
  assert(command, 'Expected prepare, validate-agent, or finalize');
  const runKey = `${process.env.GITHUB_RUN_ID ?? 'local'}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`;
  const result = await command(resolve(process.argv[3] ?? 'query-demo'), runKey);
  console.log(JSON.stringify(result, null, 2));
  if (result.passed === false && process.argv[2] === 'validate-agent') process.exitCode = 1;
  if (process.argv[2] === 'finalize' && process.env.GITHUB_OUTPUT) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_OUTPUT, `draft=${!result.passed}\n`);
  }
}