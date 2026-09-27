(function (root) {
  'use strict';
  const origin = 'https://cursosbiblicos.app';
  function slug(value) {
    return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  function coursePath(course, courses = []) {
    const base = slug(course.name) || `curso-${slug(course.id)}`;
    const duplicate = courses.some(other => String(other.id) !== String(course.id) && (slug(other.name) || `curso-${slug(other.id)}`) === base);
    return `/cursos/${base}${duplicate ? `-${slug(course.id)}` : ''}/`;
  }
  const api = { origin, coursePath };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CourseSEO = api;
}(typeof window === 'object' ? window : globalThis));
