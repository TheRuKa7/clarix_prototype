// The demo never listens on a port: the service worker calls the mock's handler directly.
export default { createServer: () => ({ listen() {} }) };
