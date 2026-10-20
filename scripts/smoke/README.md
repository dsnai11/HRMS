# Browser smoke scripts

Throwaway end-to-end checks that start the real server on an embedded database, drive the portal in Chromium (Playwright) and print what they saw. They are not part of `npm test`.

They were written in a cloud sandbox, so a few paths are hard-coded and need adjusting on your machine:

- `/home/user/hrms/...` imports: change to your repository path.
- `/opt/pw-browsers/chromium`: your Chromium executable, or remove `executablePath` to use Playwright's own.
- `/tmp/claude-0/portal-smoke/...`: screenshot and `sample.pdf` locations (the PDF is in this folder).

To use: `npm i playwright-core` somewhere outside the repo (it is not a project dependency), then `node onboarding-smoke.mjs` from that folder.
