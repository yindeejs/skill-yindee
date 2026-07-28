// Path -> area classification. Drives path-scoped rule loading and risk tiers.
// Every pattern is a glob matched against a repo-relative posix path.
// Repos override or extend these in .claude/yindee.json ("areas", "sensitive").
import { matchAny, uniq } from './util.mjs';

export const AREA_ORDER = ['security', 'database', 'infra', 'backend', 'frontend', 'test', 'docs', 'config', 'code'];

/** Areas that mean "no build verification needed". Everything else is code. */
export const NON_CODE_AREAS = new Set(['docs', 'other']);

export const DEFAULT_AREAS = {
  security: [
    '**/auth/**', '**/authn/**', '**/authz/**', '**/*auth*.*', '**/security/**',
    '**/middleware/**', '**/guards/**', '**/permission*/**', '**/*permission*.*',
    '**/rbac/**', '**/policy/**', '**/policies/**', '**/session*.*', '**/sessions/**',
    '**/*jwt*.*', '**/*token*.*', '**/*password*.*', '**/*credential*.*',
    '**/crypto/**', '**/*crypto*.*', '**/secrets/**', '**/*secret*.*',
    '.env', '.env.*', '**/.env', '**/.env.*',
  ],
  database: [
    '**/migrations/**', '**/migration/**', '**/*.sql', '**/schema.prisma',
    '**/prisma/**', '**/drizzle/**', '**/*schema*.{ts,js,py,rb,go,rs,sql}',
    // `models/` only signals a database when it holds code — ML weights,
    // fixtures and asset folders share the name.
    '**/models/**/*.{ts,tsx,js,py,rb,go,rs,php,java,kt,cs,ex,sql}',
    '**/model/**/*.{ts,tsx,js,py,rb,go,rs,php,java,kt,cs,ex,sql}',
    '**/entities/**', '**/entity/**',
    '**/repositor*/**', '**/db/**', '**/database/**', '**/seeds/**', '**/seeders/**',
    '**/alembic/**', '**/knex*', '**/*.sqlx', '.sqlx/**',
  ],
  infra: [
    '.github/**', '.gitlab-ci.yml', '.circleci/**', 'azure-pipelines.yml', 'Jenkinsfile',
    '**/Dockerfile', '**/Dockerfile.*', '**/docker-compose*.y*ml', '**/*.tf', '**/*.tfvars',
    'k8s/**', 'kubernetes/**', 'charts/**', 'helm/**', 'deploy/**', 'infra/**',
    '**/*.service', 'Procfile', 'fly.toml', 'vercel.json', 'netlify.toml', 'railway.json',
  ],
  frontend: [
    '**/*.{tsx,jsx,vue,svelte,astro}', '**/*.{css,scss,sass,less,styl}',
    '**/components/**', '**/component/**', '**/pages/**', '**/views/**', '**/screens/**',
    '**/layouts/**', '**/styles/**', '**/hooks/**', '**/stores/**', '**/public/**', '**/assets/**',
    'apps/{web,ui,client,frontend,site,www,docs-site,dashboard,admin}/**',
    'packages/{ui,design-system,components}/**',
    '**/tailwind.config.*', '**/vite.config.*', '**/next.config.*', '**/svelte.config.*',
  ],
  backend: [
    '**/api/**', '**/server/**', '**/services/**', '**/service/**', '**/handlers/**',
    '**/handler/**', '**/controllers/**', '**/controller/**', '**/routes/**', '**/router/**',
    '**/resolvers/**', '**/graphql/**', '**/grpc/**', '**/jobs/**', '**/workers/**',
    '**/queue/**', '**/cron/**', '**/usecase*/**', '**/domain/**',
    'apps/{api,server,backend,worker,gateway}/**',
    '**/main.{rs,go,py,ts,js}', '**/*.{rs,go,java,kt,rb,php,ex,cs}',
  ],
  test: [
    '**/tests/**', '**/test/**', '**/__tests__/**', '**/spec/**', '**/e2e/**',
    '**/*.test.*', '**/*.spec.*', '**/*_test.{go,py,rb}', '**/test_*.py',
    '**/benches/**', '**/benchmarks/**', '**/fixtures/**', '**/*.snap',
  ],
  docs: ['**/*.md', '**/*.mdx', '**/*.rst', '**/*.txt', 'docs/**', 'LICENSE', 'CHANGELOG*'],
  config: [
    '*.json', '*.toml', '*.y*ml', '*.ini', '*.cfg', '.editorconfig', '.gitignore',
    '.gitattributes', '**/tsconfig*.json', '**/*.config.{js,ts,mjs,cjs}',
    '**/.eslintrc*', '**/eslint.config.*', '**/.prettierrc*', 'rustfmt.toml',
    'rust-toolchain.toml', '.nvmrc', '.tool-versions',
    // Nested manifests — a dependency edit is never "uncategorised".
    '**/package.json', '**/Cargo.toml', '**/pyproject.toml', '**/go.mod', '**/go.sum',
    '**/composer.json', '**/Gemfile', '**/pom.xml', '**/build.gradle*', '**/mix.exs',
    '**/*.csproj', '**/*.fsproj', '**/pubspec.yaml', '**/deno.jsonc?',
  ],
  // Catch-all for source files that matched no specific area. Ordered last, so
  // it never outranks a real classification — but it keeps real code out of
  // "other", which is what decides whether a change needs verification at all.
  code: [
    '**/*.{ts,mts,cts,js,mjs,cjs,tsx,jsx,rs,go,py,rb,php,java,kt,kts,cs,fs,ex,exs,swift,c,h,cc,cpp,hpp,m,mm,scala,clj,dart,lua,sh,bash,ps1,sql,proto,graphql,gql}',
  ],
};

