import { describe, expect, it } from 'vitest';
import {
  canonicalJSON,
  computeProof,
  createChallenge,
  createHello,
  generateToken,
  hashTokenForStorage,
  verifyProof,
} from '../src/index.js';

describe('pairing auth', () => {
  it('completes a full handshake: hello → challenge → proof verifies', () => {
    const token = generateToken();
    const hello = createHello();
    const challenge = createChallenge();
    const proof = computeProof(token, hello.nonce, challenge.nonce, hello);
    expect(verifyProof(token, hello.nonce, challenge.nonce, hello, proof)).toBe(true);
  });

  it('rejects a proof computed with the wrong token', () => {
    const token = generateToken();
    const hello = createHello();
    const challenge = createChallenge();
    const proof = computeProof(generateToken(), hello.nonce, challenge.nonce, hello);
    expect(verifyProof(token, hello.nonce, challenge.nonce, hello, proof)).toBe(false);
  });

  it('rejects a tampered server nonce', () => {
    const token = generateToken();
    const hello = createHello();
    const challenge = createChallenge();
    const proof = computeProof(token, hello.nonce, challenge.nonce, hello);
    const tampered = 'ff'.repeat(16);
    expect(verifyProof(token, hello.nonce, tampered, hello, proof)).toBe(false);
  });

  it('rejects a tampered client nonce', () => {
    const token = generateToken();
    const hello = createHello();
    const challenge = createChallenge();
    const proof = computeProof(token, hello.nonce, challenge.nonce, hello);
    expect(verifyProof(token, '00'.repeat(16), challenge.nonce, hello, proof)).toBe(false);
  });

  it('rejects a tampered hello (capabilities changed after the proof)', () => {
    const token = generateToken();
    const hello = createHello(undefined, ['sessions']);
    const challenge = createChallenge();
    const proof = computeProof(token, hello.nonce, challenge.nonce, hello);
    const forged = { ...hello, capabilities: ['sessions', 'root'] };
    expect(verifyProof(token, hello.nonce, challenge.nonce, forged, proof)).toBe(false);
  });

  it('rejects malformed proofs through the length-guarded timingSafeEqual path', () => {
    const token = generateToken();
    const hello = createHello();
    const challenge = createChallenge();
    expect(verifyProof(token, hello.nonce, challenge.nonce, hello, 'too-short')).toBe(false);
    expect(verifyProof(token, hello.nonce, challenge.nonce, hello, 'zz'.repeat(32))).toBe(false);
  });

  it('createHello/createChallenge generate 16-byte hex nonces and honor explicit ones', () => {
    const hello = createHello();
    expect(hello.protocolVersion).toBe(1);
    expect(hello.capabilities).toEqual([]);
    expect(hello.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(createChallenge().nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(createHello('ab'.repeat(8), ['x']).nonce).toBe('ab'.repeat(8));
    expect(createChallenge('cd'.repeat(8)).nonce).toBe('cd'.repeat(8));
  });

  it('generateToken returns 32 random bytes in base64url', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(generateToken()).not.toBe(token);
  });

  it('hashTokenForStorage returns a deterministic SHA-256 hex digest', () => {
    const token = generateToken();
    const hash = hashTokenForStorage(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashTokenForStorage(token)).toBe(hash);
    expect(hashTokenForStorage(generateToken())).not.toBe(hash);
  });
});

describe('canonicalJSON', () => {
  it('sorts object keys recursively and keeps array order', () => {
    expect(canonicalJSON({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
  });

  it('handles primitives and null', () => {
    expect(canonicalJSON(null)).toBe('null');
    expect(canonicalJSON('s')).toBe('"s"');
    expect(canonicalJSON(1.5)).toBe('1.5');
    expect(canonicalJSON(true)).toBe('true');
    expect(canonicalJSON([])).toBe('[]');
    expect(canonicalJSON({})).toBe('{}');
  });

  it('throws on unsupported values', () => {
    expect(() => canonicalJSON(undefined)).toThrowError(TypeError);
    expect(() => canonicalJSON({ f: () => {} })).toThrowError(TypeError);
  });
});
