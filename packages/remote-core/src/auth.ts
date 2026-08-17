/**
 * Pairing authentication primitives for the dsh-remote daemon handshake
 * (plan §4.1).
 *
 * The pairing token is a 256-bit random value, base64url-encoded at rest.
 * Authentication is a three-step challenge/response:
 *
 * 1. frontend sends {@link createHello} (protocol version, capabilities,
 *    client nonce);
 * 2. backend answers {@link createChallenge} (server nonce, backend-advertised
 *    capabilities);
 * 3. frontend proves token possession with {@link computeProof}:
 *    `HMAC-SHA256(token, clientNonce ‖ serverNonce ‖ canonicalJSON(hello))`
 *    as hex. Both nonces are fixed-length hex (16 random bytes), so plain
 *    concatenation is unambiguous. The backend checks it with
 *    {@link verifyProof}, which compares in constant time.
 *
 * v1 backends store the plaintext token; {@link hashTokenForStorage} is
 * provided for backends that only keep the SHA-256 hash.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Frontend greeting, first step of the daemon handshake. */
export interface HelloMessage {
  /** Daemon protocol version; always 1 in this revision. */
  protocolVersion: 1;
  /** Feature names the frontend supports (may be empty in v1). */
  capabilities: string[];
  /** Client nonce: 16 random bytes as hex, unless supplied by the caller. */
  nonce: string;
}

/** Backend challenge, second step of the daemon handshake. */
export interface ChallengeMessage {
  /** Server nonce: 16 random bytes as hex, unless supplied by the caller. */
  nonce: string;
  /** Feature names the backend supports (may be empty). */
  capabilities: string[];
}

/**
 * Capability bits negotiated during the handshake: the frontend advertises
 * its set in {@link HelloMessage.capabilities}, the backend answers with its
 * own in {@link ChallengeMessage.capabilities}. Intersect the two to know
 * what a connection may use. This — not the protocol version — is the
 * wire-evolution mechanism: new features add a bit here, additively.
 */
export const Capabilities = {
  /** `session.history` seq-paginated history without resuming an agent. */
  History: 'history',
  /** `session.compact` context compaction. */
  Compact: 'compact',
  /** `session.fork` with `atSeq` (fork at a completed-turn boundary). */
  ForkAtSeq: 'fork-at-seq',
  /** `question.request` / `question.answer` / `question.closed`. */
  Questions: 'questions',
  /** `session.prompt` with structured `content` blocks (text + images). */
  PromptBlocks: 'prompt-blocks',
  /** `catalog.list` model/skill/agent-preset catalogs. */
  Catalogs: 'catalogs',
  /** `session.attach` results carrying `pendingInteractions`. */
  PendingInteractions: 'pending-interactions',
  /** `session.create` with a caller-selected `requestedSessionId`. */
  RequestedSessionId: 'requested-session-id',
} as const;

/** A known capability bit ({@link Capabilities} value). */
export type Capability = (typeof Capabilities)[keyof typeof Capabilities];

/** Build the handshake greeting. Pass `clientNonce` only to replay a known value (tests). */
export function createHello(clientNonce?: string, capabilities: string[] = []): HelloMessage {
  return {
    protocolVersion: 1,
    capabilities,
    nonce: clientNonce ?? randomBytes(16).toString('hex'),
  };
}

/**
 * Build the backend challenge. Pass `serverNonce` only to replay a known
 * value (tests). `capabilities` advertises what the backend supports; see
 * {@link Capabilities} for the known bits.
 */
export function createChallenge(serverNonce?: string, capabilities: string[] = []): ChallengeMessage {
  return { nonce: serverNonce ?? randomBytes(16).toString('hex'), capabilities };
}

/**
 * Deterministic JSON serialization: object keys are sorted recursively,
 * arrays keep their order. Used so both sides hash byte-identical hello
 * messages regardless of key insertion order. Throws on values JSON cannot
 * represent (undefined, functions, bigint, …).
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJSON(item)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const body = Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJSON(record[key]))
      .join(',');
    return '{' + body + '}';
  }
  throw new TypeError(`canonicalJSON: unsupported value of type ${typeof value}`);
}

/**
 * Compute the handshake proof: HMAC-SHA256 keyed by the pairing token over
 * `clientNonce ‖ serverNonce ‖ canonicalJSON(hello)`, hex-encoded.
 */
export function computeProof(
  token: string,
  clientNonce: string,
  serverNonce: string,
  hello: HelloMessage,
): string {
  const message = clientNonce + serverNonce + canonicalJSON(hello);
  return createHmac('sha256', token).update(message, 'utf8').digest('hex');
}

/** Constant-time verification of a proof produced by {@link computeProof}. */
export function verifyProof(
  token: string,
  clientNonce: string,
  serverNonce: string,
  hello: HelloMessage,
  proof: string,
): boolean {
  const expected = Buffer.from(computeProof(token, clientNonce, serverNonce, hello), 'utf8');
  const actual = Buffer.from(proof, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** Generate a new pairing token: 32 random bytes, base64url-encoded. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex digest of a token, for backends that store only the hash. */
export function hashTokenForStorage(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
