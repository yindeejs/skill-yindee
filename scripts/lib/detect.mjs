// Deterministic project detection: stacks, package manager, workspace layout,
// package graph, verification commands, CI and project docs.
// Nothing here asks an LLM anything, and nothing walks the whole repository.
import path from 'node:path';
import { exists, readJson, readText, listDir, collectFiles, walk, IGNORE_DIRS } from './fsx.mjs';
import { parseToml } from './toml.mjs';
import { toPosix, uniq, matchGlob } from './util.mjs';

const j = (root, ...p) => readJson(path.join(root, ...p));
const t = (root, ...p) => readText(path.join(root, ...p));
const has = (root, ...p) => exists(path.join(root, ...p));

// ---------------------------------------------------------------- stacks ---

const STACK_MARKERS = [
  ['node', ['package.json']],
  ['deno', ['deno.json', 'deno.jsonc']],
  ['rust', ['Cargo.toml']],
  // A workspace root often carries only go.work, with no go.mod of its own.
  ['go', ['go.mod', 'go.work']],
  ['python', ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile']],
  ['ruby', ['Gemfile', '*.gemspec']],
  ['php', ['composer.json']],
  ['java', ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']],
  ['dotnet', ['*.sln', '*.csproj', '*.fsproj']],
  ['elixir', ['mix.exs']],
  ['dart', ['pubspec.yaml']],
  ['swift', ['Package.swift']],
];

function stacksAt(dir) {
  const names = listDir(dir).filter((e) => e.isFile()).map((e) => e.name);
  const out = [];
  for (const [stack, markers] of STACK_MARKERS) {
    if (markers.some((m) => (m.includes('*') ? names.some((n) => matchGlob(n, m)) : names.includes(m)))) {
      out.push(stack);
    }
  }
  return out;
}

// ------------------------------------------------------ package managers ---

function detectPackageManager(root, stacks) {
  if (stacks.includes('node')) {
    const pkg = j(root, 'package.json') || {};
    const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null;
    if (declared) return declared;
    if (has(root, 'pnpm-lock.yaml')) return 'pnpm';
    if (has(root, 'bun.lockb') || has(root, 'bun.lock')) return 'bun';
    if (has(root, 'yarn.lock')) return 'yarn';
    if (has(root, 'package-lock.json')) return 'npm';
    return 'npm';
  }
  if (stacks.includes('deno')) return 'deno';
  if (stacks.includes('rust')) return 'cargo';
  if (stacks.includes('go')) return 'go';
  if (stacks.includes('python')) {
    if (has(root, 'uv.lock')) return 'uv';
    if (has(root, 'poetry.lock')) return 'poetry';
    if (has(root, 'Pipfile')) return 'pipenv';
    return 'pip';
  }
  if (stacks.includes('ruby')) return 'bundler';
  if (stacks.includes('php')) return 'composer';
  if (stacks.includes('java')) return has(root, 'pom.xml') ? 'maven' : 'gradle';
  if (stacks.includes('dotnet')) return 'dotnet';
  if (stacks.includes('elixir')) return 'mix';
  if (stacks.includes('dart')) return 'pub';
  return 'unknown';
}

// -------------------------------------------------------- workspace globs ---

/** pnpm-workspace.yaml has exactly one shape we care about; no YAML dep needed. */
function pnpmWorkspaceGlobs(root) {
  const src = t(root, 'pnpm-workspace.yaml') || t(root, 'pnpm-workspace.yml');
  if (!src) return [];
  const out = [];
  let inPackages = false;
  for (const line of src.split(/\r?\n/)) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/);
      if (m) out.push(m[1].trim());
      else if (/^\S/.test(line)) inPackages = false;
    }
  }
  return out;
}

