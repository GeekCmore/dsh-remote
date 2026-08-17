import { describe, expect, it } from 'vitest';
import { Methods, RemoteError, computeProof, createHello, type ChallengeMessage } from '@dsh-remote/core';
import { TEST_TOKEN, expectRemoteError, handshake, makeWorld } from './fakes.js';
import { sleep } from '@dsh-remote/test-utils';

describe('serve handshake', () => {
  it('rejects everything except hello/hello.proof before authentication', async () => {
    const world = makeWorld();
    await expectRemoteError(world.client.call(Methods.SessionList), 'REMOTE_PROTOCOL_ERROR');
  });

  it('completes hello → challenge → proof and returns a client id', async () => {
    const world = makeWorld();
    const result = await handshake(world.client);
    expect(result.authenticated).toBe(true);
    expect(result.clientId).toBe('client-1');
    expect(world.server.clientId).toBe('client-1');
    // After auth the method surface opens up.
    await expect(world.client.call(Methods.SessionList)).resolves.toEqual({ sessions: [] });
  });

  it('answers REMOTE_AUTH_FAILED for a wrong token', async () => {
    const world = makeWorld();
    const hello = createHello();
    const challenge = (await world.client.call(Methods.Hello, hello)) as ChallengeMessage;
    const badProof = computeProof('wrong-token', hello.nonce, challenge.nonce, hello);
    await expectRemoteError(
      world.client.call(Methods.HelloProof, {
        clientNonce: hello.nonce,
        serverNonce: challenge.nonce,
        hello,
        proof: badProof,
      }),
      'REMOTE_AUTH_FAILED',
    );
  });

  it('rejects a proof bound to a different hello (nonce mismatch)', async () => {
    const world = makeWorld();
    const hello = createHello();
    const challenge = (await world.client.call(Methods.Hello, hello)) as ChallengeMessage;
    const other = createHello();
    const proof = computeProof(TEST_TOKEN, other.nonce, challenge.nonce, other);
    await expectRemoteError(
      world.client.call(Methods.HelloProof, {
        clientNonce: other.nonce,
        serverNonce: challenge.nonce,
        hello: other,
        proof,
      }),
      'REMOTE_AUTH_FAILED',
    );
  });

  it('rejects a malformed hello', async () => {
    const world = makeWorld();
    await expectRemoteError(world.client.call(Methods.Hello, { nope: true }), 'REMOTE_PROTOCOL_ERROR');
  });

  it('rate-limits consecutive failures and goes fatal at the limit', async () => {
    const world = makeWorld({ auth: { maxFailures: 3, baseDelayMs: 20, maxDelayMs: 100 } });
    const attempt = async () => {
      const hello = createHello();
      const challenge = (await world.client.call(Methods.Hello, hello)) as ChallengeMessage;
      const t0 = Date.now();
      await expectRemoteError(
        world.client.call(Methods.HelloProof, {
          clientNonce: hello.nonce,
          serverNonce: challenge.nonce,
          hello,
          proof: 'deadbeef',
        }),
        'REMOTE_AUTH_FAILED',
      );
      return Date.now() - t0;
    };
    const first = await attempt();
    const third = await attempt();
    await attempt();
    // Delay grows with the consecutive-failure count (20ms/40ms/60ms, ±jitter).
    expect(third).toBeGreaterThan(first);
    // onFatal fires slightly after the last error response.
    await sleep(50);
    expect(world.fatalCount()).toBe(1);
    expect(world.diags.some((d) => d.includes('failure limit'))).toBe(true);
  });

  it('still serves a good proof after earlier failures (counter resets)', async () => {
    const world = makeWorld({ auth: { maxFailures: 5, baseDelayMs: 1 } });
    const hello = createHello();
    const challenge = (await world.client.call(Methods.Hello, hello)) as ChallengeMessage;
    await expectRemoteError(
      world.client.call(Methods.HelloProof, {
        clientNonce: hello.nonce,
        serverNonce: challenge.nonce,
        hello,
        proof: 'bad',
      }),
      'REMOTE_AUTH_FAILED',
    );
    const result = await handshake(world.client);
    expect(result.authenticated).toBe(true);
    expect(world.fatalCount()).toBe(0);
  });
});
