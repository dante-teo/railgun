import { homedir } from "node:os";
import { join } from "node:path";
import { createDevinProvider, createFileTokenStore } from "widevin";
import type { DevinModel, DevinProvider } from "widevin";
import { openUrlInBrowser } from "./openBrowser.js";

export const TOKEN_PATH = join(homedir(), ".railgun", "devin-token");

export interface DevinSession {
  devin: DevinProvider;
  model: DevinModel;
}

export const initDevinSession = async (): Promise<DevinSession> => {
  const tokenStore = createFileTokenStore(TOKEN_PATH);
  const devin = createDevinProvider({ tokenStore, openBrowser: openUrlInBrowser });

  if (!(await tokenStore.get())) {
    await devin.login();
  }

  const models = await devin.listModels();
  const model = models[0];
  if (!model) throw new Error("Devin returned no available models");
  console.error(`Using model: ${model.id}`);

  return { devin, model };
};
