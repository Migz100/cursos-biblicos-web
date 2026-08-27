# App context

Cursos Bíblicos is a Spanish, mobile-first library for Bible-course PDFs and PowerPoint lessons. It is intentionally simple enough for family use on iPhone and iPad, while the Vercel deployment also works on desktop.

The public catalog reads an immutable, revisioned manifest from Vercel Blob and falls back to the bundled `data.json` and `pdfs.json`. The administration area can upload, reorder, rename, replace, restore, and back up course material. Destructive content actions are soft-delete-first and protected by revision checks.

The Edit App page is different from the content administrator: it sends plain-language software requests to Miguel's Windows coding host. Requests, progress, and results are AES-256-GCM encrypted before they enter the existing public Blob store. Provider credentials and the source repository never run in the browser or in Vercel. The host chooses Codex, Kimi, or the local Ollama model, runs the existing tests, and only publishes after an explicit Publish action.

Important commands:

- `npm test`: all behavior and security tests.
- `npm run check`: JavaScript parsing plus HTML module/reference validation.
- `npm run code-host`: run the local coding bridge in the foreground.

Production: `https://cursos-biblicos-web.vercel.app`
