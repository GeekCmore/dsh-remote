/**
 * Newline-delimited JSON-RPC 2.0 peer, aligned with the semantics of the dsh
 * sdk/protocol layer: unary request/response calls paired by `id`, plus
 * fire-and-forget notifications. Requests and notifications may flow in both
 * directions over the same stream.
 *
 * Malformed input policy:
 *
 * - a line that is not valid JSON is answered with a `-32700` parse error
 *   (id null) and skipped; decoding continues with the next line;
 * - valid JSON that is not a well-formed JSON-RPC message is answered with
 *   `-32600` (id null), except response-shaped messages, which are ignored;
 * - notifications are never answered, per the spec;
 * - lines carrying the data-frame marker are ignored here — they belong to
 *   the channel mux when both layers share one byte stream;
 * - responses with an unknown id are ignored (late answer to a cancelled or
 *   timed-out call).
 *
 * When a method handler throws a {@link RemoteError}, its stable code is
 * propagated to the caller in `error.data.remoteCode` (with optional details
 * in `error.data.remoteData`); the caller side restores a RemoteError with
 * that code. Any other handler failure becomes `-32603`, and `-32601`/`-32603`
 * responses surface to the caller as RemoteError(REMOTE_PROTOCOL_ERROR)
 * preserving the server's message text.
 */
import { RemoteError, isRemoteErrorCode } from './errors.js';
import { LineDecoder, encodeLine, isFrameMessage } from './framing.js';

/** JSON-RPC error code: parse error (invalid JSON was received). */
export const PARSE_ERROR = -32700;
/** JSON-RPC error code: invalid request (valid JSON, not a valid message). */
export const INVALID_REQUEST = -32600;
/** JSON-RPC error code: method not found. */
export const METHOD_NOT_FOUND = -32601;
/** JSON-RPC error code: internal error (handler threw). */
export const INTERNAL_ERROR = -32603;

/** Notification method sent when a pending call is aborted via AbortSignal. */
export const CANCEL_METHOD = '$/cancel';

type RpcId = number | string;

/** Server-side method handler. May be async; returned value is the result. */
export type RpcHandler = (params: unknown) => unknown | Promise<unknown>;

/** Handler for inbound notifications. Return value is ignored. */
export type NotificationHandler = (params: unknown) => void;

/** Output hook the peer writes encoded lines to. */
export interface JsonRpcOutbound {
  send(line: Uint8Array): void;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

/** Wire shape of `error.data` for errors raised from a {@link RemoteError}. */
interface RemoteErrorData {
  remoteCode: string;
  remoteData?: unknown;
}

/**
 * Bidirectional JSON-RPC 2.0 endpoint over a newline-framed byte stream.
 * Consumes `inbound` in the background until it ends or fails; at that point
 * every pending call is rejected with REMOTE_CONN_LOST and {@link closed}
 * resolves.
 */
export class JsonRpcPeer {
  #out: JsonRpcOutbound;
  #decoder: LineDecoder;
  #nextId = 1;
  #pending = new Map<RpcId, PendingCall>();
  #handlers = new Map<string, RpcHandler>();
  #notifications = new Map<string, NotificationHandler>();
  #closed: Promise<void>;
  #resolveClosed!: () => void;

