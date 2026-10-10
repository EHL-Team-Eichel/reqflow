import { api } from "@/lib/api";
import { createRunStore } from "./run-store";

export const runStore = createRunStore(api);
