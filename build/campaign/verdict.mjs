// Cell verdict rules shared by the cross engine (tests/campaign/cross-lib.js) and triage.mjs.

/** Messages that betray an unhandled exception rather than a reason given to the user. */
export const JS_EXCEPTION = /Cannot read propert|is not a function|is not defined|is not iterable|\bundefined\b|\bnull\b|\bNaN\b|TypeError|RangeError|ReferenceError|SyntaxError|Maximum call stack|out of memory|Unexpected token|Invalid array length|\bat \S+ \(/;

/** Errors that are only error toasts worded for the user (no console or page error): a named refusal. */
export const isRefusal = (errors) => errors.length > 0 && errors.every((e) => e.startsWith('toast-error') && !JS_EXCEPTION.test(e));
