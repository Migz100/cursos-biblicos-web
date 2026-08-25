function resolveActionAssets(action, resolveAsset) {
  const safe = { ...action };
  delete safe.asset;

  if (safe.type === 'lesson.add' || safe.type === 'lesson.replace') {
    safe.asset = resolveAsset(safe.assetToken);
  }
  if ((safe.type === 'course.add' || safe.type === 'course.replaceLessons') && Array.isArray(safe.lessons)) {
    safe.lessons = safe.lessons.map(item => ({
      title: item.title,
      asset: resolveAsset(item.assetToken)
    }));
  }
  return safe;
}

module.exports = { resolveActionAssets };
