import pkg from '../../package.json';

export const VERSION = pkg.version;
export const SHA = import.meta.env.PUBLIC_GIT_SHA ?? 'dev';
export const SHORT_SHA = SHA.length > 7 ? SHA.slice(0, 7) : SHA;
export const BUILD_TIME = import.meta.env.PUBLIC_BUILD_TIME ?? 'unknown';
