import { describe, expect, it } from 'vitest';
import { Methods, Notifications, RemoteError, type ApprovalRequestParams } from '@dsh-remote/core';
import { ApprovalBridge } from '../src/approval.js';
import { SessionBroker } from '../src/broker.js';
import {
  FakeAgentHost,
  FakeApprovalHost,
  FakeSessionHost,
  fakeConnection,
} from './fakes.js';
import { tick } from './util.js';

function makeBridge(options?: { failClosed?: boolean }) {
  const sessions = new FakeSessionHost();
  const agents = new FakeAgentHost();
  const broker = new SessionBroker(sessions, agents);
  const host = new FakeApprovalHost();
  const bridge = new ApprovalBridge(host, broker, options);
  return { sessions, broker, host, bridge };
}

describe('ApprovalBridge routing', () => {
  it('routes to the write-control holder only', async () => {
    const { sessions, broker, host, bridge } = makeBridge();
    sessions.add('s1');
    const writer = fakeConnection('writer');
    const reader = fakeConnection('reader');
    broker.connect(writer.conn);
    broker.connect(reader.conn);
    broker.attach('writer', { sessionId: 's1', mode: 'write' });
    broker.attach('reader', { sessionId: 's1', mode: 'read' });

    const raised = host.raise({ sessionId: 's1', kind: 'exec', summary: 'rm -rf /tmp/x' });
    await tick();
    const requests = writer.notifications.filter((n) => n.method === Methods.ApprovalRequest);
    expect(requests).toHaveLength(1);
    expect(reader.notifications.filter((n) => n.method === Methods.ApprovalRequest)).toHaveLength(0);

    const { requestId } = requests[0]!.params as ApprovalRequestParams;
    bridge.answer('writer', { requestId, decision: 'approve', note: 'ok' });
    await expect(raised).resolves.toEqual({ decision: 'approve', note: 'ok' });
  });

  it('broadcasts to readers when no writer holds control; first answer wins', async () => {
    const { sessions, broker, host, bridge } = makeBridge();
    sessions.add('s1');
    const r1 = fakeConnection('r1');
    const r2 = fakeConnection('r2');
    broker.connect(r1.conn);
    broker.connect(r2.conn);
    broker.attach('r1', { sessionId: 's1', mode: 'read' });
    broker.attach('r2', { sessionId: 's1', mode: 'read' });

    const raised = host.raise({ sessionId: 's1', kind: 'fs-write', summary: 'write a.txt' });
    await tick();
    const req1 = r1.notifications.find((n) => n.method === Methods.ApprovalRequest)!
      .params as ApprovalRequestParams;
    const req2 = r2.notifications.find((n) => n.method === Methods.ApprovalRequest)!
      .params as ApprovalRequestParams;
    expect(req1.requestId).toBe(req2.requestId);

    bridge.answer('r1', { requestId: req1.requestId, decision: 'deny' });
    await expect(raised).resolves.toEqual({ decision: 'deny' });
    // The loser is told to stand down.
    expect(r2.notifications).toContainEqual({
      method: Notifications.ApprovalClosed,
      params: { requestId: req1.requestId, decision: 'deny', winner: 'r1' },
    });
    // A late answer is rejected as already settled.
    expect(() => bridge.answer('r2', { requestId: req1.requestId, decision: 'approve' }))
      .toThrowError(RemoteError);
  });

  it('fails closed when nobody is attached (next() is not called)', async () => {
    const { host } = makeBridge();
    await expect(host.raise({ sessionId: 's1', kind: 'exec', summary: 'x' })).resolves.toEqual({
      decision: 'deny',
      note: 'unavailable: no frontend attached',
    });
    expect(host.nextCalls).toBe(0);
  });

  it('delegates to next() when fail-closed is disabled and nobody is attached', async () => {
    const { host } = makeBridge({ failClosed: false });
    await expect(host.raise({ sessionId: 's1', kind: 'exec', summary: 'x' })).resolves.toEqual({
      decision: 'approve',
      note: 'host default',
    });
    expect(host.nextCalls).toBe(1);
  });

  it('marks the session waiting-approval while pending', async () => {
    const { sessions, broker, host, bridge } = makeBridge();
    sessions.add('s1');
    const a = fakeConnection('a');
    broker.connect(a.conn);
    broker.attach('a', { sessionId: 's1', mode: 'read' });

    const raised = host.raise({ sessionId: 's1', kind: 'exec', summary: 'x' });
    await tick();
    expect(broker.list().find((s) => s.sessionId === 's1')!.status).toBe('waiting-approval');
    expect(a.notifications).toContainEqual({
      method: Notifications.SessionStatus,
      params: { sessionId: 's1', status: 'waiting-approval' },
    });

    const req = a.notifications.find((n) => n.method === Methods.ApprovalRequest)!
      .params as ApprovalRequestParams;
    bridge.answer('a', { requestId: req.requestId, decision: 'approve' });
    await raised;
    expect(broker.list().find((s) => s.sessionId === 's1')!.status).toBe('idle');
  });

  it('rejects answers from non-target clients and unknown request ids', async () => {
    const { sessions, broker, host, bridge } = makeBridge();
    sessions.add('s1');
    const a = fakeConnection('a');
    const stranger = fakeConnection('stranger');
    broker.connect(a.conn);
    broker.connect(stranger.conn);
    broker.attach('a', { sessionId: 's1', mode: 'write' });

    const raised = host.raise({ sessionId: 's1', kind: 'exec', summary: 'x' });
    await tick();
    const req = a.notifications.find((n) => n.method === Methods.ApprovalRequest)!
      .params as ApprovalRequestParams;
    expect(() => bridge.answer('stranger', { requestId: req.requestId, decision: 'approve' }))
      .toThrowError(/not a target/);
    expect(() => bridge.answer('a', { requestId: 'apr-nope', decision: 'approve' }))
      .toThrowError(/unknown or already-settled/);
    bridge.answer('a', { requestId: req.requestId, decision: 'approve' });
    await raised;
  });

  it('settles deny when the only target disconnects mid-request', async () => {
    const { sessions, broker, host, bridge } = makeBridge();
    sessions.add('s1');
    const a = fakeConnection('a');
    broker.connect(a.conn);
    broker.attach('a', { sessionId: 's1', mode: 'write' });

    const raised = host.raise({ sessionId: 's1', kind: 'exec', summary: 'x' });
    await tick();
    expect(bridge.pendingCount).toBe(1);
    bridge.disconnect('a');
    await expect(raised).resolves.toEqual({
      decision: 'deny',
      note: 'frontend disconnected before answering',
    });
    expect(bridge.pendingCount).toBe(0);
  });
});
