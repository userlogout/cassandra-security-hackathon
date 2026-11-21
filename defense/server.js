import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { createSimulator } from './simulator.js';

const maxPayload = 4096;
const loopback = '127.0.0.1';

function send(response, { status = 200, ...body }) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function readCommand(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= maxPayload) chunks.push(chunk);
  }
  return size <= maxPayload ? JSON.parse(Buffer.concat(chunks).toString()) : null;
}

export function createSimulatorServer() {
  const simulator = createSimulator();
  const sockets = new WebSocketServer({ noServer: true, maxPayload });

  const server = createServer(async (request, response) => {
    // Require a loopback Host and disallow cross-origin browser requests.
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(request.headers.host ?? '') ||
        request.headers.origin !== undefined) {
      return send(response, { status: 403, error: 'local_client_required' });
    }

    const sessionId = request.headers['x-demo-session'];
    switch (`${request.method} ${request.url}`) {
      case 'POST /session':
        return send(response, { status: 201, sessionId: simulator.startSession() });
      case 'DELETE /session':
        if (!simulator.endSession(sessionId)) {
          return send(response, { status: 401, error: 'session_ended' });
        }
        return send(response, { ended: true });
      case 'POST /command': {
        const handle = simulator.connect(sessionId);
        if (!handle) return send(response, { status: 401, error: 'session_ended' });
        let command;
        try {
          command = await readCommand(request);
        } catch {
          return send(response, { status: 400, error: 'invalid_command' });
        }
        return send(response, handle(command));
      }
      default:
        return send(response, { status: 404, error: 'unknown_route' });
    }
  });

  server.on('upgrade', (request, socket, head) => {
    const handle = simulator.connect(request.headers['x-demo-session']);
    if (request.url !== '/stream' || !handle ||
        !/^127\.0\.0\.1(?::\d+)?$/.test(request.headers.host ?? '') ||
        request.headers.origin !== undefined) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }

    sockets.handleUpgrade(request, socket, head, (connection) => {
      connection.on('error', () => connection.terminate());
      connection.on('message', (data, binary) => {
        let command;
        try {
          command = binary ? null : JSON.parse(data.toString());
        } catch {
          command = null;
        }
        const result = handle(command);
        connection.send(JSON.stringify(result));
        if (result.status === 401) connection.close(1008, 'session ended');
      });
    });
  });

  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  createSimulatorServer().listen(8765, loopback, () => {
    console.log('Simulator listening at http://127.0.0.1:8765');
  });
}
