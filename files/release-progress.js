// Local preparation diagnostics and safe job recovery only. Never retain request metadata, paths or errors.
const STAGES = new Set(['authorizing', 'preflight', 'source-preparing', 'source-resolving',
  'source-downloading', 'source-hashing', 'upload-preparing', 'uploading',
  'upload-sealing', 'submitting', 'cleanup']);

/** Trusted callback seam, separate from browser input. Diagnostics cannot change release semantics. */
export function reportReleaseProgress(onProgress, stage, values = {}) {
  if (typeof onProgress !== 'function' || !STAGES.has(stage)) return;
  const event = { stage };
  for (const key of ['bytes', 'totalBytes']) {
    if (Number.isSafeInteger(values[key]) && values[key] >= 0 && values[key] <= 256 * 1024 * 1024) event[key] = values[key];
  }
  try { onProgress(event); } catch { /* Progress consumers must not interrupt security checks or cleanup. */ }
}

export function createReleaseProgress({ now = Date.now } = {}) {
  let record = { state: 'idle', startedAt: null, updatedAt: null, finishedAt: null, stage: null, completedStages: [] };
  let stageStartedAt = null, generation = 0;
  const timestamp = () => Math.max(record.updatedAt ?? 0, now());
  function update(event) {
    if (record.state !== 'running' || !event || !STAGES.has(event.stage)) return;
    const time = timestamp();
    if (record.stage !== event.stage) {
      record.completedStages.push({ stage: record.stage, durationMs: time - stageStartedAt });
      if (record.completedStages.length > 64) record.completedStages.shift();
      record.stage = event.stage; stageStartedAt = time;
      delete record.bytes; delete record.totalBytes;
    }
    record.updatedAt = time;
    for (const key of ['bytes', 'totalBytes']) {
      if (Number.isSafeInteger(event[key]) && event[key] >= 0 && event[key] <= 256 * 1024 * 1024) record[key] = event[key];
    }
  }
  return Object.freeze({
    begin() {
      if (record.state === 'running') throw Object.assign(new Error('本机已有发布准备正在进行，请等待并查询进度，不要重复提交'), { status: 409, code: 'RELEASE_PREPARATION_RUNNING' });
      const time = now();
      record = { state: 'running', startedAt: time, updatedAt: time, finishedAt: null, stage: 'authorizing', completedStages: [] };
      stageStartedAt = time;
      const current = ++generation;
      return event => { if (current === generation) update(event); };
    },
    finish(success, result) {
      if (record.state !== 'running') return;
      // Production release IDs are random 128-bit hex identifiers, not request data.
      // Retain no raw result (which can include actor, worker tokens or bundle paths).
      if (success && typeof result?.jobId === 'string' && /^[a-f0-9]{32}$/.test(result.jobId)) record.jobId = result.jobId;
      const time = timestamp();
      record.completedStages.push({ stage: record.stage, durationMs: time - stageStartedAt });
      if (record.completedStages.length > 64) record.completedStages.shift();
      record.state = success ? 'completed' : 'failed'; record.updatedAt = time; record.finishedAt = time;
    },
    snapshot() {
      const time = record.state === 'running' ? timestamp() : record.finishedAt;
      return structuredClone({ ...record, elapsedMs: record.startedAt === null ? 0 : time - record.startedAt,
        stageElapsedMs: stageStartedAt === null ? 0 : time - stageStartedAt });
    },
  });
}
