import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createSimulator } from '../defense/simulator.js';
import { createSimulatorServer } from '../defense/server.js';

const require = createRequire(new URL('../defense/package.json', import.meta.url));
const WebSocket = require('ws');
const command = { type: 'record_mock_intent', commandId: 'DEMO-1', symbol: 'SIM-ALPHA' };

test('baseline without deduplication processes the same command across reconnection twice', () => {
  const sim = createSimulator({ deduplicate: false });
  const session = sim.startSession();
  assert.equal(sim.connect(session)(command).revision, 1);
  assert.equal(sim.connect(session)(command).revision, 2);
});

test('protected core reuses the receipt across connections and rejects a different payload', () => {
  const sim = createSimulator();
  const session = sim.startSession();
  const receipt = sim.connect(session)(command);
  assert.deepEqual(sim.connect(session)(command), { ...receipt, duplicate: true });
  assert.equal(sim.connect(session)({ ...command, symbol: 'SIM-BETA' }).status, 409);
  assert.equal(sim.connect(session)({ ...command, commandId: 'DEMO-2' }).revision, 2);
});

test('baseline without per-message session checks still accepts on an existing connection', () => {
  const sim = createSimulator({ checkSession: false });
  const session = sim.startSession();
  const handle = sim.connect(session);
  sim.endSession(session);
  assert.equal(handle(command).revision, 1);
  assert.equal(sim.connect(session), null);
});

test('protected core refuses new and previously processed commands after logout', () => {
  const sim = createSimulator();
  const session = sim.startSession();
  const handle = sim.connect(session);
  assert.equal(handle(command).revision, 1);
  sim.endSession(session);
  assert.equal(handle(command).status, 401);
  assert.equal(handle({ ...command, commandId: 'DEMO-2' }).status, 401);
  assert.equal(sim.connect(session), null);
  const freshHandle = sim.connect(sim.startSession());
  assert.equal(freshHandle(command).duplicate, true);
  assert.equal(freshHandle({ ...command, commandId: 'DEMO-2' }).revision, 2);
});

test('loopback HTTP and WebSocket share receipts and enforce logout', { timeout: 5000 }, async (t) => {
  const server = createSimulatorServer();
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.terminate();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const host = `127.0.0.1:${server.address().port}`;
  const origin = `http://${host}`;
  const sessionResponse = await fetch(`${origin}/session`, { method: 'POST' });
  assert.equal(sessionResponse.status, 201);
  const headers = { 'x-demo-session': (await sessionResponse.json()).sessionId };
  const sendHttp = (payload) => fetch(`${origin}/command`, {
    method: 'POST', headers, body: JSON.stringify(payload),
  });
  const connect = () => {
    const client = new WebSocket(`ws://${host}/stream`, { headers });
    clients.push(client);
    return client;
  };
  async function sendWs(client, payload) {
    const reply = once(client, 'message');
    client.send(JSON.stringify(payload));
    const [raw] = await reply;
    return JSON.parse(raw);
  }

  let client = connect();
  await once(client, 'open');
  const first = await sendWs(client, command);
  assert.equal(first.revision, 1);
  const closed = once(client, 'close');
  client.close();
  await closed;
  client = connect();
  await once(client, 'open');
  const retries = await Promise.all([
    sendWs(client, command),
    sendHttp(command).then((res) => res.json()),
  ]);
  const { status, ...httpReceipt } = first;
  assert.equal(status, 200);
  assert.deepEqual(retries, [
    { ...first, duplicate: true },
    { ...httpReceipt, duplicate: true },
  ]);

  assert.equal((await fetch(`${origin}/session`, { method: 'DELETE', headers })).status, 200);
  const revoked = once(client, 'close');
  assert.equal((await sendWs(client, { ...command, commandId: 'DEMO-2' })).status, 401);
  assert.equal((await revoked)[0], 1008);
  assert.equal((await sendHttp(command)).status, 401);
  await assert.rejects(once(connect(), 'open'), /Unexpected server response: 403/);
});
