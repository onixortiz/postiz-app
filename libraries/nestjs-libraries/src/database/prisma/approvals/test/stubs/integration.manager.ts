// FORK: approvals. The real IntegrationManager imports every social provider,
// and several of them ship ESM that jest can't load. The fork tests never
// publish, so they use this empty class as the DI token instead.
export class IntegrationManager {
  getSocialIntegration(_identifier: string): any {
    return undefined;
  }

  getAllPlugs(): any[] {
    return [];
  }
}