function workspaceGlobs(root, stacks) {
  const globs = [];
  let tool = null;

  if (stacks.includes('node')) {
    const pkg = j(root, 'package.json') || {};
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
    if (Array.isArray(ws)) {
      globs.push(...ws);
      tool = 'npm-workspaces';
    }
    const pnpmGlobs = pnpmWorkspaceGlobs(root);
    if (pnpmGlobs.length) {
      globs.push(...pnpmGlobs);
      tool = 'pnpm-workspaces';
    }
    const lerna = j(root, 'lerna.json');
    if (lerna?.packages) {
      globs.push(...lerna.packages);
      tool = tool || 'lerna';
    }
    if (has(root, 'turbo.json')) tool = 'turbo';
    if (has(root, 'nx.json')) tool = 'nx';
    if ((tool === 'turbo' || tool === 'nx') && !globs.length) {
      globs.push('apps/*', 'packages/*', 'libs/*', 'services/*');
    }
  }

  if (stacks.includes('rust')) {
    const cargo = parseToml(t(root, 'Cargo.toml') || '');
    const members = cargo?.workspace?.members;
    if (Array.isArray(members) && members.length) {
      globs.push(...members);
      tool = tool || 'cargo-workspace';
    }
  }

  if (stacks.includes('go')) {
    const work = t(root, 'go.work');
    if (work) {
      const m = work.match(/use\s*\(([\s\S]*?)\)/);
      const entries = m
        ? m[1].split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        : (work.match(/^use\s+(\S+)/gm) || []).map((l) => l.replace(/^use\s+/, ''));
      globs.push(...entries.map((e) => e.replace(/^\.\//, '')));
      tool = tool || 'go-work';
    }
  }

  if (stacks.includes('python')) {
    const py = parseToml(t(root, 'pyproject.toml') || '');
    const members = py?.tool?.uv?.workspace?.members || py?.tool?.rye?.workspace?.members;
    if (Array.isArray(members) && members.length) {
      globs.push(...members);
      tool = tool || 'uv-workspace';
    }
  }

  if (stacks.includes('dotnet')) {
    const sln = listDir(root).find((e) => e.isFile() && e.name.endsWith('.sln'));
    if (sln) {
      const src = t(root, sln.name) || '';
      for (const m of src.matchAll(/"([^"]+\.(?:cs|fs|vb)proj)"/g)) {
        globs.push(toPosix(path.dirname(m[1])));
      }
      tool = tool || 'dotnet-sln';
    }
  }

  return { globs: uniq(globs.map((g) => toPosix(g).replace(/\/$/, ''))), tool };
}

/** Expand workspace globs to directories that actually carry a manifest. */
function expandGlobs(root, globs) {
  const dirs = new Set();
  const literals = globs.filter((g) => !/[*?{[]/.test(g));
  const patterns = globs.filter((g) => /[*?{[]/.test(g));

  for (const lit of literals) {
    if (exists(path.join(root, lit))) dirs.add(lit);
  }

  if (patterns.length) {
    // Only descend as deep as the deepest pattern needs.
    const maxDepth = Math.max(...patterns.map((p) => p.split('/').length)) + 1;
    walk(root, {
      maxDepth,
      maxEntries: 60_000,
      includeDirs: true,
      onFile: (rel, isDir) => {
        if (!isDir) return;
        if (patterns.some((p) => matchGlob(rel, p))) dirs.add(rel);
      },
    });
  }
  return [...dirs].filter((d) => stacksAt(path.join(root, d)).length > 0);
}

// ------------------------------------------------------------- packages ---

function packageAt(root, rel) {
  const abs = rel ? path.join(root, rel) : root;
  const stacks = stacksAt(abs);
  if (!stacks.length) return null;
  const stack = stacks[0];
  const p = { path: toPosix(rel || '.'), stack, name: null, kind: 'lib', manifest: null, deps: [], scripts: {} };

  if (stacks.includes('node')) {
    const pkg = readJson(path.join(abs, 'package.json')) || {};
    p.stack = 'node';
    p.name = pkg.name || path.basename(abs);
    p.manifest = p.path === '.' ? 'package.json' : `${p.path}/package.json`;
    p.scripts = pkg.scripts || {};
    p.private = !!pkg.private;
    p.rawDeps = uniq([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
      ...Object.keys(pkg.peerDependencies || {}),
    ]);
    const deployable = /^(apps|services)\//.test(p.path) || !!pkg.scripts?.dev || !!pkg.scripts?.start;
    p.kind = deployable ? 'app' : pkg.bin ? 'bin' : 'lib';
    if (pkg.dependencies?.next || pkg.dependencies?.react || pkg.dependencies?.vue || pkg.dependencies?.svelte) {
      p.hint = 'frontend';
    }
    p.typescript = exists(path.join(abs, 'tsconfig.json'));
  } else if (stacks.includes('rust')) {
    const cargo = parseToml(readText(path.join(abs, 'Cargo.toml')) || '');
    p.stack = 'rust';
    p.name = cargo?.package?.name || path.basename(abs);
    p.manifest = p.path === '.' ? 'Cargo.toml' : `${p.path}/Cargo.toml`;
    p.rawDeps = uniq([
      ...Object.keys(cargo?.dependencies || {}),
      ...Object.keys(cargo?.['dev-dependencies'] || {}),
      ...Object.keys(cargo?.['build-dependencies'] || {}),
    ]);
    p.kind = exists(path.join(abs, 'src/main.rs')) ? 'bin' : 'lib';
  } else if (stacks.includes('python')) {
    const py = parseToml(readText(path.join(abs, 'pyproject.toml')) || '');
    p.stack = 'python';
    p.name = py?.project?.name || py?.tool?.poetry?.name || path.basename(abs);
    p.manifest = exists(path.join(abs, 'pyproject.toml'))
      ? p.path === '.' ? 'pyproject.toml' : `${p.path}/pyproject.toml`
      : p.path === '.' ? 'requirements.txt' : `${p.path}/requirements.txt`;
    const deps = py?.project?.dependencies || [];
    p.rawDeps = Array.isArray(deps) ? deps.map((d) => String(d).split(/[<>=!~ \[]/)[0]).filter(Boolean) : [];
  } else if (stacks.includes('go')) {
    const mod = readText(path.join(abs, 'go.mod')) || '';
    p.stack = 'go';
    p.name = (mod.match(/^module\s+(\S+)/m) || [])[1] || path.basename(abs);
    p.manifest = p.path === '.' ? 'go.mod' : `${p.path}/go.mod`;
    p.kind = exists(path.join(abs, 'main.go')) || exists(path.join(abs, 'cmd')) ? 'bin' : 'lib';
    // Both `require (` blocks and single-line `require x v1`.
    p.rawDeps = uniq([...mod.matchAll(/^\s*(?:require\s+)?([\w.\-~/]+\.[\w.\-~/]+)\s+v\d/gm)].map((m) => m[1]));
  } else {
    p.stack = stack;
    p.name = path.basename(abs);
    const names = listDir(abs).filter((e) => e.isFile()).map((e) => e.name);
    p.manifest = names.find((n) => /\.(sln|csproj|fsproj)$|^(pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|mix\.exs|pubspec\.yaml|Package\.swift|deno\.jsonc?)$/.test(n));
    if (p.manifest && p.path !== '.') p.manifest = `${p.path}/${p.manifest}`;
    p.rawDeps = [];
  }

  return p;
}

function testPathsFor(root, pkg) {
  const base = pkg.path === '.' ? root : path.join(root, pkg.path);
  const candidates = ['tests', 'test', '__tests__', 'spec', 'e2e', 'benches', 'benchmarks'];
  const found = candidates.filter((c) => exists(path.join(base, c))).map((c) => (pkg.path === '.' ? c : `${pkg.path}/${c}`));
  return found;
}

// ------------------------------------------------------------ commands ---

const SCRIPT_ALIASES = {
  fmtCheck: ['format:check', 'fmt:check', 'prettier:check', 'format:ci', 'check:format'],
  fmt: ['format', 'fmt', 'prettier'],
  lint: ['lint', 'lint:check', 'eslint', 'check:lint'],
  typecheck: ['typecheck', 'type-check', 'types', 'check-types', 'tsc', 'check:types'],
  test: ['test', 'test:unit', 'tests', 'test:ci'],
  build: ['build', 'compile'],
};

const pickScript = (scripts, key) => (SCRIPT_ALIASES[key] || []).find((n) => scripts && scripts[n]) || null;

function nodeRunners(pm) {
  switch (pm) {
    case 'pnpm':
      return { root: (s) => `pnpm run ${s}`, pkg: (s, p) => `pnpm --filter ${p} run ${s}` };
    case 'yarn':
      return { root: (s) => `yarn ${s}`, pkg: (s, p) => `yarn workspace ${p} run ${s}` };
    case 'bun':
      return { root: (s) => `bun run ${s}`, pkg: (s, p) => `bun run --filter ${p} ${s}` };
    default:
      return { root: (s) => `npm run ${s}`, pkg: (s, p) => `npm run ${s} --workspace ${p}` };
  }
}

function nodeCommands(root, pm, monorepoTool, rootPkg) {
  const scripts = rootPkg?.scripts || {};
  const run = nodeRunners(pm);
  const cmds = {};
  const affected = {};

  for (const key of ['fmtCheck', 'fmt', 'lint', 'typecheck', 'test', 'build']) {
    const s = pickScript(scripts, key);
    if (s) cmds[key] = run.root(s);
  }
  if (!cmds.typecheck && exists(path.join(root, 'tsconfig.json'))) {
    cmds.typecheck = `${pm === 'npm' ? 'npx' : pm === 'yarn' ? 'yarn' : pm === 'bun' ? 'bunx' : 'pnpm exec'} tsc --noEmit`;
  }

  // Scoped forms: `{pkg}` is substituted by the verifier.
  for (const key of ['lint', 'typecheck', 'test', 'build']) {
    const s = pickScript(scripts, key) || key;
    cmds[`${key}Pkg`] = run.pkg(s, '{pkg}');
  }

  if (monorepoTool === 'turbo') {
    const exec = pm === 'npm' ? 'npx turbo' : `${pm} turbo`;
    for (const key of ['lint', 'typecheck', 'test', 'build']) {
      const task = pickScript(scripts, key) || key;
      cmds[`${key}Pkg`] = `${exec} run ${task} --filter={pkg}`;
      affected[key] = `${exec} run ${task} --filter=...[{base}]`;
    }
  } else if (monorepoTool === 'nx') {
    const exec = pm === 'npm' ? 'npx nx' : `${pm} nx`;
    for (const key of ['lint', 'typecheck', 'test', 'build']) {
      const task = key === 'typecheck' ? 'typecheck' : key;
      cmds[`${key}Pkg`] = `${exec} run {pkg}:${task}`;
      affected[key] = `${exec} affected -t ${task} --base={base}`;
    }
  }

  cmds.install = { pnpm: 'pnpm install --frozen-lockfile', yarn: 'yarn install --immutable', bun: 'bun install --frozen-lockfile' }[pm] || 'npm ci';
  return { cmds, affected: Object.keys(affected).length ? affected : null };
}

function stackCommands(root, stack, pm) {
  switch (stack) {
    case 'rust':
      return {
        install: 'cargo fetch',
        fmtCheck: 'cargo fmt --all -- --check',
        fmt: 'cargo fmt --all',
        lint: 'cargo clippy --workspace --all-targets -- -D warnings',
        lintPkg: 'cargo clippy -p {pkg} --all-targets -- -D warnings',
        typecheck: 'cargo check --workspace --all-targets',
        typecheckPkg: 'cargo check -p {pkg} --all-targets',
        test: 'cargo test --workspace',
        testPkg: 'cargo test -p {pkg}',
        build: 'cargo build --workspace',
        buildPkg: 'cargo build -p {pkg}',
      };
    case 'go':
      return {
        install: 'go mod download',
        fmtCheck: 'gofmt -l .',
        fmt: 'gofmt -w .',
        lint: exists(path.join(root, '.golangci.yml')) || exists(path.join(root, '.golangci.yaml'))
          ? 'golangci-lint run ./...'
          : 'go vet ./...',
        lintPkg: 'go vet ./{path}/...',
        typecheck: 'go build ./...',
        test: 'go test ./...',
        testPkg: 'go test ./{path}/...',
        build: 'go build ./...',
      };
    case 'python': {
      const py = parseToml(readText(path.join(root, 'pyproject.toml')) || '');
      const tools = py?.tool || {};
      const hasRuff = !!tools.ruff || exists(path.join(root, 'ruff.toml')) || exists(path.join(root, '.ruff.toml'));
      const hasBlack = !!tools.black;
      const hasMypy = !!tools.mypy || exists(path.join(root, 'mypy.ini'));
      const hasPyright = !!tools.pyright || exists(path.join(root, 'pyrightconfig.json'));
      const prefix = pm === 'uv' ? 'uv run ' : pm === 'poetry' ? 'poetry run ' : pm === 'pipenv' ? 'pipenv run ' : '';
      const c = { install: pm === 'uv' ? 'uv sync' : pm === 'poetry' ? 'poetry install' : 'pip install -r requirements.txt' };
      if (hasRuff) {
        c.fmtCheck = `${prefix}ruff format --check .`;
        c.fmt = `${prefix}ruff format .`;
        c.lint = `${prefix}ruff check .`;
        c.lintPkg = `${prefix}ruff check {path}`;
      } else if (hasBlack) {
        c.fmtCheck = `${prefix}black --check .`;
        c.fmt = `${prefix}black .`;
      }
      if (hasMypy) {
        c.typecheck = `${prefix}mypy .`;
        c.typecheckPkg = `${prefix}mypy {path}`;
      } else if (hasPyright) {
        c.typecheck = `${prefix}pyright`;
      }
      c.test = `${prefix}pytest -q`;
      c.testPkg = `${prefix}pytest -q {path}`;
      return c;
    }
    case 'ruby':
      return {
        install: 'bundle install',
        lint: 'bundle exec rubocop',
        lintPkg: 'bundle exec rubocop {path}',
        test: exists(path.join(root, 'spec')) ? 'bundle exec rspec' : 'bundle exec rake test',
        testPkg: 'bundle exec rspec {path}',
      };
    case 'php':
      return {
        install: 'composer install --no-interaction',
        lint: 'composer run-script lint',
        test: 'vendor/bin/phpunit',
        testPkg: 'vendor/bin/phpunit {path}',
      };
    case 'java':
      return pm === 'maven'
        ? { install: 'mvn -q -B dependency:go-offline', lint: 'mvn -q -B checkstyle:check', test: 'mvn -q -B test', build: 'mvn -q -B package -DskipTests' }
        : { install: './gradlew dependencies', lint: './gradlew check -x test', test: './gradlew test', build: './gradlew build -x test' };
    case 'dotnet':
      return {
        install: 'dotnet restore',
        fmtCheck: 'dotnet format --verify-no-changes',
        fmt: 'dotnet format',
        build: 'dotnet build --nologo',
        buildPkg: 'dotnet build {path} --nologo',
        test: 'dotnet test --nologo',
        testPkg: 'dotnet test {path} --nologo',
      };
    case 'elixir':
      return { install: 'mix deps.get', fmtCheck: 'mix format --check-formatted', fmt: 'mix format', lint: 'mix credo --strict', test: 'mix test', testPkg: 'mix test {path}' };
    case 'dart':
      return { install: 'dart pub get', fmtCheck: 'dart format --output=none --set-exit-if-changed .', lint: 'dart analyze', test: 'dart test', testPkg: 'dart test {path}' };
    case 'deno':
      return { fmtCheck: 'deno fmt --check', fmt: 'deno fmt', lint: 'deno lint', typecheck: 'deno check .', test: 'deno test -A', testPkg: 'deno test -A {path}' };
    case 'swift':
      return { build: 'swift build', test: 'swift test' };
    default:
      return {};
  }
}

// ------------------------------------------------------------------- CI ---

function detectCI(root) {
  const out = { provider: null, files: [], jobs: [], commands: [] };
  const wfDir = path.join(root, '.github', 'workflows');
  if (exists(wfDir)) {
    out.provider = 'github-actions';
    for (const e of listDir(wfDir)) {
      if (!e.isFile() || !/\.ya?ml$/.test(e.name)) continue;
      out.files.push(`.github/workflows/${e.name}`);
      const src = readText(path.join(wfDir, e.name)) || '';
      const jobsIdx = src.search(/^jobs:\s*$/m);
      if (jobsIdx !== -1) {
        for (const m of src.slice(jobsIdx).matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)) out.jobs.push(m[1]);
      }
      // Both `run:` and `- run:` step forms.
      for (const m of src.matchAll(/^\s*(?:-\s*)?run:\s*(?!\|)(.+)$/gm)) {
        const cmd = m[1].trim().replace(/^["']|["']$/g, '');
        if (cmd && !cmd.startsWith('sudo ') && cmd.length < 200) out.commands.push(cmd);
      }
    }
  } else if (exists(path.join(root, '.gitlab-ci.yml'))) {
    out.provider = 'gitlab-ci';
    out.files.push('.gitlab-ci.yml');
  } else if (exists(path.join(root, '.circleci'))) {
    out.provider = 'circleci';
    out.files.push('.circleci/config.yml');
  } else if (exists(path.join(root, 'azure-pipelines.yml'))) {
    out.provider = 'azure-pipelines';
    out.files.push('azure-pipelines.yml');
  } else if (exists(path.join(root, 'Jenkinsfile'))) {
    out.provider = 'jenkins';
    out.files.push('Jenkinsfile');
  }
  out.jobs = uniq(out.jobs).slice(0, 20);
  out.commands = uniq(out.commands).slice(0, 25);
  return out;
}

// ----------------------------------------------------------------- docs ---

function detectDocs(root) {
  const pick = (...names) => names.filter((n) => has(root, n));
  const docsDir = ['docs', 'doc', 'documentation'].find((d) => has(root, d)) || null;
  let docFiles = [];
  if (docsDir) {
    docFiles = collectFiles(root, docsDir, { maxDepth: 2, limit: 200 })
      .filter((f) => /\.(md|mdx|rst)$/i.test(f))
      .slice(0, 40);
  }
  return {
    agentInstructions: pick('CLAUDE.md', 'AGENTS.md', '.cursorrules', '.github/copilot-instructions.md'),
    readme: pick('README.md', 'README.rst', 'readme.md')[0] || null,
    architecture: pick('ARCHITECTURE.md', 'DESIGN.md', 'ADR.md'),
    contributing: pick('CONTRIBUTING.md')[0] || null,
    roadmap: pick('ROADMAP.md')[0] || null,
    security: pick('SECURITY.md')[0] || null,
    docsDir,
    docFiles,
  };
}

// ------------------------------------------------------------ frameworks ---

/**
 * Declared-dependency -> framework label. Read from manifests only: a framework
 * is "present" because the project declared it, never because a file looked
 * like it. Order is the display order.
 */
const FRAMEWORKS = [
  ['next', 'Next.js'], ['nuxt', 'Nuxt'], ['@remix-run/react', 'Remix'], ['astro', 'Astro'],
  ['@angular/core', 'Angular'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['solid-js', 'Solid'],
  ['react-native', 'React Native'], ['expo', 'Expo'], ['electron', 'Electron'], ['react', 'React'],
  ['@nestjs/core', 'NestJS'], ['express', 'Express'], ['fastify', 'Fastify'], ['koa', 'Koa'], ['hono', 'Hono'],
  ['django', 'Django'], ['flask', 'Flask'], ['fastapi', 'FastAPI'], ['rails', 'Rails'], ['sinatra', 'Sinatra'],
  ['laravel/framework', 'Laravel'], ['symfony/framework-bundle', 'Symfony'],
  ['axum', 'axum'], ['actix-web', 'Actix'], ['rocket', 'Rocket'], ['tokio', 'Tokio'],
  ['phoenix', 'Phoenix'], ['spring-boot-starter', 'Spring Boot'],
  ['tailwindcss', 'Tailwind'], ['@storybook/react', 'Storybook'],
];

/** Frameworks any package declares, strongest first, deduped and capped. */
function frameworksOf(packages) {
  const declared = new Set(packages.flatMap((p) => p.rawDeps || []));
  const hit = [];
  for (const [dep, label] of FRAMEWORKS) {
    if (declared.has(dep) || [...declared].some((d) => d === dep || d.endsWith(`/${dep}`))) hit.push(label);
  }
  // Next.js/Nuxt/Remix already imply their view layer; naming both is noise.
  const implied = { 'Next.js': 'React', Remix: 'React', Nuxt: 'Vue', Expo: 'React Native' };
  const covered = new Set(hit.map((h) => implied[h]).filter(Boolean));
  return uniq(hit.filter((h) => !covered.has(h))).slice(0, 3);
}

// ---------------------------------------------------------------- config ---

/** Per-repo override files, in precedence order. */
export const CONFIG_FILES = ['.claude/yindee.json', '.yindee.json'];

export function readConfig(root) {
  for (const rel of CONFIG_FILES) {
    const found = readJson(path.join(root, rel));
    if (found) return found;
  }
  return {};
}

// ----------------------------------------------------------------- main ---

export function detect(root) {
  const config = readConfig(root);
  const rootStacks = stacksAt(root);
  const { globs, tool } = workspaceGlobs(root, rootStacks);
  const memberDirs = globs.length ? expandGlobs(root, globs) : [];

  const packages = [];
  const rootPkgEntry = packageAt(root, '');
  // A workspace root manifest is usually not a real package (no [package] table,
  // private umbrella package.json) — keep it only when nothing else was found.
  const rootIsPackage =
    rootPkgEntry &&
    (!memberDirs.length ||
      (rootPkgEntry.stack === 'node' && !rootPkgEntry.private && rootPkgEntry.name) ||
      (rootPkgEntry.stack === 'rust' && !!parseToml(t(root, 'Cargo.toml') || '')?.package));

  for (const dir of memberDirs) {
    const p = packageAt(root, dir);
    if (p) packages.push(p);
  }
  if (rootIsPackage && !packages.some((p) => p.path === '.')) packages.unshift(rootPkgEntry);
  if (!packages.length && rootPkgEntry) packages.push(rootPkgEntry);
  // Repos with source but no manifest (scripts, infra, docs sites) still need a
  // package to hang paths off, otherwise context/impact have nothing to scope to.
  if (!packages.length) {
    packages.push({ name: path.basename(root), path: '.', stack: 'unknown', kind: 'lib', manifest: null, deps: [], rawDeps: [], scripts: {} });
  }

  // Read before `rawDeps` is filtered down to workspace-local edges below.
  const frameworks = frameworksOf(packages);

  // Internal dependency edges (workspace-local only).
  const byName = new Map(packages.map((p) => [p.name, p]));
  for (const p of packages) {
    p.deps = uniq((p.rawDeps || []).filter((d) => byName.has(d) && d !== p.name));
    delete p.rawDeps;
    p.tests = testPathsFor(root, p);
  }
  // Reverse edges: who breaks when this package changes.
  for (const p of packages) {
    p.dependents = packages.filter((o) => o.deps.includes(p.name)).map((o) => o.name);
  }

  const stacks = uniq([...rootStacks, ...packages.map((p) => p.stack)]);
  const packageManager = detectPackageManager(root, rootStacks);

  let commands = {};
  let affected = null;
  if (stacks.includes('node')) {
    const nodeRoot = readJson(path.join(root, 'package.json'));
    const r = nodeCommands(root, packageManager, tool, nodeRoot);
    commands = { ...commands, ...r.cmds };
    affected = r.affected;
  }
  for (const s of stacks) {
    if (s === 'node') continue;
    const c = stackCommands(root, s, packageManager);
    for (const [k, v] of Object.entries(c)) if (!commands[k]) commands[k] = v;
  }
  commands = { ...commands, ...(config.commands || {}) };

  // Workspace container directories, e.g. `packages/*` -> `packages`. A new
  // member adds no line to any manifest we already track, so without watching
  // the container a freshly added package would never invalidate the cached map.
  const workspaceDirs = uniq(
    globs
      .map((g) => toPosix(g).split('/').filter((s) => !s.includes('*') && s !== '.').join('/'))
      .filter(Boolean),
  );

  const manifestFiles = uniq([
    ...uniq([
      ...packages.map((p) => p.manifest).filter(Boolean),
      ...workspaceDirs,
      'package.json', 'pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json',
      'Cargo.toml', 'go.work', 'go.mod', 'pyproject.toml', 'composer.json', 'Gemfile',
      'pom.xml', 'build.gradle', 'build.gradle.kts', 'mix.exs', 'deno.json', 'pubspec.yaml',
    ]).filter((f) => has(root, f)),
    // Always fingerprinted, present or not: the fingerprint is taken over the
    // *cached* file list, so a config that is only filtered in once it exists
    // could never invalidate the map that predates it. `fingerprint` records
    // absent files explicitly, so creating it moves the fingerprint.
    ...CONFIG_FILES,
  ]);

  return {
    stacks,
    frameworks,
    typescript: packages.some((p) => p.typescript) || has(root, 'tsconfig.json'),
    packageManager,
    monorepo: { tool, isMonorepo: packages.length > 1, globs },
    packages,
    commands,
    affected,
    ci: detectCI(root),
    docs: detectDocs(root),
    manifestFiles,
    config,
  };
}
