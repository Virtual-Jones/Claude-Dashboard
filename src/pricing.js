// Anthropic API list prices, per 1M tokens (USD).
// Source: claude-api skill reference (cached 2026-06-24).
//
// These rates are used ONLY to estimate the dollar-equivalent "value" of your
// subscription usage. A Claude Max plan is a flat monthly fee, so this figure is
// what the same tokens would have cost at pay-as-you-go API rates -- a fun way to
// see how much value you're getting out of the subscription. It is not a bill.
//
// Cache pricing follows Anthropic's multipliers relative to input price:
//   5-minute cache write : 1.25x input
//   1-hour   cache write : 2.00x input
//   cache read           : 0.10x input

const MTOK = 1_000_000;

const MODEL_PRICES = {
  // Opus tier
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  // Sonnet tier
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  // Haiku tier
  'claude-haiku-4-5': { input: 1, output: 5 },
  // Fable (creative) -- public API price not documented yet; Sonnet-tier estimate.
  'claude-fable-5': { input: 3, output: 15 },
};

const DEFAULT_PRICE = { input: 5, output: 25 }; // assume Opus-tier when unknown

function priceFor(model) {
  if (!model) return DEFAULT_PRICE;
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  // Log ids often carry a date suffix (claude-sonnet-4-5-20250929); match by family.
  const m = String(model).toLowerCase();
  if (m.includes('opus')) return { input: 5, output: 25 };
  if (m.includes('sonnet')) return { input: 3, output: 15 };
  if (m.includes('haiku')) return { input: 1, output: 5 };
  if (m.includes('fable')) return { input: 3, output: 15 }; // estimate; see MODEL_PRICES
  return DEFAULT_PRICE;
}

// USD cost of a single normalized usage record.
// record fields: input, output, cacheCreate5m, cacheCreate1h, cacheCreate (combined), cacheRead
function costOf(model, r) {
  const p = priceFor(model);
  const write5m = p.input * 1.25;
  const write1h = p.input * 2;
  const read = p.input * 0.1;

  const c5 = r.cacheCreate5m || 0;
  const c1h = r.cacheCreate1h || 0;
  // If the 5m/1h split is absent but a combined figure exists, price it as 5m.
  const combined = c5 + c1h > 0 ? 0 : r.cacheCreate || 0;

  return (
    (r.input || 0) * p.input +
    (r.output || 0) * p.output +
    c5 * write5m +
    c1h * write1h +
    combined * write5m +
    (r.cacheRead || 0) * read
  ) / MTOK;
}

module.exports = { MODEL_PRICES, priceFor, costOf };
