// A reading copy preserves the original presentation and its download link.
window.LessonCompanions = {
  get(courseId, lesson) {
    if (courseId !== 'c_ce795f91-5ff0-4270-9cc2-d7ef4f930933' || lesson?.id !== 'l_9f57406e-8c41-4bd9-a0a2-6cfa381e7ec1') return null;
    const source = 'https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/d8c999bb-d978-445e-a941-54ebfd004e1b-29-el-milenio.pptx';
    if (String(lesson.url || lesson.downloadUrl || '').split('?')[0] !== source) return null;
    return { pdfUrl: '/assets/companions/el-milenio.pdf' };
  }
};
