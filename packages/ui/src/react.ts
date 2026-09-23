/**
 * React entry point.
 *
 * Kept separate from the package root so a non-browser consumer (the API, a
 * worker, a CLI) can import the state model without pulling in React.
 *
 * The state model is re-exported here too: a component and the mapping it
 * renders from should not have to be imported from two different specifiers.
 */
export * from "./index.js";
export * from "./react/index.js";
