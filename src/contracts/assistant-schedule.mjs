/** Schedule operations remain bound to the authenticated assistant conversation. */
export const ASSISTANT_SCHEDULE_OPERATIONS = Object.freeze(['schedule-catalog', 'schedule-list', 'schedule-get', 'schedule-history', 'schedule-create', 'schedule-update', 'schedule-delete']);
export const ASSISTANT_SCHEDULE_CAPABILITY = 'personal-assistant-schedule-manager/v1';
/** @param {unknown} operation */
export const isAssistantScheduleOperation = operation => typeof operation === 'string' && ASSISTANT_SCHEDULE_OPERATIONS.includes(operation);
