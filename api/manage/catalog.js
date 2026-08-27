const { CmsError, applyMutation, assertRevision } = require('../_lib/cms/core');
const { resolveActionAssets } = require('../_lib/cms/action-assets');
const { assertUniqueContent } = require('../_lib/cms/content-audit');
const { allowMethod, readJson, sendError, standardHeaders } = require('../_lib/cms/http');
const { requireCsrf } = require('../_lib/cms/security');
const { requireEditor } = require('../_lib/code/security');
const { enforceRate, loadManifest, validatedAsset, writeManifest } = require('../_lib/cms/storage');

const VISITOR_LIMIT = { count: 30, bytes: 0, windowMs: 24 * 60 * 60 * 1000 };
const GLOBAL_LIMIT = { count: 60, bytes: 0, windowMs: 24 * 60 * 60 * 1000 };

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['POST'])) return;
  try {
    requireEditor(req);
    requireCsrf(req);
    await enforceRate(req, 'changes', 0, VISITOR_LIMIT, GLOBAL_LIMIT);
    const action = await readJson(req);
    const current = await loadManifest();
    assertRevision(current.revision, action.baseRevision);

    let next;
    let label;
    let undoTrashId = null;
    if (action.type === 'catalog.rollback') {
      if (action.confirmText !== 'RESTAURAR') throw new CmsError(400, 'CONFIRMATION_REQUIRED', 'Escribe RESTAURAR para volver a esa versión.');
      if (typeof action.targetRevision !== 'string' || action.targetRevision === current.revision) {
        throw new CmsError(400, 'INVALID_REVISION', 'Selecciona una versión anterior.');
      }
      next = await loadManifest(action.targetRevision);
      label = `Catálogo restaurado a la versión del ${next.updatedAt ? new Date(next.updatedAt).toLocaleString('es') : 'catálogo original'}`;
    } else {
      const safeAction = resolveActionAssets(action, validatedAsset);
      assertUniqueContent(current, safeAction);
      const result = applyMutation(current, safeAction);
      next = result.manifest;
      label = result.label;
      undoTrashId = result.undoTrashId;
    }

    const manifest = await writeManifest(current.revision, next, { type: action.type, label });
    standardHeaders(res);
    res.status(200).json({ manifest, undoTrashId });
  } catch (error) {
    sendError(res, error);
  }
};
