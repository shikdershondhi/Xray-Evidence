---
name: xray-evidence
description: Project-specific development guidance for the Xray-Evidence repository. Use when working in this repo to follow its JavaScript file conventions, testing patterns, Gist sync behavior, workflow automation structure, and local validation commands.
---

# Xray-Evidence Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the Xray-Evidence JavaScript codebase. You'll learn about file naming, import/export styles, commit message practices, and how to write and organize tests. This guide is designed to help contributors maintain consistency and quality in the project.

## Coding Conventions

### File Naming
- **Style:** kebab-case
- **Example:**  
  ```
  evidence-processor.js
  data-loader.test.js
  ```

### Import Style
- **Style:** Relative imports
- **Example:**  
  ```js
  import { processEvidence } from './evidence-processor.js';
  ```

### Export Style
- **Style:** Named exports
- **Example:**  
  ```js
  // evidence-processor.js
  export function processEvidence(data) {
    // ...
  }
  ```

### Commit Messages
- **Style:** Freeform, no strict prefixes
- **Average Length:** ~68 characters
- **Example:**  
  ```
  Add initial implementation of evidence data loader
  Fix bug in evidence validation logic
  ```

## Workflows

### Adding a New Feature
**Trigger:** When implementing a new capability or module  
**Command:** `/add-feature`

1. Create a new file using kebab-case (e.g., `new-feature.js`).
2. Use relative imports to include dependencies.
3. Export functions or objects using named exports.
4. Write corresponding test files as `new-feature.test.js`.
5. Commit changes with a clear, descriptive message.

### Fixing a Bug
**Trigger:** When resolving a defect or issue  
**Command:** `/fix-bug`

1. Locate the relevant file(s) and make necessary corrections.
2. Update or add tests in `*.test.js` files to cover the fix.
3. Commit with a message describing the fix.

### Writing and Running Tests
**Trigger:** When adding or updating tests  
**Command:** `/run-tests`

1. Write test files using the pattern `*.test.js`.
2. Place test files alongside or near the code they test.
3. Use the project's preferred (unknown) test runner to execute tests.

## Testing Patterns

- **Test File Naming:**  
  Use `*.test.js` (e.g., `evidence-processor.test.js`)
- **Placement:**  
  Test files are typically located near the source files.
- **Framework:**  
  Not explicitly detected; follow existing patterns or consult maintainers.

**Example:**
```js
// evidence-processor.test.js
import { processEvidence } from './evidence-processor.js';

test('processEvidence returns expected result', () => {
  // ...test implementation
});
```

## Commands
| Command      | Purpose                                      |
|--------------|----------------------------------------------|
| /add-feature | Start the workflow for adding a new feature  |
| /fix-bug     | Start the workflow for fixing a bug          |
| /run-tests   | Run all test files in the codebase           |
