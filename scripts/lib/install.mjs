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
    '| start of any task | `map` — layout, packages, commands, CI (cached) |',
    '| before opening files | `context "<task>"` — which packages/rules/files to read |',
    '| after editing | `impact` — changed files, risk tier, verification plan |',
    '| verify | `verify` — runs that plan, reports failures only |',
    '| before commit/PR | `review` — bounded diff + path-scoped checklist |',
    '| reporting a task | `benchmark start` / `benchmark stop` — measured duration and cost |',
    '',
    'Never state elapsed time or token usage that did not come from `benchmark`. When it reports token',
    'usage as `unavailable`, say "Token usage unavailable from runtime telemetry" — do not estimate it.',
    '',
    `Path-scoped rules load on demand from \`${skillRel}/rules/\` (frontend, backend, database, security) —`,
    'read only the ones `context`/`impact` name.',
    END,
  ].join('\n');
}

export function install(skillRoot, target, opts = {}) {
  const actions = [];
  const dest = path.join(target, '.claude', 'skills', 'yindee');
  const skillRel = '.claude/skills/yindee';

  if (path.resolve(dest) === path.resolve(skillRoot)) {
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
    for (const dir of ['scripts', 'rules', 'references', 'templates']) {
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
