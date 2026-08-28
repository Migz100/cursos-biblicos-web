# Cursos Bíblicos coding guide

This repository is the complete deployed Cursos Bíblicos web app. The user of the in-app editor is nontechnical, so interpret plain-language requests, implement them autonomously, and explain the finished result in simple Spanish.

## Project map

- `index.html`, `styles.css`, and `site.js`: course catalog.
- `curso.html` and `course.js`: course lesson list.
- `leer.html`: PDF reader.
- `presentacion.html` and `presentation.js`: PowerPoint viewer.
- `admin/`: catalog administration.
- `edit/`: family-friendly coding interface.
- `api/`: Vercel Functions. `api/_lib/cms/` manages course content; `api/_lib/code/` is the encrypted coding relay.
- `data.json` and `pdfs.json`: bundled starter catalog.
- `test/`: Node test suite.

The complete supporting source library is at `N:\projects\personal\Personal\Cursos Biblicos`. It contains 202 verified source files and is read-only reference material. Never alter, move, rename, or delete anything in that library.

## Required workflow

1. Inspect the relevant code and preserve unrelated behavior.
2. Make the smallest complete change that works on iPhone, iPad, and desktop.
3. Keep accessibility, Spanish copy, touch targets, and safe-area insets intact.
4. Run `npm test` and `npm run check` after an edit.
5. Do not commit, push, or deploy. The local coding host performs those steps only after the user explicitly chooses Publish.

Never open, read, print, transmit, or edit `.env*`, `.vercel/`, `.code-host/`, credential files, or provider configuration. The editor is OPEN TO EVERYONE since 2026-08-27 (Miguel's explicit decision): `requireEditor` and `requirePairingKey` are intentional no-ops; do not re-add the private-link gate. The encrypted relay and host token still protect the coding host; do not weaken those. Do not add a login screen unless Miguel explicitly asks for one.
