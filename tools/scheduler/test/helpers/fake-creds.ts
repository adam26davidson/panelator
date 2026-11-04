import { join } from "node:path";
/** The fake `systemd-creds` of spec 030 section 3: reversible, not plaintext. */
export const fakeCreds = join(import.meta.dirname, "fake-systemd-creds");
