import nodemailer, { type Transporter } from "nodemailer";
import { decryptIfEncrypted } from "../config/crypto.js";
import { createLogger } from "../config/logger.js";

const mailLog = createLogger("mail");

let cachedTransporter: Transporter | null = null;
let cachedConfigSig: string | null = null;

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  defaultTo: string;
}

function loadSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) return null;

  const port = Number(process.env.SMTP_PORT || 587);
  const secure =
    process.env.SMTP_SECURE === "true" || port === 465;
  const user = process.env.SMTP_USER?.trim() || "";
  const pass = decryptIfEncrypted(process.env.SMTP_PASSWORD);
  const from = process.env.SMTP_FROM?.trim() || user || "ai-pipeline@localhost";
  const defaultTo = process.env.ALERT_EMAIL_TO?.trim() || "";

  return { host, port, secure, user, pass, from, defaultTo };
}

export function isMailConfigured(): boolean {
  return loadSmtpConfig() !== null;
}

function getTransporter(): { transporter: Transporter; config: SmtpConfig } | null {
  const config = loadSmtpConfig();
  if (!config) return null;

  const sig = `${config.host}:${config.port}:${config.secure}:${config.user}:${config.pass.length}`;
  if (!cachedTransporter || cachedConfigSig !== sig) {
    cachedTransporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.user
        ? { auth: { user: config.user, pass: config.pass } }
        : {}),
    });
    cachedConfigSig = sig;
  }

  return { transporter: cachedTransporter, config };
}

export async function sendAlertEmail(params: {
  to?: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<{ sent: boolean; messageId?: string; reason?: string }> {
  const bundle = getTransporter();
  if (!bundle) {
    mailLog.debug({ subject: params.subject }, "SMTP not configured; skipping email");
    return { sent: false, reason: "SMTP_HOST is not configured" };
  }

  const recipient = params.to?.trim() || bundle.config.defaultTo;
  if (!recipient) {
    mailLog.warn({ subject: params.subject }, "No recipient configured (ALERT_EMAIL_TO)");
    return { sent: false, reason: "No recipient email address configured" };
  }

  const info = await bundle.transporter.sendMail({
    from: bundle.config.from,
    to: recipient,
    subject: params.subject,
    text: params.text,
    ...(params.html ? { html: params.html } : {}),
  });

  mailLog.info(
    { to: recipient, subject: params.subject, messageId: info.messageId },
    "Alert email sent"
  );
  return { sent: true, messageId: info.messageId };
}

export async function sendJenkinsCircuitBreakerAlert(params: {
  nodeId: string;
  baseUrl: string;
  fromState: string;
  toState: string;
  backoffMs: number;
  reason: string;
}): Promise<void> {
  if (process.env.ALERT_EMAIL_ENABLED === "false" || !isMailConfigured()) {
    return;
  }
  const subject = `[AI-Pipeline 告警] Jenkins 节点 ${params.nodeId} 熔断关闭 (${params.fromState} -> ${params.toState})`;
  const text = [
    `Jenkins 节点状态变更告警：`,
    `- 节点 ID: ${params.nodeId}`,
    `- 地址: ${params.baseUrl}`,
    `- 状态变更: ${params.fromState} -> ${params.toState}`,
    `- 退避时间: ${params.backoffMs} ms`,
    `- 触发原因: ${params.reason}`,
    `- 时间: ${new Date().toISOString()}`,
  ].join("\n");

  await sendAlertEmail({ subject, text }).catch((err) => {
    mailLog.warn({ err, nodeId: params.nodeId }, "Failed to send circuit breaker alert email");
  });
}

export async function sendPipelineResultAlert(params: {
  skillName: string;
  status: "passed" | "failed";
  totalRepos: number;
  failedRepos: string[];
}): Promise<void> {
  if (process.env.ALERT_EMAIL_ENABLED === "false" || !isMailConfigured()) {
    return;
  }
  const subject = `[AI-Pipeline 通知] Skill "${params.skillName}" 流水线测试${params.status === "passed" ? "全部通过" : "存在失败"}`;
  const text = [
    `Skill: ${params.skillName}`,
    `状态: ${params.status}`,
    `总仓库数: ${params.totalRepos}`,
    `失败仓库 (${params.failedRepos.length}): ${params.failedRepos.join(", ") || "无"}`,
    `时间: ${new Date().toISOString()}`,
  ].join("\n");

  await sendAlertEmail({ subject, text }).catch((err) => {
    mailLog.warn({ err, skillName: params.skillName }, "Failed to send pipeline alert email");
  });
}
