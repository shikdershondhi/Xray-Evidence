```markdown
# Xray-Evidence Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the Xray-Evidence JavaScript codebase. It covers file organization, import/export styles, commit message habits, and testing approaches. By following these guidelines, contributors can write code that is consistent, maintainable, and easy to review.

## Coding Conventions

### File Naming
- **Style:** kebab-case
- **Example:**  
  ```text
  evidence-processor.js
  data-utils.js
  ```

### Import Style
- **Style:** Relative imports
- **Example:**
  ```javascript
  import { processEvidence } from './evidence-processor.js';
  import { formatData } from '../utils/data-utils.js';
  ```

### Export Style
- **Style:** Named exports
- **Example:**
  ```javascript
  // evidence-processor.js
  export function processEvidence(evidence) {
    // ...
  }
  ```

### Commit Messages
- **Type:** Freeform (no enforced prefixes)
- **Average Length:** ~68 characters
- **Example:**
  ```
  Fix bug in evidence parser when handling empty input arrays
  ```

## Workflows

### Adding a New Feature
**Trigger:** When implementing a new functionality  
**Command:** `/add-feature`

1. Create a new JavaScript file using kebab-case.
2. Write your feature using named exports.
3. Use relative imports to include dependencies.
4. Add or update relevant `.test.js` files to cover the new feature.
5. Commit your changes with a clear, descriptive message.

### Fixing a Bug
**Trigger:** When resolving a reported issue or bug  
**Command:** `/fix-bug`

1. Identify the source of the bug in the codebase.
2. Make changes in the appropriate kebab-case file.
3. Update or add test cases in the corresponding `.test.js` file.
4. Commit with a descriptive message explaining the fix.

### Writing and Running Tests
**Trigger:** When validating code changes  
**Command:** `/run-tests`

1. Create or update test files using the `*.test.js` pattern.
2. Write tests for your functions and modules.
3. Run tests using the project's preferred test runner (framework not specified; check project documentation or package.json).
4. Ensure all tests pass before committing.

## Testing Patterns

- **Test File Naming:**  
  Use the `*.test.js` pattern, e.g., `evidence-processor.test.js`.
- **Framework:**  
  Not specified; check the project for details.
- **Example:**
  ```javascript
  // evidence-processor.test.js
  import { processEvidence } from './evidence-processor.js';

  test('processEvidence returns correct result for valid input', () => {
    const input = [/* ... */];
    const result = processEvidence(input);
    expect(result).toEqual(/* expected output */);
  });
  ```

## Commands
| Command       | Purpose                                   |
|---------------|-------------------------------------------|
| /add-feature  | Scaffold and document a new feature       |
| /fix-bug      | Guide through the bugfix workflow         |
| /run-tests    | Instructions for writing and running tests|
```
