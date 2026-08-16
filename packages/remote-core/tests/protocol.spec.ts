import { describe, expect, it } from 'vitest';
import { Methods, Notifications, PROTOCOL_VERSION } from '../src/index.js';

describe('protocol vocabulary', () => {
  it('pins the v1 method and notification names', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(Methods.Hello).toBe('hello');
    expect(Methods.HelloChallenge).toBe('hello.challenge');
    expect(Methods.HelloProof).toBe('hello.proof');
    expect(Methods.SessionList).toBe('session.list');
    expect(Methods.SessionCreate).toBe('session.create');
    expect(Methods.SessionAttach).toBe('session.attach');
    expect(Methods.SessionDetach).toBe('session.detach');
    expect(Methods.SessionControlRelease).toBe('session.control-release');
    expect(Methods.SessionPrompt).toBe('session.prompt');
    expect(Methods.SessionCancel).toBe('session.cancel');
    expect(Methods.SessionFork).toBe('session.fork');
    expect(Methods.ApprovalRequest).toBe('approval.request');
    expect(Methods.ApprovalAnswer).toBe('approval.answer');
    expect(Methods.MonitorSubscribe).toBe('monitor.subscribe');
    expect(Methods.MonitorUnsubscribe).toBe('monitor.unsubscribe');
    expect(Methods.TransferOpen).toBe('transfer.open');
    expect(Notifications.SessionEvent).toBe('session.event');
    expect(Notifications.SessionStatus).toBe('session.status');
    expect(Notifications.SessionControlChanged).toBe('session.control-changed');
    expect(Notifications.MonitorMetrics).toBe('monitor.metrics');
    expect(Notifications.ApprovalClosed).toBe('approval.closed');
  });
});
