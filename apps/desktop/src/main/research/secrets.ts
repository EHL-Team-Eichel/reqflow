import { SecretsStore, type SecureStorage } from "../secrets";
export type { SecureStorage } from "../secrets";
/** Legacy test factory constructor. All encryption and environment policy lives in SecretsStore. */
export class SecretStore extends SecretsStore {
  constructor(dir: string, storage: SecureStorage, platform = process.platform) {
    super(dir, { secureStorage: storage, platform, environment: {} });
  }
}
