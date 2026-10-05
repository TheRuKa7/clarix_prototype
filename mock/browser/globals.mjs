// Injected first into the demo service worker bundle: the Node globals the mock expects.
import { Buffer } from 'buffer';
export const process = { env: {} };
export { Buffer };
