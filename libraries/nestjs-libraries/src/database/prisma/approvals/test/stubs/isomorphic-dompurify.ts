// FORK: approvals. jsdom (pulled by isomorphic-dompurify) ships ESM that jest
// can't load. Only the DTO decorators use it, and the fork tests build bodies
// directly, so it is replaced in the fork tests only.
const DOMPurify = {
  sanitize: (value: string) => value,
  addHook: () => undefined,
  removeHook: () => undefined,
  setConfig: () => undefined,
};

export default DOMPurify;
