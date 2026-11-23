import { z } from "zod";

/**
 * Schema for user session JSON stored in Redis for OAuth / Token authentication.
 */
export const RedisSessionUserSchema = z.object({
  userId: z.union([z.string().min(1), z.number()]).transform(String),
  username: z.string().min(1),
  nickname: z.string().optional(),
  email: z.string().email().optional(),
  avatar: z.string().optional(),
  roles: z.array(z.string()).default([]),
  provider: z.string().default("oauth"),
  expiresAt: z.number().int().positive().optional(),
});
export type RedisSessionUser = z.infer<typeof RedisSessionUserSchema>;

export const OAuthLoginSchema = z
  .object({
    token: z.string().trim().min(1).optional(),
    code: z.string().trim().min(1).optional(),
    state: z.string().trim().optional(),
    redirectUri: z.string().url().optional(),
  })
  .refine((data) => Boolean(data.token || data.code), {
    message: "Either `token` or `code` must be provided",
  });
export type OAuthLoginInput = z.infer<typeof OAuthLoginSchema>;

export const CreateMcpSchema = z.object({
  owner: z.string().trim().min(1, "`owner` is required"),
  name: z.string().trim().min(1, "`name` is required"),
  url: z
    .string()
    .trim()
    .url("`url` must be a valid http(s) URL")
    .refine(
      (u) => u.startsWith("http://") || u.startsWith("https://"),
      "`url` must start with http:// or https://"
    ),
  headers: z.record(z.string(), z.string()).optional().default({}),
  description: z.string().optional().default(""),
});
export type CreateMcpInput = z.infer<typeof CreateMcpSchema>;

export const JenkinsExecuteSchema = z
  .object({
    jobName: z.string().trim().min(1).optional(),
    xml: z.string().optional(),
    repoUrl: z.string().trim().optional(),
    repoBranch: z.string().trim().optional(),
    skillName: z.string().trim().optional(),
    taskPrompt: z.string().optional(),
    waitForCompletion: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
    parameters: z.record(z.string(), z.string()).optional(),
  })
  .refine(
    (data) => Boolean(data.xml?.trim() || (data.repoUrl?.trim() && data.skillName?.trim())),
    {
      message: "Either `xml` or (`repoUrl` and `skillName`) is required",
    }
  );
export type JenkinsExecuteInput = z.infer<typeof JenkinsExecuteSchema>;

export const MailTestSchema = z.object({
  to: z.string().trim().email("Invalid recipient email address").optional(),
  subject: z.string().trim().min(1).max(200).optional(),
  text: z.string().trim().min(1).max(4000).optional(),
});
export type MailTestInput = z.infer<typeof MailTestSchema>;

export type SchemaParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; issues: Array<{ path: string; message: string }> };

/**
 * Validate arbitrary runtime input against a Zod schema and return typed data or structured errors.
 */
export function parseWithSchema<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown
): SchemaParseResult<z.infer<T>> {
  const res = schema.safeParse(input);
  if (res.success) {
    return { ok: true, data: res.data };
  }
  const issues = res.error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
  const first = issues[0];
  return {
    ok: false,
    error: first ? `${first.path}: ${first.message}` : "Validation failed",
    issues,
  };
}
