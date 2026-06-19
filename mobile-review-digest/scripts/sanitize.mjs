// Turn a git branch name into a single safe directory key.
export function sanitizeBranch(branch) {
  return String(branch)
    .trim()
    .replace(/[\/\\\s]+/g, '__')        // path separators + whitespace runs -> __
    .replace(/[^A-Za-z0-9._-]+/g, '')   // drop anything else
    .replace(/_{3,}/g, '__')            // collapse over-long underscore runs
    .replace(/^_+|_+$/g, '');           // trim leading/trailing underscores
}
