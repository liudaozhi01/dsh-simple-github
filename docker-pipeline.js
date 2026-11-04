import { createDockerPlans } from './docker-plan.js';
import { createDockerPublisher } from './docker-publish.js';
import { createDockerExecutor } from './docker-executor.js';

/** Server-only composition root, deliberately not wired to HTTP.
 * deliver must perform real delivery and return independent digest/health evidence.
 * Never supply the preflight-only adapter as a successful deliver capability.
 * Accepted releases may use an explicitly injected durable journal; plans/jobs
 * remain ephemeral. Construct one pipeline per plugin lifetime.
 */
export function createDockerPipeline({ resolveDev, getUser, build, command, deliver, query, backendRepository, frontendRepository, dockerConfig, path, journal, now = Date.now } = {}) {
  if (typeof deliver !== 'function') throw new TypeError('Trusted actual delivery capability required.');
  const plans = createDockerPlans({ resolveDev, getUser, now });
  const publisher = createDockerPublisher({ build, command, backendRepository, frontendRepository, dockerConfig, ...(path === undefined ? {} : { path }) });
  const evidence = new Map();
  if (journal !== undefined) {
    if (typeof journal.list !== 'function' || typeof journal.append !== 'function') throw new TypeError('Trusted journal capability required.');
    const restored = journal.list();
    if (!Array.isArray(restored) || restored.length > 128) throw new Error('Invalid journal restore.');
    for (const release of restored) {
      plans.recordDevRelease(release);
      const artifact = Object.freeze({ head: release.head, backendImage: release.backendImage, frontendImage: release.frontendImage, provenanceVerified: true });
      evidence.set(key({ head: release.head }, artifact), artifact);
    }
  }
  const executionPlans = { getPlan: plans.getPlan, recordDevRelease: async release => {
    // Persist before making the record promotable. A write uncertainty must block acceptance.
    if (journal) await journal.append(release);
    return plans.recordDevRelease(release);
  } };
  function key(remote, artifact) { return JSON.stringify([remote.head, artifact.backendImage, artifact.frontendImage]); }
  const executor = createDockerExecutor({ plans: executionPlans, getUser, now, query,
    build: async input => {
      if (evidence.size >= 128) throw new Error('Publication evidence capacity exhausted; operator reconciliation required.');
      const artifact = await publisher.buildAndPublish(input);
      evidence.set(key(input.remote, artifact), Object.freeze({ ...artifact }));
      return artifact;
    },
    deliver: async ({ jobId, environment, remote, artifact }) => {
      const verified = evidence.get(key(remote, artifact));
      if (!verified || verified.head !== remote.head || verified.provenanceVerified !== true) throw new Error('No trusted publication evidence for this exact source and image pair.');
      // Immutable internal evidence supplies head/provenance for both dev and test.
      // Test never invokes publisher/build and never accepts proof from HTTP callers.
      return deliver({ jobId, environment, remote: Object.freeze({ ...remote }), artifact: verified });
    },
  });
  return Object.freeze({ check: plans.check, promotion: plans.promotion, start: executor.start, status: executor.status, accept: executor.accept, reconcile: executor.reconcile });
}
