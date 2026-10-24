import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_RECORDS = 10_000;
const MAX_TEXT_BYTES = 64 * 1024;
const identifier = (value, field) => {
  const result = String(value ?? '').trim();
  if (!/^[a-zA-Z0-9._:-]{1,128}$/u.test(result)) throw Object.assign(new TypeError(`${field} is invalid`), { code: 'STATE_IDENTIFIER_INVALID' });
  return result;
};
const text = (value, field, required = true) => {
  const result = String(value ?? '').trim();
  if (required && !result) throw Object.assign(new TypeError(`${field} is required`), { code: 'STATE_FIELD_REQUIRED' });
  if (Buffer.byteLength(result, 'utf8') > MAX_TEXT_BYTES) throw Object.assign(new TypeError(`${field} is too large`), { code: 'STATE_FIELD_TOO_LARGE' });
  return result;
};

/**
 * Durable profile-local state for sessions, memory and schedules.
 *
 * The state directory is supplied by runtime-service on the user's PVC. The
 * plugin never removes it during disable/uninstall; DSH owns bundle selection
 * while this store owns only the records created by the assistant runtime.
 */
export class PersonalAssistantStateStore {
  constructor(root) {
    this.root = String(root ?? '').trim();
    if (!this.root.startsWith('/')) throw new TypeError('state root must be an absolute path');
    this.pending = Promise.resolve();
  }

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const name of ['sessions', 'memory', 'schedules']) {
      const path = this.file(name);
      try { await readFile(path, 'utf8'); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await writeFile(path, '[]', { mode: 0o600 });
      }
    }
    return this;
  }

  file(name) { return join(this.root, `${name}.json`); }

  async read(name) {
    try {
      const parsed = JSON.parse(await readFile(this.file(name), 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw Object.assign(new Error(`state file ${name} is invalid`), { code: 'STATE_CORRUPT', cause: error });
    }
  }

  async write(name, rows) {
    if (!Array.isArray(rows) || rows.length > MAX_RECORDS) throw new TypeError(`state collection ${name} is invalid`);
    const target = this.file(name);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(rows)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }

  mutate(name, operation) {
    const run = this.pending.then(async () => {
      const rows = await this.read(name);
      const result = await operation(rows);
      await this.write(name, rows);
      return result;
    });
    this.pending = run.catch(() => {});
    return run;
  }

  async sessions(botId) {
    const id = identifier(botId, 'botId');
    return (await this.read('sessions')).filter(row => row.botId === id);
  }

  createSession({ botId, title = '', metadata = {} } = {}) {
    const id = identifier(botId, 'botId');
    return this.mutate('sessions', rows => {
      const session = Object.freeze({
        sessionId: `session-${randomUUID()}`,
        botId: id,
        title: text(title, 'title', false),
        metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      rows.push(session);
      return session;
    });
  }

  memory(botId, query = '') {
    const id = identifier(botId, 'botId');
    const needle = text(query, 'query', false).toLowerCase();
    return this.read('memory').then(rows => rows.filter(row => row.botId === id && (!needle || `${row.key}\n${row.content}`.toLowerCase().includes(needle))));
  }

  putMemory({ botId, key, content, metadata = {} } = {}) {
    const id = identifier(botId, 'botId');
    const memoryKey = identifier(key, 'key');
    const value = text(content, 'content');
    return this.mutate('memory', rows => {
      const index = rows.findIndex(row => row.botId === id && row.key === memoryKey);
      const next = { botId: id, key: memoryKey, content: value, metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {}, updatedAt: new Date().toISOString() };
      if (index < 0) rows.push(next); else rows[index] = next;
      return next;
    });
  }

  schedules(botId) {
    const id = identifier(botId, 'botId');
    return this.read('schedules').then(rows => rows.filter(row => row.botId === id));
  }

  putSchedule({ botId, scheduleId, runAt, metadata = {} } = {}) {
    const id = identifier(botId, 'botId');
    const schedule = identifier(scheduleId, 'scheduleId');
    const timestamp = Number(runAt);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw Object.assign(new TypeError('runAt is invalid'), { code: 'SCHEDULE_INVALID' });
    return this.mutate('schedules', rows => {
      const index = rows.findIndex(row => row.botId === id && row.scheduleId === schedule);
      const next = { botId: id, scheduleId: schedule, nextRunAt: timestamp, metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {}, updatedAt: new Date().toISOString() };
      if (index < 0) rows.push(next); else rows[index] = next;
      return next;
    });
  }

  removeSchedule(botId, scheduleId) {
    const id = identifier(botId, 'botId');
    const schedule = identifier(scheduleId, 'scheduleId');
    return this.mutate('schedules', rows => {
      const before = rows.length;
      rows.splice(0, rows.length, ...rows.filter(row => !(row.botId === id && row.scheduleId === schedule)));
      return before !== rows.length;
    });
  }
}

export function createPersonalAssistantStateStore(root) {
  return new PersonalAssistantStateStore(root);
}
