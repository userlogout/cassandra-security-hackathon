import { randomUUID } from 'node:crypto';

export function createSimulator({ checkSession = true, deduplicate = true } = {}) {
  const account = 'DEMO-ACCOUNT';
  const sessions = new Set();
  const receipts = new Map();
  let revision = 0;

  function startSession() {
    const sessionId = randomUUID();
    sessions.add(sessionId);
    return sessionId;
  }

  function connect(sessionId) {
    if (!sessions.has(sessionId)) return null;

    return function handle(command) {
      if (checkSession && !sessions.has(sessionId)) {
        return { status: 401, error: 'session_ended' };
      }

      const { type, commandId, symbol } = command ?? {};
      if (type !== 'record_mock_intent' || typeof commandId !== 'string' ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(commandId) ||
          !['SIM-ALPHA', 'SIM-BETA'].includes(symbol)) {
        return { status: 400, error: 'invalid_command' };
      }

      // One synthetic account and one action type share this map across sessions
      // and transports. This synchronous path has no yield before the receipt write.
      const receipt = deduplicate ? receipts.get(commandId) : undefined;
      if (receipt) {
        if (receipt.symbol !== symbol) return { status: 409, error: 'id_conflict' };
        return { ...receipt, duplicate: true };
      }

      const result = { status: 200, account, symbol, revision: ++revision, duplicate: false };
      if (deduplicate) receipts.set(commandId, result);
      return { ...result };
    };
  }

  return {
    startSession,
    endSession: (sessionId) => sessions.delete(sessionId),
    connect,
  };
}