  constructor(outbound: JsonRpcOutbound, inbound: AsyncIterable<Uint8Array>) {
    this.#out = outbound;
    this.#decoder = new LineDecoder(undefined, (_raw, err) => {
      const detail = err instanceof Error ? err.message : String(err);
      this.#sendError(null, PARSE_ERROR, `parse error: ${detail}`);
    });
    this.#closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    void this.#pump(inbound);
  }

  /** Resolves once the inbound stream has ended and all calls were settled. */
  get closed(): Promise<void> {
    return this.#closed;
  }

  /**
   * Invoke `method` on the remote peer and await its result. Server errors
   * reject with a {@link RemoteError}: `-32601`/`-32603` map to
   * REMOTE_PROTOCOL_ERROR with the server message preserved; errors raised
   * from a server-side RemoteError keep their original code. Aborting
   * `signal` rejects with REMOTE_ABORTED and sends a `$/cancel` notification
   * so the server can drop the in-flight work.
   */
  call<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new RemoteError('REMOTE_ABORTED', `call "${method}" aborted`));
        return;
      }
      const onAbort = () => {
        if (!this.#pending.delete(id)) return;
        this.notify(CANCEL_METHOD, { id });
        reject(new RemoteError('REMOTE_ABORTED', `call "${method}" aborted`));
      };
      this.#pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value as T);
        },
        reject: (err) => {
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  /** Register a server-side handler for `method`. */
  on(method: string, handler: RpcHandler): void {
    this.#handlers.set(method, handler);
  }

  /** Send a notification; no response is expected or accepted. */
  notify(method: string, params?: unknown): void {
    this.#send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  /** Register a handler for inbound notifications on `method`. */
  onNotification(method: string, handler: NotificationHandler): void {
    this.#notifications.set(method, handler);
  }

  #send(msg: Record<string, unknown>): void {
    this.#out.send(encodeLine(msg));
  }

  #sendError(id: RpcId | null, code: number, message: string, data?: unknown): void {
    this.#send({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    });
  }

  async #pump(inbound: AsyncIterable<Uint8Array>): Promise<void> {
    let failure: unknown;
    try {
      for await (const chunk of inbound) {
        for (const msg of this.#decoder.push(chunk)) {
          this.#handleMessage(msg);
        }
      }
    } catch (err) {
      failure = err;
    }
    const teardown =
      failure instanceof RemoteError
        ? failure
        : new RemoteError('REMOTE_CONN_LOST', 'peer closed the byte stream', { cause: failure });
    for (const pending of this.#pending.values()) pending.reject(teardown);
    this.#pending.clear();
    this.#resolveClosed();
  }

  #handleMessage(msg: unknown): void {
    // Data frames belong to the channel mux when layers share one stream.
    if (isFrameMessage(msg)) return;
    if (typeof msg !== 'object' || msg === null) {
      this.#sendError(null, INVALID_REQUEST, 'invalid request: not an object');
      return;
    }
    const rec = msg as Record<string, unknown>;
    if (typeof rec['method'] === 'string') {
      if (rec['jsonrpc'] !== '2.0') {
        if ('id' in rec) this.#sendError(asId(rec['id']), INVALID_REQUEST, 'invalid request: jsonrpc must be "2.0"');
        return;
      }
      if ('id' in rec) {
        void this.#handleRequest(asId(rec['id']), rec['method'], rec['params']);
      } else {
        this.#handleNotification(rec['method'], rec['params']);
      }
      return;
    }
    if ('id' in rec && ('result' in rec || 'error' in rec)) {
      this.#handleResponse(rec);
      return;
    }
    this.#sendError(null, INVALID_REQUEST, 'invalid request');
  }

  async #handleRequest(id: RpcId, method: string, params: unknown): Promise<void> {
    const handler = this.#handlers.get(method);
    if (!handler) {
      this.#sendError(id, METHOD_NOT_FOUND, `method not found: ${method}`);
      return;
    }
    try {
      const result = await handler(params);
      this.#send({ jsonrpc: '2.0', id, result: result === undefined ? null : result });
    } catch (err) {
      if (err instanceof RemoteError) {
        const data: RemoteErrorData =
          err.data === undefined
            ? { remoteCode: err.code }
            : { remoteCode: err.code, remoteData: err.data };
        this.#sendError(id, INTERNAL_ERROR, err.message, data);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.#sendError(id, INTERNAL_ERROR, message);
      }
    }
  }

  #handleNotification(method: string, params: unknown): void {
    const handler = this.#notifications.get(method);
    if (!handler) return;
    try {
      handler(params);
    } catch {
      // Notification handlers are fire-and-forget; failures are swallowed.
    }
  }

  #handleResponse(rec: Record<string, unknown>): void {
    const id = rec['id'];
    if (typeof id !== 'number' && typeof id !== 'string') return;
    const pending = this.#pending.get(id);
    if (!pending) return; // unknown id: late answer to a settled call
    this.#pending.delete(id);
    const error = rec['error'];
    if (error !== undefined && error !== null) {
      pending.reject(responseErrorToRemote(error));
    } else {
      pending.resolve(rec['result']);
    }
  }
}

function asId(value: unknown): RpcId {
  return typeof value === 'number' || typeof value === 'string' ? value : 0;
}

function responseErrorToRemote(error: unknown): RemoteError {
  const e = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    message?: unknown;
    data?: unknown;
  };
  const message = typeof e.message === 'string' ? e.message : 'remote error';
  const data = e.data;
  if (typeof data === 'object' && data !== null) {
    const remoteCode = (data as RemoteErrorData).remoteCode;
    if (isRemoteErrorCode(remoteCode)) {
      return new RemoteError(remoteCode, message, { data: (data as RemoteErrorData).remoteData });
    }
  }
  return new RemoteError('REMOTE_PROTOCOL_ERROR', `RPC error ${String(e.code)}: ${message}`, { data });
}
