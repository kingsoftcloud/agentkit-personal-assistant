/**
 * Read-only lineage for accounts that already opened a cloud personal assistant.
 *
 * The first-use wizard now ships with the standalone
 * `@kingsoftcloud/agentkit-personal-assistant` DSH plugin, so DSH Host keeps no
 * opening UI. What DSH Host still needs is the durable receipt written by the old
 * wizard: catalog and preset binding must resolve the local Agent to the
 * verified cloud deployment without starting any deployment work.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256, portableError } from './portable-resources.mjs';

export function createAssistantSetup({ storeDir, configuration }) {
  async function scope() {
    const { values } = await configuration.resolve();
    if (!values.cloudAccessKey || !values.cloudSecretKey) throw portableError('CLOUD_CREDENTIALS_MISSING', '请先配置云端凭证');
    return sha256(JSON.stringify([values.cloudServerUrl || '', values.cloudRegion || '', values.cloudCustomSource || '', values.cloudAccessKey]));
  }
  const path = key => join(storeDir, `${key}.json`);
  async function read(key) {
    try {
      const record = JSON.parse(await readFile(path(key), 'utf8'));
      if (record.format !== 'agentkit.assistant-setup/v1' || record.scope !== key) throw Error();
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw portableError('ASSISTANT_SETUP_CORRUPT', '开通记录无法读取，请保留记录并核对云端实例');
    }
  }
  // Read-only lineage lookup: catalog/binding must never start deployment work.
  async function reference() {
    let key;
    try { key = await scope(); } catch (error) { if (error.code === 'CLOUD_CREDENTIALS_MISSING') return null; throw error; }
    const record = await read(key);
    return record ? { agentId: record.agentId, cloudAgentId: record.cloudAgentId, deploymentId: record.deploymentId } : null;
  }
  return { reference };
}
