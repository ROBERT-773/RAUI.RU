'use client';
import { SignInByCode, type EmailCodeSignInProps } from './phone-sign-in';

export default function EmailCodeSignIn<T>(props: EmailCodeSignInProps<T>) {
  return <SignInByCode {...props} channel="email" />;
}
