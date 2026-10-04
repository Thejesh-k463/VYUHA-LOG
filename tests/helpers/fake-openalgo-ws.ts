import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

/**
 * A minimal RFC 6455 server standing in for OpenAlgo's `websocket_proxy`
 * (v4.7.0 C7) — NO dependency: `node:http`'s `upgrade` event, the
 * Sec-WebSocket-Accept handshake, MASKED client text frames (7-bit, 16-bit and
 * 64-bit lengths), UNMASKED server text frames, ping / pong and close frames
 * with a code (incl. OpenAlgo's 4401 "auth timeout", research R11 A6).
 *
 * It speaks no OpenAlgo itself: each test scripts the replies through
 * `onMessage`, so the REAL client (Node's global `WebSocket`) is exercised
 * against exactly the wire shapes R11 recorded from OpenAlgo's `server.py`.
 * Binds 127.0.0.1 on an ephemeral port.
 */

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface FakeConnection {
  /** Every client text frame, JSON-parsed (unparseable text kept as a string). */
  readonly received: unknown[];
  /** Payloads of every pong the client sent back. */
  readonly pongs: string[];
  /** The close code the CLIENT sent, once it sent one. */
  clientCloseCode: number | null;
  /** True once the TCP socket has ended, whoever closed it. */
  ended: boolean;
  send(payload: unknown): void;
  ping(payload?: string): void;
  close(code: number, reason?: string): void;
}

export interface FakeOpenAlgoServer {
  /** ws://127.0.0.1:<port> */
  readonly url: string;
  readonly connections: FakeConnection[];
  /** Scripted replies: called for every parsed client text frame. */
  onMessage: (conn: FakeConnection, msg: unknown) => void;
  stop(): Promise<void>;
}

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export async function startFakeOpenAlgoServer(): Promise<FakeOpenAlgoServer> {
  const sockets = new Set<Duplex>();
  const connections: FakeConnection[] = [];
  const server: Server = createServer((_req, res) => {
    res.statusCode = 426;
    res.end();
  });

  const api: FakeOpenAlgoServer = {
    url: "",
    connections,
    onMessage: () => {},
    stop: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };

  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    sockets.add(socket);
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const conn: FakeConnection = {
      received: [],
      pongs: [],
      clientCloseCode: null,
      ended: false,
      send(payload) {
        if (!conn.ended) socket.write(frame(0x1, Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload))));
      },
      ping(payload = "") {
        if (!conn.ended) socket.write(frame(0x9, Buffer.from(payload)));
      },
      close(code, reason = "") {
        if (conn.ended) return;
        const body = Buffer.alloc(2 + Buffer.byteLength(reason));
        body.writeUInt16BE(code, 0);
        body.write(reason, 2);
        socket.write(frame(0x8, body));
        socket.end();
      },
    };
    connections.push(conn);
    socket.on("close", () => {
      conn.ended = true;
      sockets.delete(socket);
    });
    socket.on("error", () => {});

    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const maskOff = off;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.subarray(off, off + len));
        if (masked) for (let i = 0; i < len; i += 1) payload[i] ^= buf[maskOff + (i % 4)];
        buf = buf.subarray(off + len);

        if (opcode === 0x1) {
          const text = payload.toString("utf8");
          let msg: unknown = text;
          try {
            msg = JSON.parse(text);
          } catch {
            /* kept as text */
          }
          conn.received.push(msg);
          api.onMessage(conn, msg);
        } else if (opcode === 0xa) {
          conn.pongs.push(payload.toString("utf8"));
        } else if (opcode === 0x8) {
          conn.clientCloseCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          if (!conn.ended) {
            socket.write(frame(0x8, payload.subarray(0, 2)));
            socket.end();
          }
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  (api as { url: string }).url = `ws://127.0.0.1:${port}`;
  return api;
}
