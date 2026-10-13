import { randomBytes } from 'crypto';

export function createId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}
