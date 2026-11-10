/** Portable Native builtin classification and capability manifest.
 *
 * v1 pins the original ten workspace tools. v2 admits the complete concrete
 * Node builtin catalog. External services still use the target Host's explicit
 * configuration, credentials and resource bindings; this manifest grants no
 * permissions and does not imply that those services are available. A Frozen
 * Build pinned to the Native DSH turn contract preserves its original bindings; a
 * capability manifest field binds the exact, spec-sorted tool names and the
 * required Native engine so the import side can verify the contract
 * independently of the export check — even when a recomputed archive identity
 * carries a bad manifest. */
import { isDeepStrictEqual } from 'node:util';
import { selectedNativeBuildContract } from './build-engine.mjs';
import { NATIVE_DSH_TURN_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-contract';
import { NATIVE_NODE_BUILTIN_NAMES } from './providers/dsh-node-builtin-catalog.mjs';

export const PORTABLE_NATIVE_BUILTIN_CONTRACT = 'agentkit.portable-native-builtin/v1';
export const PORTABLE_NATIVE_BUILTIN_CATALOG_CONTRACT = 'agentkit.portable-native-builtin/v2';
export const PORTABLE_NATIVE_PATCH_CONTRACT = 'agentkit.portable-native-builtin/v3';
export const PORTABLE_NATIVE_REWIND_CONTRACT = 'agentkit.portable-native-builtin/v4';
const rewindTools = ['list_workspace_checkpoints', 'preview_workspace_rewind', 'rewind_workspace_files'];

// Keep v1 immutable: old importers cannot mistake new tool families for a
// capability they understand. Workspace-only exports retain their v1 bytes.
export const PORTABLE_NATIVE_WORKSPACE_TOOLS = Object.freeze([
  'delete_workspace_file',
  'edit_workspace_file',
  'lint_workspace_file',
  'list_workspace_files',
  'multi_edit_workspace_file',
  'read_workspace_file',
  'search_workspace_files',
  'workspace_status',
  'write_workspace_file',
  'write_workspace_files',
]);
// Preserve the v2 migrated catalog. A patch-capable Build requires v3 so an
// older importer cannot mistake the new writer for a known capability.
export const PORTABLE_NATIVE_BUILTIN_TOOLS = Object.freeze(NATIVE_NODE_BUILTIN_NAMES.filter(name => name !== 'apply_workspace_patch' && !rewindTools.includes(name)).sort());
export const PORTABLE_NATIVE_PATCH_TOOLS = Object.freeze(NATIVE_NODE_BUILTIN_NAMES.filter(name => !rewindTools.includes(name)).sort());
export const PORTABLE_NATIVE_REWIND_TOOLS = Object.freeze([...NATIVE_NODE_BUILTIN_NAMES].sort());
const contracts = new Map([
  [PORTABLE_NATIVE_BUILTIN_CONTRACT, PORTABLE_NATIVE_WORKSPACE_TOOLS],
  [PORTABLE_NATIVE_BUILTIN_CATALOG_CONTRACT, PORTABLE_NATIVE_BUILTIN_TOOLS],
  [PORTABLE_NATIVE_PATCH_CONTRACT, PORTABLE_NATIVE_PATCH_TOOLS],
  [PORTABLE_NATIVE_REWIND_CONTRACT, PORTABLE_NATIVE_REWIND_TOOLS],
]);

// Identity fields a tool binding object may carry, matching the formal catalog
// binding contract (bootstrap.mjs / agent-preset-admission.mjs read
// resourceId || id || name). No other field is accepted as an identity; extra
// fields on the object are ignored rather than rejected, matching the formal
// contract which never inspects them.
const TOOL_IDENTITY_FIELDS = ['resourceId', 'id', 'name'];

/** Resolve one bound tool name. Accepts a non-empty string, or an object
 *  carrying exactly one stable catalog identity (resourceId/id/name) with no
 *  contradiction across present fields. Rejects null, numbers, empty objects,
 *  empty strings, and numeric/non-string identities — never silently drops
 *  a malformed element as "no tool". */
function resolveToolName(value) {
  if (typeof value === 'string') return value ? { name: value } : { error: true };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { error: true };
  const present = TOOL_IDENTITY_FIELDS.filter(key => Object.prototype.hasOwnProperty.call(value, key));
  if (!present.length) return { error: true };
  const identities = present.map(key => value[key]);
  // Every identity must be a non-empty string; no String() coercion of numbers
  // or objects (a numeric resourceId is a malformed binding, not "123").
  if (!identities.every(id => typeof id === 'string' && id)) return { error: true };
  // No contradiction: resourceId and name must agree when both present.
  if (new Set(identities).size > 1) return { error: true };
  return { name: identities[0] };
}

/**
 * Strictly resolve the bound builtin tool names from a Frozen Build's two
 * binding copies. A Frozen Build stores bindings both inside spec
 * (spec.bindings) and at the top level (bindings); host-build.mjs freezes
 * the same object into both, so they are always deep-equal in a genuine
 * build. When both copies exist, their `tools` must agree — a divergence
 * means a tampered archive smuggling unknown tools through one copy while the
 * other passes validation. Malformed shapes (non-array, null elements, empty
 * objects, empty strings, numeric identities) are rejected as `invalid`
 * rather than silently dropped.
 *
 * Returns { kind: 'none' } when no tools are bound, { kind: 'tools', names }
 * with the de-duplicated resolved names, or { kind: 'invalid' } for any
 * malformed shape or cross-copy mismatch.
 */
function resolveBindingTools(build) {
  const specBindings = build?.spec?.bindings, topBindings = build?.bindings;
  if (specBindings !== undefined && topBindings !== undefined
    && !isDeepStrictEqual(specBindings.tools, topBindings.tools)) return { kind: 'invalid' };
  const tools = specBindings?.tools !== undefined ? specBindings.tools : topBindings?.tools;
  if (tools === undefined || tools === null) return { kind: 'none' };
  if (!Array.isArray(tools)) return { kind: 'invalid' };
  if (!tools.length) return { kind: 'none' };
  const names = [];
  for (const value of tools) {
    const resolved = resolveToolName(value);
    if (resolved.error) return { kind: 'invalid' };
    names.push(resolved.name);
  }
  return { kind: 'tools', names: [...new Set(names)] };
}

/**
 * Resolve the portable builtin capability manifest for a Frozen Build.
 *
 * `build` is record/definition shaped: { spec, bindings, executionEngine,
 * buildId }. The Native decision follows selectedNativeBuildContract, so it
 * reflects the Frozen Build's executionEngine rather than a Host env switch or
 * the runtime string alone. Returns:
 *   - { kind: 'none' } when the build binds no builtin tools (legacy export).
 *   - { kind: 'native', manifest } when every bound tool is a concrete Node
 *     builtin on a Native Frozen engine build.
 *   - { kind: 'unsupported', names, unknown? } when tools are present but the
 *     build is not a Native Frozen engine build, or some bound tool is not on
 *     the whitelist.
 *   - { kind: 'invalid' } when the tool binding shape is malformed (non-array,
 *     null/empty elements, numeric identities, cross-copy mismatch).
 */
export function resolvePortableNativeBuiltins(build) {
  const result = resolveBindingTools(build);
  if (result.kind === 'invalid') return { kind: 'invalid' };
  if (result.kind === 'none') return { kind: 'none' };
  const names = result.names;
  const native = selectedNativeBuildContract({
    spec: build?.spec, executionEngine: build?.executionEngine, buildId: build?.buildId,
  });
  if (native !== NATIVE_DSH_TURN_CONTRACT) return { kind: 'unsupported', names };
  const unknown = names.filter(name => !PORTABLE_NATIVE_REWIND_TOOLS.includes(name));
  if (unknown.length) return { kind: 'unsupported', names, unknown };
  const contract = names.some(name => rewindTools.includes(name)) ? PORTABLE_NATIVE_REWIND_CONTRACT
    : names.includes('apply_workspace_patch') ? PORTABLE_NATIVE_PATCH_CONTRACT
    : names.every(name => PORTABLE_NATIVE_WORKSPACE_TOOLS.includes(name)) ? PORTABLE_NATIVE_BUILTIN_CONTRACT : PORTABLE_NATIVE_BUILTIN_CATALOG_CONTRACT;
  return { kind: 'native', manifest: { contract, engine: NATIVE_DSH_TURN_CONTRACT, tools: [...names].sort() } };
}

/**
 * The declared capability manifest for embedding in a portable archive
 * identity, or undefined when the build carries no portable Native builtins.
 */
export function portableNativeBuiltinField(build) {
  const resolved = resolvePortableNativeBuiltins(build);
  return resolved.kind === 'native' ? resolved.manifest : undefined;
}

function isValidNativeBuiltinManifest(declared) {
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return false;
  const keys = Object.keys(declared);
  if (keys.length !== 3 || !keys.includes('contract') || !keys.includes('engine') || !keys.includes('tools')) return false;
  const allowed = contracts.get(declared.contract);
  if (!allowed) return false;
  if (declared.engine !== NATIVE_DSH_TURN_CONTRACT) return false;
  if (!Array.isArray(declared.tools) || !declared.tools.length) return false;
  if (new Set(declared.tools).size !== declared.tools.length) return false;
  if (![...declared.tools].every(name => typeof name === 'string' && allowed.includes(name))) return false;
  const sorted = [...declared.tools].sort();
  if (!sorted.every((name, index) => name === declared.tools[index])) return false;
  return true;
}

/**
 * Validate a declared portable builtin manifest against the Frozen Build it
 * travels with. Returns null when acceptable, or an error code string.
 *
 * The declared manifest must be intrinsically well-formed (known contract,
 * correct engine, exactly the sorted whitelisted tool names, no extra fields)
 * AND match the build's actual bound tools — which are themselves strictly
 * shape-validated and cross-checked between the two binding copies. The
 * cross-check is independent of the content-addressed bundleId, so a
 * recomputed archive identity carrying a bad manifest, a malformed tool
 * binding, a spec/bindings divergence, or a spurious manifest on a tools-less
 * build still fails here, not only at export time.
 */
export function validatePortableNativeBuiltin(declared, build) {
  const resolved = resolvePortableNativeBuiltins(build);
  if (resolved.kind === 'invalid') return 'PORTABLE_BUNDLE_INVALID';
  if (declared === undefined) return resolved.kind === 'none' ? null : 'PORTABLE_BUNDLE_INVALID';
  if (resolved.kind !== 'native' || !isValidNativeBuiltinManifest(declared)
    || !isDeepStrictEqual(declared, resolved.manifest)) return 'PORTABLE_BUNDLE_INVALID';
  return null;
}
