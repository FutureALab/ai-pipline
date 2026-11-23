import { defineConfig } from "prisma/config";
import { decryptConnectionUrl } from "./src/config/crypto.js";

const dbUrl =
  decryptConnectionUrl(process.env.DATABASE_URL) ||
  "postgresql://postgres:postgres@localhost:5432/ai_pipeline";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: dbUrl,
  },
});