/** Changes here always escalate to the strictest verification tier. */
export const DEFAULT_SENSITIVE = [
  '**/auth/**', '**/*auth*.*', '**/security/**', '**/permission*/**', '**/rbac/**',
  '**/middleware/**', '**/guards/**', '**/policy/**', '**/policies/**',
  '**/*jwt*.*', '**/*token*.*', '**/*password*.*', '**/*credential*.*', '**/*secret*.*',
  '**/crypto/**', '.env', '.env.*', '**/.env*',
  '**/migrations/**', '**/migration/**', '**/*.sql', '**/schema.prisma', '**/alembic/**',
  '.github/workflows/**', '**/Dockerfile*', '**/docker-compose*.y*ml', '**/*.tf',
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'Cargo.lock',
  'poetry.lock', 'uv.lock', 'go.sum', 'Gemfile.lock', 'composer.lock',
];

const LOCKFILES = [
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'Cargo.lock',
  'poetry.lock', 'uv.lock', 'go.sum', 'Gemfile.lock', 'composer.lock', 'Podfile.lock',
];

export const isLockfile = (p) => LOCKFILES.includes(p.split('/').pop());

export const isGenerated = (p) =>
  isLockfile(p) ||
  /(^|\/)(dist|build|out|target|coverage|\.next|generated|__generated__)\//.test(p) ||
  // The harness's own generated cache and vendored copy are tooling, not the
  // change under review — otherwise `install` then `review` dumps the harness.
  p.startsWith('.claude/yindee/') ||
  p.startsWith('.claude/skills/yindee/') ||
  /\.(min\.(js|css)|map|snap|lock)$/.test(p);

/** Build/dependency manifests. A manifest edit is a build change first of all. */
const MANIFEST_GLOBS = [
  '**/package.json', '**/Cargo.toml', '**/pyproject.toml', '**/go.mod', '**/go.sum',
  '**/composer.json', '**/Gemfile', '**/pom.xml', '**/build.gradle*', '**/mix.exs',
  '**/*.csproj', '**/*.fsproj', '**/pubspec.yaml', '**/deno.json', '**/deno.jsonc',
  '**/requirements*.txt',
];

/**
 * Areas a single path belongs to, strongest first. Never empty — falls back to
 * "other" so downstream code can always group by area.
 */
export function areasOf(filePath, config = {}) {
  const table = { ...DEFAULT_AREAS, ...(config.areas || {}) };
  const hits = AREA_ORDER.filter((a) => table[a] && matchAny(filePath, table[a]));
  // A manifest inside packages/db/ is a dependency change, not a schema change.
  if (matchAny(filePath, MANIFEST_GLOBS)) return uniq(['config', ...hits]);
  // A test file that also matches backend/frontend stays primarily a test file.
  if (hits.includes('test')) return uniq(['test', ...hits.filter((h) => h !== 'test')]);
  return hits.length ? hits : ['other'];
}

export const primaryArea = (filePath, config) => areasOf(filePath, config)[0];

export function isSensitive(filePath, config = {}) {
  const pats = config.sensitive ? [...DEFAULT_SENSITIVE, ...config.sensitive] : DEFAULT_SENSITIVE;
  return matchAny(filePath, pats);
}

/** Which rule files a set of areas needs. Keeps rule loading path-scoped. */
export function rulesFor(areas) {
  const want = [];
  if (areas.includes('security')) want.push('security');
  if (areas.includes('database')) want.push('database');
  if (areas.includes('backend') || areas.includes('infra')) want.push('backend');
  if (areas.includes('frontend')) want.push('frontend');
  return uniq(want);
}
