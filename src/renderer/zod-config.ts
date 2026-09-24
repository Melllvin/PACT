import { config } from 'zod';

// Imported first by main.tsx, before any schema is defined. The strict CSP forbids eval: stop zod
// from probing `new Function` for its JIT (Chromium logs that as a CSP violation) and use its
// interpreter instead.
config({ jitless: true });
