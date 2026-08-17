/**
 * Shared in-memory fakes for dsh-remote daemon-protocol tests. Previously
 * copied between `packages/remote-client/tests`, `packages/remote-daemon/tests`
 * (including `tests/e2e`) and `packages/remote-proxy/tests` (including
 * `tests/e2e`); this package is the single canonical home.
 *
 * Dependency note: this package sits ABOVE the packages it fakes
 * (`core`/`remote`/`backend` are real dependencies) and is consumed only by
 * the tests of `remote-client`, `remote-daemon` and `remote-proxy`, so the
 * workspace build graph stays acyclic and `pnpm -r build` keeps its
 * topological order. `remote-backend`'s own tests keep their private superset
 * (`packages/remote-backend/tests/fakes.ts`) because importing this package
 * from there would close a dependency cycle (this package imports
 * `@dsh-remote/backend` types/runtime).
 */

export { BytePipe } from '@dsh-remote/test-utils';
export { FakeBackendBroker } from './fake-backend.js';
export { FakeBackendTransport } from './backend-transport.js';
export { FakeTargetConnector } from './fake-connector.js';
export { FakeRemoteHub } from './fake-hub.js';
export {
  FakeSession,
  FakeSessionHost,
  FakeAgent,
  FakeAgentHost,
  FakeApprovalHost,
  FakePersistence,
  FakeQuestionHost,
  FakeCatalogs,
  FakeCompaction,
  FakeAttachments,
  fakeMonitorSources,
} from './host-fakes.js';
export { BackendRig, RigRemoteHub, E2E_TOKEN } from './real-backend-hub.js';
