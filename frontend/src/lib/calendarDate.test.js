import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const formatModule = new URL('../utils/format.js', import.meta.url).href;
const workoutDate = '2026-11-15';

function formatInTimezone(timezone, formatter) {
  // Start Node with the target timezone so this test does not change Vitest's TZ.
  const script = `
    import { ${formatter} } from ${JSON.stringify(formatModule)};
    process.stdout.write(${formatter}(${JSON.stringify(workoutDate)}));
  `;

  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TZ: timezone },
  });
}

describe.each(['Europe/Rome', 'America/New_York'])('calendar dates in %s', (timezone) => {
  it('shows the saved workout day in history', () => {
    expect(formatInTimezone(timezone, 'formatDate')).toBe('15/11/2026');
  });

  it('keeps the saved workout day in the edit field', () => {
    expect(formatInTimezone(timezone, 'toDateInputValue')).toBe(workoutDate);
  });
});
