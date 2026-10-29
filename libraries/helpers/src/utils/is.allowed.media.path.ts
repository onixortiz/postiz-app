import { resolve, sep } from 'path';

// a media path that isn't a remote url is read straight from the worker's
// disk, so it has to resolve inside UPLOAD_DIRECTORY
export const isAllowedMediaPath = (path: unknown) => {
  if (typeof path !== 'string' || /^https?:\/\//.test(path)) {
    return true;
  }

  // containing "http" anywhere skips the UPLOAD_DIRECTORY prefix, and the
  // providers would then read it relative to the working directory
  if (path.indexOf('http') > -1) {
    return false;
  }

  const base = resolve(String(process.env.UPLOAD_DIRECTORY));
  const filePath = resolve(process.env.UPLOAD_DIRECTORY + path);
  return filePath.startsWith(base + sep);
};
