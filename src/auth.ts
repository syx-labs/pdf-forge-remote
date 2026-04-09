import type { Request, Response, NextFunction } from "express";

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip auth for health check
  if (req.path === "/health") {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.slice(7);
  const validKeys = (process.env.API_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);

  if (validKeys.length === 0) {
    res.status(500).json({ error: "No API keys configured" });
    return;
  }

  if (!validKeys.includes(token)) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  next();
}
