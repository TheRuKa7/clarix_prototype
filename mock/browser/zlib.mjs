import { deflateSync, inflateSync } from 'fflate';
import { Buffer } from 'buffer';
export const deflateRawSync = (b) => Buffer.from(deflateSync(new Uint8Array(b)));
export const inflateRawSync = (b) => Buffer.from(inflateSync(new Uint8Array(b)));
