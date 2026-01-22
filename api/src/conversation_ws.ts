import type { DurableObjectState } from 'cloudflare:workers';

type BroadcastEvent = { type: string; [key: string]: unknown };

export class ConversationWebSocket {
  private ctx: DurableObjectState;
  private clients: Set<WebSocket> = new Set();

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  handleUpgrade(request: Request): Response | null {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return null;
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    this.clients.add(server);
    console.log(`[WebSocket] Client connected. Total clients: ${this.clients.size}`);

    server.addEventListener('close', () => {
      this.clients.delete(server);
      console.log(`[WebSocket] Client disconnected. Total clients: ${this.clients.size}`);
    });

    server.addEventListener('error', (err) => {
      console.log(`[WebSocket] Client error:`, err);
      this.clients.delete(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(event: BroadcastEvent) {
    const data = JSON.stringify(event);
    console.log(`[Broadcast] Sending ${event.type} to ${this.clients.size} clients`);
    for (const client of this.clients) {
      try {
        client.send(data);
      } catch (err) {
        console.log(`[Broadcast] Error sending to client:`, err);
        this.clients.delete(client);
      }
    }
  }
}
