// FORK: approvals. file-type is ESM only and the fork tests never inspect files.
export const fileTypeFromBuffer = async (): Promise<undefined> => undefined;
export const fileTypeStream = async (stream: any) => stream;
