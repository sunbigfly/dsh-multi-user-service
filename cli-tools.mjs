import Schema from '@deepseek-ai/schemastery';
import { MemberCliRegistry } from './carrier/cli-tools.mjs';
import { ExecutionCatalog } from './carrier/execution-catalog.mjs';

export const name = 'member-cli-tools';
export const Config = Schema.object({
  tools: Schema.array(Schema.object({
    id: Schema.string().required().description('Command name exposed to members, for example smart-search.'),
    label: Schema.string().description('Name shown in administrator CLI permissions.'),
    enabled: Schema.boolean().default(true),
    command: Schema.string().required().description('Absolute executable path on this server.'),
    args: Schema.array(Schema.string()).default([]).description('Fixed arguments before member-supplied arguments.'),
    readOnlyPaths: Schema.array(Schema.string()).default([]).description('Program and dependency paths required by this command. Member data remains isolated.'),
    environment: Schema.dict(Schema.string()).default({}),
    credentials: Schema.dict(Schema.string()).default({}).description('Environment variable to Harness credential reference. Authorized members can read the supplied credentials.'),
  })).default([]),
  executionTools: Schema.object({
    version: Schema.number().default(1),
    sources: Schema.array(Schema.object({ id: Schema.string().required(), kind: Schema.const('tool-runner'), root: Schema.string().required(), command: Schema.string().required() })).default([]),
    grants: Schema.array(Schema.object({ id: Schema.string().required(), fingerprint: Schema.string().required(), operations: Schema.array(Schema.string()).default([]), harness: Schema.boolean().default(false), shared: Schema.boolean().default(false) })).default([]),
  }).default({}),
}).default({});

export function apply(ctx, config) {
  const registry = new MemberCliRegistry({ tools: config.tools, credentials: () => ctx.get('credentials') });
  registry.execution = new ExecutionCatalog(config.executionTools);
  ctx.provide('lanCliTools', registry);
}
