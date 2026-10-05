// The mock reads scenario.json once at start; the demo bundle embeds it instead.
import scenario from '../scenario.json';
export const readFileSync = () => JSON.stringify(scenario);
export default { readFileSync };
