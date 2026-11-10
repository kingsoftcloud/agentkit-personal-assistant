/** Versioned, receipt-scoped carrier for an explicit public DSH projection. */
export const ASSISTANT_NATIVE_CAPABILITY = 'personal-assistant-native-carrier/v1';
export const ASSISTANT_NATIVE_REPRESENTATION = 'assistant-public-projection/v1';
export const ASSISTANT_NATIVE_OPERATIONS = Object.freeze([
  'native-open', 'native-call', 'native-stream-open', 'native-stream-poll', 'native-stream-cancel', 'native-close',
]);
/** @param {string} operation */
export const isAssistantNativeOperation = operation => ASSISTANT_NATIVE_OPERATIONS.includes(operation);
