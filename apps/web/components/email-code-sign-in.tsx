'use client';
import { SignInByCode, type SessionSignInProps } from './phone-sign-in';

export default function EmailCodeSignIn<T>(props: SessionSignInProps<T>) {
  return <SignInByCode {...props} channel="email" />;
}
