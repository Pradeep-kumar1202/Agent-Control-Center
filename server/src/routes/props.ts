/**
 * Legacy route — delegates to the props skill module.
 * Kept for backward compatibility; new code should use /skills/props/generate.
 */
import { Router } from "express";
import { handlePropsRoute, handlePropsList } from "../skills/props/index.js";

export const propsRouter = Router();
propsRouter.post("/props/generate", handlePropsRoute);
propsRouter.get("/props", handlePropsList);
