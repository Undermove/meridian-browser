// Tool arguments come from a model or an MCP client. validateInput (src/agent/tools.js) must never
// throw, and anything it accepts must really match the tool's schema: only the tool's own fields,
// each with the declared type, every required field present.
const { FuzzedDataProvider } = require('@jazzer.js/core');
const { TOOLS, validateInput } = require('../src/agent/tools.js');

const typeOk = (spec, v) => ({
  string: typeof v === 'string', integer: Number.isInteger(v), number: typeof v === 'number', boolean: typeof v === 'boolean',
}[spec.type] ?? true) && (!spec.enum || spec.enum.includes(v));

// Field names: the tool's own, every other tool's, and whatever the fuzzer (and its dictionary) makes.
const KEYS = [...new Set(TOOLS.flatMap((t) => Object.keys(t.input_schema.properties || {})))];

function value(fdp, depth) {
  switch (fdp.consumeIntegralInRange(0, 7)) {
    case 0: return fdp.consumeString(fdp.consumeIntegralInRange(0, 64), 'utf-8');
    case 1: return fdp.consumeIntegral(4, true);
    case 2: return fdp.consumeNumber();
    case 3: return fdp.consumeBoolean();
    case 4: return null;
    case 5: return depth > 2 ? [] : Array.from({ length: fdp.consumeIntegralInRange(0, 3) }, () => value(fdp, depth + 1));
    case 6: return depth > 2 ? {} : object(fdp, depth + 1);
    default: return fdp.consumeBoolean() ? '' : undefined;
  }
}
function object(fdp, depth) {
  // Parsed from JSON text, the way it arrives: '__proto__' is then an own key, as JSON.parse makes it.
  const pairs = [];
  for (let n = fdp.consumeIntegralInRange(0, 6); n > 0 && fdp.remainingBytes; n--) {
    const key = fdp.consumeBoolean() ? KEYS[fdp.consumeIntegralInRange(0, KEYS.length - 1)] : fdp.consumeString(fdp.consumeIntegralInRange(0, 24), 'utf-8');
    pairs.push(`${JSON.stringify(key)}:${JSON.stringify(value(fdp, depth)) ?? 'null'}`);
  }
  return JSON.parse(`{${pairs.join(',')}}`);
}

module.exports.fuzz = function (data) {
  const fdp = new FuzzedDataProvider(data);
  const tool = TOOLS[fdp.consumeIntegralInRange(0, TOOLS.length - 1)];
  let input;
  if (fdp.consumeBoolean()) {
    try { input = JSON.parse(fdp.consumeRemainingAsString()); } catch { return; }
  } else input = object(fdp, 0);

  const err = validateInput(tool, input);
  if (err !== null && typeof err !== 'string') throw new Error(`validateInput returned ${typeof err}`);
  if (err !== null) return;

  const { properties = {}, required = [] } = tool.input_schema;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('accepted a non-object');
  for (const [key, value] of Object.entries(input)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) throw new Error(`${tool.name}: accepted unknown field ${JSON.stringify(key)}`);
    if (!typeOk(properties[key], value)) throw new Error(`${tool.name}: accepted ${key}=${JSON.stringify(value).slice(0, 80)}`);
  }
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(input, key)) throw new Error(`${tool.name}: accepted without ${key}`);
};
