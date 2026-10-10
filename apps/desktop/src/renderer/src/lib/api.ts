import { createApi } from "./bridge-client";

/** The only way UI code talks to the main process (data, AI runs, files, settings). */
export const api = createApi(window.reqflowBridge);
export { ReqflowError } from "./bridge-client";
