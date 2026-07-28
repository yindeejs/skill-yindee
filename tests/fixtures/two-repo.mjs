// The stress-test fixture, shared by the tests and the benchmark so both
// measure the same repository.
//
// Repo A is a component library to be modernised; repo B is the reference
// design system it should be modernised against. This is the shape that
// produced multiple broad Explore agents in the field.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const write = (root, rel, content) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
};

export const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

export function commitAll(root) {
  if (!hasGit) return false;
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@e.st');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return true;
}

const component = (name) =>
  `import { spacing, radius } from '@kairo/tokens';\n\n` +
  `export type ${name}Props = { children?: unknown };\n\n` +
  `export const ${name} = (props: ${name}Props) => {\n` +
  `  const style = { padding: spacing.md, borderRadius: radius.sm };\n` +
  `  return null;\n};\n`;

/** Repo A: the component library being modernised. A pnpm workspace. */
export function makeComponentLibrary(root) {
  write(root, 'package.json', {
    name: 'kairo-ui-root', private: true, packageManager: 'pnpm@10.0.0',
    scripts: { lint: 'eslint .', typecheck: 'tsc -b', test: 'vitest run', build: 'tsc -b' },
  });
  write(root, 'pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n');
  write(root, 'tsconfig.json', { compilerOptions: { strict: true } });
  write(root, 'README.md', '# kairo-ui\n\nA component library.\n');
  write(root, '.github/workflows/ci.yml',
    'name: CI\non: [push]\njobs:\n  q:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run lint\n      - run: pnpm run test\n');

  write(root, 'packages/tokens/package.json', { name: '@kairo/tokens', main: 'src/index.ts' });
  write(root, 'packages/tokens/src/index.ts', 'export * from "./tokens";\nexport * from "./theme";\n');
  write(root, 'packages/tokens/src/tokens.ts', 'export const spacing = { sm: 4, md: 8, lg: 12 };\nexport const radius = { sm: 2, md: 4 };\nexport const shadow = { sm: "0 1px 2px #0002" };\n');
  write(root, 'packages/tokens/src/theme.ts', 'export const theme = { color: { fg: "#000", bg: "#fff" } };\n');

  write(root, 'packages/ui/package.json', {
    name: '@kairo/ui', main: 'src/index.tsx',
    dependencies: { '@kairo/tokens': 'workspace:*', react: '^18.0.0' },
  });
  write(root, 'packages/ui/tsconfig.json', { compilerOptions: {} });
  write(root, 'packages/ui/src/index.tsx',
    ['Button', 'Input', 'Modal', 'Stack', 'Toast'].map((c) => `export * from "./components/${c}";`).join('\n') + '\n');
  for (const c of ['Button', 'Input', 'Select', 'Checkbox', 'Modal', 'Tooltip']) {
    write(root, `packages/ui/src/components/${c}.tsx`, component(c));
    write(root, `packages/ui/src/components/${c}.test.tsx`, `import { ${c} } from './${c}';\nexport const t = ${c};\n`);
  }
  write(root, 'packages/ui/src/layout/Stack.tsx', component('Stack'));
  write(root, 'packages/ui/src/layout/Grid.tsx', component('Grid'));
  write(root, 'packages/ui/src/feedback/Toast.tsx', component('Toast'));
  write(root, 'packages/ui/src/feedback/Banner.tsx', component('Banner'));
  write(root, 'packages/ui/src/styles/reset.css', ':root { color: #000; }\n');

  write(root, 'packages/docs/package.json', {
    name: '@kairo/docs', dependencies: { '@kairo/ui': 'workspace:*' }, scripts: { dev: 'vite' },
  });
  write(root, 'packages/docs/src/index.tsx', 'export default function Docs() { return null; }\n');
  return commitAll(root);
}

/** Repo B: the reference design system. Never edited, only compared against. */
export function makeReferenceDesignSystem(root) {
  write(root, 'package.json', {
    name: 'nongmuek-ref', version: '2.0.0', main: 'src/index.ts', dependencies: { react: '^18.0.0' },
  });
  write(root, 'tsconfig.json', { compilerOptions: { strict: true } });
  write(root, 'README.md', '# nongmuek-ref\n\nReference design system.\n');
  write(root, 'src/index.ts', 'export * from "./tokens";\nexport * from "./theme";\n');
  write(root, 'src/tokens.ts', 'export const spacing = { sm: 8, md: 16, lg: 24 };\nexport const radius = { sm: 6, md: 10 };\nexport const shadow = { sm: "0 1px 3px #0003" };\n');
  write(root, 'src/theme.ts', 'export const theme = { color: { fg: "#111", bg: "#fafafa" } };\n');
  write(root, 'src/typography.ts', 'export const typography = { body: 16, heading: 24 };\n');
  for (const c of ['Button', 'Input', 'Card', 'Dialog']) {
    write(root, `src/components/${c}.tsx`, `export const ${c} = () => null;\n`);
  }
  return commitAll(root);
}
