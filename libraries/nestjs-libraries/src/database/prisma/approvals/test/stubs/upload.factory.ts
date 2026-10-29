// FORK: approvals. The real factory loads the storage providers, which pull
// ESM-only packages (file-type). The fork tests never store files.
export class UploadFactory {
  static createStorage(): any {
    return {};
  }
}
