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

export function summarizeLoadSpans(log, route = '/v1/listings/:id/public') {
  const timings = [];
  const routes = {
    '/v1/categories': 'GET',
    '/v1/search': 'POST',
    '/v1/listings/:id/public': 'GET',
    '/v1/search/map': 'POST',
    '/v1/auth/me': 'GET',
    '/v1/auth/sessions': 'GET',
  };
  if (
    Object.hasOwn(routes, route) &&
    typeof log === 'string' &&
    log.length <= 1024 * 1024
  ) {
    for (const line of log.split('\n').slice(0, 5000)) {
      if (line.length > 1024) continue;
      try {
        const span = JSON.parse(line);
        if (
          span.event === 'http_span' &&
          span.route === route &&
          span.method === routes[route] &&
          span.status === (routes[route] === 'POST' ? 201 : 200) &&
          Number.isSafeInteger(span.durationMs) &&
          span.durationMs >= 0 &&
          span.durationMs <= 30000
        )
          timings.push(span.durationMs);
      } catch {
        /* Raw logs and other payloads are never emitted. */
      }
    }
  }
  timings.sort((a, b) => a - b);
  return {
    count: timings.length,
    p95Ms: timings.length
      ? timings[Math.ceil(timings.length * 0.95) - 1]
      : null,
    maxMs: timings.length ? timings[timings.length - 1] : null,
  };
}

export function summarizeSlowQueries(log) {
  const groups = [
    ['visibility', 'SELECT l.* FROM listings l JOIN users u'],
    ['property', 'SELECT p.id,p.category_code,p.attributes,a.formatted'],
    ['media', 'SELECT id,kind,variants FROM media'],
  ];
  return groups.map(([query, prefix]) => {
    const durations = [];
    if (typeof log === 'string' && log.length <= 1024 * 1024)
      for (const line of log.split('\n').slice(0, 5000)) {
        if (line.length > 4096) continue;
        const match = line.match(
          /duration: ([0-9]+(?:\.[0-9]+)?) ms\s+(?:execute [^:]{1,128}|statement|bind [^:]{1,128}):\s+(SELECT.*)/,
        );
        if (match && match[2].startsWith(prefix)) {
          const ms = Number(match[1]);
          if (Number.isFinite(ms) && ms >= 0 && ms <= 30000) durations.push(ms);
        }
      }
    return {
      query,
      count: durations.length,
      maxMs: durations.length ? Math.max(...durations) : null,
    };
  });
}
