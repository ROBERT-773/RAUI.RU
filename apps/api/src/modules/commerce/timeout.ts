import { ServiceUnavailableException } from '@nestjs/common';
export async function paymentDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  milliseconds = 5000,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ServiceUnavailableException('Payment provider timed out'));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
