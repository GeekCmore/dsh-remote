import { describe, expect, it } from 'vitest';
import { Methods } from '@dsh-remote/core';
import {
  FakeAttachments,
  expectRemoteError,
  handshake,
  makeWorld,
} from './fakes.js';

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString('base64');

describe('session.prompt with content blocks', () => {
  it('saves image blocks via attachments and assembles attachment refs', async () => {
    const attachments = new FakeAttachments();
    const world = makeWorld({ attachments });
    world.sessions.add('s1');
    const agent = world.agents.add('s1');
    await handshake(world.client);
    await world.client.call(Methods.SessionAttach, { sessionId: 's1', mode: 'write' });

    await world.client.call(Methods.SessionPrompt, {
      sessionId: 's1',
      text: 'what is in this image?',
      content: [
        { type: 'text', text: 'what is in this image?' },
        { type: 'image', mediaType: 'image/png', data: PNG_BASE64, name: 'shot.png' },
      ],
    });
    expect(attachments.saved).toHaveLength(1);
    expect(attachments.saved[0]!.mediaType).toBe('image/png');
    expect(attachments.saved[0]!.name).toBe('shot.png');
    expect([...attachments.saved[0]!.data]).toEqual([...PNG_BYTES]);

    expect(agent.prompts).toHaveLength(1);
    expect(agent.prompts[0]!.role).toBe('user');
    expect(agent.prompts[0]!.content).toEqual([
      { type: 'text', text: 'what is in this image?' },
      { type: 'image', mediaType: 'image/png', name: 'shot.png', attachment: { id: 'att-1' } },
    ]);
  });

  it('keeps the legacy text-only message shape when no content blocks are passed', async () => {
    const attachments = new FakeAttachments();
    const world = makeWorld({ attachments });
    world.sessions.add('s1');
    const agent = world.agents.add('s1');
    await handshake(world.client);
    await world.client.call(Methods.SessionAttach, { sessionId: 's1', mode: 'write' });

    await world.client.call(Methods.SessionPrompt, { sessionId: 's1', text: 'plain' });
    expect(attachments.saved).toHaveLength(0);
    expect(agent.prompts[0]!.content).toEqual([{ type: 'text', text: 'plain' }]);
  });

  it('fails REMOTE_CAPABILITY_UNSUPPORTED for image blocks without an attachments host', async () => {
    const world = makeWorld();
    world.sessions.add('s1');
    const agent = world.agents.add('s1');
    await handshake(world.client);
    await world.client.call(Methods.SessionAttach, { sessionId: 's1', mode: 'write' });

    await expectRemoteError(
      world.client.call(Methods.SessionPrompt, {
        sessionId: 's1',
        text: 'look',
        content: [{ type: 'image', mediaType: 'image/png', data: PNG_BASE64 }],
      }),
      'REMOTE_CAPABILITY_UNSUPPORTED',
    );
    expect(agent.prompts).toHaveLength(0);
  });
});
