/**
 * Validators for the two manifest surfaces used by this project.
 *
 * `package.json.dsh` follows the DSH loader contract. The separate
 * `personal-assistant.plugin.json` is an AgentKit application metadata file;
 * DSH does not read its `metadata` values.
 */

const FORMAT = 'agentkit-personal-assistant.plugin/v1';
const PLUGIN_ID = '@kingsoftcloud/agentkit-personal-assistant';
const REQUIRED_DSH = '0.2.1-rc.2';
const REQUIRED_HOST_API = `dsh-native/${REQUIRED_DSH}`;

function fail(message) {
  throw new TypeError(`Invalid personal-assistant manifest: ${message}`);
}

function string(value, field) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${field} must be a non-empty string`);
  return value;
}

function strings(value, field) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) fail(`${field} must be an array of non-empty strings`);
  if (new Set(value).size !== value.length) fail(`${field} must not contain duplicates`);
  return value;
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  return value;
}

/** Validate the subset of package.json.dsh consumed by DSH's loader. */
export function validateDshPackageManifest(manifest) {
  const root = object(manifest, 'package.json');
  string(root.name, 'package.json.name');
  string(root.version, 'package.json.version');
  const dsh = root.dsh === undefined ? {} : object(root.dsh, 'package.json.dsh');
  const bundle = dsh.bundle === undefined ? undefined : object(dsh.bundle, 'package.json.dsh.bundle');
  if (bundle !== undefined) {
    const patch = bundle.patch;
    if (!(typeof patch === 'string' && patch.trim() !== '') && !(Array.isArray(patch) && patch.length > 0 && patch.every(item => typeof item === 'string' && item.trim() !== ''))) {
      fail('package.json.dsh.bundle.patch must be a path or non-empty path array');
    }
  }
  const client = dsh.client === undefined ? undefined : object(dsh.client, 'package.json.dsh.client');
  if (client !== undefined) {
    string(client.platform, 'package.json.dsh.client.platform');
    if (client.inject !== undefined) strings(client.inject, 'package.json.dsh.client.inject');
    if (client.external !== undefined) strings(client.external, 'package.json.dsh.client.external');
    if (client.immediately !== undefined && typeof client.immediately !== 'boolean') fail('package.json.dsh.client.immediately must be a boolean');
  }
  return root;
}

/** Validate the application-owned personal-assistant.plugin.json shape. */
export function validatePersonalAssistantManifest(manifest) {
  const root = object(manifest, 'personal-assistant.plugin.json');
  const allowedRoot = new Set(['$schema', 'format', 'pluginId', 'version', 'compatibility', 'metadata']);
  for (const key of Object.keys(root)) if (!allowedRoot.has(key)) fail(`unrecognized top-level field: ${key}`);
  if (root.format !== FORMAT) fail(`format must be ${FORMAT}`);
  if (root.pluginId !== PLUGIN_ID) fail(`pluginId must be ${PLUGIN_ID}`);
  string(root.version, 'version');
  const compatibility = object(root.compatibility, 'compatibility');
  if (compatibility.requiredDsh !== REQUIRED_DSH) fail(`compatibility.requiredDsh must be ${REQUIRED_DSH}`);
  if (compatibility.requiredHostApi !== REQUIRED_HOST_API) fail(`compatibility.requiredHostApi must be ${REQUIRED_HOST_API}`);
  if (!Number.isInteger(compatibility.requiredHostContract) || compatibility.requiredHostContract < 1) fail('compatibility.requiredHostContract must be a positive integer');
  const allowedMetadata = new Set(['defaultEnabled', 'autoConnect', 'capabilities', 'contributes', 'entrypoints']);
  const metadata = object(root.metadata, 'metadata');
  for (const key of Object.keys(metadata)) if (!allowedMetadata.has(key)) fail(`unrecognized metadata field: ${key}`);
  if (typeof metadata.defaultEnabled !== 'boolean') fail('metadata.defaultEnabled must be a boolean');
  if (typeof metadata.autoConnect !== 'boolean') fail('metadata.autoConnect must be a boolean');
  strings(metadata.capabilities, 'metadata.capabilities');
  strings(metadata.contributes, 'metadata.contributes');
  const entrypoints = object(metadata.entrypoints, 'metadata.entrypoints');
  for (const key of Object.keys(entrypoints)) if (!new Set(['host', 'client']).has(key)) fail(`unrecognized metadata.entrypoints field: ${key}`);
  if (entrypoints.host !== '.' || entrypoints.client !== './client') fail('metadata.entrypoints must point to package exports . and ./client');
  return root;
}

export const PERSONAL_ASSISTANT_MANIFEST_FORMAT = FORMAT;
