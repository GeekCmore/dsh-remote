import { describe, expect, it } from 'vitest';
import { Capabilities, Methods } from '@dsh-remote/core';
import {
  FakeAttachments,
  FakeCatalogs,
  FakeCompaction,
  FakePersistence,
  FakeQuestionHost,
  expectRemoteError,
  handshake,
  handshakeWithChallenge,
  makeWorld,
} from './fakes.js';

describe('capability advertisement on the challenge', () => {
  it('advertises every capability when all subsystems are present', async () => {
    const world = makeWorld({
      persistence: new FakePersistence(),
      questionHost: new FakeQuestionHost(),
      catalogs: new FakeCatalogs(),
      compaction: new FakeCompaction(),
      attachments: new FakeAttachments(),
    });
    const { challenge } = await handshakeWithChallenge(world.client);
    expect([...challenge.capabilities].sort()).toEqual(
      [
        Capabilities.History,
        Capabilities.Compact,
        Capabilities.ForkAtSeq,
        Capabilities.Questions,
        Capabilities.PromptBlocks,
        Capabilities.Catalogs,
        Capabilities.PendingInteractions,
      ].sort(),
    );
  });

  it('advertises only fork-at-seq + pending-interactions in a default world', async () => {
    const world = makeWorld();
    const { challenge } = await handshakeWithChallenge(world.client);
    expect([...challenge.capabilities].sort()).toEqual(
      [Capabilities.ForkAtSeq, Capabilities.PendingInteractions].sort(),
    );
  });

  it('advertises the bare minimum without an approval bridge', async () => {
    const world = makeWorld({ withApproval: false });
    const { challenge } = await handshakeWithChallenge(world.client);
    expect(challenge.capabilities).toEqual([Capabilities.ForkAtSeq]);
  });
});

describe('capability-gated methods', () => {
  it('question.answer without a question bridge → REMOTE_CAPABILITY_UNSUPPORTED', async () => {
    const world = makeWorld();
    await handshake(world.client);
    await expectRemoteError(
      world.client.call(Methods.QuestionAnswer, { questionId: 'qst-x', answers: {} }),
      'REMOTE_CAPABILITY_UNSUPPORTED',
    );
  });

  it('approval.answer without an approval bridge → REMOTE_CAPABILITY_UNSUPPORTED', async () => {
    const world = makeWorld({ withApproval: false });
    await handshake(world.client);
    await expectRemoteError(
      world.client.call(Methods.ApprovalAnswer, { requestId: 'apr-x', decision: 'approve' }),
      'REMOTE_CAPABILITY_UNSUPPORTED',
    );
  });

  it('monitor.subscribe without a monitor → REMOTE_CAPABILITY_UNSUPPORTED', async () => {
    const world = makeWorld({ withMonitor: false });
    await handshake(world.client);
    await expectRemoteError(
      world.client.call(Methods.MonitorSubscribe, {}),
      'REMOTE_CAPABILITY_UNSUPPORTED',
    );
  });

  it('transfer.open without a transfer endpoint → REMOTE_CAPABILITY_UNSUPPORTED', async () => {
    const world = makeWorld({ withTransfer: false });
    await handshake(world.client);
    await expectRemoteError(
      world.client.call(Methods.TransferOpen, { direction: 'download', remotePath: '/tmp/x' }),
      'REMOTE_CAPABILITY_UNSUPPORTED',
    );
  });
});
