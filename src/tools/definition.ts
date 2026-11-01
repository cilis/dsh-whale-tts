/**
 * Local tool-definition builder.
 *
 * The plugin deliberately does **not** import `@deepseek-ai/dsh-tools` at
 * runtime. Inside a profile, that bare specifier is resolved by Node from the
 * profile's `node_modules` chain, which on machines with an older global DSH
 * install can yield an incompatible copy (for example 0.1.0-rc.8 while the
 * runtime is 0.2.1-rc.5). The tool registry only needs a plain definition
 * object, so this module builds one:
 *
 *   { name, description, parameters: <raw JSON Schema>, output: { schema, render },
 *     timeoutMs?, execute, presentCall?, presentResult? }
 *
 * `parameters` is a raw JSON Schema object (supported subset:
 * type / oneOf / properties / required / additionalProperties / items /
 * enum / const + annotations). `output.schema` is validated by the registry on
 * registration; `output.render` is model-visible content only.
 *
 * Arguments are validated here because the runtime's own `defineTool` wrapper
 * is not available; the shapes are small and fixed.
 */

/** Raw JSON Schema node (the subset DSH's registry supports). */
export type JsonSchemaNode = Record<string, unknown>

/** One model-visible content block. */
export interface TextContentBlock {
  readonly type: 'text'
  readonly text: string
}

/** Subset of the tool execution context this plugin uses. */
export interface ToolExecutionLike {
  readonly signal: AbortSignal
  readonly agent?: unknown
}

/** Result shape handed to `presentResult`. */
export interface ToolResultLike {
  readonly content: readonly TextContentBlock[]
  readonly isError: boolean
  readonly meta?: unknown
}

/** Opaque UI render intent; the host maps it to a card. */
export type ToolCallView = Record<string, unknown>
/** Opaque completed-card render intent. */
export type ToolResultView = Record<string, unknown>

/** Options accepted by {@link defineLocalTool}. */
export interface LocalToolOptions<Args extends Record<string, unknown>> {
  readonly name: string
  readonly description: string
  /** Object-rooted raw JSON Schema of the model-visible parameters. */
  readonly parameters: JsonSchemaNode
  readonly outputSchema: JsonSchemaNode
  readonly render: (args: Args, value: never) => readonly TextContentBlock[]
  readonly timeoutMs?: number
  readonly presentCall?: (args: Args) => ToolCallView | undefined
  readonly presentResult?: (
    args: Args,
    result: ToolResultLike,
  ) => ToolResultView | undefined
  readonly execute: (args: Args, exec: ToolExecutionLike) => Promise<unknown>
}

/** A definition shaped for `ctx.tools.register(definition)`. */
export interface LocalToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchemaNode
  readonly output: {
    readonly schema: JsonSchemaNode
    readonly render: (args: never, value: never) => readonly TextContentBlock[]
    readonly presentationMeta?: (args: never, value: never) => unknown
  }
  readonly timeoutMs?: number
  readonly presentCall?: (args: never) => ToolCallView | undefined
  readonly presentResult?: (args: never, result: ToolResultLike) => ToolResultView | undefined
  readonly execute: (args: never, exec: ToolExecutionLike) => Promise<unknown>
}

const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function typeMatches(node: JsonSchemaNode, value: unknown): boolean {
  const type = node['type']
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return isRecord(value)
  return true
}

function checkNode(node: JsonSchemaNode, value: unknown, path: string, violations: string[]): void {
  if (!isRecord(node)) return
  const oneOf = node['oneOf']
  if (Array.isArray(oneOf)) {
    const matched = oneOf.some((branch) => {
      const local: string[] = []
      if (isRecord(branch)) checkNode(branch, value, path, local)
      return local.length === 0
    })
    if (!matched) violations.push(`${path} must match exactly one allowed shape`)
    return
  }
  if (typeof node['type'] === 'string' && JSON_TYPES.has(node['type']) && !typeMatches(node, value)) {
    violations.push(`${path} must be ${String(node['type'])}`)
    return
  }
  const allowed = node['enum']
  if (Array.isArray(allowed) && !allowed.some((entry) => entry === value)) {
    violations.push(`${path} must be one of ${allowed.map(String).join(', ')}`)
    return
  }
  if (node['const'] !== undefined && node['const'] !== value) {
    violations.push(`${path} must equal ${String(node['const'])}`)
    return
  }
  if (Array.isArray(value) && Array.isArray(node['items'])) return
  if (Array.isArray(value) && isRecord(node['items'])) {
    value.forEach((entry, index) => {
      checkNode(node['items'] as JsonSchemaNode, entry, `${path}[${index}]`, violations)
    })
    return
  }
  if (isRecord(value) && isRecord(node['properties'])) {
    const properties = node['properties'] as Record<string, JsonSchemaNode>
    const required = Array.isArray(node['required']) ? node['required'].filter((key): key is string => typeof key === 'string') : []
    for (const key of required) {
      if (value[key] === undefined) violations.push(`${path}.${key} is required`)
    }
    for (const [key, child] of Object.entries(properties)) {
      if (value[key] === undefined) continue
      checkNode(child, value[key], path === '' ? key : `${path}.${key}`, violations)
    }
  }
}

/**
 * Validate model-generated arguments against a raw JSON Schema object.
 *
 * @param parameters - the tool's parameter schema.
 * @param args - candidate arguments.
 * @returns path-qualified violations; empty means valid.
 */
export function validateArguments(parameters: JsonSchemaNode, args: unknown): string[] {
  const violations: string[] = []
  if (!isRecord(args)) return ['arguments must be an object']
  checkNode(parameters, args, '', violations)
  return violations
}

/**
 * Build a registry-ready tool definition without `defineTool`.
 *
 * @param options - name, schemas, renderer, presenters and executor.
 * @returns the definition object `ctx.tools.register()` accepts.
 */
export function defineLocalTool<Args extends Record<string, unknown>>(
  options: LocalToolOptions<Args>,
): LocalToolDefinition {
  const { name, description, parameters, outputSchema, render, timeoutMs } = options
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('defineLocalTool: name must be a non-empty string')
  }
  if (typeof description !== 'string' || description.trim() === '') {
    throw new Error(`defineLocalTool(${name}): description must be a non-empty string`)
  }
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`defineLocalTool(${name}): timeoutMs must be a positive finite number`)
  }
  const definition: LocalToolDefinition = {
    name,
    description,
    parameters,
    output: {
      schema: outputSchema,
      render: render as never,
    },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(options.presentCall === undefined
      ? {}
      : {
          presentCall: ((args: never) => {
            const violations = validateArguments(parameters, args)
            if (violations.length > 0) return undefined
            return options.presentCall?.(args as Args)
          }) as never,
        }),
    ...(options.presentResult === undefined
      ? {}
      : {
          presentResult: ((args: never, result: ToolResultLike) => {
            const violations = validateArguments(parameters, args)
            if (violations.length > 0) return undefined
            return options.presentResult?.(args as Args, result)
          }) as never,
        }),
    async execute(args, exec) {
      const violations = validateArguments(parameters, args)
      if (violations.length > 0) {
        throw new Error(`invalid arguments: ${violations.join('; ')}`)
      }
      return options.execute(args as unknown as Args, exec)
    },
  }
  return definition
}
