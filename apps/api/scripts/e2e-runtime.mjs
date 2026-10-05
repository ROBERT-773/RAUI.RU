const timedOut = Symbol('timeout');
async function bounded(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(timedOut), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function trackProcess(child, label) {
  if (!['api', 'web', 'browser'].includes(label))
    throw new Error('Invalid service label');
  const record = { child, label, outcome: undefined, logFailed: false };
  record.completion = new Promise((resolve) => {
    const finish = (outcome) => {
      if (!record.outcome) {
        record.outcome = outcome;
        resolve(outcome);
      }
    };
    child.once('error', () =>
      finish({ code: null, signal: null, spawnError: true }),
    );
    child.once('exit', (code, signal) =>
      finish({ code, signal, spawnError: false }),
    );
  });
  return record;
}
export async function waitService(url, records, options = {}) {
  const deadline = Date.now() + (options.deadlineMs ?? 30000);
  const check = () => {
    if (records.some((record) => record.outcome || record.logFailed))
      throw new Error('Service exited before readiness');
  };
  while (Date.now() < deadline) {
    check();
    const controller = new AbortController();
    try {
      const response = await bounded(
        (options.fetch ?? fetch)(url, {
          signal: controller.signal,
          redirect: 'error',
        }),
        Math.max(1, Math.min(options.requestMs ?? 1000, deadline - Date.now())),
      );
      if (response !== timedOut) {
        void response.body?.cancel().catch(() => {});
        check();
        if (response.ok) return;
      }
    } catch {
      check();
    } finally {
      controller.abort();
    }
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, Math.min(options.pollMs ?? 250, deadline - Date.now())),
      ),
    );
  }
  throw new Error('Service readiness deadline exceeded');
}
export async function terminate(record, options = {}) {
  const flush = async () => {
    if (
      record.logCompletion &&
      (await bounded(record.logCompletion, options.logMs ?? 2000)) === timedOut
    )
      throw new Error('Service log cleanup deadline exceeded');
    if (record.logFailed) throw new Error('Service log cleanup failed');
  };
  if (record.outcome) return flush();
  try {
    record.child.kill('SIGTERM');
  } catch {
    if (!record.outcome) throw new Error('Service termination failed');
  }
  if ((await bounded(record.completion, options.termMs ?? 3000)) !== timedOut)
    return flush();
  try {
    record.child.kill('SIGKILL');
  } catch {
    if (!record.outcome) throw new Error('Service termination failed');
  }
  if ((await bounded(record.completion, options.killMs ?? 2000)) === timedOut)
    throw new Error('Service cleanup deadline exceeded');
  await flush();
}
export async function boundedOperation(action, milliseconds) {
  const result = await bounded(Promise.resolve().then(action), milliseconds);
  if (result === timedOut)
    throw new Error('Operation cleanup deadline exceeded');
  return result;
}

export function watchPoolErrors(pools, onFailure) {
  let failed = false;
  let signal;
  const failure = new Promise((resolve) => {
    signal = resolve;
  });
  for (const pool of pools)
    pool.on('error', () => {
      if (!failed) {
        failed = true;
        onFailure();
        signal();
      }
    });
  return {
    async run(action) {
      if (failed) throw new Error('E2E database connection failed');
      return Promise.race([
        Promise.resolve().then(() => {
          if (failed) throw new Error('E2E database connection failed');
          return action();
        }),
        failure.then(() => {
          throw new Error('E2E database connection failed');
        }),
      ]);
    },
  };
}
