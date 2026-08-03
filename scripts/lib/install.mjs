// Vendors the harness into a repo so teammates and CI get it without the skill
// installed. Cooperative by design: it never rewrites existing instructions.
import fs from 'node:fs';
import path from 'node:path';
import { copyDir, exists, readText } from './fsx.mjs';

const START = '<!-- yindee:start -->';
const END = '<!-- yindee:end -->';

function routerBlock(skillRel) {
  return [
    START,
    '## Yindee harness',
    '',
    'Deterministic project map, change-impact and verification live in scripts — do not rediscover',
    `the repo by reading it. Run \`node ${skillRel}/scripts/yindee.mjs <cmd>\`:`,
    '',
    '| When | Command |',
    '| --- | --- |',
    '| start of any task | `map` — layout, packages, commands, CI (cached; initializes on first use) |',
    '| before opening files | `context "<task>"` — which packages/rules/files to read |',
    '| after editing | `impact` — changed files, risk tier, verification plan |',
    '| verify | `verify` — runs that plan, reports failures only |',
    '| before commit/PR | `review` — bounded diff + path-scoped checklist |',
    '| which behaviors are on | `modules` — and who provides each one |',
    '',
    'Measurement is an opt-in module and is off by default. Unless `modules` reports `benchmark` as',
    'on, state no elapsed time, no token usage and no cost — you have no way to measure them.',
    '',
    'If a script can answer it, do not explore it. Task breadth does not justify repository breadth.',
    '`context` prints an `explore` level — obey it. Broad, repo-wide agents are not permitted without',
    'first stating "Yindee deterministic retrieval insufficient because …". When it prints `phases`,',
    'work one phase per pass instead of widening the search.',
    '',
    `Path-scoped rules load on demand from \`${skillRel}/rules/\` (frontend, backend, database, security) —`,
    'read only the ones `context`/`impact` name. Module docs load the same way from',
    `\`${skillRel}/modules/\` — read only the ones \`modules\` reports as on.`,
    END,
  ].join('\n');
}

export function install(skillRoot, target, opts = {}) {
  const actions = [];
  const dest = path.join(target, '.claude', 'skills', 'yindee');
  const skillRel = '.claude/skills/yindee';

  // Two ways a repo can already be the harness: the vendored copy installing
  // back into the repo that holds it, and the source checkout installing into
  // itself. The second one used to slip through — `dest` never equals
  // `skillRoot` there — and rewrote the source repo's own CLAUDE.md to point at
  // a vendored path it does not use.
  if (path.resolve(dest) === path.resolve(skillRoot) || path.resolve(target) === path.resolve(skillRoot)) {
    return { actions: ['nothing to do — target is the skill source itself'], dest };
  }

  if (exists(dest) && !opts.force) {
    actions.push(`update ${skillRel}/ (existing install refreshed)`);
  } else {
    actions.push(`create ${skillRel}/`);
  }

  if (!opts.dryRun) {
    fs.mkdirSync(dest, { recursive: true });
    // `references` and `templates` are linked from SKILL.md — a vendored copy
    // without them has dead links.
    for (const dir of ['scripts', 'rules', 'references', 'templates', 'modules']) {
      if (exists(path.join(skillRoot, dir))) copyDir(path.join(skillRoot, dir), path.join(dest, dir));
    }
    for (const file of ['SKILL.md', 'README.md']) {
      if (exists(path.join(skillRoot, file))) fs.copyFileSync(path.join(skillRoot, file), path.join(dest, file));
    }
  }

  // CLAUDE.md: create when absent, otherwise splice a marked block in.
  const claudePath = path.join(target, 'CLAUDE.md');
  const block = routerBlock(skillRel);
  if (!exists(claudePath)) {
    const tmpl = readText(path.join(skillRoot, 'templates', 'CLAUDE.md')) || '';
    const body = tmpl.replace(/\{\{YINDEE_BLOCK\}\}/g, block).replace(/\{\{REPO\}\}/g, path.basename(target));
    actions.push('create CLAUDE.md (lean router)');
    if (!opts.dryRun) fs.writeFileSync(claudePath, body);
  } else {
    const cur = readText(claudePath) || '';
    if (cur.includes(START) && cur.includes(END)) {
      const next = cur.slice(0, cur.indexOf(START)) + block + cur.slice(cur.indexOf(END) + END.length);
      if (next !== cur) {
        actions.push('update CLAUDE.md yindee block (rest untouched)');
        if (!opts.dryRun) fs.writeFileSync(claudePath, next);
      } else {
        actions.push('CLAUDE.md yindee block already current');
      }
    } else {
      actions.push('append yindee block to existing CLAUDE.md (nothing removed)');
      if (!opts.dryRun) fs.writeFileSync(claudePath, cur.replace(/\s*$/, '\n') + '\n' + block + '\n');
    }
  }

  return { actions, dest };
}
