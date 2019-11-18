'use strict';

module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
  },
  plugins: [
    "jsdoc",
    "promise",
    "security",
    '@typescript-eslint'
  ],
  extends: [
    'eslint:recommended',
    'airbnb-base',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/typescript',
  ],
  env: {
    browser: true,
  },
  rules: {
    "curly": ["error", "all"],
    "callback-return": ["error", ["callback", "cb", "next", "done"]],
    "class-methods-use-this": "off",
    "consistent-return": "off",
    "handle-callback-err": ["error", "^.*err"],
    "new-cap": "off",
    "no-console": "error",
    "no-else-return": "error",
    "no-eq-null": "off",
    "no-global-assign": "error",
    "no-loop-func": "off",
    "no-lone-blocks": "error",
    "no-negated-condition": "error",
    "no-shadow": "off",
    "no-template-curly-in-string": "error",
    "no-undef": "error",
    "no-underscore-dangle": "off",
    "no-unsafe-negation": "error",
    "no-use-before-define": "off",
    "no-useless-rename": "error",
    "padding-line-between-statements": ["error",
      {
        "blankLine": "always", "prev": [
          "directive",
          "block",
          "block-like",
          "multiline-block-like",
          "cjs-export",
          "cjs-import",
          "class",
          "export",
          "import",
          "if"
        ], "next": "*"
      },
      {"blankLine": "never", "prev": "directive", "next": "directive"},
      {"blankLine": "any", "prev": "*", "next": ["if", "for", "cjs-import", "import"]},
      {"blankLine": "any", "prev": ["export", "import"], "next": ["export", "import"]},
      {"blankLine": "always", "prev": "*", "next": ["try", "function", "switch"]},
      {"blankLine": "always", "prev": "if", "next": "if"},
      {"blankLine": "never", "prev": ["return", "throw"], "next": "*"}
    ],
    "strict": ["error", "safe"],
    "no-empty": "error",
    "no-empty-function": "error",
    "valid-jsdoc": "off",
    "yoda": "error",

    "import/no-unresolved": "off",
    'import/prefer-default-export': 'off',
    'import/no-extraneous-dependencies': 'off',

    "jsdoc/check-alignment": "error",
    "jsdoc/check-indentation": "off",
    "jsdoc/check-param-names": "off",
    "jsdoc/check-tag-names": "error",
    "jsdoc/check-types": "error",
    "jsdoc/newline-after-description": "off",
    "jsdoc/no-undefined-types": "off",
    "jsdoc/require-description": "off",
    "jsdoc/require-description-complete-sentence": "off",
    "jsdoc/require-example": "off",
    "jsdoc/require-hyphen-before-param-description": "error",
    "jsdoc/require-param": "error",
    "jsdoc/require-param-description": "off",
    "jsdoc/require-param-name": "error",
    "jsdoc/require-param-type": "error",
    "jsdoc/require-returns-description": "off",
    "jsdoc/require-returns-type": "error",
    "jsdoc/valid-types": "error",

    "security/detect-buffer-noassert": "error",
    "security/detect-child-process": "error",
    "security/detect-disable-mustache-escape": "error",
    "security/detect-eval-with-expression": "error",
    "security/detect-new-buffer": "error",
    "security/detect-no-csrf-before-method-override": "error",
    "security/detect-non-literal-fs-filename": "error",
    "security/detect-non-literal-regexp": "error",
    "security/detect-non-literal-require": "off",
    "security/detect-object-injection": "off",
    "security/detect-possible-timing-attacks": "error",
    "security/detect-pseudoRandomBytes": "error",
    "security/detect-unsafe-regex": "error",

    // Override airbnb
    "eqeqeq": ["error", "smart"],
    "func-names": "error",
    "id-length": ["error", {"exceptions": ["_", "$", "e", "i", "j", "k", "q", "x", "y"]}],
    'indent': 'off',
    "no-param-reassign": "off", // Work toward enforcing this rule
    "radix": "off",
    "spaced-comment": "off",
    "max-len": "off",
    "no-continue": "off",
    'no-dupe-class-members': 'off',
    "no-plusplus": "off",
    "no-prototype-builtins": "off",
    "no-restricted-syntax": [
      "error",
      "DebuggerStatement",
      "LabeledStatement",
      "WithStatement"
    ],
    "no-restricted-properties": ["error", {
      "object": "arguments",
      "property": "callee",
      "message": "arguments.callee is deprecated"
    }, {
      "property": "__defineGetter__",
      "message": "Please use Object.defineProperty instead."
    }, {
      "property": "__defineSetter__",
      "message": "Please use Object.defineProperty instead."
    }],
    'no-useless-constructor': 'off',
    "no-useless-escape": "off",
    "object-shorthand": ["error", "always", {
      "ignoreConstructors": false,
      "avoidQuotes": true,
      "avoidExplicitReturnArrows": true
    }],
    "prefer-spread": "error",
    "prefer-destructuring": "off",

    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/ban-ts-ignore': 'off',
    '@typescript-eslint/no-extraneous-class': 'error',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-member-accessibility': ["error"],
    '@typescript-eslint/interface-name-prefix': ['error', 'never'],
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-for-in-array': 'error',
    '@typescript-eslint/no-require-imports': 'error',
    '@typescript-eslint/no-this-alias': 'error',
    '@typescript-eslint/no-useless-constructor': 'error',
    '@typescript-eslint/no-unused-vars': 'error',
    '@typescript-eslint/prefer-for-of': 'error',
    '@typescript-eslint/prefer-includes': 'error',
    '@typescript-eslint/prefer-string-starts-ends-with': 'error',
    '@typescript-eslint/promise-function-async': 'off',
    '@typescript-eslint/restrict-plus-operands': 'error',

    // Special to this project
    'max-classes-per-file': 'off',
    '@typescript-eslint/max-classes-per-file': 'off',
  },
};
