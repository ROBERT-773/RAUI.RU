import { headers } from 'next/headers';
import { backendFetch } from './backend';

export async function signInCapabilities() {
  const requestHeaders = await headers();
  async function available(channel: 'phone' | 'email') {
    try {
      const response = await backendFetch(
        '/v1/auth/' + channel + '-sign-in/capabilities',
        requestHeaders,
      );
      return response.ok && (await response.json()).available === true;
    } catch {
      return false;
    }
  }
  const [smsAvailable, emailAvailable] = await Promise.all([
    available('phone'),
    available('email'),
  ]);
  return { smsAvailable, emailAvailable };
}
