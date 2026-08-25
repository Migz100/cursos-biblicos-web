const crypto = require('node:crypto');

const BASE_URL = 'https://cursos-biblicos-web.vercel.app';

async function json(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Request failed with ${response.status}`);
  return data;
}

async function main() {
  const sessionResponse = await fetch(`${BASE_URL}/api/manage/session`, { cache: 'no-store' });
  const session = await json(sessionResponse);
  const cookie = sessionResponse.headers.getSetCookie?.()[0]?.split(';')[0] || sessionResponse.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Editing session cookie was not issued');
  const backup = await json(await fetch(`${BASE_URL}/api/manage/backup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': session.csrfToken,
      Cookie: cookie,
      Origin: BASE_URL,
      'Sec-Fetch-Site': 'same-origin'
    },
    body: JSON.stringify({ requestId: crypto.randomUUID() })
  }));
  if (
    !backup.verified ||
    !backup.pathname?.startsWith('cms/production/backups/') ||
    !/^[a-f0-9]{64}$/.test(backup.digest)
  ) {
    throw new Error('Production backup did not pass verification');
  }
  process.stdout.write(JSON.stringify({ verified: true, revision: backup.revision, courses: backup.courses, lessons: backup.lessons, pathname: backup.pathname }) + '\n');
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
