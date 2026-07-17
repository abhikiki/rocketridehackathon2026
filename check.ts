import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RocketRideClient } from 'rocketride';

type CatalogEntry = {
  name: string;
  classType: string[];
  lanes: Record<string, string[]>;
  invoke?: Record<string, { min?: number; max?: number }>;
};

type Component = {
  id: string;
  provider: string;
  config: Record<string, unknown>;
  input?: Array<{ lane: string; from: string }>;
  control?: Array<{ classType: string; from: string }>;
};

type Pipeline = {
  components: Component[];
  source: string;
  project_id: string;
  viewport: { x: number; y: number; zoom: number };
  version: number;
};

const root = process.cwd();
const pipelinePaths = [
  'rocketride/incident-management.pipe',
  'rocketride/alert-solving.pipe',
];
const errors: string[] = [];

async function parseJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(resolve(root, path), 'utf8')) as T;
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${String(error)})`);
  }
}

function requiredConfigErrors(
  path: string,
  component: Component,
  schema: Record<string, any>,
): void {
  const configSchema = schema?.Pipe?.schema ?? {};
  for (const key of configSchema.required ?? []) {
    if (!(key in component.config)) {
      errors.push(`${path}: ${component.id} config is missing required field ${key}`);
    }
  }

  const profile = component.config.profile;
  const choices = configSchema?.dependencies?.profile?.oneOf ?? [];
  if (typeof profile !== 'string' || choices.length === 0) return;

  const choice = choices.find((item: any) =>
    item?.properties?.profile?.enum?.includes(profile),
  );
  if (!choice) {
    errors.push(`${path}: ${component.id} uses unknown profile ${profile}`);
    return;
  }

  const nested = choice?.properties?.[profile];
  const configured = component.config[profile];
  for (const key of nested?.required ?? []) {
    if (typeof configured !== 'object' || configured === null || !(key in configured)) {
      errors.push(`${path}: ${component.id}.${profile} is missing required field ${key}`);
    }
  }
}

async function validateLocal(
  path: string,
  catalogByName: Map<string, CatalogEntry>,
  documentedEnv: Set<string>,
  projectIds: Set<string>,
): Promise<Pipeline | undefined> {
  let pipeline: Pipeline;
  try {
    pipeline = await parseJson<Pipeline>(path);
  } catch (error) {
    errors.push(String(error));
    return undefined;
  }

  const firstKey = Object.keys(pipeline)[0];
  if (firstKey !== 'components') errors.push(`${path}: components must be the first field`);
  if (!Array.isArray(pipeline.components) || pipeline.components.length === 0) {
    errors.push(`${path}: components must be a non-empty array`);
    return pipeline;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pipeline.project_id)) {
    errors.push(`${path}: project_id is not a literal UUID`);
  } else if (projectIds.has(pipeline.project_id)) {
    errors.push(`${path}: project_id is reused by another pipeline`);
  } else {
    projectIds.add(pipeline.project_id);
  }
  if (pipeline.version !== 1) errors.push(`${path}: version must be 1`);

  const byId = new Map<string, Component>();
  for (const component of pipeline.components) {
    if (byId.has(component.id)) errors.push(`${path}: duplicate component id ${component.id}`);
    byId.set(component.id, component);
  }

  const source = byId.get(pipeline.source);
  if (!source) {
    errors.push(`${path}: source ${pipeline.source} does not exist`);
  } else if (!catalogByName.get(source.provider)?.classType.includes('source')) {
    errors.push(`${path}: ${source.id} is not a source provider`);
  }

  for (const component of pipeline.components) {
    const targetDefinition = catalogByName.get(component.provider);
    if (!targetDefinition) {
      errors.push(`${path}: unknown provider ${component.provider}`);
      continue;
    }

    const schemaPath = `.rocketride/schema/${component.provider}.json`;
    try {
      requiredConfigErrors(path, component, await parseJson(schemaPath));
    } catch (error) {
      errors.push(String(error));
    }

    const isSource = targetDefinition.classType.includes('source');
    const isControlled = (component.control?.length ?? 0) > 0;
    if (!isSource && !isControlled && (component.input?.length ?? 0) === 0) {
      errors.push(`${path}: ${component.id} is orphaned (no input or control connection)`);
    }

    for (const input of component.input ?? []) {
      const upstream = byId.get(input.from);
      if (!upstream) {
        errors.push(`${path}: ${component.id} input references missing ${input.from}`);
        continue;
      }
      const upstreamDefinition = catalogByName.get(upstream.provider);
      const outputLanes = new Set(Object.values(upstreamDefinition?.lanes ?? {}).flat());
      if (!outputLanes.has(input.lane)) {
        errors.push(`${path}: ${upstream.id} does not output ${input.lane}`);
      }
      if (!(input.lane in targetDefinition.lanes)) {
        errors.push(`${path}: ${component.id} does not accept ${input.lane}`);
      }
    }

    for (const control of component.control ?? []) {
      const invoker = byId.get(control.from);
      if (!invoker) {
        errors.push(`${path}: ${component.id} control references missing ${control.from}`);
        continue;
      }
      if (!targetDefinition.classType.includes(control.classType)) {
        errors.push(`${path}: ${component.id} is not classType ${control.classType}`);
      }
      if (!catalogByName.get(invoker.provider)?.invoke?.[control.classType]) {
        errors.push(`${path}: ${invoker.id} cannot invoke classType ${control.classType}`);
      }
    }
  }

  for (const invoker of pipeline.components) {
    const requirements = catalogByName.get(invoker.provider)?.invoke ?? {};
    for (const [classType, requirement] of Object.entries(requirements)) {
      const count = pipeline.components.reduce(
        (total, candidate) => total + (candidate.control ?? []).filter(
          (control) => control.from === invoker.id && control.classType === classType,
        ).length,
        0,
      );
      if (count < (requirement.min ?? 0)) {
        errors.push(`${path}: ${invoker.id} needs at least ${requirement.min} ${classType} control connection(s)`);
      }
      if (requirement.max !== undefined && count > requirement.max) {
        errors.push(`${path}: ${invoker.id} allows at most ${requirement.max} ${classType} control connection(s)`);
      }
    }
  }

  const serialized = JSON.stringify(pipeline);
  for (const match of serialized.matchAll(/\$\{(ROCKETRIDE_[A-Z0-9_]+)\}/g)) {
    if (!documentedEnv.has(match[1])) errors.push(`${path}: ${match[1]} is missing from env.example`);
  }
  for (const pattern of [/ghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /sk-ant-[A-Za-z0-9_-]{20,}/]) {
    if (pattern.test(serialized)) errors.push(`${path}: possible hardcoded credential detected`);
  }

  return pipeline;
}

async function main(): Promise<void> {
  const catalog = await parseJson<CatalogEntry[]>('.rocketride/services-catalog.json');
  const catalogByName = new Map(catalog.map((entry) => [entry.name, entry]));
  const envExample = await readFile(resolve(root, 'env.example'), 'utf8');
  const documentedEnv = new Set(
    envExample.split(/\r?\n/)
      .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
      .filter((name): name is string => Boolean(name)),
  );
  const projectIds = new Set<string>();
  const pipelines: Pipeline[] = [];

  for (const path of pipelinePaths) {
    const pipeline = await validateLocal(path, catalogByName, documentedEnv, projectIds);
    if (pipeline) pipelines.push(pipeline);
  }

  for (const fixture of [
    'rocketride/fixtures/incident-new.json',
    'rocketride/fixtures/incident-resolved.json',
    'rocketride/fixtures/github-issue-opened.json',
    'rocketride/fixtures/github-pr-merged.json',
  ]) {
    try {
      await parseJson(fixture);
    } catch (error) {
      errors.push(String(error));
    }
  }

  if (errors.length > 0) {
    console.error(`Track B check failed with ${errors.length} error(s):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Local checks passed for ${pipelines.length} pipelines and 4 fixtures.`);

  if (!process.argv.includes('--remote')) return;
  const localEnv = await readFile(resolve(root, '.env'), 'utf8');
  if (/=(replace-me|replace-with-|https:\/\/replace-me)/.test(localEnv)) {
    throw new Error('Remote validation requires real values in the ignored .env file.');
  }

  const client = new RocketRideClient();
  try {
    await client.connect();
    for (let index = 0; index < pipelines.length; index += 1) {
      const result = await client.validate({
        pipeline: pipelines[index] as any,
        source: pipelines[index].source,
      });
      if (result.errors.length > 0) {
        throw new Error(`${pipelinePaths[index]} remote errors: ${JSON.stringify(result.errors)}`);
      }
      console.log(`${pipelinePaths[index]} passed RocketRide server validation.`);
      for (const warning of result.warnings ?? []) console.warn(`Warning: ${JSON.stringify(warning)}`);
    }
  } finally {
    await client.disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
