import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
export interface Trace {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}
export const traceContext = new AsyncLocalStorage<Trace>();
export function requestTrace(value: unknown): Trace {
  const match =
    typeof value === 'string' &&
    value.match(/^00-([a-f0-9]{32})-([a-f0-9]{16})-0[01]$/);
  const valid =
    match && match[1] !== '0'.repeat(32) && match[2] !== '0'.repeat(16);
  return {
    traceId: valid ? match[1]! : randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
    ...(valid ? { parentSpanId: match[2]! } : {}),
  };
}
const bounds = [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10, Infinity];
@Injectable()
export class Telemetry {
  private registered = new Set<string>();
  private readonly samples = new Map<
    string,
    { count: number; sum: number; buckets: number[] }
  >();
  routes(paths: string[]) {
    this.registered = new Set(
      paths
        .filter((path) => /^\/[A-Za-z0-9_/:{}.-]{1,180}$/.test(path))
        .slice(0, 500),
    );
  }
  route(value: unknown) {
    return typeof value === 'string' && this.registered.has(value)
      ? value
      : 'unmatched';
  }
  method(value: string) {
    return [
      'GET',
      'POST',
      'PATCH',
      'PUT',
      'DELETE',
      'HEAD',
      'OPTIONS',
    ].includes(value)
      ? value
      : 'OTHER';
  }
  record(route: unknown, method: string, status: number, seconds: number) {
    const key = `route="${this.route(route)}",method="${this.method(method)}",status="${status >= 100 && status < 600 ? Math.floor(status / 100) : 5}xx"`;
    const sample = this.samples.get(key) ?? {
      count: 0,
      sum: 0,
      buckets: bounds.map(() => 0),
    };
    const duration = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
    sample.count++;
    sample.sum += duration;
    bounds.forEach((bound, index) => {
      if (duration <= bound) sample.buckets[index]!++;
    });
    this.samples.set(key, sample);
  }
  prometheus() {
    const lines = [
      '# HELP raui_http_duration_seconds HTTP duration without payloads or identifiers.',
      '# TYPE raui_http_duration_seconds histogram',
    ];
    for (const [labels, sample] of this.samples) {
      bounds.forEach((bound, index) =>
        lines.push(
          `raui_http_duration_seconds_bucket{${labels},le="${bound === Infinity ? '+Inf' : bound}"} ${sample.buckets[index]}`,
        ),
      );
      lines.push(
        `raui_http_duration_seconds_count{${labels}} ${sample.count}`,
        `raui_http_duration_seconds_sum{${labels}} ${sample.sum}`,
      );
    }
    return lines.join('\n') + '\n';
  }
}
