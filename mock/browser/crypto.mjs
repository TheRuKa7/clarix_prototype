import { Buffer } from 'buffer';
export const randomBytes = (n) => Buffer.from(crypto.getRandomValues(new Uint8Array(n)));
