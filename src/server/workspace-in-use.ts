/** A second Start can wait for the process that already owns this workspace. */
export class WorkspaceInUseError extends Error {
  static readonly exitCode = 75;
}
