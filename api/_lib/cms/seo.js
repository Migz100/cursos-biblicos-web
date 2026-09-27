const { origin, coursePath } = require('../../../seo');
const { CmsError } = require('./core');

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
const courseDescription = course => `Estudia ${course.name} en español con ${course.lessons.length} ${course.lessons.length === 1 ? 'lección' : 'lecciones'}. Lee los materiales en línea, descarga los archivos y comparte las lecciones que elijas.`;
const absolute = value => {
  try { const url = new URL(value, origin); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
};

function courseIndex(courses) {
  const index = new Map();
  for (const course of courses) {
    const pathname = coursePath(course, courses);
    if (index.has(pathname)) throw new Error('Duplicate course URL');
    index.set(pathname, course);
  }
  return index;
}

function lessonPath(course, lesson, scope) {
  const page = lesson.type === 'pdf' ? '/leer.html' : '/presentacion.html';
  const params = new URLSearchParams({ c: course.id, l: scope ? lesson.id : lesson.legacyNumber || lesson.id });
  if (scope) params.set('s', scope);
  return `${page}?${params}`;
}

function metadata({ title, description, canonical, image, noindex, schema }) {
  const picture = absolute(image || '/assets/course-covers/fe-de-jesus.webp');
  return `<!--seo:start-->
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<meta name="robots" content="${noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large'}">
${canonical ? `<link rel="canonical" href="${escape(canonical)}">` : ''}
<meta property="og:type" content="website">
<meta property="og:site_name" content="Cursos Bíblicos">
<meta property="og:title" content="${escape(title)}">
<meta property="og:description" content="${escape(description)}">
${canonical ? `<meta property="og:url" content="${escape(canonical)}">` : ''}
<meta property="og:image" content="${escape(picture)}">
<meta property="og:image:alt" content="Cursos Bíblicos">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escape(title)}">
<meta name="twitter:description" content="${escape(description)}">
<meta name="twitter:image" content="${escape(picture)}">
${schema ? `<script type="application/ld+json">${json(schema)}</script>` : ''}
<!--seo:end-->`;
}

function catalogMarkup(courses, scope) {
  const sections = [{ id: 'cursos', name: 'Cursos Bíblicos' }, { id: 'lafe', name: 'La Fe de Jesús (PowerPoint)' }];
  return sections.map(section => {
    const members = courses.filter(course => (course.section || 'cursos') === section.id);
    if (!members.length) return '';
    return `<section class="catalogSection" aria-labelledby="section-${section.id}"><div class="catalogSectionHead"><h2 class="secHead" id="section-${section.id}">${section.name}</h2></div><div class="courseRail" tabindex="0" role="region" aria-labelledby="section-${section.id}">${members.map(course => {
      const href = scope ? `/curso.html?c=${encodeURIComponent(course.id)}&s=${scope}` : coursePath(course, courses);
      const cover = absolute(course.coverUrl || '/assets/app-icon-512.png');
      return `<a class="card hasCover" href="${escape(href)}"><div class="coverArt" style="background-image:url('${escape(cover)}')" role="img" aria-label="Portada de ${escape(course.name)}"></div><div><div class="name">${escape(course.name)}</div><div class="meta">${course.lessons.length} ${course.lessons.length === 1 ? 'lección' : 'lecciones'}</div></div></a>`;
    }).join('')}</div></section>`;
  }).join('');
}

function lessonMarkup(course, scope) {
  return course.lessons.map((lesson, index) => {
    const number = scope && Number.isInteger(lesson.lessonNumber) && lesson.lessonNumber > 0 ? lesson.lessonNumber : index + 1;
    const title = scope ? `Lección ${number}` : lesson.title;
    return `<div class="row"><a class="rowMain" href="${escape(lessonPath(course, lesson, scope))}"><div class="num">${number}</div><div class="label">${escape(title)}</div><span class="fileKind">${escape(String(lesson.type).toUpperCase())}</span></a></div>`;
  }).join('');
}

function resolvePage(pathname, params, manifest, scope) {
  const courses = manifest.courses;
  if (pathname === '/' || pathname === '/index.html') return { kind: 'home', template: 'index' };
  const slug = /^\/cursos\/([a-z0-9-]+)\/?$/.exec(pathname);
  if (!slug && !['/curso.html', '/leer.html', '/presentacion.html'].includes(pathname)) throw new CmsError(404, 'PAGE_NOT_FOUND', 'Esta página no está disponible.');
  if (params.getAll('c').length > 1 || params.getAll('l').length > 1) throw new CmsError(400, 'INVALID_PAGE', 'El enlace no es válido.');
  const course = slug ? courseIndex(courses).get(`/cursos/${slug[1]}/`) : courses.find(item => String(item.id) === (params.get('c') || '1'));
  if (!course) throw new CmsError(404, 'COURSE_NOT_FOUND', 'Este curso no está disponible.');
  if (slug || pathname === '/curso.html') return { kind: 'course', template: 'curso', course };
  const id = params.get('l') || (!scope && pathname === '/leer.html' ? '1-01' : '');
  const lesson = course.lessons.find(item => item.id === id || (!scope && item.legacyNumber === id.padStart(2, '0')));
  if (!lesson) throw new CmsError(404, 'LESSON_NOT_FOUND', 'Esta lección no está disponible.');
  return { kind: 'lesson', template: pathname === '/leer.html' ? 'leer' : 'presentacion', course, lesson };
}

function renderPage(template, page, manifest, scope) {
  const courses = manifest.courses;
  const noindex = Boolean(scope) || page.kind === 'lesson';
  let title, description, canonical, schema, image;
  let html = template;
  if (page.kind === 'home') {
    title = scope ? 'Lecciones compartidas · Cursos Bíblicos' : 'Cursos bíblicos gratis en español | Cursos Bíblicos';
    description = scope ? 'Lee las lecciones que eligieron compartir contigo.' : `Explora ${courses.length} cursos bíblicos gratis en español. Estudia la Biblia a tu ritmo, lee las lecciones en línea y descarga los materiales.`;
    canonical = `${origin}/${scope ? `index.html?s=${scope}` : ''}`;
    html = html.replace('<div id="sections"></div>', `<div id="sections">${catalogMarkup(courses, scope)}</div>`);
    if (scope) {
      html = html.replace(/<h1 id="homeTitle">[\s\S]*?<\/h1>/, '<h1 id="homeTitle">Lecciones compartidas contigo</h1>');
      html = html.replace(/<section class="homeControls seoIntro"[\s\S]*?<\/section>/, '');
    } else {
      schema = { '@context': 'https://schema.org', '@graph': [
        { '@type': 'WebSite', '@id': `${origin}/#website`, name: 'Cursos Bíblicos', url: `${origin}/`, inLanguage: 'es' },
        { '@type': 'ItemList', name: 'Cursos bíblicos en español', numberOfItems: courses.length, itemListElement: courses.map((course, index) => ({ '@type': 'ListItem', position: index + 1, name: course.name, url: `${origin}${coursePath(course, courses)}` })) }
      ] };
    }
  } else if (page.kind === 'course') {
    const { course } = page;
    title = `${course.name}: curso bíblico en español | Cursos Bíblicos`;
    description = courseDescription(course);
    canonical = scope ? `${origin}/curso.html?c=${encodeURIComponent(course.id)}&s=${scope}` : `${origin}${coursePath(course, courses)}`;
    image = course.coverUrl;
    html = html.replace('<body>', `<body data-course-id="${escape(course.id)}">`)
      .replace('<span class="brand" style="flex:1;text-align:center" id="title"></span>', `<span class="brand" style="flex:1;text-align:center" id="title">${escape(course.name)}</span>`)
      .replace('<h1 class="courseTitle" id="courseTitle"></h1>', `<h1 class="courseTitle" id="courseTitle">${escape(course.name)}</h1>`)
      .replace('<p class="archiveNote" id="courseSummary"></p>', `<p class="archiveNote" id="courseSummary">${escape(description)}</p>`)
      .replace('<div class="lessonGroup" id="list"></div>', `<div class="lessonGroup" id="list">${lessonMarkup(course, scope)}</div>`)
      .replace('<a class="back">Inicio</a>', `<a class="back" href="${scope ? `/index.html?s=${scope}` : '/'}">${scope ? 'Selección' : 'Inicio'}</a>`);
    if (course.coverUrl) html = html.replace('<div class="courseCover" id="courseCover" hidden role="img"></div>', `<div class="courseCover" id="courseCover" role="img" aria-label="Portada de ${escape(course.name)}" style="background-image:url('${escape(absolute(course.coverUrl))}')"></div>`);
    if (!scope) schema = { '@context': 'https://schema.org', '@graph': [
      { '@type': 'Course', name: course.name, description, url: canonical, inLanguage: 'es', isAccessibleForFree: true },
      { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Cursos Bíblicos', item: `${origin}/` }, { '@type': 'ListItem', position: 2, name: course.name, item: canonical }] }
    ] };
  } else {
    title = `${page.lesson.title} · ${page.course.name} | Cursos Bíblicos`;
    description = `Lee ${page.lesson.title}, una lección del curso ${page.course.name}, en español.`;
    const params = new URLSearchParams({ c: page.course.id, l: page.lesson.id });
    if (scope) params.set('s', scope);
    canonical = `${origin}/${page.template}.html?${params}`;
    image = page.course.coverUrl;
  }
  if (scope) html = html.replace(/id="sharedNotice" hidden/, 'id="sharedNotice"');
  html = html.replace(/<!--seo:start-->[\s\S]*?<!--seo:end-->/, metadata({ title, description, canonical, image, noindex, schema }));
  html = html.replace(/\b(src|href)="(?![a-z][a-z0-9+.-]*:|\/|#)([^"\s]+)"/gi, '$1="/$2"');
  return { html, noindex };
}

function sitemap(manifest) {
  const paths = ['/', ...courseIndex(manifest.courses).keys()];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map(path => `<url><loc>${escape(origin + path)}</loc></url>`).join('')}</urlset>`;
}

function errorPage(message) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, follow"><title>Página no disponible · Cursos Bíblicos</title><link rel="icon" href="/favicon.ico"></head><body><main><h1>Página no disponible</h1><p>${escape(message)}</p></main></body></html>`;
}

module.exports = { courseIndex, coursePath, resolvePage, renderPage, sitemap, errorPage };
