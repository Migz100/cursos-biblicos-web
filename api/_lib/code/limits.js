const CODE_JOB_VISITOR_LIMIT = Object.freeze({ count: 30, bytes: 2 * 1024 * 1024, windowMs: 24 * 60 * 60 * 1000 });
const CODE_JOB_GLOBAL_LIMIT = Object.freeze({ count: 80, bytes: 4 * 1024 * 1024, windowMs: 24 * 60 * 60 * 1000 });

module.exports = { CODE_JOB_GLOBAL_LIMIT, CODE_JOB_VISITOR_LIMIT };
