import { headers } from 'next/headers';
import { backendFetch } from './backend';

export async function signInCapabilities() {
  const requestHeaders = await headers();
  const unavailable = {
    smsAvailable: false,
    emailAvailable: false,
    resetLinkAvailable: false,
  };
  try {
    const response = await backendFetch(
      '/v1/auth/password-reset/capabilities',
      requestHeaders,
    );
    if (!response.ok) return unavailable;
    const options = await response.json();
    return {
      smsAvailable: options.smsAvailable === true,
      emailAvailable: options.emailAvailable === true,
      resetLinkAvailable: options.resetLinkAvailable === true,
    };
  } catch {
    return unavailable;
  }
}
