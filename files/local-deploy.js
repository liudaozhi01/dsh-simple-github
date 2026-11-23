export function createLocalDeploy() {
  return { close() {}, route() { throw new Error("Local app deployment is unavailable in the Web edition"); } };
}
