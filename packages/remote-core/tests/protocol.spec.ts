import { describe, expect, it } from 'vitest';
import {
  Capabilities,
  isRemoteErrorCode,
  Methods,
  Notifications,
  PROTOCOL_VERSION,
  type QuestionItem,
} from '../src/index.js';

describe('protocol vocabulary', () => {
  it('pins the v1 method and notification names', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(Methods.Hello).toBe('hello');
    expect(Methods.HelloProof).toBe('hello.proof');
    expect(Methods.SessionList).toBe('session.list');
    expect(Methods.SessionCreate).toBe('session.create');
    expect(Methods.SessionAttach).toBe('session.attach');
    expect(Methods.SessionDetach).toBe('session.detach');
    expect(Methods.SessionControlRelease).toBe('session.control-release');
    expect(Methods.SessionPrompt).toBe('session.prompt');
    expect(Methods.SessionCancel).toBe('session.cancel');
    expect(Methods.SessionFork).toBe('session.fork');
    expect(Methods.SessionHistory).toBe('session.history');
    expect(Methods.SessionCompact).toBe('session.compact');
    expect(Methods.ApprovalRequest).toBe('approval.request');
    expect(Methods.ApprovalAnswer).toBe('approval.answer');
    expect(Methods.QuestionRequest).toBe('question.request');
    expect(Methods.QuestionAnswer).toBe('question.answer');
    expect(Methods.CatalogList).toBe('catalog.list');
    expect(Methods.MonitorSubscribe).toBe('monitor.subscribe');
    expect(Methods.MonitorUnsubscribe).toBe('monitor.unsubscribe');
    expect(Methods.TransferOpen).toBe('transfer.open');
    expect(Notifications.SessionEvent).toBe('session.event');
    expect(Notifications.SessionStatus).toBe('session.status');
    expect(Notifications.SessionControlChanged).toBe('session.control-changed');
    expect(Notifications.MonitorMetrics).toBe('monitor.metrics');
    expect(Notifications.ApprovalClosed).toBe('approval.closed');
    expect(Notifications.QuestionClosed).toBe('question.closed');
  });

  it('pins the capability bit literals', () => {
    expect(Capabilities.History).toBe('history');
    expect(Capabilities.Compact).toBe('compact');
    expect(Capabilities.ForkAtSeq).toBe('fork-at-seq');
    expect(Capabilities.Questions).toBe('questions');
    expect(Capabilities.PromptBlocks).toBe('prompt-blocks');
    expect(Capabilities.Catalogs).toBe('catalogs');
    expect(Capabilities.PendingInteractions).toBe('pending-interactions');
  });

  it('pins the appended error code', () => {
    expect(isRemoteErrorCode('REMOTE_CAPABILITY_UNSUPPORTED')).toBe(true);
  });

  it('pins the additive question presentation fields and intent literal', () => {
    const item: QuestionItem = {
      id: 'plan',
      question: 'Approve this plan?',
      detail: '# Plan',
      header: 'Review',
      intent: { kind: 'plan-review', approve: 'Approve' },
      options: [{ id: 'approve', label: 'Approve' }],
    };
    expect(item).toEqual({
      id: 'plan',
      question: 'Approve this plan?',
      detail: '# Plan',
      header: 'Review',
      intent: { kind: 'plan-review', approve: 'Approve' },
      options: [{ id: 'approve', label: 'Approve' }],
    });
  });
});
