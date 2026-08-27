function resolveActionAssets(action, resolveAsset) {
  const safe = { ...action };
  delete safe.asset;
  delete safe.coverAsset;

  if (safe.type === 'lesson.add' || safe.type === 'lesson.replace') {
    safe.asset = resolveAsset(safe.assetToken);
  }
  if ((safe.type === 'course.add' || safe.type === 'course.replaceLessons') && Array.isArray(safe.lessons)) {
    safe.lessons = safe.lessons.map(item => ({
      title: item.title,
      asset: resolveAsset(item.assetToken)
    }));
  }
  if ((safe.type === 'course.add' || safe.type === 'course.update') && safe.coverAssetToken) {
    safe.coverAsset = resolveAsset(safe.coverAssetToken);
  }
  return safe;
}

module.exports = { resolveActionAssets };
