export function isDetailWorkspacePath(pathname: string) {
  return /^\/(?:issues|incidents)\/[^/]+\/?$/.test(pathname);
}
